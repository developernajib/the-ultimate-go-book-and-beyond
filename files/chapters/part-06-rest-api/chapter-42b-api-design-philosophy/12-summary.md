## Summary

An API is a product with users, a lifecycle, and compounding design decisions. The shift from "plumbing" thinking to "product" thinking changes how you approach every design choice.

The key principles to internalize:

1. **Consistency over cleverness**: Every endpoint should feel like it was designed by the same person on the same day. Naming, error formats, pagination, and timestamps must all be consistent.

2. **Backward compatibility is a commitment, not a feature**: Design for the assumption that you will never change these field names. Use versioning strategies that allow evolution without breaking clients.

3. **Developer experience is product quality**: Error messages, idempotency keys, SDK quality, and documentation directly affect adoption and retention. They are not nice-to-haves.

4. **API-first means design before code**: Write the OpenAPI spec, lint it, review it with consumers, generate code from it. The review cost at design time is a fraction of the refactor cost post-implementation.

5. **Security is in the design**: Authentication, scopes, rate limiting, and CORS are not features you add at the end. They shape the API design from the start.

6. **Performance is in the shape**: Over-fetching, N+1 patterns, and missing bulk endpoints are API design failures. Sparse fieldsets, expandable resources, cursor pagination, and async patterns are design solutions.

The companies with the best APIs - Stripe, Twilio, GitHub - have invested heavily in treating API design as a first-class engineering discipline with dedicated review processes, published style guides, and teams that maintain backward compatibility over years. This investment returns in developer trust, adoption velocity, and dramatically lower support costs.

---

### Junior → FAANG: Internalizing the Chapter's Core Principles

A summary section is only useful if you can reconstruct the reasoning, not just recite the list. For each of the six principles in this chapter, be able to explain the "why" in one or two sentences without looking at the text.

**Prerequisite gaps to close**

Consistency is listed first for a reason. Before you can be consistent, you need a written standard to be consistent against. Most junior engineers on their first team inherit an API with no style guide. The correct response is to write down the implicit rules that exist, publish them as a team doc, and propose a lint check. That document becomes the consistency standard.

"API-first" is frequently misunderstood as "write the OpenAPI spec." It means something broader: you design and review the contract with consumers before any implementation exists. The spec is the artifact of that conversation, not a substitute for it.

**Worked example: applying "performance is in the shape"**

Take a hypothetical `GET /notifications` endpoint that returns every field on every notification object. Ask: what does the mobile app actually render? Usually an icon type, a title, and a timestamp. The remaining 15 fields are wasted bytes on every request. The fix is not adding a cache layer. It is redesigning the response shape. This is what "performance is in the design" means concretely.

**First-job habits from each principle**

Principle 1 (consistency): Before naming any new field, look up what similar fields are called in existing endpoints. "created_at" not "createdAt" not "timestamp" not "date."

Principle 2 (backward compatibility): Treat every field you add as permanent. If you are not sure a field is right, omit it and add it in a follow-up release. Removing is breaking. Adding is safe.

Principle 3 (DX as quality): Write the error message you would want to read at 2am when your integration is broken. If it says "invalid input," it is not good enough.

**Interview entry-point framing**

"What makes a good API?" is a common opening question at FAANG. Use the six principles here as a structured answer. Open with consistency, explain backward compatibility as a commitment not a policy, and close with the Stripe/Twilio/GitHub observation. It signals that you study real production APIs, not just textbooks.

---

### Senior @ FAANG: From Principles to Platform Governance

The six principles in the summary are correct and necessary. What distinguishes a senior or staff engineer is knowing how to institutionalize them so they apply to a 200-person engineering organization, not just to the code you personally write.

**Consistency requires tooling, not trust**

A style guide that lives in a wiki is a suggestion. A style guide enforced by `spectral lint` in CI is a constraint. At the staff level, the decision is not "should we be consistent?" It is "which of these consistency rules are automatable, which require human review, and what is the escalation path when someone disagrees with a rule?"

Automatable: field naming conventions, timestamp format (ISO 8601 vs Unix), error response shape, pagination envelope structure, HTTP method semantics. These go in the linter.

Requires human review: resource naming (should it be `payment_method` or `instrument`?), versioning decisions, which operations are synchronous vs asynchronous. These go in an API design review process with a named approver.

Escalation: when a team disagrees with a lint rule, they file a proposal. The API governance group reviews it on a defined cadence (monthly). The outcome is either a rule change applied to all existing code, or a project-specific exception with a documented rationale. This prevents the exception list from growing unchecked.

**Backward compatibility as a financial commitment**

The observation that Stripe's backward compatibility investment has saved tens of millions in migration engineering is not marketing copy. It is an ROI argument you can make to leadership. Every breaking change that requires client migration costs engineering time on both sides of the API boundary. A payment processor with 50,000 integrations that introduces a breaking change pays the support cost 50,000 times over.

At the staff level, backward compatibility governance means: automated breaking change detection in CI (`oasdiff --fail-on ERR`), a deprecation SLA written into the API governance policy (minimum 12 months for public APIs, 6 months for internal APIs), per-version traffic telemetry in Datadog or similar, and a sunset review process that requires sign-off from a named customer success contact before any version is removed.

**Developer experience as a product metric**

"DX is product quality" is a principle. The staff-level implementation tracks DX as a measurable metric. Time-to-first-successful-API-call (measured from account creation through first 200 response in production) is a leading indicator of developer adoption. Error rate on requests that receive a 400 or 422 within the first 7 days of integration is a measure of documentation clarity. SDK download trends and GitHub issue volume are leading indicators of developer sentiment.

These metrics belong in an engineering review alongside uptime and P99 latency. When DX metrics degrade, it is a platform reliability issue, not a docs problem.

**API-first as an organizational process**

At the platform level, API-first is a governance gate, not a personal practice. No implementation work begins on a new API until the OpenAPI spec has passed lint, been reviewed by at least one API consumer team, and received written sign-off from the API governance group. This process adds one to two weeks to the design phase and saves months of post-implementation negotiation.

Staff engineers own the design of this process, not just participation in it. That includes: defining the review checklist, training teams on the spec authoring workflow, creating spec templates for common patterns (CRUD resources, async jobs, webhook subscriptions), and maintaining the governance group's backlog.

**The Stripe/Twilio/GitHub observation as a platform benchmark**

These companies are cited not as aspirational ideals but as benchmarks with measurable properties. Stripe's changelog goes back to 2011 with unbroken backward compatibility. Twilio's error codes are numbered, documented, and permanent. GitHub's REST API has maintained stable resource shapes across major product changes for over a decade. The common factor is organizational investment: dedicated API teams, published style guides, automated enforcement, and a cultural norm that treats API changes as consequential decisions.

At the staff level, your job is to create the conditions for your organization to reach that benchmark, even if you never achieve it fully. The question to ask about every API governance decision is: "Does this move us toward or away from the properties that made Stripe's API worth copying?"
