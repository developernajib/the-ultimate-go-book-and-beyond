## 102G.14 Guided Exercises and Solutions

### Exercise 1: Image Security Pipeline

Build a complete image security pipeline:
1. Multi-stage Dockerfile: `golang:1.27.1-alpine` builder → `gcr.io/distroless/static-debian12:nonroot` runtime
2. GitHub Actions workflow: build → Trivy scan (fail on CRITICAL/HIGH) → push to ECR → sign with Cosign
3. Go integration test: `ScanImage()` function that runs Trivy and validates against policy
4. Kubernetes admission webhook (validating): reject pods using images with known CRITICAL CVEs (query your internal scan database)

### Exercise 2: Consul Service Discovery Load Balancer

Implement a production-grade service discovery client:
1. Register service in Consul with HTTP health check
2. Implement `LoadBalancer` with round-robin and least-connections strategies
3. Watch for Consul service changes (add/remove instances) and update the load balancer
4. Circuit breaker: if 3 consecutive requests to an instance fail, remove it from rotation for 30 seconds
5. Metrics: track per-instance request count, error rate, and latency with Prometheus

### Exercise 3: Zero-Trust mTLS Service Mesh

Build a mini zero-trust setup with 3 services:
1. Deploy SPIRE (or use a local test CA) to issue short-lived certificates
2. Service A (Go HTTP server): accepts only mTLS connections, verifies SPIFFE IDs
3. Service B (authorized caller): presents its SPIFFE ID, can call Service A
4. Service C (unauthorized): gets rejected with 403 when calling Service A
5. Demonstrate certificate rotation: stop and restart Service B, verify it gets a new certificate automatically and can still call Service A

---

### Junior → FAANG: Getting Maximum Value From These Exercises

These three exercises are not independent. Do them in order. Exercise 1 builds the image security foundation. Exercise 2 builds the service discovery layer. Exercise 3 adds zero-trust communication on top. Completing all three in sequence produces a mini production-grade system that you can describe in an interview as a concrete project.

The most common mistake when doing exercise-based learning: stopping when the happy path works. Each exercise has implicit failure scenarios that are more valuable than the happy path. For Exercise 1, validate that your CI actually fails when Trivy finds a CRITICAL CVE (introduce one artificially in a test branch). For Exercise 2, kill one of the Consul-registered instances while traffic is flowing and verify that requests to the dead instance stop within the expected TTL window. For Exercise 3, expire a certificate manually and verify that the rotation happens without dropped requests.

First-job habit: for Exercise 2's circuit breaker requirement, the real implementation challenge is concurrency. The circuit breaker state (trip count, cooldown timer) is accessed by concurrent request goroutines. Without a mutex or atomic operations, you have a data race. Running `go test -race` is the validation step that catches this before it becomes a production incident.

Prerequisite gap for Exercise 3: if you have never operated SPIRE locally, start with the official SPIRE quickstart (available in the SPIRE GitHub repository) before attempting this exercise. SPIRE requires registering workload entries, configuring the agent attestor, and understanding the socket-based Workload API before you can use it from Go code.

### Senior @ FAANG: Extending the Exercises to Staff-Level Problems

The exercises as written are mid-level (L5) problems. To reach bar-raiser depth, extend each exercise with the governance and operational dimensions that staff engineers own.

Extension for Exercise 1: add a policy exception workflow. When Trivy finds a CRITICAL CVE with no fix available, the CI should not just fail. It should open a GitHub issue with a structured template that captures the justification, the risk assessment, the affected services, and an expiry date. The issue approval process (label `security-exception-approved`) gates the CI unblock. Building this workflow tests your ability to encode an organizational process in automation.

Extension for Exercise 2: replace the in-process load balancer with a pluggable interface. The interface accepts a list of service entries and returns the selected endpoint. Implement round-robin and least-connections as concrete types. Add a weighted round-robin implementation where instance weight comes from a Consul service tag (e.g., `weight:10`). Write table-driven tests for each strategy, including edge cases (empty list, single instance, all instances at equal weight). This tests interface design and testability, not just load balancing logic.

Extension for Exercise 3: implement the migration scenario. Start with Services B and C connecting to Service A without mTLS (plaintext). Add a flag to Service A that switches between plaintext-accept and mTLS-require modes. Write a test that: (a) starts all services in plaintext mode, (b) sends traffic from B and C to A and verifies both succeed, (c) rotates A to mTLS-require mode, (d) sends traffic again and verifies B succeeds (has certificates) and C fails (no certificates), (e) rotates C to mTLS mode, (f) verifies C still fails (not in allowlist), (g) adds C to allowlist, (h) verifies C now succeeds. This migration sequence is exactly what a real zero-trust rollout looks like, and being able to describe and implement it is staff-level competency.
