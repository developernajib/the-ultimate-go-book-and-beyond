## Summary

Frontend integration is where backend design decisions become immediately visible to users and frontend teams. The patterns in this chapter address the most common sources of friction:

1. **CORS** must validate origins against an allowlist, never use wildcards with credentials, and set the `Vary: Origin` header so CDNs cache responses correctly per origin.
2. **Static file serving** for SPAs requires fallback routing to `index.html` for client-side routes, while returning 404 for missing static assets and applying content-hash-based immutable caching to built assets.
3. **API response envelopes** with consistent `success`, `data`, `error`, and `meta` fields eliminate the ad-hoc response formats that cause frontend crashes and type-checking failures.
4. **WebSocket servers** need a central hub goroutine that serializes connection registration, deregistration, and broadcast to avoid concurrent map writes. Ping/pong heartbeats detect stale connections before they leak goroutines.
5. **Server-Sent Events** provide one-way server-to-client streaming over standard HTTP, with automatic browser reconnection. Use HTTP/2 to avoid the six-connection-per-domain limit in HTTP/1.1 browsers.
6. **TypeScript API clients** mirrored from Go response structs catch integration drift at compile time rather than in production.

The next chapters build on these foundations with complete full-stack projects that exercise CORS, WebSockets, SSE, and API design patterns together in realistic applications.

### Junior -> FAANG: Consolidating Chapter Patterns Into Interview-Ready Knowledge

The six summary points in this section are the answer structure for "explain how you would build a real-time API for a SPA" in an interview. Practice delivering them in two minutes: CORS with allowlist validation and `Vary: Origin`, SPA serving with fallback routing and content-hash caching, consistent JSON envelopes, WebSocket hub with heartbeat and clean shutdown, SSE for one-way streams, and TypeScript types that mirror Go structs.

The most memorable interview pattern is the CORS/credentials constraint: `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Credentials: true` cannot coexist. A wildcard origin tells the browser not to restrict access, but credentials require knowing exactly who is allowed, which contradicts the wildcard. This constraint is frequently used as a screening question because it reveals whether the candidate understands the browser security model or is just memorizing header names.

For the WebSocket summary: being able to state that "the hub goroutine is the sole writer to the shared maps, so readPump and writePump goroutines never need locks" demonstrates you understand the difference between channel-based concurrency and mutex-based concurrency. That distinction is a common mid-level interview question.

### Senior @ FAANG: Using This Chapter as a Platform Design Foundation

The six summary points translate directly into a platform team's frontend integration mandate:

The CORS summary point is an organizational policy: which origins are trusted varies by environment (development permissive, production restrictive) and by product area (public API versus admin portal). Centralizing this policy in a shared library or API gateway config prevents teams from independently expanding the allowlist without security review.

The SPA serving summary point connects to a CDN strategy: content-hashed assets belong at the CDN edge with infinite TTL, and `index.html` belongs at the origin with `no-cache`. The Go binary should serve `index.html` and the API, nothing else. Measuring CDN hit rate for static assets (target above 99%) and origin request rate for `index.html` gives a complete picture of the static serving architecture's efficiency.

The API envelope summary point is a contract governance decision. The envelope is versioned, schema-validated in CI, and the source of truth for generated clients in every language the company uses. Changes to the envelope go through a deprecation process with at least one release cycle of forward compatibility before the old format is removed.

The WebSocket summary point at platform scale is a topology decision: the hub goroutine is a single-process component, and horizontal scale requires a pub/sub backbone. Define the backbone as part of the platform, not as an afterthought when the first service needs to scale past one pod.

The SSE summary point encodes a browser compatibility requirement: HTTP/2 is not optional for SSE at scale. The platform must enforce TLS (required for HTTP/2 in practice) and configure all proxies in the request path for HTTP/2 pass-through. An nginx proxy that downgrades to HTTP/1.1 toward the origin destroys the multiplexing benefit.

The TypeScript types summary point is an automation requirement: manual type mirroring does not scale past a small team. Invest in type generation tooling early. The cost of setting up `tygo` or `oapi-codegen` is a few engineer-days. The cost of a production bug caused by a manually-out-of-sync type is measured in incident hours and user impact.

---
