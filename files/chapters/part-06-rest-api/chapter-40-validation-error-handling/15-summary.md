## Summary

Validation and error handling essentials:

1. **Layered Validation**: Transport → Format → Business rules for clear separation
2. **Struct Tags**: Use go-playground/validator for declarative validation
3. **Custom Validators**: Register domain-specific validations (Luhn, slug, phone)
4. **Consistent Errors**: Single error format with code, message, details, and request ID
5. **Safe Parsing**: Handle JSON errors with specific error codes
6. **Parameter Validation**: Validate path, query, and header parameters
7. **Error Middleware**: Centralized error handling with domain error mapping
8. **Error Catalog**: Document errors with causes, solutions, and examples
9. **Testing**: Table-driven tests with boundary conditions
10. **Company Patterns**: Learn from Stripe, Google, and Shopify's error handling

### Junior → FAANG: The Summary You Will Actually Use on Monday

The ten bullets above are the checklist you run through when you open a new handler file. Treat them as a linter you carry in your head. If a handler does not have layered validation, a DTO separate from the domain model, a stable error code, a request ID, and a test that exercises one bad-path case, the handler is not done. This is the single most reliable way to keep your first-job code out of review bounce cycles.

The reflex loop to internalize. Read the handler top to bottom. Ask "what is the input contract, in one sentence." Ask "what is the failure taxonomy, as a list of codes." Ask "what is the observability story, as a request ID plus one metric." If any of the three answers is "I do not know," stop and fix that before you write more logic. Interviewers probe the same three questions. Shipping the same three answers in every handler is what a productive first year looks like.

Prerequisite gaps flagged by this summary. If layered validation is unfamiliar, re-read the transport, format, business, authorization split. If consistent errors are unfamiliar, read RFC 9457 once end to end. If struct tags feel like magic, run `go doc github.com/go-playground/validator/v10` and scroll the options. If error middleware is unfamiliar, trace one request through your router and point at every `http.ResponseWriter.WriteHeader` call in the chain. There should be exactly one.

### Senior @ FAANG: The Summary as a Platform Commitment

At staff and principal level, the summary is not a checklist. It is a set of platform commitments other teams depend on. Each bullet is a product surface owned by someone, versioned separately, with a deprecation policy and an SLO.

The ten bullets as platform obligations. Layered validation is a library contract with a typed failure shape, versioned independently of service releases. Struct tag validation is a standardized choice with a lock on the library version and a migration policy for breaking upgrades. Custom validators live in a shared package with test coverage and semver discipline. Consistent errors are enforced by Problem Details middleware, Spectral CI rules, and a registry of `type` URIs with owners. Safe parsing is enforced by a decode helper that sets `DisallowUnknownFields` and `MaxBytesReader`, with a lint rule rejecting direct decoder usage in handler packages. Parameter validation is a typed router integration, not a per-handler concern. Error middleware is the outermost recovery middleware, tested with deliberate panics, emitting metrics per code. Error catalog is a first-class artifact with translator workflow, SDK code generation, and a deprecation clock. Testing is a contract test suite published by the platform team that every service runs in CI. Company patterns are not references, they are the competitive baseline you commit to matching or beating on developer experience.

Maturity model summary. L1-L2: per-service implementation, copy-paste drift, pitfalls discovered in production. L3: shared library, consistent shape within a service, uneven governance. L4: platform middleware, CI enforcement, catalog as code, request IDs propagated via W3C Trace Context. L5: code-generated types and SDKs, Problem Details everywhere, PII redaction at log handler, i18n via ICU bundles, catalog changes reviewed by API council. L6-L7: error taxonomy drives product and business decisions, catalog is a published artifact with external consumers, validation DSL spans multiple runtimes, pitfalls cannot be introduced by construction because the framework makes them uncompilable.

The ADR every platform team eventually writes. Context: heterogeneous services, inconsistent validation and error handling, pitfalls rediscovered yearly, support burden on SDK teams. Decision: adopt the ten commitments above as platform obligations, with owners, SLOs, versioning, and deprecation policies. Consequences: a platform team exists with a real on-call rotation, service teams migrate over a defined window, new services opt in by default, pitfall classes are closed at the framework layer. Alternatives rejected: style guides without enforcement (produces no change at scale), per-service autonomy (produces the current state), buy a third-party platform (lock-in on contract surface too central to outsource).

Bar-raiser prompt that pulls the whole chapter together. "Design the validation and error handling platform for a new business unit, 50 services on day one, 500 services in three years, 30 languages, five SDKs, regulated workloads." Expected signal: a Problem Details contract with extensions, a code-generated error catalog with i18n, a validation DSL with multi-runtime compilers, a platform middleware stack with explicit ordering and test harness, a governance model with API council and deprecation policy, an observability story with request ID propagation and PII redaction, a maturity model so teams can self-assess, and a rollout plan that does not require a flag day. Candidates who propose code without governance cap at L5. Candidates who propose governance without code cap at L5. The L6+ answer interleaves the two.

---
