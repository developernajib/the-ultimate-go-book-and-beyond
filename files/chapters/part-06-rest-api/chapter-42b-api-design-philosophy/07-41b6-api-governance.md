## 42B.6 API Governance

### API Style Guides

A style guide answers all the questions a developer might ask when designing an endpoint, so they don't have to rely on intuition or ask in a meeting.

What a style guide covers:
- Resource naming conventions
- URL structure and depth limits
- Required and optional headers
- Pagination approach and parameters
- Error format
- Timestamp format
- ID format (UUID, slug, integer)
- Boolean field naming (`is_active` vs `active` vs `enabled`)
- Null handling
- Versioning approach

Notable public style guides to study:
- **Google API Design Guide**: `cloud.google.com/apis/design` - thorough and prescriptive, used for Google Cloud APIs
- **Stripe API Reference**: The de facto standard for payment APIs
- **Microsoft REST API Guidelines**: GitHub.com/microsoft/api-guidelines

### API Review Process

The most important governance mechanism is reviewing APIs **before** implementation, not after.

A good API review process:

```
1. Design (engineer writes OpenAPI spec, no code yet)
   ↓
2. Self-review against style guide (automated: spectral lint)
   ↓
3. Peer review (1 engineer reviews for consistency, naming)
   ↓
4. Consumer review (engineers who will USE the API review for usability)
   ↓
5. Security review (auth, scopes, rate limiting, input validation)
   ↓
6. Implementation
   ↓
7. Contract test (verify implementation matches spec)
```

The cost of a design change at step 1 is near zero. At step 7 (post-implementation), it may require significant rework.

### Ownership of Breaking Changes

Every breaking change needs a named owner, an approval chain, and a migration plan before it ships. Teams that skip this produce two artifacts at scale: surprise outages, and a graveyard of "v2" endpoints that nobody uses because the deprecation was never followed through.

A workable ownership policy:

- **Owner**: the engineer proposing the change. They write the migration guide and ship the `Sunset` header.
- **Approver**: the API platform team or a designated API council. A single person with a weekly review slot is better than a large committee that never meets.
- **Minimum notice**: 6 months for paying customers, 12 months for flagship endpoints. Enforce via CI using `oasdiff` plus a policy file that maps endpoint paths to deprecation SLAs.
- **Telemetry gate**: cannot remove a deprecated endpoint until per-version traffic falls below a defined threshold (typically 0.1% of calls for 30 consecutive days).

> **Senior track**: In 2026 the emerging pattern is "API contracts as policy-as-code." Apigee and Kong both ship governance engines that enforce style guide rules, breaking-change detection, and security baselines (auth, rate limits, scopes) at the gateway layer. Spectral rulesets check every pull request in CI, and the gateway blocks any deploy whose contract was not signed off. This is the same shift that happened with Terraform and OPA for infrastructure, applied to APIs.

### OpenAPI as Contract: Design First

The OpenAPI YAML becomes the single source of truth for the contract: the `idempotency_key` field, minimum/maximum constraints on `amount`, and the ISO 4217 `pattern` on `currency` are all validated by any conformant server implementation generated from the spec. Writing the spec before writing Go code means interface decisions are reviewed in YAML diffs, before a line of handler code exists.

```yaml
# openapi.yaml
openapi: "3.1.0"
info:
  title: Payments API
  version: "2024-01-15"

paths:
  /payments:
    post:
      operationId: createPayment
      summary: Create a payment
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreatePaymentRequest'
      responses:
        '201':
          description: Payment created
          headers:
            Location:
              schema:
                type: string
              description: URL of the created payment
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Payment'
        '422':
          $ref: '#/components/responses/ValidationError'
        '429':
          $ref: '#/components/responses/RateLimited'

components:
  schemas:
    CreatePaymentRequest:
      type: object
      required: [amount, currency, source]
      properties:
        amount:
          type: integer
          minimum: 1
          maximum: 99999999
          description: Amount in smallest currency unit (cents)
          example: 2000
        currency:
          type: string
          pattern: '^[A-Z]{3}$'
          description: ISO 4217 currency code
          example: USD
        source:
          type: string
          description: Payment method ID
          example: pm_abc123
        idempotency_key:
          type: string
          maxLength: 255
          description: Client-provided idempotency key for safe retries
```

### API Linting with Spectral

Spectral extends the base OpenAPI ruleset with project-specific rules enforced at the file level, so inconsistencies like mixed casing in path segments or missing `operationId` values are caught before code review. The `path-kebab-case` regex rule runs in CI and fails the pipeline, giving reviewers automated enforcement of naming conventions that would otherwise require tribal knowledge.

```yaml
# .spectral.yaml
extends: ["spectral:oas"]
rules:
  # Require operationId on all operations
  operation-operationId: error

  # Require descriptions on all operations
  operation-description: error

  # Custom: all paths must use kebab-case
  path-kebab-case:
    message: "Path segments must use kebab-case"
    given: "$.paths"
    severity: error
    then:
      function: pattern
      functionOptions:
        match: "^(/[a-z0-9-]+)*(/\\{[a-zA-Z_]+\\})*$"

  # Custom: all response schemas must have examples
  response-examples:
    message: "Responses should include examples"
    given: "$.paths.*.*.responses.*.content.*.schema"
    severity: warn
    then:
      field: example
      function: truthy
```

### Breaking Change Detection in CI

The `oasdiff` action compares the PR's `openapi.yaml` against the base branch version, failing CI if any breaking change is introduced, such as a removed field, a new required property, or a narrowed response schema. Running this alongside `spectral lint` means every pull request is gated on both structural correctness and backwards compatibility before merge.

```yaml
# .github/workflows/api-check.yml
name: API Contract Check
on: [pull_request]

jobs:
  breaking-change-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Get base spec
        run: git show origin/main:openapi.yaml > openapi-base.yaml

      - name: Check for breaking changes
        uses: oasdiff/oasdiff-action@main
        with:
          base: openapi-base.yaml
          revision: openapi.yaml
          fail-on: ERR  # Fail CI on breaking changes

      - name: Lint spec
        run: npx @stoplight/spectral-cli lint openapi.yaml
```

### Generating API Code from OpenAPI in Go

`oapi-codegen` generates a Go interface from the OpenAPI spec with one method per operation, and the compiler enforces that every declared endpoint is implemented before the binary builds. The `strict-server` generator wraps each handler so request decoding and response encoding follow the spec types, eliminating the entire class of bugs where a handler returns the wrong shape.

```bash
# Install oapi-codegen
go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest

# Generate server interfaces and types
oapi-codegen --config oapi-codegen.yaml openapi.yaml
```

```yaml
# oapi-codegen.yaml
package: api
generate:
  - types
  - chi-server
  - strict-server
output: internal/api/generated.go
```

The generated code produces an interface you must implement:

```go
// Generated: you must implement this interface
type StrictServerInterface interface {
    CreatePayment(ctx context.Context, request CreatePaymentRequestObject) (CreatePaymentResponseObject, error)
    GetPayment(ctx context.Context, request GetPaymentRequestObject) (GetPaymentResponseObject, error)
    ListPayments(ctx context.Context, request ListPaymentsRequestObject) (ListPaymentsResponseObject, error)
}

// Your implementation
type PaymentHandler struct {
    payments PaymentService
}

func (h *PaymentHandler) CreatePayment(
    ctx context.Context,
    req CreatePaymentRequestObject,
) (CreatePaymentResponseObject, error) {
    payment, err := h.payments.Create(ctx, CreatePaymentParams{
        Amount:         req.Body.Amount,
        Currency:       req.Body.Currency,
        Source:         req.Body.Source,
        IdempotencyKey: req.Body.IdempotencyKey,
    })
    if err != nil {
        return nil, err
    }

    return CreatePayment201JSONResponse{
        Body: mapPaymentToResponse(payment),
        Headers: CreatePayment201ResponseHeaders{
            Location: fmt.Sprintf("/payments/%s", payment.ID),
        },
    }, nil
}
```

### Junior → FAANG: Why Governance Exists and How to Work Within It

Junior engineers often experience API governance as friction: a style guide that demands kebab-case when you prefer camelCase, a review process that adds a day to a task you thought would take an hour. Understanding why these constraints exist will make you faster at working within them, and eventually at improving them.

**The prerequisite gap.** Without governance, each team makes local decisions that look reasonable in isolation but produce an incoherent API surface at the company level. A customer integrating with three of your APIs should not have to learn three different pagination schemes, three different error formats, and three different timestamp representations. The cost of inconsistency is not obvious until you are the customer paying it. Build the habit of asking "is there a style guide rule for this?" before making a naming decision.

**Worked example: The review that saved three months.** An engineer designs an endpoint to return a nested list of order items as an array of IDs. She skips the consumer review step because the ticket is time-sensitive. The iOS team implements against the spec, ships to the App Store, and two weeks later the API team wants to change the field to return full objects instead of IDs to reduce round-trips. Changing the shape is now a breaking change. The fix requires a versioning cycle. The consumer review step would have caught this in 30 minutes before any code existed.

**How to read a Spectral ruleset.** The `.spectral.yaml` in this chapter is not configuration boilerplate. It is a checklist encoded as code. Every rule answers a question the style guide already answered in prose. When you add a new rule, you are automating a decision that was previously enforced only by reviewers with institutional memory. When you see a rule fail, read its `message` field before reaching for `# spectral:off`. The message tells you which style guide decision you are about to violate and why.

**Interview entry-point framing.** When asked "How do you ensure API consistency across a growing engineering organization?", a passing answer mentions a style guide. A strong answer describes the full pipeline: spec-first design, automated linting in CI, consumer review, and breaking-change detection before merge. Name specific tools: Spectral for linting, `oasdiff` for breaking-change detection, `oapi-codegen` for contract enforcement at compile time. Explain why reviewing a YAML diff is cheaper than reviewing a code diff for API design decisions.

**First-job habits:**
- Write the OpenAPI spec before the handler code. Even if your team does not have a formal review process, writing the spec first forces you to think about the contract before you are anchored to an implementation.
- Run `spectral lint` locally before opening a pull request. Do not wait for CI to tell you your path segment is camelCase.
- When you find a case the style guide does not cover, ask rather than guess. One Slack message now prevents two teams diverging permanently.
- Read at least one public style guide end to end. Google's API Design Guide is the most thorough. Stripe's reference API is the most copied. Both are worth your time.

---

### Senior @ FAANG: API Governance as Organizational Infrastructure

At L6 and above, API governance is not a process you follow. It is infrastructure you design, operate, and evolve. The goal is to make the right API design decisions the path of least resistance for every engineer in the organization, not the result of individual discipline.

**The governance maturity model.**

Level 0: No governance. Each team writes what ships the feature fastest. The API surface is inconsistent. Customers write custom parsers for each product area. DX scores are low.

Level 1: Style guide exists in Confluence. It is updated rarely. Engineers find it through word of mouth. Compliance is enforced in code review by whoever remembers to check.

Level 2: Spectral linting runs in CI. Naming and structural rules are automated. Engineers get fast feedback on mechanical violations. But design decisions (is this the right resource model?) are still purely human.

Level 3: Spec-first with consumer review gates. The OpenAPI spec must be approved before implementation. Breaking-change detection blocks merges. A named API platform team owns the toolchain and the style guide.

Level 4: Policy-as-code at the gateway. The gateway enforces contracts at runtime. A service cannot ship a response shape that was not declared in its registered spec. Security baselines (auth required, rate limits set, scopes declared) are enforced without per-team configuration. New API surfaces are bootstrapped from templates that are already compliant.

Most organizations in 2025 are at Level 2 or 3. The gap between Level 3 and Level 4 is primarily observability and deployment pipeline integration, not tooling availability.

**Ownership model for breaking changes.** The policy described in this chapter (named owner, named approver, telemetry gate) is the right skeleton. The details that determine whether it works in practice are: the approver must have a defined SLA for reviewing requests (weekly async review in a shared doc works better than ad-hoc Slack messages), the telemetry gate must have a defined threshold that is not negotiable (0.1% of calls for 30 consecutive days, hard cutoff), and the migration guide must be a deliverable that ships at the same time as the `Sunset` header, not two weeks later. Without those specifics, every deprecation becomes a judgment call and the policy loses credibility.

**The `oapi-codegen` compile-time enforcement model.** Generating a `StrictServerInterface` from the OpenAPI spec and requiring all handlers to implement it is one of the highest-value governance controls available in Go. The compiler enforces that every declared operation is implemented. The generated request/response types enforce that handlers consume and produce the shapes declared in the spec. The spec is the law. The implementation cannot drift from it without a compile error. This is materially different from a hand-written handler that returns `map[string]any` and happens to match the spec today. At platform level, `oapi-codegen` should be a required tool for all teams shipping external APIs, invoked via a `go generate` directive in the repository, with the generated file committed so diffs are visible in pull requests.

**Running an API council that actually works.** An API council is a recurring forum where breaking-change approvals, style guide updates, and cross-team API design reviews happen. The patterns that make it work: meet weekly, not monthly (monthly meetings create backlogs that compress into rubber-stamping). Keep attendance small, three to five people maximum, rotating representation from product teams. Publish decisions as ADRs within 48 hours. Automate as much as possible so the council's attention is reserved for cases that automation cannot resolve. The most common failure mode is a council that grows to 15 people and achieves consensus by attrition rather than expertise.

**Staff-level concern: discoverability and the internal developer portal.** Governance is not only about preventing bad APIs. It is about making good APIs findable. At scale, engineers routinely reimplement APIs that already exist because they cannot discover them. An internal developer portal (Backstage is the reference implementation) that catalogs all registered APIs, their owners, their OpenAPI specs, and their deprecation status is the discoverability layer. Without it, governance reduces waste at the point of design but does not reduce the waste of duplication. The portal is owned by the API platform team, populated automatically from the spec registry, and queried by engineers before they start any new integration work.

**Bar-raiser signals at L6+.** The interviewer is testing whether you think about governance as a system. Strong signals: you describe the maturity model unprompted, you explain why spec-first is a prerequisite for effective governance (not just a nice-to-have), you name the failure modes of API councils and how to mitigate them, you connect the governance toolchain to the deployment pipeline rather than treating CI and the gateway as separate concerns, and you describe what metrics you would use to measure governance effectiveness (spec coverage rate, breaking-change incident rate, time-to-deprecation-completion). Weak signals: describing a style guide without enforcement, or treating governance as a checkbox process rather than an evolving platform capability.

---
