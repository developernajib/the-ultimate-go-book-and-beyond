## Exercises

1. **API-First Design Workflow**: Write the OpenAPI 3.1 specification for a `POST /orders` endpoint before writing any Go code. Include request body schema, two success responses (201, 202 for async), and four error responses (400, 401, 409, 422). Use `spectral lint` to validate the spec against the OAPI recommended ruleset. Only after the spec passes linting, generate the Go server stubs with `oapi-codegen` and implement the handler body.

2. **Consistency Audit Script**: Write a Go program that parses an OpenAPI spec file and enforces these style rules across all endpoints: all path parameters use `snake_case`, all response body timestamps are named `created_at` / `updated_at` (not `createdAt` or `timestamp`), all list endpoints return a `data` array and a `meta.total` field, and all error responses use the same `{"error": {"code": "...", "message": "..."}}` shape. The program must exit non-zero and list all violations if any rule is broken.

3. **Backwards Compatibility Harness**: Set up a contract test suite using recorded real API responses as golden fixtures. Each fixture is a JSON file named `{method}_{path}_{version}.golden.json`. Write a test runner that replays each fixture against the live handler and asserts the response schema is a superset of the golden file (new fields are allowed, but removed or renamed fields are failures). Run this suite in CI on every pull request.

4. **Developer Experience Audit**: Implement a `POST /echo` debug endpoint (enabled only in non-production environments) that returns a JSON object mirroring back all received headers, query parameters, path parameters, and the parsed request body. Add a rate limit of 10 req/min to prevent abuse. Write a test asserting the endpoint is unreachable when `APP_ENV=production` and fully functional otherwise.

5. **Sparse Fieldsets with `fields` Query Parameter**: Add support for a `?fields=id,name,email` query parameter on `GET /users` and `GET /users/:id`. The response must include only the requested top-level fields. If `fields` is absent, return all fields. If an unknown field is requested, return `400` listing the invalid field names. Write tests for field filtering, unknown fields, and missing parameter default behavior.

6. **Bulk and Batch Endpoint**: Design and implement a `POST /users/batch` endpoint that accepts an array of up to 100 user-creation payloads in a single request. Process them atomically in a database transaction. Return a `207 Multi-Status` response body where each item has its own `status` (201 or 422) and either the created resource or a validation error. Write a test with a mixed batch (some valid, some invalid) and assert the overall HTTP status is `207` and each item's status is correct.

7. **Performance Shape Review - Eliminating N+1**: Given a `GET /posts` handler that fetches posts and then loops to fetch each post's author in a separate query, refactor it to use a single JOIN query or a batched `WHERE id = ANY($1)` lookup. Add a query counter to the test database connection and assert the total number of queries for a 20-post page is exactly 2 (one for posts, one for authors) - not 21.

---

*Next: Chapter 42D - Beyond REST and gRPC: GraphQL, Webhooks, and AsyncAPI*

---

### Junior → FAANG: Getting Full Value From These Exercises

Exercises 1 through 7 cover the full arc of API design quality: specification, consistency, backward compatibility, developer experience, payload control, bulk operations, and performance shape. Working through all seven is more valuable than deep-diving on one.

**Prerequisite gaps to close**

If you have never used `spectral lint` or `oasdiff`, set up both before starting exercise 1. Install them, run them against a small example spec, and read the output. The tooling is the foundation. You cannot do exercises 1, 2, and 3 meaningfully without hands-on familiarity.

For exercise 6 (207 Multi-Status), look up the HTTP 207 spec before implementing. It is not widely used and the response envelope structure is not obvious. Understanding it concretely differentiates you from candidates who only know the common status codes.

**Worked approach: exercise 7 (eliminating N+1)**

Do not guess where the N+1 is. Add a query counter to the test database connection first, run the existing handler, and observe the count. That count is your baseline. Then refactor to the batch query and assert the count drops to 2. The discipline of measuring before and after is the habit interviewers probe for. "I refactored it to use a JOIN" is weaker than "I measured 21 queries per page before, and 2 queries per page after."

**First-job habits**

Exercise 3 (contract test harness) is the exercise most likely to map directly to real work. Golden-file tests for API responses are widely used at FAANG and at mature startups. Build it even if your current team does not have one. You will reference this as evidence in your next interview.

Exercise 4 (echo endpoint gated by environment) is a pattern you will use on your first week at a new job. Know how to gate debug endpoints on `APP_ENV` and how to write the test that verifies the gate works.

**Interview entry-point framing**

When an interviewer asks "how do you ensure API backward compatibility?", describe your golden-file contract test harness from exercise 3. Walk through the golden file format, the comparison logic (superset check, not equality), and how it runs in CI. This is a concrete answer that signals engineering maturity, not just theoretical knowledge.

---

### Senior @ FAANG: Extending the Exercises Into Platform Infrastructure

Each exercise in this list can be extended into a platform-scale tool. Senior engineers are expected to think about this extension dimension even when the exercise is scoped to a single service.

**Exercise 1 extended: spec-driven API lifecycle**

The API-first workflow in exercise 1 (spec, lint, review, generate, implement) is a single-service practice. The platform version is a shared OpenAPI governance repository where every team's spec lives in one repo, linted on every PR by a shared ruleset, with a named API governance group as a required reviewer for new endpoints and breaking changes. The `oapi-codegen` step becomes a CI job that generates stubs and opens a PR to the implementation repo, eliminating the manual copy step.

The ADR to write: "All new REST APIs must have their OpenAPI spec reviewed and approved before implementation begins. The spec is the source of truth. Generated code is not to be manually modified."

**Exercise 2 extended: consistency enforcement as a shared platform tool**

The consistency audit script in exercise 2 belongs in a shared internal tool repository, not in each service's repo. Publish it as a standalone binary and a GitHub Action. Teams should run `api-lint ./openapi.yaml` in their CI pipelines without having to copy or maintain the script themselves. Track violations as metrics over time. A dashboard showing "consistency score per team" makes API quality visible to engineering leadership without requiring manual audits.

**Exercise 3 extended: cross-version contract testing at scale**

At the platform level, the golden-file harness from exercise 3 becomes a centralized contract testing service. Every team registers their API version and a set of golden request/response pairs. The service replays them against production on a schedule (daily or after each deployment) and pages on-call if a regression is detected. This gives you a continuous backward compatibility guarantee across all services, not just the ones whose engineers remembered to run the tests.

The staff-level problem here is test data management. Golden fixtures that reference real database IDs break when data is cleaned up. The solution is synthetic test tenants and test IDs that are never pruned, or fixtures that use relative references resolved at runtime.

**Exercise 5 extended: sparse fieldsets as a platform concern**

Sparse fieldsets implemented per-service become a platform-level contract when you add field usage telemetry. Instrument every `GET` response to record which fields were requested via `?fields=` versus which were present in the default response. Aggregate this by client ID and endpoint. After 90 days, you have a data-driven picture of which fields are genuinely needed versus which are dead weight. Use this to propose deprecation of low-usage fields, reducing payload size platform-wide.

The governance question is: who decides a field is ready to deprecate? Define a threshold (fewer than 1% of requests include the field in `?fields=`, or the field is absent from the `?fields=` parameter in more than 99% of requests that use sparse fieldsets) and a deprecation process that matches your standard API versioning policy.

**Exercise 6 extended: 207 Multi-Status as a reliability pattern**

The batch endpoint with 207 Multi-Status has a reliability implication beyond correctness. In a high-throughput system, processing a batch of 100 items in a single database transaction holds locks for longer than processing them individually. At scale, this causes lock contention that degrades throughput for concurrent requests. The production pattern is: validate all items upfront outside a transaction, then process in batches of N (typically 10-25) within short-lived transactions, accumulating results. The final 207 response reflects the aggregate outcome. Document the batch-size parameter as a tuning knob, not a fixed constant.

**Exercise 7 extended: N+1 prevention as a platform lint rule**

The query counter test in exercise 7 works for a single endpoint. At the platform level, integrate it as a continuous test: any PR that adds a new `GET` list endpoint must include a query count assertion in its test suite. Add this to the API development checklist reviewed by the tech lead or API governance group. Pair it with a slow-query log alert in production: any query taking more than 50ms on a paginated list endpoint triggers a Slack notification for triage.

The staff-level insight is that N+1 problems are always a symptom of missing architectural guidance. They emerge because engineers write handlers without a data-fetching pattern to follow. The fix is to provide a sanctioned batch-loading utility (similar to DataLoader in GraphQL ecosystems) and make it the default way handlers fetch related resources, not an optimization to reach for after a performance complaint.
