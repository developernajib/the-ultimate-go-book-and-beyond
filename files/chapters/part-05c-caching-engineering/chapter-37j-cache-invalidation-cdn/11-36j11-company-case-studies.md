## 37J.11 Company Case Studies

The patterns covered in this chapter are not theoretical. They run in production at some of the highest-traffic systems on the internet. The following case studies show how three different organizations solved CDN caching and invalidation at scale, each with a different architectural approach.

### GitHub: Content Delivery at Scale

GitHub serves its static assets through Fastly, and the multi-CDN playbook for a site of that profile looks like this:
- **Content-addressed URLs**: JS/CSS bundled with content hash in filename (`app.a3b4c5.js`) - `immutable` cache header, infinite TTL
- **Surrogate key purging**: when a user's avatar changes, Fastly purges by `user:12345` surrogate key - all pages showing that avatar are invalidated
- **Stale-while-revalidate**: API responses for repository lists use 60s `max-age` + 30s `stale-while-revalidate` - users see instant updates while background refresh happens
- **CDN shield**: a designated shield POP absorbs cache misses from every other edge location before they reach origin, collapsing most origin traffic into one warm path

### Netflix: Edge Caching for Streaming

Netflix's Open Connect Appliance (OCA) is a purpose-built CDN that ISPs install in their networks:
- **Predictive prefetch**: Netflix pre-loads popular content to OCAs before users request it (based on regional popularity predictions)
- **Consistent hashing for OCAs**: when user requests content, routed to nearest OCA holding that content
- **Two-tier cache**: regional cache (country level) → ISP-level OCA (last mile)
- **No CDN purge**: content is immutable (different resolution = different URL) - no invalidation needed
- **Scale**: 15,000+ OCAs globally, 95% of traffic served from OCAs (not Netflix origin)

### Varnish at Scale

Varnish Cache is used by major media companies (BBC, Wikimedia) as an HTTP accelerator:
- **VCL (Varnish Configuration Language)**: custom purge logic, request routing, A/B testing at CDN level
- **Banlist purging**: instead of individual purge requests, maintain a list of regular expressions that match stale content - new requests checked against banlist
- **Hit-for-pass**: when a response is uncacheable (e.g., `Set-Cookie`), Varnish remembers not to try caching it again for 120 seconds - prevents repeated origin requests

### Junior to FAANG: prerequisite gaps, worked examples, first-job context

The case studies above look different on the surface but they resolve to three design primitives that you need to name in an interview. First, content-addressed URLs (GitHub assets, Netflix encodes, Stripe JS) push the TTL to forever and make invalidation a non-problem. Second, surrogate-key purge (GitHub, Shopify, the New York Times at Fastly) lets origin enumerate tags at write time so the edge can drop exactly the affected entries without a global flush. Third, precompute and push (Netflix OCA, Vercel ISR, Pinterest's multi-CDN warm-up) means the edge is primed before users request content, trading storage for tail latency. Every CDN architecture you will see in the wild is a combination of these three, plus a story about how they handle failure.

Worked example for a first-job interview. Shopify runs a storefront CDN mesh where each merchant is a tenant on shared Fastly POPs. When a merchant updates a product, Shopify emits a purge targeting the surrogate key `shop:12345:product:67890`. The edge does not scan the entire key space, it looks up an in-memory index that maps tag to stored object IDs and invalidates them in O(k). The lesson for a junior: surrogate-key purge is not magic, it is a secondary index on the cache, and the cost of that index is memory on the edge. When you see a case study that claims "we purge a billion keys in under a second", the real claim is "we maintain a tag index that lets us find the right keys in under a second".

The "why did this fail" reflex for case-study questions. A misconfigured `Vary` header is one of the most common ways a CDN hit rate collapses across a set of pages to near zero, leaving the origin to absorb production traffic that the edge was meant to handle. When your interviewer frames a scenario as "the CDN hit rate dropped overnight from 95% to 40%, what do you check", the answer is always: what changed in the cache key. Nine times out of ten the cache key grew a new dimension, either through a new `Vary` value, a new query parameter, a cookie leak, or a canary header that was supposed to be stripped and was not. First-job context: you will not design a CDN in your first year, but you will debug one, and the debugging ladder always starts at the cache key.

### Senior at FAANG: staff and principal material, ADRs, maturity models, governance

Staff-level framing for each case study, because at this level you are expected to compare architectures and defend tradeoffs. The New York Times at Fastly is a classic single-CDN deep integration: they bought into VCL, shield nodes, and instant purge, and the coupling is deep enough that leaving Fastly would be a year of work. The ADR for that decision reads: prefer deep integration when the CDN's primitives (surrogate keys, VCL, instant purge) are load-bearing for your product, accept vendor lock-in as the price, and invest in an abstraction layer only if multi-CDN is a real business requirement. Shopify runs a CDN mesh where they front Fastly with their own edge tier, giving them per-merchant isolation and the ability to move between providers without app-tier changes. Their ADR accepts a 5-10ms latency tax for the optionality. Vercel ISR is the opposite: they treat the CDN as a build-output distribution system, with revalidation tokens embedded in the build, so invalidation is a rebuild, not a purge. Netflix OCA is a purpose-built appliance CDN, not a commodity one, and the ADR is "our content is immutable and our traffic is 95% video, so we build instead of buy".

Multi-CDN architectures. Pinterest runs on Fastly and Cloudflare simultaneously with weighted DNS, and their failover story is the bar-raiser answer: they health-check both providers from a third-party vantage point (not from their own origin), and shift traffic via low-TTL DNS within sixty seconds of degradation. The governance rule: never use your own origin to decide whether your CDN is healthy, because the same network partition that hides the CDN can hide the origin. GitHub Pages fronts Cloudflare for user content and Fastly for docs, which is a tenant-based split rather than active-active failover, and the ADR justifies it by workload shape (user content is high cardinality low hit rate, docs are low cardinality high hit rate). Reddit's CDN history is a migration case: they moved from Fastly to a multi-CDN posture after a 2021 Fastly outage took down a third of the internet, and the lesson codified in their postmortem is that any CDN above a certain blast radius must be assumed to fail and your architecture must survive it.

Maturity model L1 to L5 for CDN operations. L1 is reactive: a single CDN, manual purges via vendor UI, no hit-rate monitoring, outages discovered by customer complaint. L2 is instrumented: hit rate dashboards per route, purge via API, a runbook for common incidents. L3 is policy-driven: every service declares cache policy as code, purge is event-driven from the write path, hit-rate SLOs are enforced per route. L4 is multi-CDN ready: provider-agnostic abstraction, synthetic health checks from third-party vantage points, DNS failover tested quarterly in game days, cost allocation per provider tracked monthly. L5 is autonomous: traffic steering based on real-time provider performance and cost, automated purge cardinality governance (detecting and alerting when a service's purge rate exceeds the negotiated contract), and a cost optimization loop that tunes CDN spend against origin spend at the five hundred thousand dollar per month scale where a two percent shift in cache efficiency is a full engineer's salary. The companies above sit at L3 to L5. If your organization is at L1 or L2, the principal work is to design the path to L3 without a rewrite.

Governance artifacts a principal should own. A CDN selection rubric that scores providers on purge latency, surrogate-key support, shield architecture, WAF integration, and egress pricing at your volume tier. A purge cardinality budget that caps how many keys a service can invalidate per minute, because a runaway purge worker can crater hit rate across the entire edge. An incident classification scheme that distinguishes CDN incidents (provider-side) from edge-config incidents (your VCL or your cache key) from origin incidents (your app), because the remediation paths are entirely different. A quarterly game day that simulates a full provider outage and exercises the failover runbook end to end. These are the artifacts that turn "we have a CDN" into "we operate a CDN", and the distinction is what staff and principal reviews look for.

---
