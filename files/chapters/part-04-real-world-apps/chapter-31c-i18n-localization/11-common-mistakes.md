## Common Mistakes

| Mistake | Problem | Solution |
|---------|---------|----------|
| Hardcoding date formats | Wrong format in other locales | Always use locale-aware formatters |
| Not handling plural rules | "1 items" in English | Use CLDR plural rules per locale |
| Storing raw bytes, not runes | Wrong string operations | Use `utf8.RuneCountInString`, `[]rune()` for length/substring |
| `strings.ToLower` for Turkish | "I" → "i" not "ı" | Use `golang.org/x/text/cases` with locale |
| Sorting without locale collation | Wrong alphabetical order | Use `collate.New(tag).SortStrings()` |
| Not normalizing Unicode | "café" (NFC) ≠ "café" (NFD) | Normalize to NFC on input |
| Ignoring RTL in API responses | Client renders wrong layout | Include `dir` field in responses |
| Not extracting keys | Missing translations discovered in prod | Run key extraction in CI |
| Currency in float64 | Floating point errors | Use `int64` minor units or `decimal` type |
| Hardcoded 2 decimal places | Wrong for JPY (0), BHD/KWD (3) | Derive scale from `currency.Cash.Rounding(unit)` |
| Hardcoded English strings | Cannot translate later | Use keys from day one |
| Using `strings.ToLower` for Turkish | Silently corrupts case | Use `cases.Fold()` or `cases.Lower(language.Turkish)` |
| Confusing NFC with NFKC | Strips author-intended styling | NFC for storage/display, NFKC only for search/identifiers |
| Hardcoded RTL language list | Misses regional variants | Match on `tag.Script()` against RTL scripts |
| Localizing an API value instead of a key | Clients cannot build custom UI | Return stable `code` plus optional localized `message` |
| Using Accept-Language to pick payment currency | Currency is not locale | Keep currency and locale as separate signals |
| Concatenating translated fragments | Breaks grammar in every non-English language | Use parameterized messages with placeholders |
| `fmt.Sprintf` with translated format string | Translator changes verbs, runtime crashes | Validate placeholder parity at catalog build time |
| Caching localizer across tenants | Cross-tenant override leak | Construct localizer per request with `(tenant, locale)` key |
| Missing `Vary: Accept-Language` on responses | CDN serves wrong locale to later users | Add `Vary` whenever locale influences response body |
| Logging in user locale | Ops cannot correlate incidents across locales | Logs always in English, never localized |

### Junior to FAANG: reading this table as a triage list

The table is a triage list for your first months on an i18n-active codebase. When you review a PR, scan for these patterns. When you open a file you have never seen, scan for these patterns. Most of these bugs are one-line fixes once you know the pattern. A few (currency in float, hardcoded plural, hardcoded date format) need architectural attention and cannot be fixed in a single PR without rippling through every call site.

Worked example. A PR adds `fmt.Sprintf("$%.2f", invoice.Total)`. You leave a review comment: "This bypasses the localized currency formatter and will render $USD in German as `$1,234.56`. Use `format.FormatMoneyMinor(invoice.TotalMinor, invoice.Currency, userLocale)` instead." The author fixes. You have done your job.

Interview framing. An interviewer shows you a code sample containing three of these bugs and asks you to find them. Practice scanning for `fmt.Sprintf` with money, `strings.ToLower` on user input, raw byte slicing of strings, and `%.2f` for currency. Those four patterns cover 60 percent of real i18n regressions.

### Senior at FAANG: mistake prevention as code-policy, not code-review

Every mistake in the table above should be prevented by a lint rule, not caught by a reviewer. Reviewers are an unreliable, expensive, and late defense. Lint rules run on every PR and never forget.

The rules a production codebase should enforce. Ban `fmt.Sprintf` with format strings that contain `$`, `€`, `¥`, `£`. Ban `strings.ToLower` in user-input-handling files (whitelist display helpers). Ban `.Format("01/02/2006")` and similar hand-rolled date patterns outside a small CLDR-aware helper. Require that every call to `message.Printer.Sprintf` uses a message key and not an inline string. Require that plural-sensitive keys (those with `.one`, `.other`, `.few`, etc.) are accompanied by a plural helper call, never a raw concatenation. Require that currency-handling code uses an integer or decimal type, never float64. These rules are `go vet` analyzers, custom linters, or Semgrep rules. Write them once and enforce them forever.

CI-level prevention goes further. Every PR touching the catalog runs placeholder-parity validation (source `%s` matches translation `%s` count and order), plural-category completeness (Arabic has six, Russian has four, Japanese has one), no-bidi-injection (translations do not introduce bidi control characters not in source), no-HTML-injection (translations do not introduce tags not in source), max-length-budget (pseudo-expansion does not overflow the component). Any failure blocks merge. No exceptions.

Architectural prevention is the final tier. A system that cannot hold a float64 for money is architecturally immune to the float-money bug. A system where the only way to format a date is through a CLDR-aware helper is immune to hand-rolled patterns. A system where translator output flows through a validator-bot that rejects invalid translations before merge is immune to the verb-mismatch bug. Architectural prevention is expensive to build but free to maintain. Invest in it for any codebase that expects more than 18 months of life.

The deeper observation: the mistakes in this table are not mistakes of ignorance. They are mistakes of convenience. `fmt.Sprintf` is easier to type than the localized equivalent. `strings.ToLower` is a short name. `%.2f` is fewer characters than looking up CLDR rounding. Engineers will take shortcuts under deadline pressure. Your platform's job is to make the correct path the shortest path. If `format.FormatMoneyMinor(...)` is shorter than `fmt.Sprintf("$%.2f", ...)`, engineers use the correct one. If it is longer, they do not. API ergonomics is a compliance mechanism.
