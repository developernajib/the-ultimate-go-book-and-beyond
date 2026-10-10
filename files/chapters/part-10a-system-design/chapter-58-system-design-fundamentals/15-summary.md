## Summary

- **Systematic approach**: Treat system design interviews as a structured conversation - clarify requirements, estimate capacity, design high-level, then drill into components in a logical sequence.
- **Capacity estimation as a tool**: Back-of-the-envelope calculations for QPS, storage, and bandwidth ground your design decisions and demonstrate engineering judgment.
- **CAP theorem implications**: In the presence of a network partition, you must choose between consistency and availability - understanding this shapes every distributed architecture decision.
- **Consistency models**: Strong consistency guarantees the latest data on every read. Eventual consistency prioritizes availability. Causal consistency preserves cause-and-effect ordering between related operations.
- **Horizontal vs vertical scaling**: Vertical scaling (bigger machines) hits a ceiling and creates a SPOF, whereas horizontal scaling (more machines) enables linear growth but demands stateless services and distributed coordination.
- **SQL vs NoSQL selection criteria**: Choose SQL for relational data, ACID transactions, and complex queries. Choose NoSQL for massive write throughput, flexible schemas, or specific access patterns (key-value, document, time-series).
- **Caching layers**: Apply caching at every appropriate tier - in-process (local), distributed (Redis/Memcached), and HTTP (CDN) - and define explicit invalidation strategies to prevent stale data.
- **CDN usage**: Offload static assets and geographically distribute content to reduce origin load and lower latency for end users across regions.
- **Load balancing strategies**: Round-robin suits homogeneous backends. Least-connections handles variable request cost. Consistent hashing minimizes cache misses when nodes change in distributed caches.

### Junior → FAANG: Turning Summary Points into Interview Answers

Each bullet in this summary is a topic that interviewers probe. The summary alone is not enough preparation: you need to be able to expand each point into a two-minute verbal explanation with a concrete example.

Practice converting each bullet to an answer using this structure: state the principle, give a concrete system design scenario where it applies, name the consequence of violating it, and name the Go-specific implementation. For example, for "prefer stateless services": "A stateful service stores session data in process memory, which means a load balancer must use sticky sessions to route every request from a given user to the same instance. When that instance goes down, the session is lost. In Go, the fix is to inject a `SessionStore` interface backed by Redis, so any instance can serve any request. The key marker in code reviews is a map field on a service struct with user or session data as values. That is the smell that tells you state is not being externalized."

Running through each summary bullet this way, until you can speak to each one fluently without reading from notes, is the most effective interview preparation for system design fundamentals.

### Senior @ FAANG: Summary as an Organizational Health Check

At the staff level, these summary points are criteria for evaluating the architectural health of a domain, not just one's own knowledge.

**Systematic approach as an organizational practice.** "Treat system design as a structured conversation" is a personal interview skill. At L7, it becomes an organizational expectation: every significant design decision in your domain goes through a structured review that includes requirements clarification, capacity estimation, component selection with documented trade-offs, and failure mode analysis. The outcome of this review is a written ADR, not a verbal agreement. Without this structure, architectural decisions are made implicitly, reversed without documentation, and repeated by different teams without the benefit of prior learning.

**Capacity estimation as a continuous practice.** Back-of-envelope math in interviews is a point-in-time exercise. At the staff level, capacity estimation is a quarterly practice. You compare actual traffic and growth rates against the estimates made at design time, identify components that are closer to their limits than expected, and initiate capacity planning work before they become incidents. This requires maintaining a capacity model (a spreadsheet or dashboard that tracks key metrics against their theoretical limits) and reviewing it regularly with the engineering team and their management chain.

**SLO ownership and the summary bullet on availability.** "Redundancy at every layer, graceful degradation, and circuit breakers" are engineering techniques. The staff-level framing is: these techniques exist to meet an availability SLO, and the SLO is negotiated with the product and business teams based on the cost of downtime. A service with a 99.9% SLO is down for 8.7 hours per year. A service with a 99.99% SLO is down for 52 minutes per year. The cost of implementing and operating the infrastructure to achieve the higher SLO is measured in engineering headcount and operational complexity. At L6 and above, you participate in the negotiation that sets the SLO, not just the engineering that meets it.
