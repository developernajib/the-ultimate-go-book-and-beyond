## Learning Objectives

By the end of this chapter, you will be able to:

- **Understand API Gateway responsibilities** and when to use gateways vs direct service communication
- **Build a custom API gateway** with routing, middleware, and service discovery
- **Implement authentication and authorization** at the gateway layer
- **Apply rate limiting and circuit breaking** to protect backend services
- **Aggregate responses** from multiple services in a single API call
- **Integrate with Kong and Envoy** for production gateway deployments
- **Apply proven patterns** for production gateway architecture at scale

### Junior -> FAANG: Mapping Objectives to Interview Topics

Each objective in this list maps directly to a question category FAANG interviewers use for system design rounds. Understanding what each objective is really testing helps you prepare more efficiently.

- "Understand API Gateway responsibilities" is tested as the classic "design an API gateway" prompt. The expected answer separates the gateway's job (routing, auth enforcement, rate limiting, TLS termination) from the service mesh's job (east-west mTLS, retries, observability) and the load balancer's job (L4 connection distribution).
- "Build a custom API gateway" exercises Go's `net/http/httputil.ReverseProxy`, the middleware chain pattern, and graceful shutdown. These are concrete coding skills that appear in take-home projects and on-site coding sessions.
- "Implement authentication at the gateway layer" is where most junior candidates lose points by conflating authN (who are you, JWT validation) with authZ (what are you allowed to do, scope checking). Know which belongs at the gateway and which stays inside the service.
- "Apply rate limiting and circuit breaking" requires knowing the algorithm tradeoffs: token bucket allows short bursts, sliding window is accurate across boundaries, fixed window is simple but double-spikes at window edges.

Build a study habit around these objectives: after reading each section, write a two-sentence explanation of the concept as if explaining it to a non-technical product manager. If you cannot do that, you have memorized code but not understood the problem.

### Senior @ FAANG: Using Learning Objectives as a Readiness Checklist

Senior and staff engineers arriving in a gateway design interview should be able to answer at the second and third order for each objective, not just the first.

First order: "Implement authentication at the gateway layer." Second order: "What is the attack surface if JWT validation is done at the gateway but individual services do not re-validate claims?" Third order: "How does your approach change under a zero-trust network model where no network boundary is trusted?"

Readiness signals by objective:

**Routing and service discovery**: Can you compare xDS (Envoy control plane API) to Consul blocking queries to Kubernetes Endpoints watches, and say which fits which deployment topology? Can you explain why querying the registry on every request is a correctness risk under high churn (deregistration lag, health check propagation delay)?

**Authentication and authorization**: Can you describe the split between coarse gateway-level authN (signature valid, not expired, issued by known issuer) and fine-grained service-level authZ (does this user's scope include this resource), and explain why collapsing them into the gateway creates a coordination bottleneck for every new permission rule?

**Rate limiting**: Can you contrast per-instance in-memory limiting (cheap, inaccurate across replicas) against centralized Redis limiting (accurate, adds network hop, Redis becomes a dependency) against edge-CDN limiting (most scalable, least expressive), and say which to use for which threat model?

**Circuit breaking**: Can you explain the thundering herd problem that emerges from globally synchronized circuit breaker state, and describe how per-instance breakers with jitter in recovery timing address it?

**Aggregation**: Can you calculate aggregate availability for N independent services at p availability each (p^N), and use that calculation to justify per-call timeouts and optional-vs-required classification?

**Observability**: Can you describe what structured logging, distributed tracing, and metrics each uniquely contribute, and explain why you cannot replace any one of them with another?

---
