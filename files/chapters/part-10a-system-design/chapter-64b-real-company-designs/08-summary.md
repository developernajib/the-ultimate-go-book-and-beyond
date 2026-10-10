## Summary

Real-world architectures from leading technology companies demonstrate key scaling tradeoffs:

**Netflix**:
- Microservices with circuit breakers (Hystrix)
- Multi-zone caching (EVCache)
- Edge computing with Open Connect CDN

**Uber**:
- Geospatial indexing with S2 cells
- Real-time driver matching
- Dynamic surge pricing

**Twitter/X**:
- Hybrid fan-out (write for regular users, read for celebrities)
- Social graph management with Redis
- Timeline merging and deduplication

**Slack**:
- WebSocket-based real-time messaging
- Channel-based message routing
- Reaction and thread support

Each architecture reflects trade-offs specific to the company's scale and domain, but the underlying patterns, circuit breaking, fan-out strategies, geospatial indexing, and WebSocket-based real-time delivery, recur across all of them.

---

### Junior -> FAANG: The Four Patterns That Appear Everywhere

After studying these four company architectures, extract the four reusable patterns and practice applying them to new problems.

Circuit breaking (Netflix) appears in any system with a dependency that can be slow or unavailable. Any service call, database query, or external API call is a candidate for a circuit breaker. The pattern is always the same: track the error rate over a rolling window, open the circuit when it crosses a threshold, probe with a single request after the sleep window, close on success.

Fan-out strategy (Twitter/X) appears in any system where one event must be delivered to many recipients: notification systems, activity feeds, live dashboards, audit logs. The decision tree is always the same: if the recipient count is bounded and small, push to all recipients at write time. If the recipient count is unbounded or the write amplification is too high, compute at read time and cache the result.

Geospatial indexing (Uber) appears in any system with a proximity query: food delivery matching, fleet tracking, location-based search. The pattern is cell-based partitioning: map geographic space to discrete cells, index entities by cell, answer proximity queries by querying the target cell and its neighbors.

WebSocket hub with pub/sub backend (Slack) appears in any real-time system that must scale across multiple server instances: live collaboration, chat, live sport scores, financial tickers. The pattern is always the same: in-process hub for local connection management, message bus for cross-instance routing.

### Senior @ FAANG: Why the Summary Understates the Difficulty

Each bullet point in this summary represents years of iteration, production incidents, and incremental improvement at real scale. The summary says "circuit breakers" as if the pattern is straightforward to implement and operate. The operational reality includes: tuning the error threshold and sleep window per command, handling the thundering herd on circuit close (all requests rush through simultaneously after the sleep window), monitoring circuit state as a first-class operational metric, and managing cascading circuit opens across a dependency graph where one slow service opens circuits in all its callers.

The staff-level discipline is not knowing the patterns, it is knowing the failure modes of each pattern and the operational runbooks for each failure mode. A circuit breaker that opens incorrectly during a traffic spike (false positive due to high concurrency against a healthy service) causes a service degradation that looks like the downstream service is unhealthy when it is not. The runbook for this scenario is: check the circuit's minimum request count configuration, increase the minimum before reopening the circuit, verify the downstream service's error rate directly, and only then conclude that the circuit should remain open.

This level of operational maturity, knowing not just that circuit breakers exist but how they fail and how to recover, is what differentiates an L5 engineer who has read about these patterns from an L6 engineer who has operated them.
