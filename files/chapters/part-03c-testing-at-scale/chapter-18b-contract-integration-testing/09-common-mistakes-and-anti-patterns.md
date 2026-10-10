## Common Mistakes and Anti-Patterns

Integration and contract tests introduce failure modes that unit tests never encounter: container lifecycle issues, shared state leaking between tests, and port conflicts in CI. The table below catalogs the most frequent mistakes teams make when adopting these testing patterns, along with their symptoms and fixes.

| Mistake | Problem | Fix |
|---------|---------|-----|
| Mocking database in integration tests | Tests pass but prod migrations break | Use real DB via testcontainers |
| Shared test data between tests | Flaky tests, order-dependent failures | Use transaction rollback isolation |
| No contract tests between services | Breaking API changes slip to production | Add Pact consumer tests to CI |
| Hard-coded test ports | Tests fail on port conflict | Use `:0` for random ports |
| Not cleaning up containers | Zombie containers, CI disk exhaustion | Use `t.Cleanup()` for container teardown |
| Huge test fixtures | Tests are slow and brittle | Use builder pattern for minimal data |
| Testing implementation not behavior | Tests break on refactor | Test via public API, not internals |
| Missing `testing.Short()` guard | Integration tests run in unit test suite | Guard with `if testing.Short() { t.Skip() }` |
| State leaking between pact interactions | Flaky provider verification | Implement state handlers that set up/tear down per interaction |
| OpenAPI spec out of sync | Contract tests pass but spec is stale | Generate spec from code or test spec compliance |
| Contract matchers too strict (exact values) | Noisy verification failures on every deploy | Use `matchers.Like` for typical values, `matchers.Term` for enums/regexes |
| Contract matchers too loose (shape only) | Real field renames and type changes slip through | Match field names and types exactly |
| Running a Kafka broker per test | Test suite takes 20 minutes | One broker per package via `TestMain`, unique topic per test |
| Transaction isolation for LISTEN/NOTIFY code | Tests pass, triggers silently broken in prod | Schema-per-test or commit-then-clean for notification-based features |
| `time.Sleep` to wait for async propagation | Flaky on slow CI runners | Poll with a deadline, assert on observable condition |
| Shared consumer group across tests | Rebalances cause flaky assertions | Unique group ID per test run |
| Testcontainers images pinned to `latest` | Nondeterministic CI when upstream changes | Pin exact image tag (`postgres:18-alpine`, not `postgres:latest`) |
| Helpers duplicated across packages | Inconsistent assertion messages, bug fixes not shared | Move to a shared `internal/testutil` package |
| Contract tests coupled to provider implementation | Consumer blocks on provider team for every change | Consumer defines expected shape, provider satisfies it. Consumer never reads provider source |
| Calling every test double a "mock" | Team argues past each other in review, and tests assert on calls when they meant to assert on state | Use the precise term. See the taxonomy below |

### Know which test double you are reaching for

"Mock" has become a generic word for "not the real thing," which hides a real design decision. Four distinct things, worth keeping straight:

- **Stub**: returns canned answers. It exists to feed the system under test the input a scenario needs. The `VirtualService` in section 3.2 is a stub when you only configure responses.
- **Spy**: a stub that also records how it was called, so the test can assert on those calls afterwards. `AssertCalledWith` is what turns that same virtual service into a spy.
- **Mock**: is programmed with expectations up front and fails the test itself when the calls do not match. The distinction from a spy is when and where the assertion lives, not whether one happens.
- **Fake**: a real working implementation that is simply unsuited to production, such as an in-memory repository. It has behavior, not just answers.

Why this matters beyond vocabulary: stubs and fakes let you assert on **state** (what ended up in the database), while spies and mocks push you toward asserting on **interactions** (what calls were made). Interaction assertions couple the test to the implementation, so a refactor that preserves behavior can still turn the suite red. Default to stubs and fakes with state assertions. Reach for a spy or a mock only when the call itself is the observable behavior, such as proving a payment provider is charged exactly once, which is precisely the case section 3.2's `AssertCalledWith` exists to cover.

### Junior → FAANG: the "what would break this test" self-audit

For every integration or contract test you write, ask: what change in production would break this test, and what change in production would this test allow to slip through? A test that passes on schema drift, field renames, timeout changes, or retry-logic regressions is a test that gives false confidence. A test that fails on trivial value changes (a different generated ID, a different timestamp) is a test that creates false alarms. Calibrating tests between those two extremes is the skill that separates a test suite that helps from a test suite that hurts. Practise this audit on every test you write for a month, and you will develop the instinct automatically.

### Senior @ FAANG: the test-flakiness budget

Flaky tests are the single biggest threat to a team's testing culture, and integration tests are the most common source. At staff level, establish a flakiness budget: no more than 0.5 percent of test runs may fail without a code change. Track the metric in CI, alert when it exceeds the threshold, and reserve engineering time each sprint to quarantine and fix flaky tests. Teams that manage this budget actively keep CI trustworthy and keep the testing culture healthy. Teams that let flakiness drift past 5 percent end up in a state where engineers reflexively retry failed CI rather than investigate, and real failures get missed in the noise. The platform-level artifact: a CI integration that surfaces flaky tests, a quarantine mechanism that isolates them from the critical path, and a runbook that walks engineers through investigation and fix. This is one of the most effective governance investments a staff engineer can make for a large test suite.

---
