## Exercises

1. **Build Custom Gateway**: Implement a gateway that routes requests to at least three upstream services based on URL prefix. Include JWT authentication middleware that skips validation for a configurable list of public paths. Verify that an invalid token returns 401 and a valid token forwards the request with user claims in a custom header.

2. **Add Circuit Breaker**: Implement a circuit breaker with configurable failure threshold, cooldown timeout, and half-open probe limit. Write a test that sends requests through the breaker, simulates five consecutive failures to trip it open, waits for the cooldown, and confirms it transitions to half-open before closing again on successful probes.

3. **Implement Rate Limiting**: Build a sliding-window rate limiter backed by Redis sorted sets. The limiter should return `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `Retry-After` headers. Test that a burst of requests exceeding the limit receives 429 responses while requests within the window pass through.

4. **Service Discovery**: Integrate the gateway with Consul so that adding or removing a service instance updates the route table within seconds. Use Consul's blocking query API (`WaitIndex`) rather than polling on a timer. Verify that traffic stops routing to a deregistered instance.

5. **API Aggregation**: Create a `/dashboard` endpoint that fans out to a user service, an order service, and a notification service in parallel. The user call should be required (fail the whole request if missing), while orders and notifications should degrade gracefully and include error details in an `_errors` field of the response.

6. **Request Transformation**: Build middleware that renames JSON body fields between the public API format and the internal service format (e.g., `firstName` to `first_name`). Ensure the middleware updates `Content-Length` after rewriting the body. Test with both request and response transformation.

7. **Add Caching Layer**: Implement response caching keyed by URL path and selected query parameters, with a configurable TTL per route. Cache entries should be invalidated on POST/PUT/DELETE to the same path prefix. Measure the latency difference between cached and uncached responses.

8. **Gateway Metrics**: Instrument the gateway with Prometheus counters for total requests (labeled by route, method, and status code), histograms for request duration, and gauges for circuit breaker state per service. Expose a `/metrics` endpoint and verify the metrics update correctly under load.

### Junior -> FAANG: Turning Exercises into Portfolio Evidence

Each exercise above corresponds to a demonstrable project component. Junior candidates at FAANG often lack production code samples. These exercises, when completed with tests and committed to a public GitHub repository, become the portfolio evidence that compensates.

Exercises 1 and 2 together form a complete gateway. Write a README that explains the architecture, the middleware order, and the test strategy. Recruiters and hiring managers read READMEs.

Exercise 3 (rate limiting) is the exercise most likely to be asked as a live coding question. Complete it with two implementations: in-memory (for tests, no Redis dependency) and Redis-backed (for production). Know the interface that both implement. Being able to say "I built this, here is the interface, here are the two implementations, here is how the tests use the in-memory version" is stronger than any textbook answer.

Exercise 5 (aggregation with partial failure) is the take-home assignment equivalent. Hiring managers at mid-level FAANG positions often ask for exactly this: fan-out to three services, graceful degradation when one fails, partial response with error detail. Build this exercise to production quality with error handling, logging, and tests. Then use it as a talking point in every design interview.

### Senior @ FAANG: Extending the Exercises into Staff-Track Problems

**Exercise 1 staff extension:** Design a route configuration system where application teams submit route definitions via a versioned API (or pull request to a config repo), a validation pipeline checks for conflicts (duplicate path prefixes, missing required fields, rate limit tier violations), and approved routes are applied to the gateway without restart. Include a rollback mechanism: if error rate on a new route exceeds threshold within 5 minutes of activation, the route is automatically reverted.

**Exercise 3 staff extension:** Implement three rate limiting strategies behind the `RateLimiter` interface: per-user (keyed by JWT subject), per-tenant (keyed by JWT tenant claim), and per-IP (for unauthenticated endpoints). Add a fourth mode: composite, which applies the most restrictive of per-user and per-tenant limits. Design the configuration so that a route can specify which mode applies. Write a benchmark that shows the Redis round-trip cost per request and argues for whether the cost is acceptable given the SLO.

**Exercise 4 staff extension:** Extend the Consul watch implementation to support multi-cluster routing: the gateway knows about two Consul datacenters (primary and secondary), prefers primary-datacenter instances, and falls over to secondary when primary has fewer than a configurable minimum healthy instances. Include a chaos test that terminates all primary instances and verifies the gateway routes to secondary within 5 seconds. Write the ADR that documents why multi-cluster routing belongs in the gateway rather than in a load balancer above it.

**Exercise 8 staff extension:** Define an SLO for the gateway itself (not just the upstreams): gateway overhead (total latency minus upstream latency) must be under 5ms at p99. Instrument the gateway to track this metric separately. Build a load test that runs at 10000 RPS and reports the p50, p95, and p99 gateway overhead. Identify the top contributor (middleware, routing, body reading) and propose an optimization. Document the result in an ADR that justifies whether the optimization is worth the complexity cost.

---
