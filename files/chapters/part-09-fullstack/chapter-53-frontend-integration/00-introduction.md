# Chapter 53: Frontend Integration Fundamentals

A React developer joins a team and opens their browser's DevTools on day one. Within minutes they hit a CORS error, a missing `Content-Type` header, and an API response shape that doesn't match the TypeScript interface in the codebase. These are not edge cases. They are everyday friction that emerges when backend engineers build APIs in isolation from the teams consuming them. Go backends powering modern single-page applications need predictable response envelopes, real-time capabilities over WebSockets and SSE, correct CORS policy for development and production, and static file serving that handles client-side routing without 404s on page refresh.

Go's `net/http` standard library and frameworks like Chi and Echo make it straightforward to serve static assets, proxy API requests, and upgrade HTTP connections to WebSockets. Doing these things correctly at production scale, however, requires understanding browser security models, connection lifecycle management, and the data-fetching patterns that React, Vue, and SvelteKit applications rely on. A WebSocket hub that leaks goroutines on disconnect, a CORS handler that allows all origins in production, or an SPA server that returns 200 with `index.html` for every path will work in development and silently degrade or create security holes in production.

This chapter covers CORS middleware with environment-aware configuration, SPA serving with cache-control headers and fallback routing, WebSocket hubs with connection lifecycle management, Server-Sent Events for server-to-client streaming, and TypeScript API clients that eliminate integration drift between frontend and backend.

**What you'll learn in this chapter:**
- Configuring CORS middleware correctly for development permissiveness and production security, including preflight caching and credential handling
- Serving single-page applications from Go with client-side routing fallback, immutable asset caching, and `ETag`-based conditional requests
- Designing RESTful API response envelopes - consistent error shapes, pagination metadata, and partial update semantics - that frontend developers can rely on
- Implementing WebSocket servers with connection registration, room-based broadcast, heartbeat/ping-pong, and clean goroutine shutdown
- Building Server-Sent Events (SSE) endpoints for real-time server-to-client streaming without the overhead of full WebSocket bidirectionality
- Generating TypeScript API clients from Go handler signatures with automatic token refresh, request cancellation, and typed error handling
- Integrating with React and Redux Toolkit Query (RTK Query) for optimized data fetching, cache invalidation, and optimistic updates
- Applying production deployment patterns for SPA backends using nginx reverse proxy, Docker multi-stage builds, and content security policy headers

**Why this matters at scale:**
A misconfigured CORS policy or incorrect `Vary` header can cause browsers to cache cross-origin responses and leak user data between sessions. Goroutine leaks in WebSocket connection lifecycle handling translate into steady memory growth. At high connection counts, this becomes gigabytes per hour.

**Prerequisites:** Chapter 29 (HTTP servers in Go), Chapter 38 (REST and middleware patterns), Chapter 11 (Go concurrency patterns), Chapter 14 (context and cancellation)

### Junior -> FAANG: Why Frontend Integration Trips Up Backend Engineers

Go developers moving into fullstack roles typically underestimate how much the browser's security model constrains server behavior. The first job-level gap is not knowing that CORS is enforced by the browser, not by the server. You can write a "CORS handler" that sets nothing and the server itself will accept every request just fine. The friction only appears when JavaScript in a browser makes the call. Understanding this distinction changes how you debug: when a CORS error appears, the question is always "what did the preflight response say?" not "is my server receiving the request?"

A second gap is mental model around SPA serving. Returning a 404 for `/dashboard/users/42` is correct behavior for a traditional server that maps URLs to files. For a SPA, it breaks every bookmarked link and page refresh. The correct model is: the server owns `/api/` and every static file path. The client router owns everything else, and the server's job is to hand those paths `index.html` and stay out of the way.

For interviews, practicing the CORS preflight flow on a whiteboard is high signal. Be able to draw: browser sends OPTIONS, server responds with `Access-Control-Allow-Origin` and `Access-Control-Allow-Methods`, browser sends the real request. Know that `credentials: 'include'` on the fetch call requires a matching `Access-Control-Allow-Credentials: true` and a specific (not wildcard) origin on the server.

### Senior @ FAANG: Platform Thinking for Frontend-Backend Contracts

At staff and principal level, frontend integration problems are governance and contract problems as much as implementation ones. A single team writing both sides can iterate quickly on the API shape because feedback is immediate. In a company with 40 frontend engineers consuming a backend platform, ad-hoc API changes become incidents. The senior-level question is: what governance model prevents breaking changes from reaching production undetected?

**ADR: API versioning strategy.** Choosing URL-path versioning (`/api/v2/`) versus header versioning (`Accept: application/vnd.myapp.v2+json`) is a permanent architectural decision. Path versioning is operationally simple (easy to route, easy to log, easy to document) but pollutes every client import. Header versioning is cleaner but requires every client to set the header correctly and every proxy to forward it. Document this decision formally. Teams that skip it end up with both patterns coexisting, which is worse than either.

**ADR: Response envelope.** The `{ success, data, error, meta }` envelope from this chapter looks obvious in isolation. At scale it interacts with everything: SDK generation, mock server tooling, error monitoring aggregation, analytics pipelines. Changing the envelope after hundreds of clients exist is a multi-quarter migration. Treat the envelope as a platform API, not an implementation detail. Define it in a schema registry (e.g., JSON Schema or Protobuf with grpc-gateway) and generate types for all consumer languages from that single source.

**Maturity model for CORS governance.** Level 1: each team configures CORS on their own service, resulting in inconsistent policies. Level 2: a shared middleware library enforces the allowlist, but the list is maintained per-service. Level 3: CORS policy is declared in a central config file, validated in CI, and applied at the API gateway layer. The backend service never sees CORS headers at all. Level 3 is the right target for a platform organization because it allows the security team to audit and change CORS policy without touching service code.

**WebSocket at platform scale.** A single WebSocket hub process cannot scale horizontally because clients on different pods cannot broadcast to each other. The canonical solution is a pub/sub backbone (Redis Streams, Kafka, Google Pub/Sub) that all pods subscribe to. Any pod that receives a broadcast event from the backbone finds its local clients and writes to their channels. This decouples horizontal scale from broadcast correctness. The ADR decision is: what is the at-least-once delivery guarantee needed, and what is the acceptable message ordering constraint? Chat applications need causal ordering per room. Notification feeds can tolerate reordering. The answer drives whether you need Kafka (ordered per partition) or Redis Pub/Sub (best-effort, no ordering guarantee).

**Bar-raiser signal on frontend integration.** Candidates who only discuss implementation ("I use gorilla/websocket and a hub goroutine") are L4-L5. Candidates who discuss the operational concerns ("how do I drain WebSocket connections during a rolling deploy without dropping messages?") are operating at L6. The correct answer involves a `SIGTERM` handler that stops accepting new upgrades, waits for the existing hub to flush its broadcast channel with a deadline, and then closes all connections with a `1001 Going Away` close frame so clients reconnect to the new pod. Candidates who can also connect this to a load balancer health check that marks the pod unready immediately on `SIGTERM` are demonstrating L7-level systems thinking.

**Content Security Policy as a shared platform concern.** CSP headers sent by the Go backend control what the browser-side JavaScript can do. This is a security boundary between the frontend team and the backend platform team. A permissive CSP (`default-src *`) negates most XSS defenses. A strict CSP (`default-src 'self'; script-src 'nonce-{random}'`) requires the backend to generate and inject the nonce into every HTML response and every inline script tag, which is an integration contract. Platform teams that define CSP unilaterally without consulting frontend teams create deployment incidents. Define CSP in a governance document, review it quarterly, and version it alongside the API contract.

---
