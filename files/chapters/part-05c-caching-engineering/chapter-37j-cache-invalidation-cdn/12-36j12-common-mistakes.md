## 37J.12 Common Mistakes

### 1. Caching Private Content in CDN

Setting `Cache-Control: public` on an endpoint that derives its response from a JWT or session cookie is a critical security mistake: CDNs treat `public` as permission to serve the cached response to any requester, so user A's profile page can be returned verbatim to user B. Authenticated and user-scoped responses must use `private` (browser-only) or `no-store` to prevent shared-cache poisoning.

```go
// BAD: authenticated content cached publicly
func GetUserProfile(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Cache-Control", "public, max-age=3600")
    // User-specific data cached publicly → user A sees user B's data!
    json.NewEncoder(w).Encode(getUserFromToken(r))
}

// GOOD: private content uses private cache-control
func GetUserProfile(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Cache-Control", "private, max-age=300, no-store")
    // Or better: no caching for sensitive data
    w.Header().Set("Cache-Control", "no-store")
    json.NewEncoder(w).Encode(getUserFromToken(r))
}
```

### 2. Not Setting Vary Header

When an endpoint serves different content based on a request header (such as `Accept-Encoding` for compression or `Accept-Language` for localization), the `Vary` header tells the CDN to maintain separate cache entries for each header value. Without it, the CDN stores whichever variant it received first and serves that to all clients, causing decompression errors for clients that cannot handle gzip or wrong-language content for international users.

```go
// BAD: same URL serves different content per Accept-Encoding but no Vary header
// CDN caches gzipped version, serves it to clients that can't handle gzip
func GetProducts(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Cache-Control", "public, max-age=300")
    // If Accept-Encoding: gzip → serve gzip
    // If no Accept-Encoding → serve plain text
    // BUT: without Vary header, CDN caches ONE version for all clients
    // ...
}

// GOOD: tell CDN to cache separate copies per encoding
func GetProducts(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Cache-Control", "public, max-age=300")
    w.Header().Set("Vary", "Accept-Encoding")
    // Now CDN caches: products.gzip + products.plaintext separately
    // ...
}
```

### 3. Cache-Control Without s-maxage

Without `s-maxage`, CDNs honor the same `max-age` as browsers, which is often set to a short value to keep the user's browser fresh, forcing the CDN to re-fetch from origin far more often than necessary. Setting `s-maxage` independently allows the CDN to hold a response for an hour while browsers re-validate every five minutes, dramatically reducing origin traffic for public content.

```go
// BAD: max-age applies to both browser AND CDN
// max-age=300 means CDN keeps it for 5 minutes - may be too short
w.Header().Set("Cache-Control", "public, max-age=300")

// GOOD: different TTLs for browser vs CDN
// Browser: 5 min (user sees fresh content more often)
// CDN: 1 hour (less origin traffic)
w.Header().Set("Cache-Control", "public, max-age=300, s-maxage=3600")
// stale-while-revalidate: CDN serves stale while refreshing origin
w.Header().Set("Cache-Control", "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600")
```

### 4. Invalidating Entire CDN Cache

Issuing a full CDN purge on every data change collapses the cache hit rate to zero and routes the resulting thundering herd of re-warming requests directly to the origin, effectively a self-inflicted DDoS. Surrogate-key (cache-tag) invalidation scopes the purge to only the URLs that embed the changed entity, so a single product update clears only the product detail page and any category pages that include it, leaving the rest of the cached content untouched.

```go
// BAD: purge everything when one product updates
// "When in doubt, nuke the cache" approach
cloudflare.PurgeEverything(ctx)
// Cache hit rate drops to 0%, origin gets 100% of traffic → DDoS yourself

// GOOD: targeted invalidation via surrogate keys
cloudflare.PurgeByTags(ctx, []string{fmt.Sprintf("product:%s", productID)})
// Only the 5 URLs tagged with this product are invalidated
// Everything else remains cached
```

### Junior to FAANG: prerequisite gaps, worked examples, first-job context

Beyond the four listed, there are six more mistakes that show up in the first-job postmortems for CDN incidents. Unkeyed header pollution is the first: a service writes a debug header such as `X-Request-ID` or `X-Trace-Id` into the response, and a poorly configured edge includes it in the cache key, fragmenting the cache per request. The fix is to standardize the cache-key allowlist at the edge and forbid origin from influencing it. `Vary: Accept` is the second, and it is subtler than `Vary: Accept-Encoding` because the Accept header has unbounded cardinality across clients, so each browser quirk produces a separate cache entry and hit rate collapses. The rule: never vary on a header whose value space you do not control. Missing `Surrogate-Key` is the third, and its symptom is a purge worker that resorts to URL enumeration, which is both slow and incomplete. TTLs on dynamic content is the fourth: setting `s-maxage=60` on a per-user dashboard is a bug that leaks user A's data to user B for up to a minute. Treating the CDN as source of truth is the fifth: origin gets decommissioned or scaled down because "the CDN holds everything", and the next time the CDN evicts under memory pressure, origin cannot keep up. Not monitoring hit rate per route is the sixth, and it is the most common reason a regression goes undetected for weeks.

Worked example for the hit-rate-per-route point. A team ships a feature flag that appends `?exp=variant_a` to image URLs for a subset of users. The URL is a valid cache key input, so the CDN happily caches the variant separately, but the origin serves the same bytes regardless of `exp`. Hit rate for the image route drops from ninety percent to sixty percent overnight, origin egress doubles, and the bill goes up by tens of thousands per month. Nobody noticed for three weeks because the global hit-rate dashboard still showed ninety-two percent (dominated by other routes). The fix is strip the query parameter at the edge, but the prevention is per-route hit-rate alerts with a five percent drop threshold. First-job context: when you inherit a service, the first dashboard you build is hit rate per route, not global hit rate.

"Why did this fail" reflex for the mistakes above. Cache poisoning incidents usually reduce to one of three root causes: an origin header influenced the cache key in a way the edge did not sanitize, a `Vary` value was trusted from the client, or a purge targeted the wrong key due to a typo in the tag namespace. When you are on-call and an incident channel opens with "users are seeing other users' data", your first move is to pull five sample cached responses from the edge and compare their cache keys. The root cause is almost always visible in that comparison within minutes.

### Senior at FAANG: staff and principal material, ADRs, maturity models, governance

At staff level the mistake list becomes a governance checklist that CI enforces. The principle is to make the mistake impossible to commit, not to train humans to avoid it. The ADR for CDN safety codifies the following rules and wires each to a static check or a runtime probe. Rule one, `Cache-Control: public` combined with any authentication middleware in the handler chain is a compile-time error, enforced by an AST analyzer that walks the handler graph and flags the combination. Rule two, `Vary` values are drawn from a typed enum (`VaryAcceptEncoding`, `VaryAcceptLanguage`), never a string, and adding a new enum member requires edge-team approval in code review. Rule three, every `Cache-Control` header is composed via the `CachePolicy` struct, and a linter rejects raw string writes to that header. Rule four, purge calls go through a typed client that accepts only well-formed surrogate keys matching the namespace regex, and a global purge is a separate method (`PurgeAll`) that requires a feature flag and a signed incident ticket to execute. Rule five, the CDN is declared as a non-authoritative cache in the architecture doc, and any service that treats it as authoritative must pass a design review.

Bar-raiser incident response playbook for cache poisoning. When an external report arrives, the first action is to freeze purge operations to prevent the attacker using them to expand the blast radius. The second action is to snapshot the edge cache state for forensics, because most vendors expire logs within hours. The third action is to rotate the cache-key salt if your edge supports it (Fastly and Cloudflare both do via VCL or Workers) so every key is invalidated without a bulk purge. The fourth action is to patch the origin to strip the offending header or normalize the vector input, and only then resume purges. A junior team will purge first and patch later, which both destroys forensics and often reintroduces the poison within minutes because the origin is still vulnerable. Codify this order in the incident runbook.

Maturity model for mistake prevention. L1 is "we document the rules in a wiki". L2 is "we review for these in code review". L3 is "our CI linter rejects the patterns". L4 is "our runtime probes detect the patterns in production within minutes and auto-open an incident". L5 is "our edge configuration is declarative, version-controlled, and every edge config change goes through the same review gates as application code". The jump from L3 to L4 is where organizations catch the mistakes that slip past linters, which is always the long tail, and it is the work that staff engineers own.

Cost optimization governance at the five hundred thousand dollar per month tier. The three levers are cache efficiency (hit rate), object size (compression and image optimization at the edge), and egress geography (tiered pricing by region). The governance rule is that every service over ten thousand dollars per month in CDN spend gets a quarterly review where an edge engineer reads the top ten routes by bytes served and identifies at least one optimization. Expected wins: moving image thumbnails to AVIF saves twenty to thirty percent on image egress, moving static JS to a content-addressed URL with `immutable` saves another ten percent on cache churn, and moving API responses from JSON to gzip-negotiated with a stable `Vary: Accept-Encoding` saves another five to ten percent. Across a hundred services this is tens of millions per year, which is why principal engineers who can write this governance doc get promoted.

---
