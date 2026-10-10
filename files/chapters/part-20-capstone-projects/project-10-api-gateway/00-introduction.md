# Capstone Project 10: Building a Production-Ready API Gateway

**Difficulty**: Advanced
**Estimated Time**: 3-4 weeks
**Target**: Ultra-low-latency, dynamically configurable reverse proxy and API Gateway
**Tech Stack**: Go 1.27+, net/http, atomic memory swapping, Redis, JWT/OAuth2, Prometheus, Docker

---

### Project Overview & Architecture

An API Gateway sits at the entry point of every microservice ecosystem, serving as the single front door for all incoming client traffic. It decouples client clients from backend service topologies, handling cross-cutting concerns—authentication, traffic routing, load balancing, rate limiting, and request transformation—with sub-millisecond latency overhead.

In this capstone project, you will build a production-grade API Gateway in Go inspired by Kong and Envoy. The gateway architecture features a non-blocking asynchronous reverse proxy pipeline, a dynamic trie-based router, a pluggable middleware engine supporting runtime hot reloading via atomic pointer swaps, and a distributed token-bucket rate limiter backed by Redis.

```
┌──────────────────────────────────────────────────────────────┐
│                    Client Requests                           │
│                                                              │
│       Mobile App / Web SPA / External API Clients            │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTP/1.1 & HTTP/2
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    API Gateway Core Engine                   │
│                                                              │
│   Fast Trie Router (Method, Host, Path Prefix Matching)      │
│   ├─ Plugin Chain Pipeline (Composable Middleware)           │
│   │   ├─ 1. Correlation ID & Access Logging                  │
│   │   ├─ 2. Distributed Token Bucket Rate Limiting (Redis)   │
│   │   ├─ 3. JWT & API Key Authentication                     │
│   │   └─ 4. Header & Payload Request Transformation          │
│   └─ Upstream Load Balancer (Round-Robin / Least Connection) │
│       ├─ Active & Passive Health Checking Probes             │
│       └─ Circuit Breaker (Closed, Open, Half-Open)           │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                   Backend Microservices                      │
│                                                              │
│       Auth Service  │  Payment Service  │  Catalog Service   │
└──────────────────────────────────────────────────────────────┘
```

### What You Will Build and Learn Across Sections

- **Part 1 & 2 (Setup & Core Types)**: Define the request context, route representations, upstream target pools, and the fundamental plugin interface.
- **Part 3 & 4 (Routing Engine & Load Balancing)**: Implement a Radix-Tree / Trie router supporting parameter capture, wildcard paths, and load balancing algorithms (Round Robin, Weighted Least-Connections).
- **Part 5 & 6 (Built-in Plugin Pipeline)**: Implement rate limiting (Token Bucket with Redis Lua scripts), authentication (JWT validation with JWKS caching), and header transformations.
- **Part 7 & 8 (Gateway Server & Admin API)**: Build the core HTTP reverse proxy engine alongside an administrative REST API for dynamically provisioning routes, plugins, and upstreams.
- **Part 9 & 10 (Observability & Hot Reloading)**: Integrate Prometheus metrics, structured access logs, and implement lock-free configuration hot-reloading using `atomic.Pointer[Config]`.
- **Part 11 to 15 (Resilience & Deployment)**: Implement circuit breakers, retries with exponential backoff, Docker containerization, and load benchmark suites.

### Junior → FAANG: HTTP Mechanics & Concurrency

- **Connection Reuse & Transport Tuning**: A common beginner mistake is using `http.DefaultTransport` for reverse proxying. By default, it limits idle connections per host to 2, causing aggressive connection teardown and high TLS handshake latency. Master tuning `MaxIdleConns`, `MaxIdleConnsPerHost`, and idle connection timeouts.
- **Preventing Request Leakage**: When proxying streaming or chunked payloads, naive handlers buffer entire request bodies into memory before forwarding, resulting in OOM crashes on large uploads. Master streaming request and response bodies via `io.Copy` with buffer pooling.

### Senior @ FAANG: Zero-Downtime Reconfiguration & Resilience

- **Atomic Configuration Hot Reloading**: In production, route configurations and rate limit thresholds change hundreds of times per day. The gateway must never drop inflight connections or restart processes to apply changes. Master lock-free atomic pointer swaps (`atomic.Pointer[RoutingTable]`) ensuring active requests complete against the old configuration while new requests immediately use the new table.
- **Cascading Failure Protection**: When downstream microservices degrade, a gateway without proper circuit breaking will exhaust its own worker goroutines and file descriptors, taking down all other healthy routes. Implement circuit breakers with fast fallback responses and distributed rate limiting to maintain overall platform availability.
