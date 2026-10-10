## Architecture Overview

The architecture diagram below provides a high-level view of the system's components and their interactions. Understanding this structure clarifies the data flow, the points where failures can occur, and where each cross-cutting concern (security, observability, caching) should be applied.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         API GATEWAY ARCHITECTURE                                 │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────── Without Gateway ─────────────────────────────┐     │
│  │                                                                          │    │
│  │   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐         │      │
│  │   │ Mobile   │    │   Web    │    │  IoT     │    │ Partner  │         │      │
│  │   │  App     │    │  App     │    │ Device   │    │   API    │         │      │
│  │   └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘         │      │
│  │        │               │               │               │                │     │
│  │        └───────────────┼───────────────┼───────────────┘                │     │
│  │                        ▼               ▼                                 │    │
│  │   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐             │      │
│  │   │ User    │    │ Order   │    │ Product │    │ Payment │             │      │
│  │   │ Service │    │ Service │    │ Service │    │ Service │             │      │
│  │   └─────────┘    └─────────┘    └─────────┘    └─────────┘             │      │
│  │                                                                          │    │
│  │   Problems: Auth in each service, client complexity, no aggregation     │     │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  ┌─────────────────────────── With Gateway ────────────────────────────────┐     │
│  │                                                                          │    │
│  │   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐         │      │
│  │   │ Mobile   │    │   Web    │    │  IoT     │    │ Partner  │         │      │
│  │   │  App     │    │  App     │    │ Device   │    │   API    │         │      │
│  │   └────┬─────┘    └────┬─────┘    └────┬─────┘    └────┬─────┘         │      │
│  │        │               │               │               │                │     │
│  │        └───────────────┴───────────────┴───────────────┘                │     │
│  │                               │                                          │    │
│  │                               ▼                                          │    │
│  │   ┌───────────────────────────────────────────────────────────────┐     │     │
│  │   │                     API GATEWAY                               │      │    │
│  │   │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │    │      │
│  │   │  │  Auth   │ │  Rate   │ │ Circuit │ │ Request │ │Response │  │    │      │
│  │   │  │         │ │ Limit   │ │ Breaker │ │ Routing │ │ Cache   │  │    │      │
│  │   │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘  │    │      │
│  │   └───────────────────────────┬───────────────────────────────────┘     │     │
│  │                               │                                          │    │
│  │        ┌──────────────────────┼──────────────────────┐                  │     │
│  │        │                      │                      │                  │     │
│  │        ▼                      ▼                      ▼                  │     │
│  │   ┌─────────┐           ┌─────────┐           ┌─────────┐              │      │
│  │   │ User    │           │ Order   │           │ Product │              │      │
│  │   │ Service │           │ Service │           │ Service │              │      │
│  │   └─────────┘           └─────────┘           └─────────┘              │      │
│  └──────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│                          GATEWAY RESPONSIBILITIES                                │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐         │
│   │   SECURITY       │     │   TRAFFIC        │     │   OBSERVABILITY  │         │
│   ├──────────────────┤     ├──────────────────┤     ├──────────────────┤         │
│   │ • Authentication │     │ • Rate Limiting  │     │ • Logging        │         │
│   │ • Authorization  │     │ • Load Balancing │     │ • Metrics        │         │
│   │ • SSL/TLS        │     │ • Circuit Break  │     │ • Tracing        │         │
│   │ • API Key Mgmt   │     │ • Request Queue  │     │ • Health Check   │         │
│   │ • IP Filtering   │     │ • Timeout        │     │ • Audit Trail    │         │
│   └──────────────────┘     └──────────────────┘     └──────────────────┘         │
│                                                                                  │
│   ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐         │
│   │   ROUTING        │     │   TRANSFORMATION │     │   AGGREGATION    │         │
│   ├──────────────────┤     ├──────────────────┤     ├──────────────────┤         │
│   │ • Path Routing   │     │ • Request Mod    │     │ • Response Merge │         │
│   │ • Header Routing │     │ • Response Mod   │     │ • Parallel Calls │         │
│   │ • Service Disc.  │     │ • Protocol Conv. │     │ • GraphQL Layer  │         │
│   │ • Versioning     │     │ • Data Mapping   │     │ • BFF Pattern    │         │
│   └──────────────────┘     └──────────────────┘     └──────────────────┘         │
│                                                                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│                            REQUEST FLOW                                          │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   Client Request                                                                 │
│        │                                                                         │
│        ▼                                                                         │
│   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐          │
│   │   TLS       │──►│  Request    │──►│   Auth      │──►│ Rate Limit  │          │
│   │ Termination │   │   Logging   │   │   Check     │   │   Check     │          │
│   └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘          │
│                                                               │                  │
│                                                               ▼                  │
│   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐          │
│   │  Response   │◄──│  Response   │◄──│   Circuit   │◄──│   Route     │          │
│   │  Logging    │   │   Cache     │   │   Breaker   │   │   Match     │          │
│   └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘          │
│        │                                                                         │
│        ▼                                                                         │
│   Client Response                                                                │
│                                                                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│                         GATEWAY PATTERNS                                         │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   1. Backend for Frontend (BFF):                                                 │
│   ┌──────────────────────────────────────────────────────────────────────────┐   │
│   │   ┌──────────┐    ┌──────────┐    ┌──────────┐                           │   │
│   │   │ Mobile   │    │  Web     │    │  TV      │                           │   │
│   │   │  App     │    │  App     │    │  App     │                           │   │
│   │   └────┬─────┘    └────┬─────┘    └────┬─────┘                           │   │
│   │        │               │               │                                 │   │
│   │        ▼               ▼               ▼                                 │   │
│   │   ┌──────────┐    ┌──────────┐    ┌──────────┐                           │   │
│   │   │ Mobile   │    │  Web     │    │   TV     │  ← Tailored for each      │   │
│   │   │   BFF    │    │  BFF     │    │   BFF    │    client's needs         │   │
│   │   └────┬─────┘    └────┬─────┘    └────┬─────┘                           │   │
│   │        │               │               │                                 │   │
│   │        └───────────────┴───────────────┘                                 │   │
│   │                        │                                                 │   │
│   │                        ▼                                                 │   │
│   │             [Backend Microservices]                                      │   │
│   └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│   2. API Composition/Aggregation:                                                │
│   ┌──────────────────────────────────────────────────────────────────────────┐   │
│   │   GET /api/dashboard                                                     │   │
│   │        │                                                                 │   │
│   │        ▼                                                                 │   │
│   │   ┌──────────────────────────┐                                           │   │
│   │   │    API Gateway           │                                           │   │
│   │   │  (Parallel Fan-out)      │                                           │   │
│   │   └──────────┬───────────────┘                                           │   │
│   │         ┌────┼────┬────┐                                                 │   │
│   │         ▼    ▼    ▼    ▼                                                 │   │
│   │   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                            │   │
│   │   │ User   │ │ Orders │ │ Stats  │ │ Notif  │                            │   │
│   │   │Service │ │Service │ │Service │ │Service │                            │   │
│   │   └────────┘ └────────┘ └────────┘ └────────┘                            │   │
│   │         │         │         │         │                                  │   │
│   │         └─────────┴─────────┴─────────┘                                  │   │
│   │                        │                                                 │   │
│   │                        ▼                                                 │   │
│   │   { user: {...}, orders: [...], stats: {...}, notifications: [...] }     │   │
│   └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: Reading Architecture Diagrams in Interviews

System design interviewers at FAANG draw or ask you to draw exactly the kind of diagram above. Junior candidates often sketch boxes without annotating the failure modes on each edge. Train yourself to annotate every arrow with: what protocol, what auth, and what happens if the receiver is down.

For the gateway diagram specifically, internalise the request flow sequence: TLS termination, logging, auth check, rate limit check, route match, circuit breaker check, upstream proxy. Interviewers ask "walk me through a request" and expect that ordered list.

The BFF pattern in the second diagram is a common follow-up question: "Netflix had one gateway and it got messy, so they went to multiple BFFs. When would you make that call?" The answer requires knowing the tradeoff: one gateway is one team and one operational surface, but it forces all client shapes through the same response format. Multiple BFFs give per-client optimization at the cost of duplicated gateway logic and more services to operate.

First-job habit: when reading a new codebase, find the diagram (or draw it yourself) before reading any code. The diagram tells you where the trust boundaries are. Code tells you how they are enforced.

### Senior @ FAANG: Architectural Decisions Hidden in This Diagram

The architecture in this chapter makes several implicit decisions that a staff engineer would surface explicitly before building.

**Decision 1: Single gateway vs sidecar mesh.** The diagram shows a central gateway for north-south traffic (external to internal). It does not show east-west traffic (service to service). If east-west calls also need mTLS, retries, and observability, a service mesh sidecar (Envoy via Istio, Linkerd) handles that. The gateway and mesh coexist: gateway owns the external boundary, mesh owns internal service-to-service. Mixing them (using the gateway to mediate internal calls) creates a bottleneck and a circular dependency.

**Decision 2: Where state lives.** The diagram's rate limiter and circuit breaker boxes imply state. In-process state is cheapest but does not hold across restarts and is inaccurate across replicas. Redis state is accurate but adds a network dependency on the hot path. The architectural decision is: accept per-instance inaccuracy for rate limiting (each replica allows N requests, total is N times replicas), or pay the Redis hop. For rate limiting, per-instance is usually acceptable because the inaccuracy is bounded. For circuit breaker state, local per-instance is actually preferable because it prevents synchronized herd failures.

**Decision 3: How the gateway is deployed.** A single binary handles all traffic is the simplest model. But at scale, teams split the gateway into tiers: an edge tier (bare metal or anycast, handles DDoS and TLS) and an inner gateway tier (routes to services, applies auth and rate limits). The inner tier is what this chapter builds. Knowing this distinction matters because the configuration, scaling, and failure model differ between tiers.

**Decision 4: How routes are managed at scale.** With 10 services, inline `gw.Route(...)` calls work. With 200 services, you need a route registry that application teams update independently, a validation pipeline, and an audit log. The diagram does not show this, but a staff engineer asks about it on day one. The answer is usually: routes live in version-controlled config (CRDs, YAML, Kong deck files), a CI pipeline validates and applies them, and a route admission controller enforces policy (allowed upstreams, required auth fields, rate limit tiers).

---
