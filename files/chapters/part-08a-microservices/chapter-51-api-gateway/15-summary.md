## Summary

An API gateway sits at the boundary between external clients and internal services, owning the public API contract while letting backend services evolve independently. This chapter built a gateway in Go from the ground up.

**Core takeaways:**

1. **Routing and service discovery.** The gateway resolves service names to live endpoints through a registry (in-memory for tests, Consul or etcd in production). Watch-based discovery reacts to scale events within seconds rather than waiting for a cache TTL to expire.
2. **Middleware chain.** Cross-cutting concerns stack in a defined order: tracing wraps logging, which wraps rate limiting, which wraps authentication. Each middleware operates on `http.HandlerFunc`, keeping the chain composable and testable.
3. **Rate limiting.** A sliding-window algorithm backed by Redis sorted sets provides accurate per-client rate enforcement without the boundary-burst problem of fixed windows. The `X-RateLimit-*` response headers give clients visibility into their remaining quota.
4. **Circuit breaking.** A per-service circuit breaker fails fast when an upstream exceeds its error threshold, transitions to half-open after a cooldown, and recovers only after consecutive successful probes. Local breakers with jitter prevent the thundering-herd problem that shared circuit state creates.
5. **Request and response transformation.** Header injection, body field remapping, and URL rewriting happen in a composable pipeline so the public API contract can differ from the internal service contracts.
6. **API aggregation.** Parallel fan-out to multiple services with a shared deadline, dependency ordering, and graceful degradation for non-critical calls gives clients composite responses without multiple round trips.
7. **Observability.** Every request gets a unique ID propagated to upstream services. Structured logging and OpenTelemetry tracing provide the correlation needed to debug latency across the full request path.

**When choosing between a custom gateway and an off-the-shelf solution** (Kong, Envoy, AWS API Gateway), consider whether your aggregation and transformation needs are domain-specific enough to justify the maintenance cost. A common hybrid is to use Envoy or Kong for edge routing and TLS termination while keeping a thin custom BFF layer for business-specific aggregation.

### Junior -> FAANG: Consolidating the Chapter for Interview Recall

The seven takeaways in this summary map to seven potential interview sub-questions. For each, have a 30-second answer ready before expanding.

1. Routing and service discovery: "The gateway resolves a service name to a live endpoint using a registry, caches the result with a short TTL, and uses watch-based invalidation for fast reaction to scale events."
2. Middleware chain: "Cross-cutting concerns stack in order: tracing wraps everything, logging captures total duration, rate limiting gates by client identity, auth validates credentials before the handler runs."
3. Rate limiting: "Sliding window with Redis sorted sets, enforced by client API key or user ID, with `X-RateLimit-*` headers so clients can back off gracefully."
4. Circuit breaking: "Per-service, three-state (closed/open/half-open), fail fast when error rate exceeds threshold, recover after cooldown with jitter to prevent thundering herd."
5. Transformation: "Small stateless changes at the gateway: header injection, path rewriting, field stripping. Heavy schema translations go in a BFF or adapter service."
6. Aggregation: "Parallel fan-out under a shared deadline, required vs optional classification, partial response with `_errors` field for degraded optional calls."
7. Observability: "Request ID propagated to all upstreams, structured log per request, OpenTelemetry span wrapping the full gateway processing time."

### Senior @ FAANG: Chapter Synthesis as a Design Framework

A senior or staff engineer reading this chapter extracts a decision framework, not a list of techniques. The framework answers: given a new gateway requirement, which layer owns it, how does it interact with existing layers, and what is the failure mode?

**The layer assignment rule:**
- CDN/WAF layer: DDoS protection, IP blocking, coarse rate limiting, TLS termination at the edge.
- Gateway layer: fine-grained rate limiting, JWT validation (local), request routing, response aggregation, header transformation, circuit breaking.
- Service mesh sidecar layer: east-west mTLS, retries with backoff, service-to-service rate limiting.
- Service layer: fine-grained authZ (permission check on specific resource), business validation, domain logic.

Anything that does not fit cleanly in one layer needs an ADR. The ADR forces the team to articulate why the layer boundary is being crossed and what the maintenance and failure implications are.

**The interaction rule:** Each layer must be independently deployable and independently observable. Rate limiting config changes at the gateway should not require a service deployment. Circuit breaker threshold changes should not require a gateway restart (use a config store with watch-based hot reload). Observability pipelines (tracing, logging, metrics) should be consistent across all layers so a single request can be traced end-to-end with one query.

**The failure mode rule:** For every component added to the gateway hot path, document: what happens if it is slow, what happens if it is unavailable, and what happens if it returns incorrect data. If none of these failure modes have an acceptable graceful degradation path, the component does not belong on the hot path. Move it out-of-band (async enrichment), add a cache, or accept the dependency and invest in high availability for that component.

This framework is what FAANG L6/L7 system design looks like: not "I know how to code a circuit breaker" but "I have a principled way to decide what belongs in the gateway, how it interacts with adjacent systems, and how it fails gracefully."

---
