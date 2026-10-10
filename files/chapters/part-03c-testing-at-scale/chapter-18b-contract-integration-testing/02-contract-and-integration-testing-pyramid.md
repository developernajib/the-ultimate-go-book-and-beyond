## Contract and Integration Testing Pyramid

The testing pyramid for distributed systems extends unit and integration testing with contract tests that verify service boundaries without requiring every dependent service to be running simultaneously. Contract tests sit between unit tests (fast, no dependencies) and end-to-end tests (slow, full stack), providing confidence that service interfaces remain compatible as they evolve independently. Knowing where each test type belongs in the pyramid, and what it is and isn't responsible for verifying, prevents the common mistake of trying to use contract tests as end-to-end tests or integration tests as contract tests. The diagram below shows how contract tests fit between unit and integration layers, along with the consumer-driven contract flow that coordinates consumer expectations with provider verification.

```
                     ┌─────────────────┐
                     │   E2E Tests     │   Slow, expensive, rare
                     │   (few)         │   Full system
                     └────────┬────────┘
                  ┌───────────┴──────────┐
                  │   Integration Tests  │   Medium speed
                  │   (service + DB)     │   Real dependencies
                  └──────────┬───────────┘
               ┌─────────────┴─────────────┐
               │    Contract Tests         │   Fast, isolated
               │    (API boundaries)       │   Pact / OpenAPI
               └─────────────┬─────────────┘
        ┌──────────────────────┴──────────────────────┐
        │                  Unit Tests                 │   Very fast
        │              (pure functions)               │   Mocks OK
        └─────────────────────────────────────────────┘

Consumer-Driven Contract Flow:
┌──────────────┐    Pact file     ┌──────────────────┐
│   Consumer   │ ──────────────► │   Pact Broker     │
│  (Order Svc) │                  │  (shared store)  │
└──────────────┘                  └────────┬─────────┘
                                           │ verify
                                  ┌────────▼─────────┐
                                  │    Provider      │
                                  │  (Payment Svc)   │
                                  └──────────────────┘
```

### What each layer catches (and does not)

Each layer of the pyramid has a specific class of defect it is designed to surface. **Unit tests** catch logic bugs inside pure functions: off-by-one, wrong sign, missing null check. They do not catch anything that crosses a process or network boundary. **Contract tests** catch interface-shape bugs: a field renamed from `userId` to `user_id`, a required field that became optional, a status code that changed from 200 to 204. They do not catch behavioral bugs in the provider's implementation or bugs in data flow through the consumer's own code. **Integration tests** catch cross-boundary behavior: SQL query correctness against a real schema, transaction rollback under contention, broker ordering guarantees, HTTP middleware interaction with handlers. They do not catch end-to-end user journeys that span multiple services. **End-to-end tests** catch composite scenarios: signup-through-checkout, multi-service workflows, UI behavior. They are expensive to write, slow to run, and flaky when given the chance, which is why the pyramid is narrow at the top.

Teams that conflate layers pay a tax. If contract tests try to verify provider behavior (not just shape), they become slow and brittle. If integration tests try to verify contract compatibility, they are redundant with Pact and harder to maintain. If end-to-end tests are used to catch bugs that unit or integration tests should catch, the feedback loop is far slower than it needs to be. Keeping each layer focused on its class of defect is the discipline that keeps the whole suite healthy.

### Junior → FAANG: the "which layer catches this bug?" drill

For every bug you encounter (in your code or a colleague's), ask yourself which layer of the pyramid should have caught it. A signup race condition between read and write? Integration test with a real database. A field rename on a downstream API? Contract test. A UI redirect loop? End-to-end test. An off-by-one in a tax calculation? Unit test. Practising this classification builds the instinct for where to invest testing effort. Engineers who can answer this question reliably write testing strategies that scale. Engineers who cannot tend to pile everything into end-to-end tests and wonder why CI takes 45 minutes.

### Senior @ FAANG: the testing investment portfolio

At staff level, the testing pyramid is a portfolio allocation question. You have finite engineering time and CI budget. How much goes into each layer, and how do you know whether the allocation is right. The signal is incident post-mortems: for each production incident in the last quarter, which test layer should have caught it. If the answer is consistently "unit tests would have caught it," the team under-invests at the base. If the answer is consistently "end-to-end would have caught it," the suite is missing integration coverage. If the answer is consistently "contract test would have caught it," the team has not adopted contracts, and the adoption case is obvious. Staff engineers run this analysis quarterly and adjust the team's testing investment based on where incidents actually come from. This is the kind of evidence-driven decision-making that separates staff from senior.

---
