## Interview Questions

**Q: What's the difference between i18n and l10n?**

A: Internationalization (i18n) is engineering the system to support multiple languages - abstracting strings, using locale-aware formatters, designing for RTL. Localization (l10n) is the process of adapting the product for a specific locale - translating strings, adjusting date/currency formats, adapting images and colors. i18n is done by engineers. l10n is done by translators and cultural consultants.

**What FAANG expects:** A crisp distinction plus an operational consequence, that i18n is a one-time engineering investment (interfaces, catalogs, formatters), while l10n is an ongoing content pipeline with translator SLAs, TM, and continuous delivery. Bonus points for mentioning g11n (globalization) as the umbrella term that includes both plus currency, tax, and legal adaptations.

Follow-ups:
- When in the product lifecycle should i18n be introduced, and what is the cost of retrofitting it later?
- Who owns the glossary and style guide in a mature l10n organization, and why does that matter for brand consistency?
- How do you measure l10n quality quantitatively (LISA QA model, MQM, error categories)?

---

**Q: How do you handle pluralization across languages?**

A: The CLDR (Common Locale Data Repository) defines six plural categories: zero, one, two, few, many, other. English uses two (one/other). Arabic uses all six. Japanese uses one (other). Russian uses four (one/few/many/other). Use message catalogs with per-category keys (`items.one`, `items.other`, ...) and a selection function that maps a count to the correct category for each locale. `golang.org/x/text/feature/plural.Cardinal.MatchPlural` implements the full CLDR cardinal rules, and `plural.Ordinal` handles ordinals ("1st, 2nd, 3rd..."). Never hand-roll plural rules, CLDR ships a new release roughly twice a year and your table will drift.

**What FAANG expects:** You understand that plural rules are data-driven (CLDR), not code-driven. That ordinals and cardinals have separate rule sets. And that a translator must be able to add a category without a code deploy. Candidates who say "just use `if count == 1` else plural" immediately signal lack of i18n depth.

Follow-ups:
- Walk through how `plural.Cardinal.MatchPlural` uses the CLDR operands (n, i, v, w, f, t) and why `2.0` may select a different form than `2`.
- How do you extend ICU MessageFormat to combine plural and gender selection in the same message?
- What is the correct fallback when a translator forgets to supply the `few` form for Russian?

---

**Q: Why is currency stored as integers instead of floats?**

A: Floating-point arithmetic cannot represent all decimal fractions exactly, `0.1 + 0.2 = 0.30000000000000004` in `float64`. For currency, store as the smallest indivisible unit (cents for USD, pence for GBP, fils for AED, sen for JPY, though JPY has no minor unit). USD $10.99 = 1099 cents. Use integer arithmetic for all operations, apply bankers' rounding or the currency's documented rounding rule at aggregation boundaries, and convert to decimal only for display. The correct scale for a currency comes from CLDR (`currency.Cash.Rounding(unit)`), never a hardcoded `2`.

**What FAANG expects:** You recognize this as a correctness question (floats lose cents in aggregates at scale) and a compliance question (accounting systems must reconcile to the penny). Senior signal: mentioning that even integer minor units can overflow, high-throughput systems use `int64` or `big.Int`/`decimal.Decimal`, and that tax/FX conversions need deterministic rounding rules negotiated with finance.

Follow-ups:
- How do you represent fractional cents (e.g. an exchange rate of 0.00001234 BTC/USD) without losing precision?
- What is the difference between ISO 4217 rounding, CLDR cash rounding, and the currency's regulatory rounding, and when does it matter?
- How do you handle multi-currency arithmetic where `USD(100) + EUR(100)` must be rejected at compile time?

### Junior to FAANG: how to answer without over-reaching

These questions reward a structured, factual, specific answer. Structure: define the term, give the concrete mechanism, give a small example. Factual: name CLDR, name BCP 47, name NFC. Specific: say "Arabic has six plural categories" not "some languages have more plurals than English."

The common failure mode is over-reaching. A junior candidate, asked about pluralization, explains CLDR plural categories, then drifts into gender rules and bidi algorithm and time zone handling. The interviewer cannot tell whether the candidate has depth or is pattern-matching on i18n keywords. Stay in scope. Answer the question asked. If the interviewer wants depth elsewhere, they will ask a follow-up.

A worked answer pattern for "What is the difference between i18n and l10n." Start: "Internationalization is the engineering work of making a system ready for multiple locales without code changes per locale. Localization is the per-locale content and cultural adaptation work." Concrete mechanism: "Engineers abstract strings behind keys, route formatting through a locale-aware layer like `golang.org/x/text/message`, and ensure the catalog data model supports CLDR plural categories. Translators and cultural consultants then fill in the translations, review date and number formats, and sign off on imagery and colors per market." Example: "Shipping a button reading 'Save' in the catalog with key `action.save` is i18n. Translating it to 'Speichern' in the German catalog is l10n."

If you can reproduce that pattern for any of the three questions above, you will pass the i18n portion of a FAANG mid-level interview.

### Senior at FAANG: what the interviewer is actually probing for

At staff level, interview questions about i18n are rarely about the vocabulary. The interviewer is probing for platform maturity. The signal they want: have you built or significantly contributed to an i18n platform that serves more than ten locales at scale, and do you know which decisions matter and which do not.

For "i18n vs l10n," the staff-level follow-up is "Who owns the catalog at your org, who owns the translator vendor relationship, how do those interact, and what is the SLA on new strings reaching production in all supported locales." A weak answer names only engineering. A strong answer names engineering, localization operations, product, legal, and brand, and describes the interface between them as an ADR with explicit ownership. Bonus: mention that the interface includes a glossary governance process and a dispute-resolution mechanism for terminology conflicts across products.

For pluralization, the staff-level follow-up is "How do you handle a CLDR data change that alters plural categories for a locale you support." The answer describes a version-locked CLDR ingestion pipeline, diff review per release, impact assessment against your message catalog (which keys have plural forms that the new CLDR version changes the selection for), a staged rollout (feature flag), and a translator review for affected strings. If you have not lived through a CLDR upgrade, you cannot fake this answer.

For currency, the staff-level follow-up is "How do you model a multi-currency ledger that supports FX conversion, rounding, and reconciliation to the penny across 30 currencies." The answer touches on decimal precision (integer minor units insufficient for some arithmetic, use `shopspring/decimal` or a custom type), rounding policy (per currency, per operation, documented in an ADR), FX rate sourcing and caching (batch updates, rate versioning, audit trail), ledger isolation (one journal per currency with explicit conversion entries, not implicit conversion at read time), reconciliation (daily close, diff against source-of-truth systems, tolerance for rounding noise), and compliance (PCI-DSS for cards, AML for large transfers, tax treatment per jurisdiction). A strong answer is 20 minutes of content. An interviewer signals "go deeper" when they want more.

The meta-question underlying all i18n interview questions is "do you understand that localization is a continuous operational program, not a project." A candidate who describes localization as "we translated the strings and shipped" signals a pre-2010 mental model. A candidate who describes it as "a continuous delivery pipeline with TM, glossary, vendor SLAs, CI validation, and observability" signals 2026 maturity. The words you use telegraph your experience.

The ICU MessageFormat 2.0 question is now common at staff-level interviews. "MF2 reached Stable status in 2025 (CLDR 47). What is the migration story for an org currently on MF1 or on a bespoke format." The expected answer names the bidirectional converter (MF1 and MF2 are not isomorphic, but the common subset covers most real strings), the vendor readiness (CAT tool support is the gating factor), the runtime library readiness (the ICU implementations still lag the spec: ICU4J's core API is at draft and ICU4C remains a technology preview, and `golang.org/x/text` does not yet expose an MF2 API), and the staged migration (new strings in MF2, existing strings migrated per catalog revision, deprecation window measured in quarters). If you do not know MF2 reached Stable status, your i18n knowledge is at least a year stale.

Pseudo-localization is a staff-level lightning-round question. "Describe pseudo-localization and its role in CI." The answer: a transformation that takes English source and produces a fake locale with expanded length, accented characters, and bracket sentinels, used to exercise the UI in a layout-stress condition before real translators are involved. Its role in CI is as a gating test that catches text-overflow, clipping, and hardcoded-English bugs before launch. The failure to mention pseudo-localization in a staff i18n interview is a negative signal.

RTL at interview scale means specifically naming UAX #9, the isolate characters (FSI, LRI, RLI, PDI), and the policy that logical CSS properties are the default. "How do you test RTL in CI" prompts the visual regression suite answer (Percy, Chromatic, or equivalent, with real Arabic and Hebrew content, reviewed by native speakers). Mention libphonenumber for phone numbers and CLDR for name and address formatting. The interview signal is that you know the specific standards, not just the concept.
