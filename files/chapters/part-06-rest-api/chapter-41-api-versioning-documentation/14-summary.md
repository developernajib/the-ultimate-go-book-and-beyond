## Summary

API versioning and documentation essentials:

1. **Versioning Strategies**: URL path for public APIs, headers (including Stripe-style date pinning) for sophisticated internal consumers. Avoid query-parameter versioning, which pollutes cache keys and is silently stripped by intermediaries. Any header-based scheme must emit `Vary` or caches will serve one version's body to another version's caller.
2. **Deprecation Timeline**: Announce early, emit the `Sunset` header (RFC 8594, an HTTP-date) and the `Deprecation` header (RFC 9745, an `@`-prefixed Unix timestamp, never `true`) alongside a `Link: rel="successor-version"` (RFC 8288), provide migration guides, track per-client usage, and email affected API key owners directly before sunset.
3. **OpenAPI 3.1 Specification**: Prefer OpenAPI 3.1 (aligned with JSON Schema 2020-12) for new APIs. Fall back to 3.0 only when a critical downstream generator has not caught up. Document every endpoint, schema, error shape, and example.
4. **Interactive Documentation**: Swagger UI for "try it out" testing, Redoc for long-form reference reading, Scalar for a polished modern portal, all from the same `openapi.json`.
5. **Code-First vs. Spec-First**: `swag` annotations keep code-first docs close to handlers but risk drift. `ogen` and `oapi-codegen` make drift structurally impossible but require YAML fluency and a regen cycle. Pick based on whether the contract or the implementation moves faster in your team.
6. **Changelog Management**: Categorize changes (added, changed, deprecated, removed, fixed, security), visually separate breaking changes, include `before`/`after` JSON examples, and ship an RSS feed for programmatic consumers.
7. **Breaking Change Detection**: Automate spec-diff in CI. Adding a required field, renaming a field, changing a field's type, or narrowing an enum are all breaking and should block the merge without a major version bump.
8. **SDK Generation**: Once the OpenAPI spec is stable, Stainless and Fern produce polished multi-language client SDKs, the approach behind the public SDKs of Anthropic, OpenAI, and Cloudflare, and a tier above what generic OpenAPI Generator templates emit.
9. **Company Patterns**: Stripe (date-based versioning with account pinning and server-side version-gate transforms), GitHub (dated versions selected by the `X-GitHub-Api-Version` **header**, not a `/v3` URL, with `Accept` media types reserved for opting into preview features), Twilio (date-versioned paths with multi-language code samples baked into the docs).

### Junior to FAANG: What to Internalize From This Chapter

Prerequisite gap closed. By the end of this chapter you should know the difference between additive and breaking, the four main versioning axes and when each wins, the `Deprecation` header (RFC 9745) and the `Sunset` header (RFC 8594) including the fact that they are separate RFCs with different value formats, and the failure modes of code-first versus spec-first documentation. If any of those four are fuzzy, reread the relevant section before moving on.

Worked reflection. Pick one API you use at work or at home. Identify its versioning axis. Read its changelog. Look for Deprecation or Sunset headers in a response using curl -i. Count how many of the five signals (axis, policy, headers, telemetry, migration tooling) the provider ships. Most public APIs hit three of five. The best hit all five.

First-job context. Your first year is not about designing the versioning platform. It is about reading PRs through the lens of "what will this do to a client on last month's SDK" and refusing to rubber-stamp changes that cross the breaking line. A junior who catches three breaking changes in their first six months earns trust that takes other juniors years to accumulate.

"Why did this fail?" reflex, condensed. Three questions after any post-deploy failure: did any field change type, did any required field appear, did any field disappear. If yes to any, you found it.

Interview entry point, condensed. Know the four axes, the two compatibility rules, the two deprecation headers and their separate RFCs (`Deprecation` from RFC 9745, `Sunset` from RFC 8594), and the two documentation strategies. If you can name those eight things and give one concrete trade-off per pair, you will clear the L3 and L4 bar. Citing the right RFC for the right header is a small detail that reliably separates people who have implemented this from people who have read a blog post about it.

### Senior at FAANG: Consolidated Governance Takeaways

Staff and principal takeaways from this chapter:

1. The versioning axis is a one-time decision for a given API surface. The transform pipeline, the deprecation telemetry, the SDK codegen, and the governance process are permanent investments. Budget accordingly. A public API serving 1M developer keys justifies a platform team of three to five engineers for the lifetime of the product.
2. Per-customer telemetry is the cornerstone control. Without it, you cannot safely deprecate. Without it, you cannot prove compliance with contractual notice periods. Without it, every sunset becomes a risk assessment instead of a decision.
3. The breaking-change detector is the most leveraged piece of platform tooling you will ship in this domain. It removes judgment calls from code review and replaces them with policy citations. Invest in it early and extend it continuously.
4. SDK codegen is part of the versioning contract, not a downstream artifact. Treat every release as a simultaneous emission across every supported language with golden file tests and a unified changelog.
5. Governance scales through policy-as-code. An API review board that must manually review every PR is a bottleneck. An API review board that defines rules and lets CI enforce them is a multiplier.
6. Deprecation without migration tooling fails. Always ship a migration guide with before and after examples, a diff tool that flags affected client code, and office hours for top callers. Goodwill alone does not move enterprise customers.
7. Documentation drift is structural. Single source of truth plus contract tests in CI is the only durable fix. Annotations and manual YAML will always drift.
8. The maturity model is the artifact you present to leadership. L1 to L5 across each axis (policy, telemetry, tooling, governance, culture) gives a shared vocabulary for where the platform is and where it needs to go next.

ADR consolidation. Every platform-level versioning decision should have an ADR with context, options, decision, consequences, and review cadence. The ADR corpus becomes the institutional memory. When a new staff engineer joins, handing them the ADR index is the fastest onboarding.

Maturity model consolidated L1 to L5 across the chapter:

- L1. Versioning is ad hoc. Breaking changes happen. No postmortems.
- L2. URL versioning exists. Changelog is manual. Postmortems exist but do not change policy.
- L3. Written policy. Deprecation signals shipped. Contract tests in CI.
- L4. Per-customer telemetry. Migration tooling. SDK codegen pipeline. Enforcing detector in CI.
- L5. Policy-as-code. API review board. Dashboards for leadership. Zero-incident quarters are the norm.

---
