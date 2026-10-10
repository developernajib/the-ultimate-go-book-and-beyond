## Exercises

1. **URL Path Versioning Router**: Implement a versioned router that mounts `/v1/` and `/v2/` handler groups. `GET /v1/users/:id` returns a flat user object. `GET /v2/users/:id` returns the same data with an embedded `address` sub-object. Write a test that calls both versions and asserts the response shapes differ exactly as documented without any shared mutable state between versions.

2. **Header-Based Version Negotiation**: Add an `API-Version` request header strategy alongside URL versioning. If both URL prefix and header are present and conflict, return `400 Bad Request` with a clear error. If only the header is present, route to the correct handler. Write tests covering: header only, URL only, matching both, and conflicting both.

3. **Deprecation Headers**: Write a middleware that reads a version deprecation config (map of version → deprecation timestamp and sunset date) and automatically injects `Deprecation`, `Sunset`, and `Link` (rel="successor-version") headers on responses for deprecated API versions. Get the formats right, because they are all different and none of them is RFC 3339: `Sunset` (RFC 8594) is an HTTP-date in GMT, produced by `t.UTC().Format(http.TimeFormat)`. `Deprecation` (RFC 9745) is a structured-fields Date, `@` followed by Unix seconds, and is **not** the string `true`. `Link` (RFC 8288) is `<url>; rel="successor-version"`. Write a test asserting each header matches its own format, including one case that parses the `Sunset` value back with `http.ParseTime` and one asserting the `Deprecation` timestamp precedes the sunset instant.

4. **OpenAPI Spec Generation with swag**: Annotate at least five handler functions with `swag` doc comments covering `@Summary`, `@Description`, `@Param`, `@Success`, `@Failure`, and `@Router`. Run `swag init` and serve the generated `swagger.json` at `GET /docs/openapi.json`. Write a test that loads the generated spec with `kin-openapi/openapi3` and asserts no validation errors.

5. **Breaking Change Detection in CI**: Write a Go test (not a shell script) that loads the current `openapi.yaml` and a `openapi.previous.yaml` baseline, then asserts none of the following have changed: existing endpoint paths, HTTP methods, required request body fields, and response field names. The test should fail with a descriptive message listing each detected breaking change.

6. **Changelog Automation**: Build a `GET /changelog` endpoint that reads a `CHANGELOG.md` file and returns a structured JSON array of versions, each with `version`, `release_date`, `breaking` (bool), and `changes` (array of strings) fields. Parse the Markdown headings and bullet points without an external library. Write a test that asserts a known version entry round-trips correctly.

7. **Multi-Language Code Sample Generation**: Write a function that accepts an `openapi3.Operation` struct and generates code samples in three languages (Go `net/http`, Python `requests`, cURL) as strings. Inject these samples into the OpenAPI spec's code-samples extension field before serving the spec. Check which spelling your renderer expects: Redoc introduced `x-code-samples` and later renamed it to `x-codeSamples`, and picking the one your viewer does not read produces a spec that validates cleanly and renders no samples at all. Write a unit test that generates a sample for a `POST /users` operation and asserts the generated cURL command contains the correct `-X POST`, URL, and `-H "Content-Type: application/json"` flags.

### Junior to FAANG: How to Attack These Exercises

Prerequisite gap. Before you start, make sure you can write a basic Chi or stdlib router with a subrouter per version, write a middleware that sets response headers, and parse YAML with kin-openapi. If any of those three are unfamiliar, spend an hour on each before you start the exercises. Fighting the tooling while learning the concept wastes both.

Worked attack plan for Exercise 1. Mount two subrouters. Define two handler structs. Share the service layer. Do not share response DTOs. Write the test first, assert the exact JSON shape per version, then implement until the test passes. If you find yourself passing a version flag into a single handler, stop and refactor to two handlers with a shared service.

First-job context. Exercises 3 and 5 are the two that map most directly to real first-year work. You will be asked to add deprecation headers to a service. You will be asked to wire a breaking-change check into CI. Do those two first and keep the code. They become your portfolio.

"Why did this fail?" reflex for the exercises. If a test fails with a decode error, check the type. If a test fails with a missing header, check the middleware order. If a test fails with a spec validation error, the spec is wrong, not the loader.

Interview entry point. Exercise 5 is the most common coding interview prompt in this domain. Practice it until you can write the breaking-change detector in forty-five minutes from a blank file. Being able to classify diffs into path, operation, request, response, and parameter categories live is an L4 signal.

### Senior at FAANG: Staff Extensions to Every Exercise

Staff engineers convert each exercise into a platform capability. The extensions below turn the learning scaffolding into shipping tooling.

Extension to Exercise 1. Replace the two-handler pattern with a transform layer. One handler serves the latest shape. A registered chain of migrations down-converts the response for older versions. Add property-based tests that assert round-trip equivalence across the chain. This is the Stripe model in miniature.

Extension to Exercise 2. Add telemetry on which negotiation path each request used. Log header, URL, both-matching, both-conflicting, and neither. Build a dashboard that shows the distribution across customers. Use the data to decide when to deprecate one of the negotiation paths. Most teams find that within a year, one axis dominates and the other can be retired.

Extension to Exercise 3. Extend the deprecation middleware to emit per-customer telemetry, notify the API key owner through a notification service, and enforce a hard block after the Sunset date with an override path for contracted customers. Add an admin endpoint to simulate the post-sunset response for any customer to verify client handling.

Extension to Exercise 4. Add a contract test that exercises every path and method in the generated spec against the live handler and fails on mismatch. Add a CI job that regenerates the spec on every commit and fails if the generated spec differs from the committed spec, preventing manual edits.

Extension to Exercise 5. Turn the detector into a GitHub Action. Post a review comment with a diff table. Block merge on breaking changes unless a label such as `version-bump-approved` is applied by a member of the API review board. Emit metrics on per-rule fire rate across the org. Feed the metrics into a quarterly platform health report.

Extension to Exercise 6. Replace Markdown parsing with a structured changelog format derived from OpenAPI diffs. Every merge that touches the spec emits a structured changelog entry. The endpoint serves the entries as JSON and as Atom for programmatic consumers. Add a query parameter to filter by severity (breaking, additive, fix) and by date range.

Extension to Exercise 7. Expand the code sample generator to eight languages. Add golden file tests per language. Integrate with an SDK codegen pipeline so that every release publishes the samples to the docs site and the SDK repositories simultaneously. Add a validation step that executes the generated Go and Python samples against a staging server in CI to prove they run.

ADR template for promoting any exercise to production:

1. Scope. Which services, which teams.
2. Control type. Advisory, warn-only, or enforcing.
3. Rollout. Dates, exit criteria, rollback plan.
4. Ownership. Platform team, on-call, escalation.
5. Metrics. What is measured, who reads the dashboard.

Maturity model L1 to L5 for exercise-derived tooling:

- L1. Exercises completed locally. Code discarded after the chapter.
- L2. One exercise shipped into a service. Ad hoc.
- L3. Multiple exercises shipped. Used by the team.
- L4. Exercises generalized into shared platform libraries.
- L5. Platform libraries govern the entire org with policy-as-code enforcement and quarterly maturity reporting.
