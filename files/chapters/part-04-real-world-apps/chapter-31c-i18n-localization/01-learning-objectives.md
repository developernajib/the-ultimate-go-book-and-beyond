## Learning Objectives

By the end of this chapter, you will:
- Distinguish between internationalization (i18n) - designing for multiple locales - and localization (l10n) - adapting for a specific locale - and know why conflating them causes production bugs
- Be able to apply CLDR plural rules correctly, handling the six plural categories (zero, one, two, few, many, other) across different languages using `golang.org/x/text`
- Know how to build and manage message catalogs, including extraction from source code, XLIFF/PO format support, and hot-reloading translated resources
- Be able to implement locale-aware number formatting (decimal separators, grouping), date/time formatting, and currency display using Go's `golang.org/x/text/message` and `golang.org/x/text/number` packages
- Implement right-to-left (RTL) language support for APIs and templates, including bidirectional text handling and logical vs. visual ordering
- Know how to evaluate and integrate Go i18n libraries (go-i18n, spreak, golang.org/x/text) and select the right tool for a given project's complexity
- Be able to design and implement end-to-end translation workflows covering string extraction, translator handoff, translation import, and continuous localization pipelines
- Know how to write tests that validate localized output, including locale-specific assertions, pseudo-localization for layout testing, and snapshot testing across locales

### Junior to FAANG: how to read these objectives on day one

Read the list as a sequence, not a set. The first objective (i18n vs l10n) is vocabulary. The second (CLDR plurals) is the single most underestimated topic on the list. The third (message catalogs) is the file format and tooling layer. The fourth (locale-aware formatting) is where most production bugs live. Only after those four does anything else become useful. If you skip plural rules and go straight to RTL, you will produce an app that renders Arabic correctly but says "You have 1 messages" in Russian.

A worked entry point. Pick one objective, say number formatting, and produce a failing test before you read the chapter. Write a test that asserts `message.NewPrinter(language.German).Sprintf("%d", 1234)` returns `"1.234"` with a German dot as thousands separator. Run it. Observe that it passes. Now change the locale to `language.MustParse("de-CH")` (Swiss German) and assert the separator is `"'"` (apostrophe). That single exercise teaches you more about locale data than reading the objective list five times.

Interview framing. When a question asks "what does it mean to internationalize a Go service," the expected shape of the answer is "separate content from code, formalize locale as a request-scoped value, route all user-facing text through a `message.Printer` bound to that locale, ship a catalog artifact loaded at startup, and instrument fallback so we know when translations are missing." If you can reproduce that sentence, you have hit the objectives bar for a mid-level interview.

### Senior at FAANG: objectives as an ADR checklist

At staff level, these objectives are a checklist for the architectural decision record you write when a product decides to go multilingual. Each bullet expands into a section of the ADR. "Distinguish i18n and l10n" becomes a policy statement that engineering owns i18n-readiness and localization operations owns l10n delivery, with a shared interface defined by the catalog format and the review pipeline. "Apply CLDR plural rules" becomes a commitment to CLDR as the sole source of plural truth, with a versioned data pipeline and a process for handling CLDR updates that change plural categories. "Build and manage message catalogs" becomes a choice between XLIFF 2.0, ICU MessageFormat, and MF2, with a migration path stated.

"Locale-aware formatting" becomes a policy that `fmt.Sprintf` is banned in any user-facing code path, enforced by a lint rule in CI. `message.Printer` is the only permitted formatter. Currency formatting is decoupled from locale, because a user in France might hold a USD account. Date formatting uses locale skeletons (`yMMMd`, `Hms`) not hand-rolled patterns, because hand-rolled patterns produce date orderings wrong in Japan, Hungary, and Iran. "RTL support" becomes a commitment that every UI surface has an RTL screenshot in its visual regression suite and that the mobile and web teams share a common set of directional primitives.

"Evaluate Go i18n libraries" becomes an ADR section explicitly picking one. The defensible picks in 2026 are `golang.org/x/text` as the formatting primitive, an MF2-aware layer on top for authoring, and `nicksnyder/go-i18n/v2` as the routing layer when MF2 adoption is incomplete. `spreak` is a valid choice for gettext-native shops. Do not mix libraries across services, because catalog formats do not cross-cut cleanly.

"End-to-end translation workflow" becomes the most expensive part of the ADR. You must name the TM vendor, the file format exchanged, the SLA for string turnaround, the escalation for missing launch-blocking strings, the pseudo-localization gating policy, the glossary enforcement mechanism, the handling of brand-specific and tenant-specific overrides, and the metrics dashboard owned jointly by engineering and localization operations. "Write tests that validate localized output" becomes a statement that pseudo-localization runs on every PR, that snapshot tests exist for the top five locales, and that a scheduled job diffs CLDR data between releases and flags downstream test-expectation changes.

If your ADR cannot answer each of those points with a sentence and a link to an owning team, the platform is not ready. The objectives list in this chapter is the table of contents for that ADR.
