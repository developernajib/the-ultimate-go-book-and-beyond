## Part 2: Translation Files

Translation files map a message ID to a locale-specific string, with plural forms expressed as separate entries per CLDR plural category (`zero`, `one`, `two`, `few`, `many`, `other`). Several on-disk formats are common: `gotext`'s JSON output consumed by `golang.org/x/text/message/pipeline`, `go-i18n` v2's TOML/YAML/JSON format (`active.en.toml`, `active.ja.toml`), and the industry-standard XLIFF 2.x used by translation platforms (Phrase, Lokalise, Crowdin, Smartling). Files are embedded into the binary at compile time using `//go:embed`, removing the need to ship translation files separately or handle missing files at runtime. The message extractor scans Go source files for `message.Sprintf`, `.T(...)`, and similar calls and generates translation templates so every localizable string in the code has a corresponding catalog entry.

For messages that combine plurals, gender, or ordered arguments, the de facto industry syntax is ICU MessageFormat, e.g. `{count, plural, one {# item} other {# items}}` or `{gender, select, female {She} male {He} other {They}} replied`. `go-i18n` v2 supports this natively. With pure `x/text` you either use the built-in plural syntax from `feature/plural` or wrap ICU-parsed templates yourself. Either way, the string IDs in code stay stable while the translated variants evolve inside the catalog files.

```json
// locales/en-US.json
{
  "welcome": "Welcome, {{name}}!",
  "items.zero": "No items",
  "items.one": "%d item",
  "items.other": "%d items",
  "email.subject": "Your order #{{order_id}} has been confirmed",
  "error.not_found": "The requested resource was not found",
  "error.unauthorized": "You are not authorized to perform this action",
  "date.relative.just_now": "just now",
  "date.relative.minutes_ago.one": "%d minute ago",
  "date.relative.minutes_ago.other": "%d minutes ago",
  "date.relative.hours_ago.one": "%d hour ago",
  "date.relative.hours_ago.other": "%d hours ago",
  "date.relative.yesterday": "yesterday",
  "date.relative.days_ago.other": "%d days ago",
  "nav.home": "Home",
  "nav.profile": "Profile",
  "nav.settings": "Settings",
  "action.save": "Save",
  "action.cancel": "Cancel",
  "action.delete": "Delete"
}
```

The Japanese translation file omits the `items.one` key entirely because Japanese has no singular/plural distinction - all counts use the `other` form. This is a direct consequence of CLDR rules: the catalog only needs entries for plural categories the language uses.

```json
// locales/ja-JP.json
{
  "welcome": "{{name}}さん、ようこそ！",
  "items.other": "%d 件",
  "email.subject": "ご注文 #{{order_id}} が確認されました",
  "error.not_found": "お探しのリソースが見つかりません",
  "error.unauthorized": "この操作を実行する権限がありません",
  "date.relative.just_now": "たった今",
  "date.relative.minutes_ago.other": "%d分前",
  "date.relative.hours_ago.other": "%d時間前",
  "date.relative.yesterday": "昨日",
  "date.relative.days_ago.other": "%d日前",
  "nav.home": "ホーム",
  "nav.profile": "プロフィール",
  "nav.settings": "設定",
  "action.save": "保存",
  "action.cancel": "キャンセル",
  "action.delete": "削除"
}
```

Arabic requires all six CLDR plural categories for the `items` key. Notice that `items.one` and `items.two` use word forms rather than a numeric format string - Arabic has dedicated words for "one item" and "two items" that do not include the digit.

```json
// locales/ar-SA.json
{
  "welcome": "مرحباً {{name}}!",
  "items.zero": "لا توجد عناصر",
  "items.one": "عنصر واحد",
  "items.two": "عنصران",
  "items.few": "%d عناصر",
  "items.many": "%d عنصراً",
  "items.other": "%d عنصر",
  "error.not_found": "لم يتم العثور على المورد المطلوب",
  "error.unauthorized": "ليس لديك صلاحية لأداء هذا الإجراء",
  "nav.home": "الرئيسية",
  "nav.profile": "الملف الشخصي",
  "nav.settings": "الإعدادات",
  "action.save": "حفظ",
  "action.cancel": "إلغاء",
  "action.delete": "حذف"
}
```

The same messages expressed in `go-i18n` v2 TOML format show the native CLDR plural keys and ICU-style placeholders. Translators on platforms like Phrase and Crowdin prefer TOML because it roundtrips without escaping headaches:

```toml
# active.ru.toml (go-i18n v2)
[welcome]
other = "Добро пожаловать, {{.Name}}!"

[items]
one   = "{{.Count}} элемент"
few   = "{{.Count}} элемента"
many  = "{{.Count}} элементов"
other = "{{.Count}} элемента"
```

### Junior to FAANG: reading a translation file correctly the first time

When you open a translation file for the first time, scan for three things. The message keys (the identifiers your code uses). The placeholder syntax (does it use `%s`, `{{name}}`, or `{name}` ICU style). The plural structure (flat keys like `items.one` vs nested keys like `[items] one = ...`). Mixing placeholder styles across files in the same project is the single most common rookie mistake. Pick one and enforce it in the linter.

The Japanese file in the example legitimately omits `items.zero`, `items.one`, `items.two`, `items.few`, and `items.many`. CLDR says Japanese uses only the `other` category. Do not translate non-existent categories. Translators who add `items.one` in Japanese because the source has it are wrong, and the build should reject that catalog. Conversely, an Arabic catalog that ships only `items.one` and `items.other` is broken, because Arabic requires all six categories and the runtime will fall back to `other` for counts of 2, 3-10, and 11-99, producing grammatically wrong sentences. Validate category completeness at build time. The CLDR plural rules for every locale are shipped with `golang.org/x/text` and you can enumerate them.

Worked example. Your team ships a feature with a string "You have 5 pending invitations." You add `invitations.pending` with `one` and `other` in English. A week later, marketing launches in Russian, Arabic, and Welsh. Your build fails because Russian needs `one`, `few`, `many`, `other`. Arabic needs `zero`, `one`, `two`, `few`, `many`, `other`. Welsh needs `zero`, `one`, `two`, `few`, `many`, `other` as well (yes, Welsh has the most complex plural system in CLDR). The fix is not "add `other` to each and ship it." The fix is to send the string to translators with a clear plural breakdown in the CAT tool, let them supply the required categories per language, and gate the build on category completeness. This is the moment you understand why product managers treat launch-date as a dependency on localization throughput.

Interview framing. "What are the CLDR plural categories" is a literal question. The answer is `zero`, `one`, `two`, `few`, `many`, `other`, and not every language uses all six. "Which languages use `two`" is a follow-up. Arabic, Welsh, Hebrew, and Slovenian are the common ones. If you can name at least three, you pass. The deeper question is "why is `other` not the English plural default" and the answer is that in English, `one` is the singular and `other` covers everything else including zero. In French, zero is treated as `one`. These asymmetries are why you delegate to CLDR, never hand-roll.

### Senior at FAANG: catalog format strategy, governance, and migration

The format choice is a governance decision with a ten-year half-life. The realistic options in 2026 are XLIFF 2.1, ICU MessageFormat 1 in a transport wrapper (JSON, TOML, or YAML), MF2 in its native syntax, and gettext PO. Each has a different trade-off shape. XLIFF 2.1 is the only format your enterprise translation vendors will accept without complaint for large-volume work, because it carries metadata (source, translation state, approval, notes, segment IDs) that loose JSON does not. ICU MF1 is the format your engineers write by habit and what most runtime libraries parse natively. MF2 is the future, stabilized under Unicode in 2025 (CLDR 47), designed to carry selectors on multiple variables and annotations that MF1 cannot express. Gettext PO is legacy. Do not pick it for new work.

The right production architecture uses two formats. Authoring format (what engineers write, what the runtime loads) is ICU MF1 or MF2, typically embedded in JSON or TOML. Exchange format (what the CAT tool consumes and produces) is XLIFF 2.1. A build step translates between the two in both directions. This separation is critical. Engineers do not learn XLIFF. Translators do not touch JSON. The build pipeline enforces the round-trip guarantee that a string extracted to XLIFF, translated, and re-imported produces the same runtime behavior.

Translation memory governance lives inside the CAT tool but has platform consequences. Every string you extract is a candidate for TM leveraging against prior translations. A 100 percent TM match is free. A fuzzy match (75 to 99 percent) is cheap. A no-match is full price. The platform decision is how aggressively to leverage TM across products, brands, and tenants. Full cross-product leveraging maximizes reuse and minimizes cost but risks semantic drift (the word "post" means different things in a social feed and a shipping UI). Isolated per-product TM is safer but costs 2 to 3x more over the lifetime of a product. Staff-level ADR: segment TM by semantic domain, not by product. Use glossary terms to force consistency on domain-crossing vocabulary.

In-context translation is the single highest-impact tool for translation quality, and it requires a platform investment. The CAT tool needs to render screenshots of each string in its actual UI context so translators see the exact visual frame their translation appears in. Smartling has the strongest implementation (its Global Delivery Network captures context automatically from live pages). Lokalise and Phrase require explicit screenshot upload. Crowdin has a browser extension that captures context for web apps. For Go backend services, context is harder because the string is produced in a template and rendered in a consuming client. The architecture is a screenshot service that subscribes to catalog changes, renders the consuming page in a headless browser with the string highlighted, and posts the screenshot to the CAT tool. This is a six-engineer-week build and pays back within a quarter.

Translatable-string expansion governance is where product and engineering collide. German translations expand roughly 30 percent over English. Finnish 35. Russian 20. Arabic can expand or contract depending on the string. A menu item that reads "Save" in English reads "Speichern" in German and "Tallenna" in Finnish. UI built for English breaks when translated. The staff-level mandate is: every component has a documented max-width policy, every string is budgeted against that policy plus a 40 percent expansion factor, and pseudo-localization in CI validates the budget automatically. Strings that exceed budget are flagged to product for rewording, not to translators for shortening.

Multi-tenant and multi-brand override layering is a catalog feature, not a runtime feature. The default catalog ships with all messages. A brand catalog overrides a subset. A tenant catalog overrides a further subset. The resolution order is tenant then brand then default. The CAT tool must model this hierarchy explicitly, because a translator updating the default "Save" button text must not silently overwrite a brand-specific variant. Smartling and Phrase support this natively. Lokalise requires project branching. Document your layering model in the ADR and instrument per-layer hit rates in production so you know which overrides are actually used.

Catalog validation is a CI concern and a deploy gate. The validator checks at minimum: every source key has a translation in every launch-blocking locale. Every pluralized key has every CLDR category required by the locale. Every translated string parses to the same format verbs or ICU placeholders as the source. No translation exceeds the component's max-width budget under pseudo-expansion. No translation contains HTML or script that the source did not contain (XSS vector). No translation changes a URL scheme from HTTPS to HTTP. No translation introduces a bidi control character that was not in the source. These validations run on every PR that touches the catalog, and a failure blocks merge.

Migration from MF1 to MF2 is the work staff engineers plan for 2026 and 2027. The migration is not automated. MF2 has semantics MF1 cannot express (matrix selectors, attached functions), and the new form of a string often reads differently than the MF1 equivalent. Plan a quarter-by-quarter migration gated on tooling support. The MF2 specification reached Stable status in CLDR 47 (March 2025) and was integrated into ICU 77, but the implementations lag the spec: ICU4J's core API is at draft and ICU4C remains a technology preview, so neither ships a fully production-stable MF2 yet. `golang.org/x/text` does not yet expose an MF2 API. Translation-vendor and CAT-tool support is still maturing in parallel. Do not migrate until both your runtime library and your CAT tool have production MF2 parity.

---
