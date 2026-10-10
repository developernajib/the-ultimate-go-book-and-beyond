## Part 13: Expanded Interview Questions

The following questions extend the three questions in the original chapter and cover production-level depth expected at FAANG+ engineering interviews.

---

**Q: How do you handle missing translation keys gracefully in production without crashing or showing raw key names to users?**

A: The strategy is a three-tier fallback chain: (1) Exact locale match (e.g., `pt-BR`). (2) Parent language fallback (`pt`). (3) Default language (usually `en`). If all three fail, return a sanitized key name (e.g., replace dots with spaces and title-case it) so it is human-readable but obviously untranslated. Never panic or return an empty string. Instrument every fallback-to-default event with a metric counter so the team can detect coverage regressions. Log missing keys at `WARN` level with the key name and locale, then aggregate them daily into a missing-keys report fed to the localization team's ticket backlog.

```go
// FallbackLookup performs a three-tier locale fallback.
func (b *Bundle) FallbackLookup(locale, key string) string {
	// Tier 1: exact locale
	if val := b.get(locale, key); val != "" {
		return val
	}
	// Tier 2: parent language tag
	tag := language.MustParse(locale)
	parent, conf := tag.Base()
	if conf > language.No {
		if val := b.get(parent.String(), key); val != "" {
			return val
		}
	}
	// Tier 3: default language
	if val := b.get(b.defaultLocale, key); val != "" {
		b.metrics.MissingKeyCount.WithLabelValues(locale, key).Inc()
		return val
	}
	// Last resort: humanize the key
	return humanizeKey(key)
}

func humanizeKey(key string) string {
	parts := strings.Split(key, ".")
	last := parts[len(parts)-1]
	// strings.Title is deprecated in favor of cases.Title:
	//   cases.Title(language.English).String(...)
	return cases.Title(language.English).String(strings.ReplaceAll(last, "_", " "))
}
```

**What FAANG expects:** Graceful degradation plus observability. Interviewers want to hear a layered fallback, metrics emitted per miss, and a feedback loop into the translation pipeline. A crashing or blank string for a missing key is instantly disqualifying at Google, Meta, and Airbnb, where shipped strings cross dozens of locales.

Follow-ups:
- How do you prevent cascading fallbacks from masking a broken locale (e.g., `pt-BR` silently serving English for months)?
- What SLO would you set on "% of rendered strings served from the user's primary locale" and how would you alert on it?
- How does your fallback strategy change when the untranslated string is a legal or medical disclaimer?

---

**Q: When should you use ICU MessageFormat instead of simple string interpolation?**

A: Use simple `%s`/`{{.Name}}` interpolation only for single-variable substitutions with no plural or gender variance. Switch to ICU MessageFormat when: (1) a message contains a count that requires plural rules (`{count, plural, one{# item} other{# items}}`), (2) a message varies by gender (`{gender, select, male{He} female{She} other{They}} liked your post`), (3) a message contains both a count and gender simultaneously, or (4) translators need to reorder variables (`{0}` vs `{1}` may swap in some languages). ICU MessageFormat is the industry standard used by Android, iOS, Chrome, and every major localization platform (Phrase, Lokalise, Crowdin, Smartling). In Go, `github.com/nicksnyder/go-i18n/v2` supports ICU-style plural/select natively and layers on top of CLDR data shipped via `golang.org/x/text`.

**What FAANG expects:** Pragmatism. Over-engineering with ICU for a sign-in button is as bad as under-engineering with `fmt.Sprintf` for a notification counter. The candidate should articulate the inflection point (variability driven by linguistic features) and know that ICU strings must be escaped carefully in code review because a broken `{` will fail at render time, not compile time.

Follow-ups:
- How do you lint ICU MessageFormat strings in CI so a malformed `{plural, ...}` is caught before merge?
- What is the migration strategy for converting an existing catalog of `%s`-style strings into ICU without breaking translators mid-sprint?
- When would you reject ICU MessageFormat entirely (e.g. for LLM-generated copy) and what is the alternative?

---

**Q: What is pseudo-localization and why should it be part of your CI pipeline?**

A: Pseudo-localization is a testing technique where all translatable strings are automatically transformed into a visually distinct but ASCII-safe format that:
- Inflates string length by 30-50% (to catch UI clipping for German/Finnish which are naturally longer)
- Wraps strings in markers `[!!!...!!!]` (to detect untranslated hardcoded strings)
- Replaces ASCII vowels with accented equivalents (ä é ï ö ü) to catch encoding issues
- Does NOT change actual text logic, so the app remains functional

```go
// PseudoLocalizer transforms strings for i18n QA testing.
func PseudoLocalize(s string) string {
	var b strings.Builder
	b.WriteString("[!!! ")
	replacer := strings.NewReplacer(
		"a", "à", "e", "é", "i", "î",
		"o", "ô", "u", "ü", "A", "À",
		"E", "É", "I", "Î", "O", "Ô", "U", "Ü",
	)
	// Write accented version
	b.WriteString(replacer.Replace(s))
	// Pad to simulate expansion (German is ~35% longer than English)
	padding := int(float64(len(s)) * 0.4)
	b.WriteString(strings.Repeat("x", padding))
	b.WriteString(" !!!]")
	return b.String()
}
// PseudoLocalize("Hello world") → "[!!! Héllô wôrldxxxx !!!]"
```

In CI: run the UI test suite with the pseudo-locale enabled. Any visible `[!!! !!!]` wrapper in screenshots flags a hardcoded string. Any clipped text flags a layout that cannot handle translation expansion. This catches entire categories of bugs before any real translation work begins.

**What FAANG expects:** You view i18n as a testable product property, not an afterthought. Pseudo-localization should run on every PR that touches UI, with screenshot diffs auto-reviewed. Google's Chromium build and Meta's mobile test lanes both gate releases on pseudo-locale rendering passes.

Follow-ups:
- How do you generate a pseudo-locale that exercises RTL rendering (bidi-aware wrapping, mirrored glyphs) without actually translating content?
- Where should pseudo-localization NOT be applied (e.g. API error codes, legal strings)? How do you express that exclusion in the extractor?
- How do you quantify "layout breakage" in pseudo-locale runs, pixel-diff thresholds, clipped-text detection, both?

---

**Q: How do WhatsApp and WeChat handle 100+ language support at scale?**

A: Both use a combination of:
1. **Offline string bundles**: All translations are bundled in the app binary, partitioned by locale. On Android, this is the `res/values-{locale}/strings.xml` hierarchy. On Go backends, it is locale-keyed embedded JSON files.
2. **Over-the-air (OTA) updates**: Separate lightweight update channels allow pushing new translation strings without a full app release. WhatsApp uses this for rapid hotfixes.
3. **Translation memory (TM)**: A database of previously translated sentence pairs. New strings are automatically matched against TM, and 100% matches skip human review, cutting costs and time.
4. **Continuous localization**: CI pipelines push newly extracted string keys to the localization platform (Phrase/Crowdin) the moment they are merged to main. Translators work in parallel with engineers.
5. **Quality automation**: Machine translation (DeepL/Google Cloud Translation) provides a first-pass draft. Human translators only review, reducing turnaround from days to hours.
6. **Locale sharding**: For user-generated content (messages), direction and script detection happen per-message on the client, not centrally.

**What FAANG expects:** System-design framing. The candidate should sketch the pipeline (source of truth, extraction, TMS, review, build, deploy) and identify the bottleneck (usually human review at the long tail of locales). Senior signal: mentioning that the engineering team owns the schema and tooling, but the localization team owns the content SLA.

Follow-ups:
- How do you roll out a new locale to 1% of users for QA without exposing broken strings to the rest?
- What is the cost model, per-word translation fees vs. engineering time vs. reviewer time, and how does machine translation change it?
- How do you handle user-generated content translation (auto-translate chat messages) at latency budgets under 50 ms?

---

**Q: Explain the Accept-Language header negotiation algorithm.**

A: RFC 9110 defines `Accept-Language` as a comma-separated list of language tags with optional quality values: `Accept-Language: fr-CH, fr;q=0.9, en;q=0.8, de;q=0.7, *;q=0.5`. The negotiation algorithm:
1. Parse the header into a list of (tag, quality) pairs, sorted descending by quality.
2. For each tag in priority order, attempt an exact match against supported locales.
3. If no exact match, attempt a "lookup" match (strip subtags: `fr-CH` → `fr`).
4. If still no match, use the site's default locale.

```go
// NegotiateLocale picks the best supported locale from an Accept-Language header.
func NegotiateLocale(header string, supported []language.Tag, fallback language.Tag) language.Tag {
	if header == "" {
		return fallback
	}
	tags, _, err := language.ParseAcceptLanguage(header)
	if err != nil {
		return fallback
	}
	matcher := language.NewMatcher(supported)
	tag, _, _ := matcher.Match(tags...)
	return tag
}
```

The `golang.org/x/text/language.NewMatcher` handles the full RFC algorithm including script and region fallback, and `language.MatchStrings(matcher, headers...)` lets you negotiate across URL params, cookies, and `Accept-Language` in a single call. It is production-safe and maintained by the Go team as part of the CLDR-backed `golang.org/x/text` module.

**What FAANG expects:** Precision on the algorithm plus awareness of edge cases: the `*` wildcard, `q=0` (explicit rejection), script-and-region fallback (`zh-Hans-CN` vs `zh-Hant-TW`), and the trap of trusting browser-sent Accept-Language when the user has manually overridden locale.

Follow-ups:
- Why should `Accept-Language` be the lowest-priority source rather than the default, and what sources should outrank it?
- How do you handle `zh-Hans-CN` vs `zh-Hant-TW` when the user's Accept-Language says only `zh`?
- What is the `Vary: Accept-Language` header's role in CDN caching, and how do you avoid cache fragmentation across thousands of header variants?

---

**Q: What is translation memory and how does it integrate into a Go backend's localization workflow?**

A: A Translation Memory (TM) is a database of source→target string pairs indexed by locale. When a new string requires translation:
1. Compute a fuzzy similarity score (edit distance or TF-IDF) against all TM entries for that locale.
2. If score ≥ 100% (exact match), reuse the translation automatically.
3. If score ≥ 75% (fuzzy match), present to a human translator as a pre-filled suggestion.
4. If score < 75%, treat as a new string requiring full translation.

In a Go backend workflow, TM integration looks like:

```go
// TranslationMemoryClient abstracts a TM service (Phrase TMS, memoQ, SDL).
type TranslationMemoryClient interface {
	Lookup(ctx context.Context, source, sourceLang, targetLang string) (TMMatch, error)
	Store(ctx context.Context, source, target, sourceLang, targetLang string) error
}

type TMMatch struct {
	Translation string
	Score       float64 // 0.0 to 1.0
	Source      string  // Matched source string
}

// EnrichWithTM augments extracted keys with TM suggestions before
// sending them to human translators.
func EnrichWithTM(tm TranslationMemoryClient, keys []ExtractedKey, targetLocale string) []TranslationTask {
	tasks := make([]TranslationTask, 0, len(keys))
	for _, key := range keys {
		match, err := tm.Lookup(context.Background(), key.SourceValue, "en", targetLocale)
		task := TranslationTask{Key: key.Name, Source: key.SourceValue}
		if err == nil && match.Score >= 0.75 {
			task.Suggestion = match.Translation
			task.Confidence = match.Score
		}
		tasks = append(tasks, task)
	}
	return tasks
}
```

**What FAANG expects:** Business-economics awareness, TM directly reduces translation spend on the 30-60% of strings that recur across features. Strong candidates also mention TM hygiene (stale entries, context drift) and the need to version TM per brand/domain so "Delivery" in an Uber Eats context does not leak into a Lyft context.

Follow-ups:
- How do you score matches beyond raw edit distance, tagging, context, and prior reviewer approval?
- What is the privacy/legal concern of storing customer-facing strings in a TM managed by a third-party vendor?
- How do TM and machine translation coexist, is MT output written back to TM, gated by human review, or kept in a separate namespace?

---

**Q: How do you write table-driven tests for i18n code across multiple locales?**

A: Table-driven tests are the natural fit for i18n code because the same function must produce different outputs for each locale. The pattern is: define a test case struct with `locale`, `input`, and `expected` fields, then range over the table calling `t.Run` with a descriptive name that includes the locale.

```go
package formatting_test

import (
	"testing"

	"golang.org/x/text/language"
)

func TestFormatNumber(t *testing.T) {
	tests := []struct {
		name     string
		locale   language.Tag
		value    float64
		decimals int
		expected string
	}{
		{"english_integer", language.English, 1234567, 0, "1,234,567"},
		{"english_decimal", language.English, 1234567.89, 2, "1,234,567.89"},
		{"german_decimal", language.German, 1234567.89, 2, "1.234.567,89"},
		{"french_decimal", language.French, 1234567.89, 2, "1\u202f234\u202f567,89"},
		{"hindi_decimal", language.Hindi, 1234567.89, 2, "12,34,567.89"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := FormatNumber(tc.locale, tc.value, tc.decimals)
			if got != tc.expected {
				t.Errorf("FormatNumber(%s, %f, %d) = %q, want %q",
					tc.locale, tc.value, tc.decimals, got, tc.expected)
			}
		})
	}
}

func TestPluralForms(t *testing.T) {
	en := NewLocalizer(language.English)
	ru := NewLocalizer(language.Russian)

	tests := []struct {
		name      string
		localizer *Localizer
		key       string
		count     int
		expected  string
	}{
		{"en_singular", en, "items", 1, "1 item"},
		{"en_plural", en, "items", 5, "5 items"},
		{"ru_one", ru, "items", 1, "1 элемент"},
		{"ru_few_2", ru, "items", 2, "2 элемента"},
		{"ru_few_4", ru, "items", 4, "4 элемента"},
		{"ru_many_5", ru, "items", 5, "5 элементов"},
		{"ru_many_11", ru, "items", 11, "11 элементов"},
		{"ru_one_21", ru, "items", 21, "21 элемент"},
		{"ru_few_22", ru, "items", 22, "22 элемента"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := tc.localizer.Pluralize(tc.key, tc.count)
			if got != tc.expected {
				t.Errorf("Pluralize(%q, %d) = %q, want %q", tc.key, tc.count, got, tc.expected)
			}
		})
	}
}

func TestIsRTL(t *testing.T) {
	tests := []struct {
		tag      language.Tag
		expected bool
	}{
		{language.Arabic, true},
		{language.Hebrew, true},
		{language.MustParse("fa"), true},  // Persian
		{language.MustParse("ur"), true},  // Urdu
		{language.English, false},
		{language.German, false},
		{language.Japanese, false},
		{language.Chinese, false},
	}
	for _, tc := range tests {
		t.Run(tc.tag.String(), func(t *testing.T) {
			got := IsRTL(tc.tag)
			if got != tc.expected {
				t.Errorf("IsRTL(%s) = %v, want %v", tc.tag, got, tc.expected)
			}
		})
	}
}
```

**What FAANG expects:** Tests are the only defensible proof that i18n code is correct, because eyeball review of Arabic or Hindi output by an English-speaking reviewer is worthless. Candidates should propose golden-file tests for large output blobs, table-driven tests for discrete rules, and screenshot tests for rendered UI, all running in CI across the full supported locale matrix.

Follow-ups:
- How do you avoid test flakiness caused by CLDR data updates between x/text versions?
- What is the right way to test CLDR plural rules without hand-writing every count, property-based testing with `gopter`?
- How do you test RTL layout server-side without a browser, snapshot the rendered HTML and assert on `dir=` / logical-property usage?

---

**Q: What are the performance implications of running locale-aware formatting on every API request, and how do you mitigate them?**

A: `message.NewPrinter(tag)` is not free - it performs language tag matching and catalog lookup on each call. At high QPS, this adds measurable latency. Mitigations:
1. **Printer pool**: Cache `*message.Printer` instances per locale in a `sync.Map`. Create once on startup for all supported locales.
2. **Pre-format at write time**: Format numbers and dates once when data is created and store the formatted string alongside the raw value in the database. Re-format only on locale change.
3. **Client-side formatting**: For web SPAs, send raw numbers and ISO dates from the API and format them in JavaScript using the browser's native `Intl.NumberFormat` and `Intl.DateTimeFormat`. This offloads all formatting work to the client and eliminates per-request Go formatting overhead entirely.
4. **Batch responses**: When returning lists of items, create a single `Printer` and use it for all items in the response, not one per item.

```go
// PrinterCache caches message.Printer instances per locale.
type PrinterCache struct {
	mu      sync.RWMutex
	printers map[language.Tag]*message.Printer
}

func NewPrinterCache() *PrinterCache {
	return &PrinterCache{printers: make(map[language.Tag]*message.Printer)}
}

func (c *PrinterCache) Get(tag language.Tag) *message.Printer {
	c.mu.RLock()
	if p, ok := c.printers[tag]; ok {
		c.mu.RUnlock()
		return p
	}
	c.mu.RUnlock()

	c.mu.Lock()
	defer c.mu.Unlock()
	// Double-check after acquiring write lock
	if p, ok := c.printers[tag]; ok {
		return p
	}
	p := message.NewPrinter(tag)
	c.printers[tag] = p
	return p
}
```

**What FAANG expects:** Quantitative reasoning, the candidate should estimate the cost of `message.NewPrinter` (microseconds), multiply by QPS, and decide whether a cache is worth the memory/contention. At Google scale, a printer cache is standard. At 100 QPS, re-creating per request is fine and simpler. Mention client-side formatting (`Intl.*`) as the cheapest option when the client can bear it.

Follow-ups:
- What is the memory footprint of a `message.Printer` per locale, and when does a printer cache become a memory regression instead of a win?
- How do you avoid the lock-contention cliff on `sync.RWMutex` when 200 goroutines all look up the same uncached locale simultaneously? (`singleflight`, `sync.Map`, per-locale sharding)
- How does pre-formatting-at-write-time interact with user locale changes, do you re-format on read, store N variants, or fall back to client-side?

---

### Junior to FAANG: how to sound prepared on these questions

Every question above has a canonical short answer and a follow-up set that goes deeper. Prepare the canonical answer first. For each, practice a 60-second version and a 3-minute version. The 60-second version covers the terms and the mechanism. The 3-minute version adds an example and a trade-off.

The most commonly failed question is "explain Accept-Language negotiation." Candidates recite the algorithm but cannot name `language.MatchStrings`, cannot explain `Vary`, and cannot articulate why Accept-Language is the weakest signal. The fix: memorize `language.NewMatcher` and `language.MatchStrings` as the Go API, say "priority order: URL then cookie then Accept-Language then fallback," and mention that `Vary: Accept-Language` is required for CDN caching.

The second commonly failed is "what is pseudo-localization." Candidates describe it as "translate strings into fake languages for testing" without explaining expansion, sentinel wrapping, or CI gating. The fix: say "pseudo-localization transforms English into an expanded accented form wrapped in sentinels, runs in CI on every PR, catches text-overflow and hardcoded-English bugs before translators are involved." Name it as a CI quality gate.

The third commonly failed is "how do you test i18n code." Candidates suggest "test each locale." The fix: say "table-driven tests parameterized on locale, golden-file tests for large outputs, property-based tests for plural rules, visual regression for layout, and enum-all-locales for coverage completeness." Mention that CI matrix multiplies per locale, which affects build time, and you filter on launch-blocking locales for PR builds.

The fourth commonly failed is the performance question. Candidates either dismiss it ("Go is fast enough") or over-engineer it. The fix: quantify. "A `message.NewPrinter` call is on the order of microseconds. At 100k QPS that is a handful of CPU seconds per second, measurable but not dominant. At 10k QPS, ignorable. Cache the printer per locale with `sync.Map` if profiling shows contention. Pre-format only when the data is read more than it is written by a large margin. Client-side formatting via `Intl.*` is the cheapest when applicable."

For every question, the differentiator is specificity. Naming concrete APIs, concrete numbers, and concrete trade-offs wins. Generic answers lose.

### Senior at FAANG: where these questions expose platform maturity

At staff level, the interviewer is not testing whether you know the answer. They are testing whether you have operated the system that produces the answer. The tell is always in the follow-ups.

"What SLO would you set on % of rendered strings served from the user's primary locale" separates candidates who have shipped from those who have not. A strong answer picks a number (say, 99.95 percent for launch markets, 99 percent for secondary markets), explains the measurement (instrument at the formatter layer, emit per-locale per-key metrics), and describes the response (page the i18n on-call when the SLO burns, auto-file tickets against the content team). A weak answer says "I would measure it" without a number.

"How does your fallback strategy change when the untranslated string is a legal or medical disclaimer" probes policy maturity. The correct answer: legal and medical strings are marked in the catalog with a `require_translation` flag. Missing translations for these strings block the deploy, do not fall back to English. The product either ships without the feature in that locale, or delays the launch. This is documented in the launch-readiness checklist signed by legal.

"What is the privacy concern of storing customer-facing strings in a TM managed by a third-party vendor" probes compliance thinking. The correct answer: customer-facing strings may contain PII embedded in templated content (usernames, email fragments). Your TM vendor contract must specify data handling, residency, and deletion. Under GDPR, you need a DPA with the vendor. Under CCPA, you need disclosure. The platform engineer does not sign the contract but flags the requirement to legal and procurement.

"How do TM and machine translation coexist" probes workflow sophistication. The correct answer: MT produces a first-pass suggestion for new strings with no TM match. Human translators review MT output as a seed, not as final. MT output is never written back to TM until human-approved. This prevents MT error cascades where a bad MT result becomes a TM entry and propagates to future translations. Separate namespaces for MT-draft, human-approved, and MT-plus-human-reviewed translations.

"How do you handle user-generated content translation at latency budgets under 50ms" is the hard-mode question. The correct answer: pre-compute translations for high-volume UGC in batch jobs, not on the hot path. For real-time translation (chat messages, social posts), accept a 200ms to 2s latency window and stream the translation progressively. If sub-50ms is a hard requirement, use on-device MT models (mobile) or cached translations with a fallback to source-language display. Mention that Apple and Google both ship on-device translation in 2026 iOS and Android.

Every question in this section has a layer below what the interviewer asks. The staff signal is knowing the layer without being prompted.
