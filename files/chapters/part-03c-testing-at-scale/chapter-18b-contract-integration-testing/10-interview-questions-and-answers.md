## Interview Questions and Answers

Contract testing and integration testing strategies come up frequently in senior-level system design interviews, particularly when discussing microservice architectures, deployment safety, and testing distributed systems at scale. The questions below reflect what FAANG interviewers expect candidates to reason about.

**Q: What is consumer-driven contract testing and why is it better than provider-driven?**

A: In provider-driven testing, the provider defines what they expose and consumers must adapt. In consumer-driven contract testing (CDCT), each consumer defines what it *actually uses* from the provider. The provider must then verify it can satisfy all consumer expectations. CDCT is better because: (1) consumers only specify what they need, so providers can change anything unused without breaking consumers. (2) if a provider change would break a consumer, it is caught in CI before deployment. (3) the broker creates a dependency graph showing which consumer versions are compatible with which provider versions, enabling safe independent deployments.

**What FAANG expects:** Acknowledge that CDCT is not a free lunch. It shifts the cost of integration to the consumer (who must write good contracts) and requires organizational buy-in. Interviewers want to hear you contrast it with OpenAPI/schema-first flows (Spring Cloud Contract, bi-directional contract testing) and explain when each fits.

Follow-ups:
- When would provider-driven or schema-first (OpenAPI) make more sense than CDCT?
- How do you handle a breaking change a consumer genuinely needs (e.g., a new required field)?
- Who owns the contract file once it is published to the broker, the consumer team or the provider team?

**Q: Why use testcontainers instead of mocking the database?**

A: Mocking a database means you are testing against an imagined API, not the real one. Real databases behave differently from mocks in ways that matter: constraint enforcement (unique, FK, check), transaction isolation levels, query planner behavior, index usage, specific error types and codes, JSON/array operators, full-text search, etc. Testcontainers spins up a real database in Docker that your tests interact with identically to production. The tradeoff is slower test startup (roughly 5 to 10 seconds per container), but this is acceptable for integration tests. The alternative, discovering production-only bugs, is far more expensive.

**What FAANG expects:** Testcontainers is correct for integration tests, not unit tests. Interviewers want you to place it correctly on the pyramid and know the performance tradeoffs: one shared container per package with transaction-based isolation, reusable containers via `TESTCONTAINERS_RYUK_DISABLED`, or Ryuk-managed cleanup.

Follow-ups:
- How do you keep a test suite using testcontainers under 2 minutes when you have hundreds of tests?
- What changes when you run tests in CI on ephemeral runners vs. local dev?
- How would you test a schema migration end-to-end with testcontainers?

**Q: How do you achieve test isolation with a shared database?**

A: Three strategies, in order of preference: (1) **Transaction rollback**: run each test in a transaction and roll back at the end. Fastest, no cleanup code. Works when the code under test uses a passed `*sql.Tx`. (2) **Truncate per test**: clear all tables before each test using `TRUNCATE ... RESTART IDENTITY CASCADE`. Slightly slower but works when you cannot pass a transaction. (3) **Separate schema per test**: create a new Postgres schema (`CREATE SCHEMA test_123`) per test, drop it at the end. Full isolation but expensive. Use testcontainers with a single shared instance and strategy (1) for most cases.

**What FAANG expects:** You know the limits of transaction-based isolation. It breaks for code that opens its own connections, uses `LISTEN/NOTIFY`, or depends on committed visibility (triggers, materialized views, replication). Interviewers want to hear how you handle parallelism (`t.Parallel()`) on a shared DB without data races.

Follow-ups:
- Transaction rollback breaks for code that opens its own connection. How do you handle that?
- How do you run tests in parallel against a single Postgres container?
- Why not just use SQLite in-memory for tests?

**Q: When would you use service virtualization over a real service or a simple mock?**

A: Mocks are in-process and too simple. They do not test HTTP serialization, headers, or network timing. A real service requires running the dependency, which may not be possible (rate-limited API, cost, unavailability). Service virtualization sits between them: it is an actual HTTP server with canned responses that records calls. Use it when: (1) the external service has rate limits or costs money (payment gateways, SMS APIs). (2) testing specific error conditions (503, timeout, malformed JSON) that are hard to trigger in real services. (3) performance testing where the real service would be a bottleneck.

**What FAANG expects:** You can name tools (WireMock, mountebank, Hoverfly, MockServer) and explain when each fits. Interviewers also want to hear that virtualization is not a substitute for contract testing. A stub returns whatever you told it to return, so you still need Pact or an equivalent to confirm the stub matches the real provider's behavior.

Follow-ups:
- How do you keep a virtualized stub in sync with the real provider?
- Would you virtualize an internal service you own? Why or why not?
- How do you simulate network partitions and retries in a virtual service?

**Q: How do you test asynchronous message contracts between a Kafka producer and consumer?**

A: Two layers. The schema layer (Avro, Protobuf, or JSON Schema in a registry) enforces wire-format compatibility. The behavioral layer (Pact message pacts or an AsyncAPI equivalent) verifies semantic expectations: what fields mean, which are required for a given event type, and what state transitions the consumer expects. Keep the direction straight, because it is the same as for HTTP and it is easy to state backwards. The **consumer** writes the message-pact test, declaring the message shape its handler can process, and publishes that contract. The **producer** then verifies by feeding its real serializer's output through the contract. No broker is involved in either test, which is the point: the contract is checked without a running Kafka. Integration tests against a real Kafka via testcontainers cover routing, partitioning, and consumer-group behavior that schemas alone cannot express.

**What FAANG expects:** You distinguish between schema compatibility (handled by the registry) and contract compatibility (handled by Pact or equivalent). You know Confluent Schema Registry compatibility modes (BACKWARD, FORWARD, FULL) and how they interact with rolling deployments.

Follow-ups:
- What compatibility mode would you pick for a high-throughput event topic and why?
- How do you handle a schema evolution that is incompatible (e.g., removing a field consumers rely on)?
- How does `can-i-deploy` apply to async consumers?

**Q: What is the deployment gating flow with a Pact Broker?**

A: On every build: the consumer runs contract tests and publishes the pact to the broker tagged with the Git SHA and branch. The provider fetches relevant pacts from the broker, runs verification, and publishes results. Before deploying either side, the pipeline calls `pact-broker can-i-deploy --pacticipant X --version SHA --to-environment production`. This returns non-zero if any consumer-provider pair is incompatible or unverified. Deployment is blocked until verification passes. On successful deploy, the pipeline calls `record-deployment` so future `can-i-deploy` queries know what is live in each environment.

**What FAANG expects:** You understand why `can-i-deploy` beats matrix verification at scale, and you can discuss WIP pacts (work-in-progress contracts that surface breaking changes at PR time) and pending pacts (let new consumer expectations land without failing provider builds immediately).

Follow-ups:
- How do you handle a consumer that publishes a contract for a feature not yet implemented on the provider?
- What is the difference between a WIP pact and a pending pact?
- How would you stage rolling out a breaking provider change across 10 consumer teams?

---

**Q (Junior-track onramp): You have never used Pact. Where do you start?**

A: I would pick a small consumer-provider pair in my team's codebase. Write one consumer Pact test following the canonical template from section 1.1, keeping matchers calibrated (field names and types exact, values loose). Run locally, confirm the pact file is generated. Then on the provider side, write a verifier test that loads the pact from the local filesystem and runs it against the real provider. Run both, confirm they pass. Deliberately break the provider (rename a field) and watch verification fail. That six-step exercise is the smallest meaningful Pact adoption and teaches the mental model. I would also ask a senior colleague to review the test so I can catch matcher calibration mistakes before they become habit.

Follow-ups:
- "How would you introduce Pact to a team that has never used it?" (Start with one consumer-provider pair, show the failure mode it catches, scale gradually.)
- "What if the provider team does not want to run verification?" (Start with consumer-side tests only, which still catch bugs in the consumer's HTTP client. Provider participation is a separate adoption decision.)

---

**Q (Staff-track): Your organization has 80 microservices, mostly pairwise REST APIs, and no contract testing. You are the staff engineer asked to introduce it. Write the rollout plan.**

A: I would split it into three phases over two quarters. Phase one, month one: pick a single high-value consumer-provider pair (a pair with recent integration-bug history and willing teams). Set up a Pact broker, hosted PactFlow for speed. Get those two teams to the point of passing contract verification in CI and `can-i-deploy` gating in staging. Document the patterns. Phase two, months two and three: roll out to five more pairs across different teams. Gather learnings, refine the documentation, build shared tooling for publishing and verification. Phase three, months four through six: open adoption to any team that wants it, with the platform team providing office hours and onboarding support. Do not mandate adoption across 80 services at once. The organizational capacity to adopt is finite, and a mandate without enabling tooling produces compliance theatre rather than real value. Success metric: fraction of consumer-provider pairs with passing contract verification, tracked monthly. If the fraction grows steadily past 50 percent within six months, the rollout is working. If it stalls, investigate the blocker before pushing harder.

Follow-ups:
- "What would you measure to know it is working?" (Integration bugs caught in CI vs production, deployment gate failure rate, team sentiment.)
- "When would you stop pushing for broader adoption?" (When the remaining pairs have legitimate reasons not to adopt: deprecated services, internal-only pairs with strong OpenAPI coverage, cases where the cost exceeds the benefit.)
- "How do you handle consumer teams that refuse to participate?" (Do not mandate. Focus on willing teams until the benefit is obvious. Mandate follows social proof, not the other way around.)

