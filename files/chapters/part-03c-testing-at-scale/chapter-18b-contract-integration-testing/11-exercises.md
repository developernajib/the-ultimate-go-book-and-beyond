## Exercises

Each exercise builds a complete testing artifact that you can reuse in production projects. They progress from setting up a Pact pipeline to building test data infrastructure and Kafka consumer verification.

1. **Full Pact Pipeline**: Set up a Pact consumer-provider pair between two services in a monorepo. Configure a local Pact Broker (run it in Docker). Write consumer tests for 5 API operations, run provider verification, and add a GitHub Actions workflow that blocks PR merges if provider verification fails.

2. **Database Migration Tests**: Write integration tests that apply each migration from an empty database and verify the schema is correct at each step. Include a test that verifies all migrations are idempotent (applying twice produces the same result).

3. **OpenAPI Conformance Suite**: Generate an OpenAPI spec from your API code (using `swaggo/swag`). Write a test suite that makes a request to every operation defined in the spec and validates both the request and response conform to the spec. Run this in CI to catch spec drift.

4. **Test Data Seeder**: Build a test data seeder system (like Laravel factories) that can create realistic test datasets. Implement at least: `UserFactory`, `OrderFactory`, `ProductFactory`. Add a `WithOrders(n int)` option to `UserFactory` that creates a user with N associated orders. Verify the seeder produces valid FK relationships.

5. **Kafka Consumer Integration Test**: Using testcontainers, write a full integration test for a Kafka consumer that: (1) publishes 100 messages, (2) runs the consumer, (3) verifies all messages were processed, (4) tests that a redelivered message is handled idempotently. Note that a redelivery is not the same offset arriving twice: it is the same logical event, carrying the same event ID, arriving at a new offset after a rebalance or a failed commit. Your consumer must dedupe on the event ID, not the offset.

### Junior → FAANG: ramped exercises

6. **Write your first consumer Pact test**: Pick one HTTP client in your codebase. Write a single Pact consumer test with matchers calibrated per section 1.4. Run it. Commit the pact file to a temporary branch.

7. **Verify it as the provider**: On the provider side, write a verifier test that loads the pact from step 6. Run it, confirm it passes. Break a field name on the provider, watch verification fail. Fix it, confirm it passes again.

8. **Spin up a real Postgres with testcontainers**: Write a test that starts a Postgres container, applies your migrations, inserts a row, queries it back, and asserts correctness. Measure how long the test takes. Optimize by sharing the container across tests via `TestMain`.

9. **Write one fault-injection integration test**: Pick a downstream HTTP call in your service. Use the virtual-service pattern from section 3.2 to configure the downstream to delay by 5 seconds. Assert that your service times out or degrades correctly within its configured window.

### Senior @ FAANG: staff-level exercises

10. **Write the contract-testing rollout plan for your team**: Follow the template in the staff-track answer at the end of the interview section. Include phases, success metrics, blockers, and escalation paths. Share with your tech lead and collect feedback.

11. **Audit your team's test suite against the pyramid**: For each of the last 10 production incidents, identify which test layer should have caught the bug. Document the gaps. Present findings to your team and propose the most valuable investment.

12. **Build the deploy-gate integration for `can-i-deploy`**: Following section 5.5, write the shared script, wire it into the deploy pipeline, and document the fallback behavior for broker outages. Validate with a dry-run against a real contract.

13. **Mentor a junior through exercise 6**: Sit with a junior engineer while they write their first Pact test. Ask "what would break this test?" at each matcher decision. The coaching practice is the staff-level artifact.

---
