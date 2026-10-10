## Exercises

1. **Build a CRUD REST API**: Implement a fully functional `/articles` resource with `GET`, `POST`, `PUT`, `PATCH`, and `DELETE` handlers using only the standard `net/http` package. Each handler must return the correct HTTP status code (200, 201, 204, 404) and a consistent JSON response envelope with `data`, `meta`, and `error` fields.

2. **Implement Middleware Chain**: Create a composable middleware stack that applies request ID injection, structured JSON logging (method, path, status, duration), panic recovery, and CORS headers. Wire the middlewares together using a helper function so they can be applied in a declarative order without modifying handler logic.

3. **Cursor-Based Pagination**: Replace offset pagination with cursor-based pagination on a `GET /posts` endpoint. The cursor should be an opaque, base64-encoded JSON token encoding the last seen `(created_at, id)` pair. Verify with a table-driven test that the same post never appears on two pages even when new records are inserted between requests.

4. **Idempotency Key Implementation**: Add idempotency key support to a `POST /payments` endpoint. Store the key and its response in an in-memory map with a 24-hour TTL. If the same key is received again, return the cached response with the original status code and an `Idempotent-Replayed: true` header. Write a concurrent test with `sync.WaitGroup` that fires 10 goroutines with the same key and asserts only one payment record was created.

5. **Content Negotiation**: Extend a handler to serve both `application/json` and `text/csv` based on the client's `Accept` header. If the header is absent or unsupported, default to JSON. Return `406 Not Acceptable` only when the client explicitly rejects both. Write tests covering each branch using `httptest.NewRecorder`.

6. **HATEOAS Links**: Add a `links` field to every item in a `GET /orders` response. Each order object should include `self`, `cancel`, and `items` hypermedia links constructed from the request's `Host` and scheme. Verify the links resolve to valid route patterns registered on the router.

7. **Security Headers Middleware**: Write a middleware that unconditionally sets `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and a strict `Content-Security-Policy` on every response. Write a test that asserts all five headers are present and have the correct values regardless of which handler is called.

### Junior → FAANG: How to Work These Exercises for Real Signal

Do not treat this list as homework. Treat it as a portfolio. Each exercise, done properly, becomes a public GitHub repo you can link on a resume. Each one teaches a specific reflex that shows up in interviews.

Ordering for first-job prep. Exercise 1 first because it is the entire phone screen. Exercise 2 next because middleware composition is the single most common whiteboard task. Exercise 4 next because idempotency is the highest-signal security question. Exercise 3 after because cursor pagination is the distinguishing L3 versus L4 signal. Exercises 5, 6, 7 in any order as bonus depth.

Extensions that make each exercise FAANG-shaped. Exercise 1: replace the in-memory store with Postgres using `pgx`, add OpenAPI generation, add Prometheus metrics, add a Dockerfile, deploy to Railway or Fly.io, publish a public URL. That is a first-job portfolio piece. Exercise 2: add OpenTelemetry trace propagation to the middleware chain, integrate with Jaeger locally, show spans in a screenshot on the README. Exercise 3: add HMAC signing on the cursor so tamper attempts return 400, write a test that proves tamper resistance. Exercise 4: add the body-hash check so retries with different bodies return 422, write a concurrent test with 100 goroutines and prove exactly one record is created. Exercise 5: add `application/problem+json` (RFC 9457) as a third content type for errors, write tests that prove error responses use it. Exercise 6: add a `Link` header (RFC 8288) alongside the JSON `links` field, write tests proving both are present. Exercise 7: add a report-only CSP with a reporting endpoint, show how violations are collected.

"Why did this fail" drill for each exercise. Exercise 4 is the best one. After writing the concurrent test, deliberately break the locking (remove the `SetNX`), re-run the test, watch it fail with two records created, then re-add the lock and watch it pass. That visceral feedback loop is what makes the idempotency concept stick.

First-job context. In your first month you will implement Exercise 1 at least three times against different domains (users, orders, invoices). Make sure the first implementation is clean so the next two become copy-paste-adjust. In your first quarter you will add Exercise 2, Exercise 4, and Exercise 7 to existing codebases as hardening tasks. In your first year you will be asked to review someone else's implementation of all seven. Do yours first so you can review with authority.

Interview entry-point. Link your exercise repos in your resume with a one-line description of what each demonstrates. "REST CRUD with Postgres, OpenAPI, and Prometheus" is a concrete signal. "Familiar with REST" is not. The repos are the signal.

### Senior @ FAANG: Exercises as Platform Artifacts

At staff level these exercises are seeds for platform capabilities. Each can be extended into a reusable library or service that your org's product teams adopt. That extension is the staff contribution.

Exercise 1 extension into a platform artifact. Build a `crudgen` CLI that reads an OpenAPI spec and emits a complete Go service skeleton with handlers, repository, tests, OpenAPI validation middleware, metrics, traces, and a migration stub. Publish internally with a versioned release cadence. Adopt across product teams over two quarters. The artifact reduces new-service setup from two weeks to two hours. Budget one engineer-quarter for v1, ongoing maintenance roughly one engineer-week per quarter.

Exercise 2 extension. Build a `middleware.Chain` package as the standard middleware stack every service imports. Include required middleware (request ID, logging, recovery, timeout, auth, rate limit, body size, content negotiation, security headers) with sane defaults and escape hatches. Publish with semantic versioning. Ban services from writing their own recovery or auth middleware by lint rule. Budget one engineer-quarter.

Exercise 3 extension. Covered in section 38.12 (staff extension 3). The pagination library is a platform artifact, not an exercise.

Exercise 4 extension. Build an idempotency service as a shared platform capability. Postgres-backed, with `INSERT ... ON CONFLICT DO NOTHING RETURNING` semantics, 24-hour TTL, body-hash check, metrics on cache-hit rate and replay rate. Expose as a Go package plus an optional sidecar for non-Go services. Budget two engineer-quarters including the sidecar.

Exercise 5 extension. Build a content negotiation library that reads `Accept` and `Content-Type` headers, applies RFC 9110 preference rules, and returns the right response writer plus error types for `406` and `415`. Include RFC 9457 problem+json as a mandatory error format. Ban services from hand-rolling negotiation. Budget one engineer-quarter.

Exercise 6 extension. Build a HATEOAS response adapter that reads a route table and emits `_links` plus `Link` headers automatically from a struct tag on the resource model. The adapter removes hardcoded URLs from handler code. Budget one engineer-quarter. Adoption is opt-in because the ROI is team-dependent.

Exercise 7 extension. Build a security-headers middleware plus a CSP report collector that stores violations in a queryable dashboard. Publish the CSP policy as the org-wide default with per-team escape hatches that require security review sign-off. Budget two engineer-quarters including the reporting pipeline.

ADR stance per extension. Artifacts that become org-wide defaults (middleware chain, idempotency service, security headers) are required, with exceptions requiring platform sign-off. Artifacts that are optional (HATEOAS, content negotiation beyond JSON) are provided but not mandated, with adoption tracked but not enforced.

Governance on artifacts. Each artifact has a named owner (a platform engineer), a versioning policy (semver with deprecation SLA), a release cadence (monthly minor, quarterly major), a migration playbook for breaking changes, and a support channel. Artifact quality is measured by adoption rate across teams, issue-resolution time, and internal NPS.

Bar-raiser question, "you have 50 services, seven of them have custom recovery middleware that swallows panics silently, how do you fix it." L6 answer. Phase 1, detect via a lint rule that flags non-standard recovery middleware. Phase 2, write a migration playbook and file PRs for each offending service, co-authored with the service owner. Phase 3, remove the escape hatch that allowed custom recovery middleware in the first place. Phase 4, add a regression test in the standard middleware package that fails if recovery is bypassed. Budget two quarters.

Bar-raiser question, "how do you roll out a new required middleware across 200 services without breaking production." Answer. Ship the middleware as opt-in for one release. Add a metric that reports adoption rate. At 50% adoption, flip the default to opt-in-required (warn if missing). At 80% adoption, flip to required (fail the build if missing). At 95%, remove the opt-out path. This takes two to three quarters and requires exec sponsorship because it blocks other work.

Principal-level lens. These exercises and their extensions are a curriculum for growing staff engineers. If your org does not ship artifacts like these, it does not have a platform team. If the artifacts exist but are not adopted, the platform team is not measuring right. If the artifacts are adopted but the incidents continue, the artifacts are not the right controls. The principal's job is to keep this loop honest.

---
