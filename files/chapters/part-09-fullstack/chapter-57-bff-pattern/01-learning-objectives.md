## Learning Objectives

By the end of this chapter, you will be able to:

- **Understand the BFF pattern** and distinguish it from API gateways and general backends
- **Design client-specific APIs** that optimize for web, mobile, and admin use cases
- **Implement parallel data aggregation** from multiple backend services efficiently
- **Build shared service clients** with circuit breakers, retries, and tracing
- **Create response transformers** that tailor data for specific client needs
- **Implement caching strategies** appropriate for different data freshness requirements
- **Handle partial failures gracefully** to provide degraded but functional responses
- **Test BFF services** with mocked backend services and integration tests

### Junior -> FAANG: Mapping Objectives to Interview Readiness

Each learning objective in this chapter corresponds to a question category you will encounter in system design interviews. Understanding the mapping helps you prioritize study time.

"Distinguish BFF from API gateways" maps directly to the classic question: "How would you architect a backend for a mobile app that shares services with a web app?" Interviewers expect you to name both layers and explain what belongs in each. Saying "I would use an API gateway" and stopping there is an incomplete answer. You need to describe the client-specific aggregation layer behind it.

"Implement parallel data aggregation" maps to the follow-up question: "How do you make the homepage load in under 200ms when it requires data from five services?" The answer is concurrent fan-out with `errgroup` or goroutines plus `sync.WaitGroup`, partial failure tolerance, and caching. Be ready to write this in Go during a live coding round.

"Handle partial failures gracefully" is the most commonly underestimated objective. First-year engineers default to returning an error when any upstream call fails. FAANG interviewers watch for whether you default to partial data plus degradation signals versus hard 500 errors.

### Senior @ FAANG: Translating Objectives into Engineering Standards

At senior level these objectives become engineering standards, not personal learning targets. You are responsible for ensuring that your team implements them correctly, consistently, and in a way that can be audited.

"Design client-specific API contracts" at senior level means establishing a contract review process. Before a new BFF endpoint ships, the response shape is reviewed by the frontend team, the platform team, and security. Breaking changes require a deprecation window and migration path. This is not optional at FAANG. The teams are too large for "just update the clients" to be a workable strategy.

"Build shared service clients with circuit breakers, retries, and tracing" at senior level means defining the standard library that all BFF teams import, enforcing it through inner-source contribution guidelines, and making non-compliance visible in code review. A BFF that rolls its own retry logic outside the standard library introduces inconsistent backoff behavior that causes thundering herd failures during recovery. Standardization is a reliability concern, not just a code quality concern.

"Test BFF services with mocked backend services and integration tests" at senior level means defining the contract testing standard. Consumer-driven contracts (Pact) in CI mean that a change to a backend service that breaks a BFF's expectations fails the backend's CI build, not the BFF's production. This inverts the blame model and prevents silent breakage. Establishing this standard is a staff-level contribution because it requires buy-in from both the BFF teams (who publish contracts) and the backend teams (who run them in CI).

---
