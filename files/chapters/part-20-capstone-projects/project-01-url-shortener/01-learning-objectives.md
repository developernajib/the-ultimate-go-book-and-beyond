## Learning Objectives

By completing this project, you will:
1. Design and implement a URL shortening algorithm (Base62 encoding)
2. Build a production-grade REST API with proper error handling
3. Implement two-tier caching with Redis and in-memory LRU
4. Design normalized database schemas for PostgreSQL
5. Build an analytics pipeline for click tracking
6. Implement rate limiting using token bucket algorithm
7. Write thorough unit and integration tests
8. Deploy with Docker and Kubernetes
9. Monitor with Prometheus and Grafana
10. Handle edge cases: collisions, malicious URLs, high traffic

### Junior → FAANG: Turning a Learning Checklist into Interview Proof Points

Each objective above maps to a common interview question category. Base62 encoding maps to "explain your hashing strategy and how you handle collisions." Two-tier caching maps to "walk me through your cache invalidation logic." Rate limiting maps to "how do you protect your service from abuse?"

Treat the learning objectives as a readiness checklist, not just a project outline. For each objective, be able to explain why you made the choice you made, not just what you implemented. Juniors who can say "I chose token bucket over leaky bucket because I wanted to allow short bursts for legitimate users" demonstrate a level of thinking that separates them from candidates who just copied an implementation.

Before your interview, re-read your own code and verify you can explain every non-trivial function from memory. Interviewers will probe code you claim to have written.

### Senior @ FAANG: Reading Learning Objectives as an Engineering Maturity Map

At senior level, the ten objectives represent not individual skills but a maturity arc from "working code" to "operable system." The first six objectives produce a service that works. The last four produce a service that can be trusted in production.

The split matters architecturally. A senior engineer asks: which of these objectives can fail independently without taking down the whole system? If analytics pipeline failures cause redirect failures, the system has a coupling problem. If rate limiting is implemented in the application layer only, it does not survive horizontal scaling. These are the observations that distinguish L5 from L6 candidates.

At the staff level, the learning objectives become a template for evaluating other teams' work. When reviewing a design doc or a new service, a staff engineer mentally checks the same categories: is the caching strategy defined and tested, is there a clear rate limiting contract, is monitoring tied to SLAs or just to arbitrary thresholds? The URL shortener is a useful calibration exercise for developing that evaluation instinct.

---
