## Summary

| Topic | Key Tool/Pattern |
|-------|-----------------|
| Translation bundle | JSON files + `embed.FS` + key lookup |
| Locale detection | URL param > Cookie > Accept-Language |
| Pluralization | CLDR plural forms (zero/one/two/few/many/other) |
| Number formatting | `golang.org/x/text/message.Printer` + `number.Decimal` |
| Date formatting | Locale format strings. Use timezone always |
| Currency | Store as integer cents. Format on display |
| RTL support | `Dir()` in HTML/API. CSS `direction: rtl` |
| Unicode normalization | NFC for storage. NFD + remove Mn for search |
| Collation | `golang.org/x/text/collate` for locale sort |
| Key extraction | AST visitor finding `.T("key")` calls |
| ICU MessageFormat 2 | 2025 Unicode stabilization (CLDR 47), target for new authoring |
| Pseudo-localization | CI gate on layout overflow and hardcoded-English |
| Translation memory | Smartling, Lokalise, Phrase, Crowdin, Transifex |
| Continuous localization | PR to production-translated in hours, not weeks |
| Confusable detection | PRECIS RFC 8265 for identifier security |
| Collation tailoring | Per-locale CLDR rules, multiple rule sets per locale |
| CLDR ingestion | Version-locked, diffed per release, impact-reviewed |
| Observability | Missing-key rate, fallback rate, coverage per locale |

### Junior to FAANG: how to study from this summary

The table compresses the chapter into a reference card. Use it as a checklist when reviewing your own code. For each row, ask: is this handled correctly in the file I am looking at? If the answer is no or I am not sure, you have a learning task.

The summary deliberately pairs each topic with a specific tool. Memorize the pairs. `message.Printer` for formatting. `collate.New` for sorting. `norm.NFC` for normalization. `language.Matcher` for negotiation. `feature/plural.Cardinal.MatchPlural` for plural selection. `currency.Symbol` and `currency.Cash.Rounding` for money. These names are the working vocabulary of Go i18n.

Worked example. You receive a code review comment saying "this is not locale-aware." Before asking what that means, cross-reference the summary. If the code sorts strings, check `collate`. If it formats dates, check locale format strings. If it formats numbers, check `message.Printer`. Nine times out of ten, the answer is in the summary.

Interview framing. The summary is a cheat sheet for what FAANG expects you to know by name. If a question hits a row and you cannot produce the tool name, that is a knowledge gap. Practice until every row triggers the correct tool reflexively.

### Senior at FAANG: the summary as a platform maturity checklist

Read the summary as a checklist for your platform's maturity. For each row, ask: is this handled by a shared platform primitive, or re-implemented per service? A mature platform has one locale negotiation middleware used everywhere, one currency formatting helper used everywhere, one translation catalog loader used everywhere, one observability pipeline for i18n metrics used everywhere. A young platform has each service inventing its own.

The rows added above (MF2, pseudo-localization, TM, continuous localization, confusable detection, CLDR ingestion, observability) are the staff-level maturity markers. A platform without pseudo-localization in CI is level 2 maturity at best. A platform without continuous localization tooling is level 2 or 3. A platform with all of the added rows operational is level 4 to 5.

Your ADR for the i18n platform should reference the summary. Each row has a primitive owner (which team owns the library, the tooling, the operational dashboard), a version pin (which x/text version, which CLDR version, which ICU version), a change-control process (how breaking changes are rolled out, what services are affected), and an SLO (availability and correctness targets). Without these, the platform is fragile and every service re-invents the wheel.

The next 18 months of i18n platform evolution (through late 2027) will center on MF2 adoption, MT-assisted continuous localization, and accessibility convergence (ARIA `lang`, screen reader locale, bidi correctness baked into design systems). Staff engineers owning the i18n platform should be writing roadmap items against each of those, with concrete deliverables and measurable milestones. Reading this summary as complete is the failure mode. Reading it as the starting line for the next maturity step is the stance that matters.
