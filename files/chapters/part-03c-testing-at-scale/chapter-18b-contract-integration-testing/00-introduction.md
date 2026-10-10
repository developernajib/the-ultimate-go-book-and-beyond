# Chapter 18B: Contract and Integration Testing at Scale

*"An API without a contract is a promise waiting to be broken."* - Anonymous

In distributed systems, services communicate constantly, but how do you ensure that a change in one service does not silently break every downstream consumer? Unit tests guard individual components, and end-to-end tests cover happy paths, but neither answers the critical question at the seam between services: "Are our contracts still honored?" Contract and integration testing fills precisely this gap, giving engineering teams confidence that independently deployable services remain compatible over time.

Consumer-driven contract testing inverts the traditional provider-first mindset. Instead of the provider team writing an API specification and hoping consumers follow it, each consumer codifies its expectations as a contract, a machine-readable artifact that the provider must satisfy before any deployment. Tools like Pact operationalise this workflow, publishing contracts to a Pact Broker, running provider verification in CI, and making the "can I deploy?" question answerable with a single CLI command. Pact itself grew out of this need at REA Group, and the pattern has since spread across organizations that run large microservice estates and want to catch integration failures that would otherwise appear only in staging or production.

Integration testing, meanwhile, demands real infrastructure: real databases, real message brokers, real HTTP servers. The era of mocking everything is fading because mocks drift from reality in exactly the ways that cause production incidents. `testcontainers-go` solves this elegantly: it spins up Docker containers as part of your Go test suite, giving each test run a pristine, isolated instance of PostgreSQL, Redis, Kafka, or any other dependency. When combined with service virtualization for third-party APIs that cannot be containerised, teams achieve the full fidelity of production behavior with the repeatability of a unit test. The result is an integration layer that catches real bugs, such as schema mismatches, serialization edge cases, and transaction boundary errors, long before they reach users.

**What you'll learn in this chapter:**

- Design and implement consumer-driven contract tests using Pact with Go's `pact-go` library
- Publish and verify contracts through a Pact Broker in a CI/CD pipeline
- Spin up real database and broker containers using `testcontainers-go` for true integration coverage
- Write database integration tests that exercise migrations, transactions, and error paths
- Implement service virtualization with WireMock and Go HTTP stubs for external APIs
- Manage test data lifecycle: seeding, isolation, and teardown strategies at scale
- Evolve API contracts safely using backward-compatibility rules and consumer version selectors
- Integrate contract and integration test gates into GitHub Actions and Kubernetes-based pipelines

**Why this matters at scale:**

Organizations running thousands of microservices rely on contract testing to let each team deploy independently without breaking others, and to validate that clients can always talk to the APIs they depend on. Thoughtworks has long featured consumer-driven contracts on its Technology Radar as a proven practice for eliminating a whole category of integration bugs: the kind that slip past unit tests and only surface in expensive, slow end-to-end suites. At scale, the cost of a broken contract discovered in production is measured in incidents, rollbacks, and on-call pages. The same break caught by a contract verification in CI costs one red build.

**Prerequisites:** Familiarity with Go's `testing` package and `net/http`, basic understanding of REST APIs and microservice communication patterns, Docker installed locally for `testcontainers-go` examples.

## Two readers, one chapter

**Junior engineer on the FAANG track.** Contract testing feels like an abstraction layer with many moving parts (consumer, provider, broker, verifier, matcher), and the mechanics obscure the underlying idea. The idea is simple: the consumer writes down what it expects from the provider, the provider proves it meets the expectation, and both sides deploy independently with confidence. Once that mental model clicks, the tooling stops being intimidating. Integration testing with `testcontainers-go` has a similar shape: instead of mocking the database and hoping the mock matches reality, run a real one in Docker for the duration of the test. The first time you watch a Pact verification fail because you renamed a field, or a test fail because a migration would have silently corrupted data in production, is the moment these techniques stop being theoretical. FAANG infrastructure interviews for senior engineers frequently ask "how do you test service interactions at scale?" and having one real Pact-and-testcontainers story beats reading any amount of theory.

**Senior engineer at FAANG.** The mechanics are familiar. The staff-level question is governance: when does a team adopt Pact, and when is the operational tax not worth it. How do you roll contract testing across a mesh of 200 services without creating a bottleneck in the broker. How do you evolve contracts across versioned APIs without breaking deploys. How do you teach a team to distinguish contract tests from integration tests from end-to-end tests, and to maintain the pyramid shape that keeps the suite fast. This chapter closes each section with framing for platform adoption, roadmap trade-offs, and cross-team contracts. Treat the code examples as reference and spend your attention on the policy and rollout questions. The tooling works. The organizational pattern is where teams succeed or fail.

A final calibration: contract tests are not a substitute for integration tests, and integration tests are not a substitute for end-to-end tests. Each layer catches a different class of bug at a different cost. The strongest teams build all three layers intentionally with explicit coverage goals. Weaker teams either skip layers or conflate them, and the consequences show up in either missed bugs or a slow, unmaintainable suite.

---
