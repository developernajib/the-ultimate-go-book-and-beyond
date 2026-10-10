## 37J.13 Interview Questions & Answers

**Q1: How do surrogate keys (cache tags) work for CDN invalidation?**

A: Surrogate keys (Fastly terminology) or Cache-Tag headers (Cloudflare Enterprise) allow associating cache entries with named tags. When the origin serves a response, it includes `Surrogate-Key: product:123 category:electronics` (Fastly) or `Cache-Tag: product:123,category:electronics` (Cloudflare). The CDN stores these tag-to-URL associations in a reverse index. When you purge by tag `product:123`, the CDN invalidates every cached URL that was ever tagged with that key without you tracking the URL list. A single `POST /purge/product:123` invalidates the product detail page, every listing page, every search result, and every recommendation widget that tagged itself with that key.

Fastly exposes surrogate keys on every plan. Cloudflare restricts Cache-Tag purge to the Enterprise plan and caps the API at 30 tags per call with a 16 KiB header limit. On lower Cloudflare plans you fall back to URL purge or prefix purge.

**What FAANG expects:** Know both vendor names, the header syntax, the purge API endpoints, and the plan-tier restrictions. Walk through the tag-to-URL reverse-index implementation (inverted index in RocksDB-style storage at the POP) and the consistency model, tag purge is eventually consistent across POPs with a P99 of roughly 150 ms on Fastly, 30 s on Cloudflare.

Follow-ups:
- What happens if two requests race: one purging tag `product:123` while another request is writing a response tagged with it? (Answer: the new write wins. purge only invalidates entries present at purge time. You need versioned keys like `product:123:v42` to avoid races.)
- How do you bound the cardinality of surrogate keys to avoid unbounded memory at the edge? (Answer: cap at O(10) tags per object. Never tag by user ID.)
- How would you implement surrogate keys yourself in a Go reverse proxy in front of origin?

---

**Q2: Explain stale-while-revalidate and stale-if-error. When do you use each?**

A: Both come from RFC 5861. `stale-while-revalidate=N` tells the cache it may serve a stale response for up to N seconds past its `max-age` while asynchronously refetching from origin in the background. The user sees edge latency on every request. The origin sees one refresh per staleness window per POP. `stale-if-error=N` tells the cache it may serve a stale response for up to N seconds past expiry if the origin returns 5xx, times out, or is otherwise unreachable, a soft fail-open for origin outages.

Typical combined header: `Cache-Control: public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400`. Fresh for 60 s at the CDN, stale-refresh-allowed for 5 min, and for 24 h after that the CDN will serve stale if origin is down.

Use `stale-while-revalidate` on catalog pages, blog posts, rendered marketing pages, anywhere a few seconds of staleness is acceptable in exchange for consistent P99. Avoid it on pricing, stock levels, auth state, and anything with legal freshness requirements. Use `stale-if-error` almost universally on GET responses. It is a free resilience upgrade.

**What FAANG expects:** Cite RFC 5861, distinguish `s-maxage` (CDN only) from `max-age` (browser + CDN), and describe the origin request amplification math. Know that Chrome and Firefox honor `stale-while-revalidate` at the browser layer, while Safari (WebKit) does not implement it, so treat browser-layer SWR as a progressive enhancement, not a guarantee.

Follow-ups:
- A bug ships that crashes origin. With `stale-if-error=86400` in place, users see cached content, but every write path is broken. How do you detect this? (Answer: synthetic monitoring on origin, not on edge.)
- What is the interaction between `stale-while-revalidate` and `Vary: Cookie`?
- How does `stale-while-revalidate` change the thundering-herd behavior on cache expiry?

---

**Q3: How would you prevent cache poisoning in a CDN setup?**

A: Cache poisoning, as formalized by James Kettle in "Practical Web Cache Poisoning" (Black Hat 2018) and extended in "Web Cache Entanglement" (2020), exploits the gap between the cache key (a subset of the request) and inputs the origin reflects into the response. Mitigations:

1. **Never reflect unkeyed headers.** If the response body or headers depend on `X-Forwarded-Host`, `X-Forwarded-Scheme`, `X-Original-URL`, or `X-Rewrite-URL`, either add them to the cache key via `Vary` (expensive) or refuse to read them. Most applications should treat these as attacker-controlled.
2. **Normalize cache keys.** Strip unknown query parameters, sort parameters, lowercase the host, canonicalize encoding. Prevents `?a=1&b=2` vs `?b=2&a=1` from storing two entries and prevents fat-GET poisoning.
3. **Validate Host header.** Enforce an allowlist of expected hosts. Reject or redirect mismatches before the response is generated.
4. **Never cache responses with `Set-Cookie`** or `Authorization`-gated responses. Use `Cache-Control: private` on authenticated paths.
5. **HTTPS only with HSTS.** HTTP responses can be tampered with by a network attacker and then served from the cache to every subsequent user.
6. **Use `Vary` minimally and precisely.** `Vary: Accept-Encoding` is safe. `Vary: User-Agent` creates near-infinite cache cardinality and often papers over a poisoning vector rather than fixing it.
7. **Run PortSwigger's Param Miner** against staging. It fuzzes unkeyed header names and flags ones the response reflects.

**What FAANG expects:** Cite Kettle's research by name, explain the keyed-vs-unkeyed distinction, and walk through at least one concrete CVE (e.g., the 2019 Drupal cache-poisoning-via-`X-Original-URL` chain). Know the difference between cache poisoning (attacker writes the cache) and cache deception (attacker tricks the cache into storing private data on a public key).

Follow-ups:
- Walk me through a cache deception attack on a URL like `/account/profile/nonexistent.css`.
- Your CDN fronts a Go service that sets `Location: https://{r.Host}/next` on redirects. What is the risk and how do you fix it?
- How do you detect cache poisoning in production? (Answer: diff sampling, re-fetch a sample of cached URLs from origin with canonical headers and compare.)

---

**Q4: What is CDN shield (or origin shield)?**

A: CDN shield is an intermediate caching tier between CDN edge POPs and your origin. Instead of every one of the CDN's edge locations (Fastly has ~90, Cloudflare has ~330) independently requesting your origin on a cache miss, edge POPs route cache-miss traffic through a single designated shield POP in a region you choose (usually your origin's region). Benefits:

1. **Origin offload.** Cache fills collapse from O(edge POPs) to O(1) per object per staleness window, commonly a 90-95% reduction in origin RPS.
2. **Known ingress.** Origin sees traffic from a single POP's IP range, simplifying firewall rules and WAF tuning.
3. **Thundering-herd damping.** On coordinated invalidation, the shield absorbs the burst instead of 300 edge POPs hitting origin simultaneously.

Trade-offs: one extra network hop on cache miss (adds 10-40 ms depending on geography), and shield POP failure can degrade all edges until failover. Fastly calls it Origin Shielding. Cloudflare calls it Argo Tiered Cache. CloudFront calls it Origin Shield.

**What FAANG expects:** Know all three vendor names, explain the math (hit-ratio improvement = 1 − (1/N) where N is the number of edges hitting origin for the same object), and discuss shield selection, pick the POP closest to origin, not closest to users.

Follow-ups:
- Your origin is multi-region active-active. How do you configure shield? (Answer: one shield per origin region, routed via DNS or CDN geo-steering.)
- What happens when the shield POP itself is being rebooted?
- When is origin shield a net loss? (Answer: when your content is highly personalized and cache hit rate at the shield is near zero, the extra hop adds latency with no offload benefit.)

---

**Q5: How do you handle CDN caching for A/B tests?**

A: The problem: A/B tests assign users to variants, but naive caching either serves one user's variant to everyone (test invalid) or keys per-user (cache useless). Four approaches:

1. **`Vary: Cookie` on the experiment cookie.** Works, but cookie cardinality explodes if the cookie contains a user ID or session token. Only viable if the cookie is a low-cardinality variant ID (`exp=a` or `exp=b`).
2. **Edge assignment (Workers / Lambda@Edge / Compute@Edge).** The edge function reads the cookie, assigns a variant if missing, and uses the variant as part of the cache key. Gives you 2-N cache entries per URL regardless of user count. This is the modern default.
3. **Client-side rendering.** Ship one HTML document, run JS that reads a cookie and mutates the DOM. CDN caches one version. variant assignment runs in the browser. Fast to cache, but adds FOUC and hurts SEO on variant-dependent content.
4. **Variant in the URL path or query.** `/home?v=a` vs `/home?v=b`. Trivial to cache but requires the application to redirect users to their assigned variant URL, which leaks experiment existence and complicates analytics.

Production systems at FAANG scale typically use (2) for server-rendered content and (3) for SPA shells. The standard edge-assignment approach reads or assigns the variant in a viewer-request edge function (Workers, Lambda@Edge, or Compute@Edge) and bakes the variant into the cache key, so each URL holds one cache entry per variant regardless of user count.

**What FAANG expects:** Cache-key cardinality analysis, a concrete edge-function sketch (even pseudocode), and awareness of the statistical validity issues, if you mix client-side and edge assignment, you double-assign users and invalidate the experiment.

Follow-ups:
- How do you roll out an experiment to 1% of traffic without fragmenting the cache across the other 99%?
- What is the interaction between A/B variant cache keys and surrogate-key purges?
- How do you handle a sticky user whose assigned variant is removed mid-experiment?

### Junior to FAANG: prerequisite gaps, worked examples, first-job context

The signal ladder for CDN interview questions runs L3 to L7 and the difference between rungs is not vocabulary, it is the unit of the answer. L3 answers a question about one URL: "how do I cache this product page". L4 answers about one service: "how do I cache the product catalog API". L5 answers about one product line: "how do I design caching for the storefront across browse, search, and detail". L6 answers across product lines: "how do I design the CDN architecture for the whole e-commerce platform including checkout, account, and static assets". L7 answers across the organization: "how do I negotiate the CDN contract, design the multi-provider failover, and set the policy that every team inherits". When an interviewer asks "design CDN and invalidation for e-commerce", they are probing your rung. A junior answer lists headers. A staff answer draws the data flow from write through Kafka to origin to edge and names the SLOs at each hop.

Worked example, L3 to L4 rung. You are asked to cache the output of `GET /products/123`. The L3 answer sets `Cache-Control: public, s-maxage=300, stale-while-revalidate=60`, adds `Surrogate-Key: product:123`, and calls it done. The L4 answer adds the `Vary: Accept-Encoding` header, explains why `Vary: Accept` is rejected, derives the `ETag` from `product.UpdatedAt`, wires the mutation path to enqueue a purge to Kafka, and reports the expected hit rate and origin RPS before and after. The L3 to L4 gap is almost always about the write path and the telemetry, not the read path.

"Purge one billion keys when the catalog rebuilds" is a classic L5 to L6 question and the first-job reflex is wrong. The naive answer is "call the purge API with a billion tags". The correct answer walks up the ladder. First, ask whether the catalog rebuild is a true content change or a metadata refresh, because most catalog rebuilds do not change the bytes served and only invalidate metadata consumers. Second, propose a version prefix on the cache key (`catalog-v42:product:123`) so rebuilding the catalog flips the prefix and invalidates atomically without a purge call. Third, if purge is genuinely required, batch by surrogate-key collection (`catalog:v42`) and let the edge expand. The answer demonstrates that you have seen this problem before and that your default move is to avoid the purge, not execute it.

### Senior at FAANG: staff and principal material, ADRs, maturity models, governance

Bar-raiser questions for L6 and L7 candidates. First, design a multi-CDN failover for a global e-commerce platform where Fastly and Cloudflare each carry fifty percent of traffic via weighted DNS. The candidate should draw the health-check topology (third-party vantage points, not origin), the DNS TTL strategy (sixty seconds for steady state, ten seconds during incident), the purge fan-out across both providers (dual-publish to both purge APIs with idempotency keys), the cache-key parity (both providers must key identically or failover flips hit rate to zero), and the cost model (egress pricing differs per provider, shift ratios based on cost per GB per region). If the candidate misses cache-key parity, they are not L6 on CDN.

Second, CDN cost optimization at five hundred thousand dollars per month. The candidate should walk through the three levers (hit rate, object size, egress geography), the measurement strategy (cost per route per month, not just global egress), the optimization backlog (image format migration, asset content-addressing, compression tuning, tiered cache tuning), the contract levers (committed spend discounts, regional pricing, purge API pricing), and the governance artifact (quarterly review with edge engineer). A staff candidate names three optimizations with rough win percentages. A principal candidate names the contract renegotiation as the biggest lever and quantifies it at ten to twenty percent on volume tier.

Third, cache poisoning incident response. The scenario: an external researcher reports that users can be served other users' cart data via a crafted `X-Forwarded-Host` header. The bar-raiser answer hits six beats in order. Freeze purge operations. Snapshot edge cache for forensics. Rotate cache-key salt to invalidate the poisoned entries without bulk purge. Patch origin to strip the offending header. Add a regression test. Publish the postmortem with timeline and root cause. The candidate should also name the pre-existing controls that should have prevented it: the AST linter that rejects origin reflection of unkeyed headers, the cache-key allowlist at the edge, and the synthetic probe that re-fetches sample URLs with canonical headers and diffs against the edge response. If the candidate only names the response and not the prevention, they are strong L5, not L6.

ADR template for CDN architecture decisions. Context: state the traffic volume, hit-rate target, and blast-radius tolerance. Decision: name the provider or provider mix, the shield strategy, and the purge model. Consequences: enumerate the vendor lock-in, the operational burden (purge cardinality budget, VCL or Workers code ownership, on-call), and the cost profile. Alternatives considered: always list at least two and explain why you rejected them. Invariants: the rules the decision must preserve (cache-key parity across providers, purge idempotency, no unkeyed header reflection). Review cadence: quarterly for cost, annually for architecture, immediately after any incident above severity two. This template is what a principal engineer leaves behind when they rotate off the CDN team, and it is what the next principal reads on day one.

Maturity model L1 to L5 on CDN operations, elaborated. L1 is a contract with one provider and purges via the vendor UI. L2 adds API-driven purge and a single dashboard. L3 adds policy-as-code and per-route SLOs. L4 adds multi-provider abstraction, third-party health checks, and a purge cardinality budget. L5 adds autonomous traffic steering, cost-driven rebalancing, and edge config as version-controlled code with the same review gates as application code. The progression is expensive and each jump takes one to two quarters of staff engineering time, so the principal's job is to sequence the jumps against the business value: L1 to L2 pays for itself in weeks, L3 to L4 pays back in the first multi-hour provider outage, L4 to L5 pays back at scale above a million dollars per month in CDN spend.

---
