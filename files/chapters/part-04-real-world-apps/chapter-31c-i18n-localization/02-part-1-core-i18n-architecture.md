## Part 1: Core i18n Architecture

The i18n architecture separates message catalogs from the translation lookup engine: catalogs are loaded once at startup into an in-memory map keyed by locale tag, and the `Localizer` struct resolves messages by locale at request time without re-reading files. The `golang.org/x/text/language` package's BCP 47 matcher negotiates between the client's Accept-Language preferences and the application's supported locales, falling back to the default locale when no match is found. Locale-specific data like plural rules is stored alongside the message catalog rather than hardcoded in Go, making it possible to add a new language by adding files without recompiling.

Two libraries dominate Go i18n in production today. `golang.org/x/text` (the canonical, Unicode-team-maintained package) ships CLDR data, the plural evaluator, number/currency/date formatters, collation, normalization, and the bidi algorithm. Its sibling `gotext` CLI extracts and compiles catalogs. For projects that want TOML/YAML/JSON catalog files and ICU-style MessageFormat syntax with minimal ceremony, `github.com/nicksnyder/go-i18n/v2` wraps x/text's plural rules in a friendlier API, code-generates from CLDR data, and is the community's go-to library. The chapter uses x/text directly so the moving parts are visible, but production code often adopts go-i18n v2 on top of it. CLDR data embedded in x/text ships with each x/text release, track the release changelog rather than pinning to a specific CLDR version in your documentation.

```go
package i18n

import (
	"embed"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/text/feature/plural"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
	"golang.org/x/text/message/catalog"
)

// Locale represents a language tag (e.g., "en-US", "ja-JP", "ar-SA")
type Locale string

// Common locales
const (
	LocaleEnUS Locale = "en-US"
	LocaleEnGB Locale = "en-GB"
	LocaleJaJP Locale = "ja-JP"
	LocaleZhCN Locale = "zh-CN"
	LocaleArSA Locale = "ar-SA"
	LocaleDeDe Locale = "de-DE"
	LocaleFrFR Locale = "fr-FR"
	LocalePtBR Locale = "pt-BR"
	LocaleEsES Locale = "es-ES"
	LocaleKoKR Locale = "ko-KR"
)

// Bundle manages all loaded translations
type Bundle struct {
	mu          sync.RWMutex
	translations map[Locale]map[string]string
	catalog     *catalog.Builder
	matcher     language.Matcher
	fallback    Locale
}

//go:embed locales/*.json
var localeFS embed.FS

// NewBundle loads all translations from embedded locale files
func NewBundle(fallback Locale) (*Bundle, error) {
	b := &Bundle{
		translations: make(map[Locale]map[string]string),
		catalog:      catalog.NewBuilder(),
		fallback:     fallback,
	}

	if err := b.loadFromFS(localeFS, "locales"); err != nil {
		return nil, err
	}

	var tags []language.Tag
	for locale := range b.translations {
		tag, err := language.Parse(string(locale))
		if err == nil {
			tags = append(tags, tag)
		}
	}
	b.matcher = language.NewMatcher(tags)

	return b, nil
}

// loadFromFS loads translation files from a filesystem
func (b *Bundle) loadFromFS(fsys embed.FS, dir string) error {
	entries, err := fsys.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read locale dir: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		localeName := strings.TrimSuffix(entry.Name(), ".json")
		locale := Locale(localeName)

		data, err := fsys.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			return fmt.Errorf("read %s: %w", entry.Name(), err)
		}

		var msgs map[string]string
		if err := json.Unmarshal(data, &msgs); err != nil {
			return fmt.Errorf("parse %s: %w", entry.Name(), err)
		}

		b.mu.Lock()
		b.translations[locale] = msgs
		b.mu.Unlock()
	}
	return nil
}

// Localizer provides translation for a specific locale
type Localizer struct {
	bundle  *Bundle
	locale  Locale
	printer *message.Printer
	tag     language.Tag
}

// NewLocalizer creates a localizer for the given locale
func (b *Bundle) NewLocalizer(locale Locale) *Localizer {
	tag, err := language.Parse(string(locale))
	if err != nil {
		tag, _ = language.Parse(string(b.fallback))
	}

	// Match to best available locale
	matched, _, _ := b.matcher.Match(tag)

	return &Localizer{
		bundle:  b,
		locale:  Locale(matched.String()),
		printer: message.NewPrinter(matched),
		tag:     matched,
	}
}

// T translates a message key with optional arguments
func (l *Localizer) T(key string, args ...any) string {
	l.bundle.mu.RLock()
	msgs, ok := l.bundle.translations[l.locale]
	if !ok {
		// Fall back to default locale
		msgs = l.bundle.translations[l.bundle.fallback]
	}
	l.bundle.mu.RUnlock()

	template, ok := msgs[key]
	if !ok {
		// Key not found: return key itself (better than empty string)
		return key
	}

	if len(args) == 0 {
		return template
	}

	return fmt.Sprintf(template, args...)
}

// Tf translates with named parameters (ICU-style)
func (l *Localizer) Tf(key string, data map[string]any) string {
	l.bundle.mu.RLock()
	msgs, ok := l.bundle.translations[l.locale]
	if !ok {
		msgs = l.bundle.translations[l.bundle.fallback]
	}
	l.bundle.mu.RUnlock()

	template, ok := msgs[key]
	if !ok {
		return key
	}

	return interpolate(template, data)
}

// interpolate replaces {{key}} placeholders with values
func interpolate(template string, data map[string]any) string {
	result := template
	for k, v := range data {
		placeholder := "{{" + k + "}}"
		result = strings.ReplaceAll(result, placeholder, fmt.Sprintf("%v", v))
	}
	return result
}

// Plural translates a pluralized message
// keys: "zero", "one", "two", "few", "many", "other"
func (l *Localizer) Plural(key string, count int, args ...any) string {
	pluralKey := key + "." + l.pluralForm(count)

	l.bundle.mu.RLock()
	msgs, ok := l.bundle.translations[l.locale]
	if !ok {
		msgs = l.bundle.translations[l.bundle.fallback]
	}
	l.bundle.mu.RUnlock()

	template := msgs[pluralKey]
	if template == "" {
		// Fall back to "other"
		template = msgs[key+".other"]
	}
	if template == "" {
		return key
	}

	allArgs := append([]any{count}, args...)
	return fmt.Sprintf(template, allArgs...)
}

// pluralForm returns the CLDR plural category for count in this locale.
// It delegates to golang.org/x/text/feature/plural, which evaluates the
// full CLDR cardinal rules for every language x/text ships data for,
// rather than re-implementing Arabic/Slavic/etc. rules by hand (which
// drifts from CLDR on every data release).
//
// The trailing zeros in MatchPlural correspond to the CLDR operands
// (i, v, w, f, t) used for fractional-aware selection - for integer
// counts they are all zero.
func (l *Localizer) pluralForm(count int) string {
	form := plural.Cardinal.MatchPlural(l.tag, count, 0, 0, 0, 0)
	switch form {
	case plural.Zero:
		return "zero"
	case plural.One:
		return "one"
	case plural.Two:
		return "two"
	case plural.Few:
		return "few"
	case plural.Many:
		return "many"
	default:
		return "other"
	}
}
```

### Junior to FAANG: reading the architecture without getting lost

Before you internalize the code, draw the data flow. A request arrives with an `Accept-Language` header. A middleware parses it into a `language.Tag`. The `language.Matcher` maps that tag to one of your supported locales, falling back if necessary. The matched tag constructs a `Localizer`, which holds a `message.Printer` bound to the locale and a reference to the shared `Bundle`. The handler calls `localizer.T("greeting.hello", name)`. That call reads the message template for the matched locale out of the bundle's map, substitutes arguments, and returns the string. Nothing in that flow touches the filesystem at request time. Catalogs load once at startup.

The non-obvious piece is the `language.Matcher`. It is not a string comparison. It is a BCP 47 matcher that understands language inheritance. A request for `pt` (Portuguese, no region) against a bundle supporting `pt-BR` and `pt-PT` will match `pt-BR` if you list it first in the matcher. A request for `en-CA` against a bundle with `en-US` and `en-GB` will match `en-US` because the matcher treats American English as the default English variant. This is why the order you pass tags to `language.NewMatcher` matters. Put your launch markets first.

Worked example. Add a new locale. Create `locales/de-DE.json` with `{"greeting.hello": "Hallo %s"}`. Restart the service. Send a request with `Accept-Language: de`. Observe that the matcher resolves to `de-DE`. Confirm that `localizer.T("greeting.hello", "User")` returns `"Hallo User"`. That is the smallest possible end-to-end validation of the architecture. If it does not work, your problem is almost always file embedding (the `embed.FS` directive does not pick up files added after the binary compiles) or a malformed language tag.

Interview framing. Expect "how would you structure a Go i18n service." The answer walks through the three layers: bundle (load-time), matcher (per-request locale resolution), and localizer (per-request formatter). Name `golang.org/x/text` explicitly. Name BCP 47. Explain why you hold the printer per-request not per-process (because the locale is request-scoped and printers are cheap to construct). If you can sketch this on a whiteboard in three boxes and two arrows, you have demonstrated the architecture bar.

### Senior at FAANG: production hardening beyond the textbook sketch

The code above is a textbook sketch. Production architecture differs in several non-negotiable ways. First, the bundle is not a `map[Locale]map[string]string`. It is an immutable snapshot loaded atomically and swapped via `atomic.Pointer[Bundle]` so hot-reload does not require request-time locking. The `sync.RWMutex` in the sketch becomes a latency contributor once you have tens of thousands of QPS, and a contended RWMutex on read-heavy paths is measurably worse than a pointer load. Second, the catalog is not loaded from JSON at startup. It is compiled into a Go package via `gotext` or an equivalent code-generation step, so the binary ships with the catalog as compiled constants. File IO at startup is an availability risk. Compiled catalogs are not.

Third, the fallback strategy in the sketch is single-hop. Production fallback walks a chain. For a matched tag `de-AT`, fallback order is `de-AT then de then de-DE then en-US`. The `golang.org/x/text/language` matcher handles the first three implicitly when you register the right tags, but you must be explicit about which regional default is the intra-language fallback. For English, that is typically `en-US`. For Portuguese, it is either `pt-BR` or `pt-PT` depending on your market mix. Document this. Audit it quarterly.

Fourth, missing-key behavior is a product decision, not a default. The sketch returns the key itself, which leaks implementation details to users. Production behavior is: in development, return a bright sentinel (`[[MISSING: greeting.hello]]`) that visual regression tests flag. In staging, return the English fallback and emit a metric. In production, return the English fallback, emit a metric, and rate-limit the metric so a missing key does not spam your logs at 100k QPS. The rate-limited emission is critical. I have seen a missing-key storm fill a logging pipeline's ingestion quota and drop security audit events.

Fifth, the `T` function's use of `fmt.Sprintf` with a translated template string is a subtle footgun. Translators can change format verbs. A translator writing `"Hallo %d"` when the source is `"Hello %s"` crashes your handler at runtime. The mitigation is to validate at catalog-load time that every translated string parses to the same set of format verbs as the source, in the same order. Either reject the catalog at build time or fail the deployment. Never ship a catalog that fails source-verb parity.

Sixth, ICU-style placeholder interpolation (the `{{name}}` pattern in `Tf`) needs escape handling. Translators legitimately need to write literal braces in some locales (French typography, for instance). The sketch's `strings.ReplaceAll` cannot handle escapes. Production interpolation uses a real tokenizer. If you adopt MF2, the tokenizer comes for free. If you stay on custom templates, write the tokenizer once and test it against a fuzz corpus that includes every CLDR locale's sample strings.

Seventh, plural resolution via the sketch's `pluralForm` switch is correct but brittle. The CLDR plural categories are defined per locale, and a category that exists in one locale does not exist in another. Russian has `one`, `few`, `many`, `other`. Japanese has only `other`. If you ship a catalog that defines a `russian.few` translation but no `japanese.other`, the Japanese fallback to `other` will miss and the sketch returns the key. Production catalogs validate at build time that every pluralized message has, at minimum, an `other` form for every supported locale, and has every plural form required by CLDR for that specific locale.

Eighth, the `Localizer` should carry a request-scoped correlation ID and emit per-request translation events to a telemetry pipeline. You will eventually need to answer "why did user X see the wrong translation on locale Y at timestamp Z." Without per-request telemetry tying the matched tag, fallback chain, and missing-key set back to a correlation ID, that question is unanswerable and you will debug it by reading logs forever.

Ninth, multi-tenant override is a first-class feature at platform scale. A single catalog is the default, but tenants can override specific keys. Airbnb Plus sees different copy than standard Airbnb. A white-label SaaS customer overrides brand-name references. The override layer is a second bundle that shadows the default, keyed by tenant ID, loaded at startup, refreshed on tenant config change. The resolution order is tenant-override then default-catalog then fallback-chain. This is not optional at staff level. It is how brand teams ship copy changes without a code deploy.

Tenth, CLDR version pinning is a supply-chain concern. The sketch's comment about tracking x/text changelog is correct but insufficient. You lock the x/text version in `go.mod` and you run a scheduled job that diffs the CLDR data between the locked version and the latest release. The diff flags locale additions, plural category changes, and number format changes. Any diff that affects an active market blocks its automatic adoption and files a ticket for localization review. Unicode 17 and CLDR 47 both shipped in 2025 with real plural-category-adjacent changes. You cannot consume them blindly.

---
