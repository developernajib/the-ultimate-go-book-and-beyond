## 37J.14 Exercises

Each exercise builds on the code from this chapter. You can test CDN header behavior locally using `curl -I` to inspect response headers without needing a live CDN account.

**Exercise 1: CDN-Aware Product API**

Build a Go HTTP API for products with full CDN integration:
- Set appropriate Cache-Control headers per endpoint type
- Implement ETag support for conditional GET requests
- Add surrogate key headers for targeted invalidation
- Integrate with Cloudflare API for invalidation on update/delete
- Implement cache key normalization to prevent poisoning
- Measure: CDN hit rate improvement over 1 hour of traffic

**Exercise 2: Real-Time Invalidation Pipeline**

Build an end-to-end cache invalidation system:
- Publish invalidation events to Kafka on database write
- Consumer invalidates Redis L2 + broadcasts to L1 via pub/sub
- Consumer calls Cloudflare API to purge CDN by surrogate key
- Handle failures: retry with exponential backoff, dead letter queue
- Monitor: invalidation latency, failure rate, CDN propagation time

**Exercise 3: Cache Warming Service**

Build a proactive cache warming system:
- Identify top-1000 most-requested URLs from CDN access logs
- Pre-warm Redis cache and CDN for these URLs on deployment
- Implement gradual traffic shift to new origin while warming
- Handle cache warm-up ordering: parent pages before child pages
- Measure: time-to-full-cache-efficiency after deployment

### Junior to FAANG: prerequisite gaps, worked examples, first-job context

Before you touch Exercise 1, build the observability harness that tells you whether your answer works. Start with a local `curl -I` loop that hits each endpoint twice and asserts the second hit returns `X-Cache-Status: HIT` when the path is cacheable and `X-Cache-Status: MISS` followed by `HIT` on subsequent calls when warm. Write a ten-line Go test that uses `httptest.NewRecorder` to capture headers and assert `Cache-Control`, `Vary`, `ETag`, and `Surrogate-Key` are all set correctly for each route. These assertions are the scaffolding every production CDN integration needs, and writing them first turns the exercise from "does it compile" into "does it behave".

Worked entry-point for Exercise 1. Build the `CachePolicy` struct first, not the handler. The struct carries `Public bool`, `MaxAge time.Duration`, `SMaxAge time.Duration`, `StaleWhileRevalidate time.Duration`, `StaleIfError time.Duration`, `SurrogateKeys []string`, and `VaryHeaders []string`. Its `Apply(w, r)` method composes the `Cache-Control` string from the fields, joins the surrogate keys with spaces (Fastly) or commas (Cloudflare) depending on the vendor, writes the `Vary` header as a comma-separated list, and emits the `ETag`. Once the struct is correct and tested, the handler is thirty lines of glue. The junior mistake is to write the handler first and fight the header composition every time.

"Why did this fail" reflex for Exercise 2. The first failure you will see is that the consumer purges the CDN before the origin has committed the write, so the edge re-fetches the old value and caches it again. Fix: the purge must happen after the write is confirmed committed, either by reading the write's commit log entry in Kafka or by using the database CDC stream as the event source. The second failure is that Kafka delivers the same event twice and the purge API is called twice, which is fine unless your CDN charges per purge, in which case you need an idempotency key derived from the event offset. The third failure is that a purge fails silently and the error does not surface to the dead-letter queue because the HTTP client swallowed the timeout. Fix: explicit timeouts, explicit retry budgets, explicit DLQ with alerting.

### Senior at FAANG: staff and principal material, ADRs, maturity models, governance

Staff extensions on top of each exercise, because the exercise as stated is L4 work and the staff extension is L6 work. On top of Exercise 1, build a tag-based purge system backed by Kafka with the following contract. Producers (application services) emit `cache.invalidate` events to a single topic with a schema that includes entity type, entity ID, and the tenant. A purge coordinator consumes the topic, expands each event into the full set of surrogate keys (via a tag-derivation function registered per entity type), batches by CDN provider, and calls the purge API with bounded concurrency and an idempotency key derived from the Kafka offset. The coordinator emits `cache.invalidated` events on success so downstream systems (search index, recommendation cache) can react. The staff-level design question is the back-pressure model: what happens when the CDN purge API is rate-limited at one thousand requests per second and the topic is delivering ten thousand events per second. The answer is a token-bucket shaper at the coordinator, a circuit breaker that spills to a low-priority queue on sustained rate-limit responses, and an alert when the low-priority queue exceeds a five-minute backlog.

Staff extension on Exercise 2: implement stale-if-error end to end with synthetic monitoring. The `stale-if-error` header is a free resilience upgrade for reads, but only if origin actually emits the stale response correctly when it is healthy, which is a surprisingly common configuration miss. The extension adds a synthetic probe that intentionally causes origin to return 503 on one canary route per POP per hour and asserts the edge serves the stale cached response. If the assertion fails, page the on-call. This is the kind of work that moves an organization from "we configured stale-if-error" to "we have verified stale-if-error across all POPs within the last hour", which is the L4 to L5 jump on the operational maturity model.

Staff extension on Exercise 3: harden against CPDoS (Cache-Poisoned Denial of Service). CPDoS is the class of attack where an attacker sends a request that origin rejects with a 4xx, but the 4xx gets cached at the edge because the response has a public `Cache-Control`, and subsequent legitimate users get served the error. The extension adds the following controls. One, origin emits `Cache-Control: no-store` on all 4xx responses, enforced by middleware, and a test proves no handler overrides it. Two, the edge VCL or Worker rewrites any public `Cache-Control` on a 4xx to `no-store` as defense in depth. Three, synthetic probes assert that known-bad inputs (overlength header, oversize method, HTTP Method Override) produce uncached 4xx at the edge. Four, the cache-key allowlist at the edge is declarative and version-controlled, so adding a new contributor requires a review. The full hardening is a quarter of work for a staff engineer and prevents an entire class of public CVEs.

Governance artifacts these exercises should produce. A purge API contract that documents rate limits, idempotency semantics, retry budgets, and DLQ behavior, reviewed quarterly. A surrogate-key taxonomy doc that lists every tag namespace, its cardinality budget, and the entity that owns it. A cache-key allowlist doc that enumerates every header and query parameter that contributes to the edge cache key, with a change log. A CDN incident runbook that covers cache poisoning, provider outage, purge storm, and cost spike, each with a named owner and an escalation ladder. These four documents together are the institutional memory of a CDN operation, and they are what you hand to the next principal when you rotate.

---
