# Appendix E: Common Go Patterns

**Idiomatic Design Patterns, Concurrency Blueprints, and Production Systems Architecture**

---

### Overview: Patterns Over Frameworks

Go intentionally rejects heavy, reflective object-oriented enterprise frameworks like Spring or Django. Instead, idiomatic Go applications achieve structure, extensibility, and maintainability through simple, composable design patterns and clear concurrency primitives.

This appendix catalogues the most important production-tested patterns used by senior Go engineers to build scalable, resilient, and maintainable software systems.

### What You'll Learn in This Appendix

- **1. Functional Options Pattern**: Elegant, backward-compatible API configuration without nil pointers, telescoping constructors, or mutable config structs.
- **2. Worker Pool and Fan-Out / Fan-In**: Managing bounded concurrent workloads, processing high-volume message queues, multiplexing channel streams, and avoiding unbounded goroutine memory explosions.
- **3. Circuit Breaker and Rate Limiter**: Protecting downstream dependencies with state-machine circuit breakers (Closed, Open, Half-Open) and shaping inbound traffic with token-bucket rate limiting.
- **4. Error Wrapping and Sentinel Errors**: Designing robust error architectures using fmt.Errorf("%w"), defining sentinel errors with errors.Is, inspecting custom error structures with errors.As, and multi-error aggregation via errors.Join.
- **5. Graceful Shutdown Pattern**: Intercepting OS termination signals (SIGINT, SIGTERM), halting inbound HTTP/gRPC traffic, draining active transactions, releasing database pools, and exiting cleanly within a hard deadline.
- **6. Table-Driven Tests and Mocking**: Authoring clean, maintainable, data-driven unit and integration tests, testing error branches systematically, and implementing lightweight interface mocks without heavy reflection frameworks.
- **7. Company Pattern Implementations**: Real-world architectures from Uber, Netflix, and HashiCorp illustrating how these patterns are deployed at scale.
- **8. Summary & Architectural Decision Guide**: Quick reference selection matrix mapping system design requirements to their optimal Go design patterns.

---
