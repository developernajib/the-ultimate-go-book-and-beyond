## Exercises

1. **Add Versioning**: Implement API versioning within a BFF for backward compatibility. Support both URL-based versioning (`/v1/home`, `/v2/home`) and header-based versioning (`Accept-Version: v2`). Write a middleware that routes requests to the correct handler version and returns a deprecation warning header for older versions.

2. **Implement SSE**: Add Server-Sent Events to the Web BFF for real-time updates. When a product's stock level changes in the inventory service, push an update to all connected web clients viewing that product. Handle client disconnection and reconnection with `Last-Event-ID`.

3. **Add Circuit Breaker Dashboard**: Create an admin endpoint that displays the current state (open, half-open, closed) of every circuit breaker in the BFF, along with success/failure counts and the timestamp of the last state transition. See Section 57.17, Exercise 2 for a complete solution.

4. **Implement Request Batching**: Build a batch endpoint (`POST /api/batch`) that accepts an array of API requests and executes them in parallel within the BFF, returning an array of responses. This reduces round trips for mobile clients that need data from multiple BFF endpoints on app launch.

5. **Add A/B Testing Support**: Implement a feature flag system that selects different response transformations based on the user's experiment assignment. For example, one variant returns product cards with review counts while another returns them with "X people bought this" social proof text.

6. **Metrics Dashboard**: Instrument the BFF with Prometheus metrics tracking request latency per upstream service, cache hit rates, circuit breaker state transitions, and response payload sizes. Create a Grafana dashboard that visualizes these metrics and set up alerts for p99 latency spikes above 500ms.

### Junior -> FAANG: Getting the Most from These Exercises

Exercise 1 (versioning) and Exercise 3 (circuit breaker dashboard) are the highest priority for interview preparation. Versioning comes up in almost every system design interview that involves a public or semi-public API. Circuit breaker dashboards signal operational maturity.

For Exercise 1, implement both URL versioning and header versioning, then write a test that verifies a request with `Accept-Version: v1` gets the v1 response shape and a request with `Accept-Version: v2` gets the v2 shape. This test is what proves the versioning actually works, not just that the routing middleware exists.

For Exercise 3, focus on the data model before the UI. Define what information the dashboard exposes (circuit name, state, failure count, last state change timestamp) and write the `CircuitBreakerRegistry.GetStatus()` method with full test coverage before adding any HTTP handler. The handler is straightforward once the data model is solid.

Exercise 4 (request batching) is the most directly useful for mobile BFFs and appears in mobile platform interviews. Build it with a strict maximum batch size (reject requests with more than 20 sub-requests), a timeout on the entire batch, and partial results if individual sub-requests fail.

For all exercises, write tests before implementation and verify that the tests fail for the right reasons before writing the implementation.

### Senior @ FAANG: Exercise Extensions for Principal-Level Thinking

Each exercise has a principal-level extension that goes beyond the stated requirement.

Exercise 1 (versioning) extension: implement semantic version negotiation where the BFF supports `v1`, `v2`, and `v3` response shapes, and add a deprecation sunset date header (`Sunset: Sat, 31 Dec 2025 23:59:59 GMT`) to v1 responses. Then write an alert that fires when v1 traffic exceeds a threshold after the sunset date, and a runbook that describes how to force-migrate clients still using v1.

Exercise 2 (SSE) extension: handle the case where the inventory service is producing events faster than clients can consume them. Implement back-pressure by dropping events when the client's send buffer is full, logging dropped events with the client ID, and sending a synthetic "too many updates" event that tells the client to do a full page refresh instead of processing incremental updates.

Exercise 5 (A/B testing) extension: design the experiment assignment to be sticky across sessions (the same user always gets the same variant for a given experiment), deterministic (given the same user ID and experiment ID, you always get the same variant assignment without calling the experiment service on every request), and auditable (every response that includes experiment-influenced data includes the experiment ID and variant in a response header). This is the standard implemented by Google Optimize, LaunchDarkly, and Statsig for high-traffic experiments.

Exercise 6 (metrics) extension: define SLO alerting rules, not just metric collection. Write AlertManager rules that fire when: p99 latency exceeds 500ms for more than two consecutive minutes, upstream service error rate exceeds 1% for any individual service, or a circuit breaker transitions to open state for any service, or cache hit rate drops below 60% for the featured products cache (indicating a caching infrastructure issue). Document the runbook action for each alert.

---
