## Summary

Testing at the integration and contract boundaries where bugs most commonly escape to production:

- **Consumer-driven contract testing**: Pact enables each consumer service to define expectations, and providers must verify them in CI. The Pact Broker provides can-I-deploy checks before deployments, making independent service deployments safe.

- **OpenAPI contract testing**: For services you own, validating both requests and responses against an OpenAPI spec on every test run catches spec drift and breaking changes early. `kin-openapi` provides Go-native middleware validation.

- **Testcontainers**: Eliminates the mocking problem entirely for database and message queue tests. A real Postgres instance takes ~5 seconds to start, which is acceptable for integration tests. Test isolation via transaction rollback ensures tests don't interfere.

- **Test data builders**: The builder pattern creates test scenarios with minimal boilerplate, explicit fields, and sensible defaults. `MustBuild()` variants keep test setup concise without hiding the intent.

- **Service virtualization**: A real HTTP server returning canned responses lets you test against external dependencies without their rate limits, costs, or availability concerns, and lets you inject faults (slow responses, 5xx, malformed bodies) that are hard to trigger for real. Keep the vocabulary precise: it is a stub until you assert on the calls it received, at which point it is a spy.

- **Message queue integration**: Brokers need a real broker. Testcontainers gives you Kafka or RabbitMQ per package, while unique topics and consumer groups per test keep the suite from going flaky. Assert on the decoded payload, never on message count alone, because a count-only test passes happily while the producer publishes garbage. For wire-format compatibility, a schema registry plus CI compatibility checks does the job that Pact does for HTTP.

- **Test isolation strategies**: Transaction rollback is the fastest and cleanest isolation mechanism. It requires passing a `*sql.Tx` to the repository, which is architecturally clean anyway (enables atomic multi-repository operations).

The key metric for an integration test suite: every deployment-blocking bug should be caught before reaching staging. Contract tests catch API breaking changes. Database integration tests catch query bugs. Service integration tests catch serialization and mapping bugs.

### For the junior engineer on the FAANG track

Leave this chapter with four habits. First, internalize the testing pyramid: each layer catches a different class of defect, and conflating them wastes effort. Second, reach for testcontainers over mocks when the test crosses a real boundary. The extra seconds of test time buy genuine confidence. Third, calibrate Pact matchers to field names and types, not to specific values. Fourth, when you write an HTTP client, also write the integration test that covers what happens when the downstream is slow, broken, or silent. These four habits are what interviewers at FAANG probe for when they ask "how do you test distributed systems?" Candidates who live the habits have concrete stories to tell. Those who do not fall back on textbook definitions and come apart under the first follow-up question.

### For the senior engineer at FAANG

Leave this chapter with three artifacts per service or platform. First, a written contract-testing policy that defines scope, matchers discipline, broker ownership, and deploy-gate integration. Second, an integration-test fidelity checklist that tells teams how to keep testcontainers schema, data volumes, and broker behavior aligned with production. Third, a flakiness budget tracked in CI with an escalation path for quarantine and fix. The techniques in this chapter are ingredients. The policies and artifacts are what let testing culture scale across teams and outlast the engineers who set them up. Performance engineering in the testing domain is measured by the durability of the team's practice, not by any single well-designed suite. Write the documents. Mentor the juniors. Kill the tests that no longer earn their CI minutes. The tooling will evolve. The governance outlives any specific tool.

