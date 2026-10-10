# Chapter 51: API Gateway Pattern

*An API Gateway is the single entry point for all clients. It routes requests to the appropriate microservice, aggregates responses, and provides cross-cutting concerns like authentication and rate limiting.*

Without a gateway, every external client - mobile apps, web frontends, partner integrations, IoT devices - must know the internal topology of your services. A mobile app making a single page load might need to call the User Service, the Product Service, the Inventory Service, and the Recommendation Service separately, each with its own authentication flow, error format, and versioning scheme. As the service count grows, the client becomes tightly coupled to the internal architecture. Adding, removing, or restructuring services requires coordinating changes across every client simultaneously. Meanwhile, security concerns - token validation, rate limiting, IP allowlisting - are either duplicated in every service or left unimplemented.

The API Gateway solves this by acting as the single front door for all external traffic. It owns the client-facing API contract while the internal services remain free to evolve independently. Authentication happens once at the gateway, and downstream services receive verified identity claims. Rate limiting is enforced centrally, preventing any single client from destabilizing the backend. Request routing, response aggregation, and protocol translation are handled at the edge, so individual services can speak gRPC internally while exposing REST/JSON to the outside world. This is the architecture that allows large-scale platforms to maintain stable, versioned public APIs over services that are continuously refactored and redeployed.

This chapter covers building an API gateway in Go from scratch: dynamic routing with service discovery, JWT validation middleware, per-client rate limiting with Redis, and response aggregation from multiple upstream services. It also discusses integrating with Kong and Envoy for organizations that prefer established gateway infrastructure over custom gateway code.

**The 2026 gateway landscape (know this cold for interviews):**

- **Envoy** (Lyft, CNCF graduated). C++ proxy, xDS control plane API, the de facto data plane for service meshes (Istio, Consul Connect) and many managed gateways. Most mature, most operationally demanding.
- **Kong** (Lua plugins on NGINX/OpenResty). Huge plugin ecosystem, declarative config via `decK`, Kong Gateway OSS vs Enterprise split.
- **Traefik** (Go). First-class Kubernetes Ingress/Gateway API support, dynamic config from CRDs, Docker, Consul. Easiest Go-ecosystem option for k8s shops.
- **KrakenD** (Go). Aggregation-first, declarative JSON config, stateless, strong for BFF-style gateways that need response composition without writing code.
- **Tyk** (Go). Full lifecycle API management with developer portal, analytics, multi-tenancy.
- **Managed**: AWS API Gateway (HTTP/REST/WebSocket, tight IAM/Lambda integration), Cloudflare API Gateway (edge-first, DDoS/WAF built in), Google Cloud Endpoints/API Gateway, Azure API Management.

**Gateway vs BFF (Backends for Frontends):** A single monolith gateway serves all clients uniformly. A BFF gives each client channel (iOS, Android, web, internal tools) its own gateway tailored to that client's data shape and latency needs. Netflix popularized BFFs because mobile needed aggressive aggregation while web did not. Tradeoff: better per-client DX and performance at the cost of more gateways to operate.

> **Senior track**: The gateway is a trust boundary, not a business logic layer. TLS termination, authN, authZ coarse-grained checks, rate limiting, routing, and small header/path transforms belong here. Business transforms, domain orchestration, and stateful workflows belong in services or a dedicated BFF. Every time a gateway grows a new domain-specific endpoint, you have leaked microservice concerns into the edge, which is how gateways become the monolith you were escaping.

**What you'll learn in this chapter:**
- The responsibilities of an API gateway versus a service mesh versus a load balancer, and when to use each
- Building a custom Go gateway with dynamic route registration backed by Consul service discovery
- Implementing JWT authentication at the gateway layer with per-route bypass for public endpoints
- Applying per-client and per-IP rate limiting using Redis token buckets with sliding window algorithms
- Aggregating responses from multiple upstream services into a single composite API response
- Transforming requests and responses at the gateway layer with header, body, and URL rewriting
- Avoiding common pitfalls: gateway as single point of failure, timeout cascades, stale service discovery
- Implementing circuit breaking at the gateway to prevent cascading failures when upstream services degrade

**Why this matters at scale:**
High-traffic platforms routinely process billions of gateway requests per day, routing traffic to hundreds of internal services while enforcing authentication and rate limiting at the edge. A well-designed gateway is what allows organizations to maintain strict backward compatibility across hundreds of API endpoints while continuously refactoring the internal services behind them.

**Prerequisites:** Chapter 47 (Microservices Architecture), Chapter 46 (gRPC-Gateway), Chapter 39 (Authentication and JWT)

### Junior -> FAANG: Understanding What a Gateway Actually Does

A gateway can feel abstract until you see what the world without one looks like. Build a small mental model: you have five services, each needing auth, rate limiting, and CORS. Without a gateway you copy that logic five times. The gateway centralizes it once.

Key entry-level interview framing for this topic:

- Know the difference between a load balancer (routes at L4/L7 based on connection or host), a service mesh sidecar (east-west, pod-to-pod, mTLS), and an API gateway (north-south, external client to internal service, cross-cutting concerns). Interviewers test this distinction early.
- Know the BFF pattern by name. Netflix built separate gateways for iOS, Android, and web because mobile needed fewer fields at lower bandwidth. That story recurs in FAANG interviews.
- Be able to name at least two production gateways (Envoy, Kong, Traefik, AWS API Gateway) and say one concrete thing about each. Saying "they all do routing" is not enough.
- Understand that a gateway is a trust boundary. External traffic is untrusted until the gateway validates it. Services inside the boundary trust the headers the gateway adds.

First-job habit: when you join a team, find the gateway config before you touch any service code. That is where request lifecycles, auth, and rate limit rules live.

### Senior @ FAANG: Gateway Governance and Platform Thinking

At staff level the gateway is not a coding problem, it is an organizational one. The question is not how to proxy a request but who owns the gateway contract, how teams onboard routes safely, and what happens when the gateway becomes a deployment bottleneck.

**Architecture decision record (ADR) triggers for the gateway:**

1. Custom gateway vs managed product. The correct ADR documents: current traffic shape, team's on-call capacity, specific gap in managed products that justifies maintenance cost, migration plan from day one. A team that chooses custom because Kong felt slow without measuring it is incurring invisible debt.
2. Single gateway vs BFF topology. Single gateway wins on operational simplicity. BFFs win when client teams have meaningfully different payload shapes and latency budgets. Document which client channels exist, their payload size targets, and who owns each BFF.
3. Gateway as platform vs gateway as application. At L6/L7 thinking, the gateway is a platform service owned by a platform team. Application teams file route configuration through a self-service API or pull request pipeline. Direct gateway code changes by feature teams are a governance failure.

**Maturity model for gateway operations:**

Level 1 (ad-hoc): gateway config lives in a shared config file, changed manually, reviewed inconsistently.
Level 2 (managed): declarative config (Kong deck, Traefik CRDs, Envoy xDS snapshots), reviewed in pull requests, applied by CI.
Level 3 (self-service): application teams own their route definitions in their own repos, platform pipeline validates and merges.
Level 4 (policy-as-code): OPA or CEL policies enforce rate limit tiers, auth requirements, and allowed upstream names before any route is admitted to production.

**Bar-raiser signals in gateway interviews at L6:**

- Can you articulate where the gateway ends and the service mesh begins, and why you would not replace one with the other?
- How does your gateway handle a sudden 10x traffic spike without becoming the bottleneck? (Answer involves: horizontal scaling with no shared mutable state, rate limiting pushed to the CDN edge, circuit breakers that are local per instance with jitter to avoid synchronized herd.)
- How do you safely migrate 200 routes from Kong to Envoy without downtime? (Answer involves: shadow mode, per-route canary, rollback on error rate delta, not a big-bang cutover.)
- What is your plan when the gateway itself is the slow component? (Answer involves: profiling the hot path, checking body buffering, confirming the transport reuses connections, looking at middleware chain for blocking calls, and having an SLO for gateway overhead that is separate from upstream latency.)

**Capacity and cost thinking:** A gateway processing 1 billion requests per day with 1 ms added CPU time per request contributes roughly 278 core-hours of CPU per day (or at 1 million RPS, consumes 1,000 dedicated CPU cores totaling 24,000 core-hours per day) to your infrastructure bill before upstreams are even touched. Staff engineers account for this. They push expensive operations (heavy JSON transforms, schema validation) out of the hot path into async pipelines or dedicated adapter services.

---
