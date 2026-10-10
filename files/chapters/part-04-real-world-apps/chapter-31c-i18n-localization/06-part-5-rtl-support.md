## Part 5: RTL Support

RTL (right-to-left) support is detected by checking whether the resolved locale's script is one of the RTL scripts (Arabic, Hebrew, Persian, Urdu, Thaana) using `golang.org/x/text/language` script tags. The RTL flag is injected into template data so HTML templates can conditionally render `dir="rtl"` on the root element, applying the correct text direction without any client-side JavaScript. Bidirectional text mixing, RTL content with embedded LTR fragments like URLs, product codes, or inline code, relies on Unicode bidi isolate characters (U+2066/U+2067...U+2069) inserted by the formatter so the embedded fragment does not contaminate surrounding paragraph direction. On the CSS side, prefer logical properties (`margin-inline-start`, `padding-inline-end`, `text-align: start`) over physical ones. When logical properties are not available or a component needs per-direction tweaks, use BEM-style RTL variants (`.card--rtl`, `.icon--mirrored`) driven by a `dir` attribute on the `<html>` root, mirror directional glyphs (chevrons, arrows, progress indicators) with `transform: scaleX(-1)` rather than swapping PNGs.

```go
package rtl

import (
	"golang.org/x/text/language"
)

// RTL languages
var rtlLanguages = map[string]bool{
	"ar": true, // Arabic
	"he": true, // Hebrew
	"fa": true, // Persian (Farsi)
	"ur": true, // Urdu
	"yi": true, // Yiddish
	"ps": true, // Pashto
	"ks": true, // Kashmiri
	"dv": true, // Dhivehi
}

// IsRTL returns true if the locale uses right-to-left text direction
func IsRTL(locale string) bool {
	tag, err := language.Parse(locale)
	if err != nil {
		return false
	}
	base, _ := tag.Base()
	return rtlLanguages[base.String()]
}

// Direction returns "rtl" or "ltr" for a locale
func Direction(locale string) string {
	if IsRTL(locale) {
		return "rtl"
	}
	return "ltr"
}

// HTMLLang returns the HTML lang attribute value for a locale
func HTMLLang(locale string) string {
	tag, err := language.Parse(locale)
	if err != nil {
		return locale
	}
	return tag.String()
}

// TextAlign returns the CSS text-align for a locale
func TextAlign(locale string) string {
	if IsRTL(locale) {
		return "right"
	}
	return "left"
}

// LocaleMetadata provides metadata for template rendering
type LocaleMetadata struct {
	Locale    string
	Dir       string
	Lang      string
	TextAlign string
	IsRTL     bool
}

func GetLocaleMetadata(locale string) LocaleMetadata {
	return LocaleMetadata{
		Locale:    locale,
		Dir:       Direction(locale),
		Lang:      HTMLLang(locale),
		TextAlign: TextAlign(locale),
		IsRTL:     IsRTL(locale),
	}
}

// API response with locale-aware metadata
type LocalizedResponse struct {
	Data     any            `json:"data"`
	Locale   string         `json:"locale"`
	Dir      string         `json:"dir"`
	Messages map[string]string `json:"messages,omitempty"` // key messages for client
}

func NewLocalizedResponse(data any, locale string) LocalizedResponse {
	return LocalizedResponse{
		Data:   data,
		Locale: locale,
		Dir:    Direction(locale),
	}
}
```

### Junior to FAANG: RTL is not just flipping CSS

Your first RTL task will feel simple. Add `dir="rtl"` on `<html>` when the locale is Arabic, Hebrew, Persian, or Urdu. Done. Then a native Arabic user will file a bug that the product screenshots your QA team reviewed were wrong in seven subtle ways. Welcome to the real work.

The first surprise: numbers inside RTL paragraphs render LTR. Arabic reads right-to-left, but the number `1,234.56` inside an Arabic sentence still reads left-to-right. The Unicode Bidirectional Algorithm (UAX #9) handles this automatically when your text is clean. But when you concatenate `"Order " + order_id + " confirmed"` with an Arabic translation and a Latin-script order ID, the ID can appear to flip characters because the bidi algorithm resolves the run ambiguously at concatenation boundaries. The fix is to never concatenate. Use a templated message with a placeholder. The placeholder substitution inserts the value in a direction-isolated way.

The second surprise: some icons mirror, some do not. A back-arrow icon in an RTL UI points right (the direction of "back" reverses). A play button does not mirror (media controls are not directional). A shopping cart icon does not mirror (the cart is an object, not a direction). A progress bar mirrors (progress grows toward the start of reading direction). Document a per-icon mirror policy in your design system. CSS `transform: scaleX(-1)` on a class like `.icon--directional` handles the flip.

The third surprise: logos, phone numbers, URLs, and brand names stay LTR even inside RTL text. Wrap them in FSI isolates (First Strong Isolate, `U+2068` ... `U+2069`) or use explicit direction attributes. The bidi algorithm respects isolates and prevents the embedded LTR content from contaminating the surrounding paragraph.

Worked example. You render "Welcome to Google" in Arabic as "مرحباً بكم في Google". The word "Google" stays LTR. The surrounding Arabic stays RTL. The bidi algorithm handles this without isolates because "Google" is strong-LTR and the surrounding text is strong-RTL. But "Welcome to Google at 5:30 PM" embeds a time in a format that includes a colon. Colon and whitespace are neutral in bidi. The algorithm may resolve the time ambiguously depending on surrounding context. The fix is to wrap the time in an isolate: `مرحباً بكم في Google في ⁨ 5:30 PM ⁩`. Test with real Arabic text in your regression suite. Do not test with Latin characters reversed.

Interview framing. "How do you support RTL in a web app." The minimum answer covers: detect RTL from locale, set `dir="rtl"` on root, use CSS logical properties, mirror directional icons, use bidi isolates for mixed-direction text. If you mention UAX #9 by name and explain FSI, you are at the senior bar.

### Senior at FAANG: RTL at scale, from bidi correctness to regression testing

The `rtlLanguages` map in the example code is wrong as a production primitive. It hardcodes a list that CLDR maintains authoritatively. Use `language.Tag.Base()` and consult the CLDR script data to derive directionality, not a hand-maintained map. `golang.org/x/text` does not yet expose script directionality directly, but you can parse the tag's script (via `tag.Script()`) and check against the RTL script list (`Arab`, `Hebr`, `Thaa`, `Nkoo`, `Adlm`, and others), which CLDR updates as scripts are added to Unicode. Unicode adds new scripts, occasionally right-to-left ones, every few years (Unicode 17 in 2025 added four), so a hardcoded map drifts and CLDR is the authoritative source.

Bidi algorithm correctness is the deepest layer of RTL work. UAX #9 defines how a paragraph of mixed-direction text resolves into visual order for display. The algorithm has three phases: assign bidi classes to characters, resolve neutral characters based on surrounding strong characters, reorder runs for display. Go's `golang.org/x/text/unicode/bidi` implements this. You call it when producing plain-text output (like email subject lines, log messages, or search results) where the downstream renderer does not run its own bidi pass. In HTML output, the browser runs bidi for you, but you must give it the right hints with `dir` attributes and isolate characters.

Isolate characters deserve specific treatment. The Unicode isolates introduced in Unicode 6.3 are FSI (`U+2068`), LRI (`U+2066`), RLI (`U+2067`), and PDI (`U+2069`). FSI inspects the content and picks direction from the first strong character. LRI and RLI force LTR or RTL explicitly. PDI closes the isolate. Use FSI for user-generated content embedded in templated text (a user's display name inside a notification, a product title inside a cart summary) because you do not know the direction of the embedded content in advance. Use LRI for known-LTR content (URLs, product codes, technical identifiers). Use RLI when templating LTR-default strings with known-RTL placeholders. Do not use the older LRM and RLM marks as isolates. They are weaker and compose incorrectly inside nested content.

Logical CSS properties are the only correct approach to RTL-aware layout. Replace `margin-left` with `margin-inline-start`, `padding-right` with `padding-inline-end`, `text-align: left` with `text-align: start`. Browser support in 2026 is universal (logical properties ship in every current browser, even though the CSS Logical Properties Level 1 spec is still a Working Draft). No polyfill is needed. The design system must be built on logical properties from day one, or you will do a six-month rework when the first RTL market launches. I have been on that rework. Budget eight engineer-months for a midsize component library.

Bidirectional regression testing at scale requires real content, not lorem-ipsum-mirrored. Your regression suite maintains Arabic, Hebrew, Persian, and Urdu content fixtures covering the full range of UI flows. Each fixture renders the flow in the target RTL locale, captures a screenshot, and diffs against a reviewed baseline. The baselines are reviewed by native-speaker QA quarterly, because product copy changes and the baseline drifts. The tooling: Percy, Chromatic, or a custom harness over Playwright. The budget: two full-time QA engineers fluent in at least two RTL languages, plus the tooling cost. This is not optional at staff level. Airbnb, Google, and Meta all run equivalent programs.

Mirrored iconography is a design-system concern that an engineer cannot fix alone. The icon set must carry metadata about whether each icon mirrors. The runtime applies the mirror via CSS (`scaleX(-1)`) or by loading a pre-mirrored asset, depending on whether the icon has directional fidelity problems (chirality, embedded text) that a CSS flip would corrupt. A back-arrow flips cleanly. A swoopy branded arrow logo does not. The metadata and the runtime must agree. This is a design-system governance item: every new icon added goes through a mirror-policy review.

Typography in RTL needs locale-appropriate fonts. Arabic rendered in a font without Arabic glyphs falls back to system defaults that often look poor. Hebrew has the same issue. Persian needs a font that supports Persian-specific glyph variants (like the Persian heh form) which not every Arabic-supporting font provides. Your web fonts must declare `unicode-range` correctly so the browser loads Arabic glyphs when needed and not for LTR locales. Font-performance budgets matter more in RTL because a missing glyph fallback causes visible reflow.

Form fields in RTL have direction behavior distinct from page direction. An email input on an Arabic page stays LTR because email addresses are LTR. A password field usually stays LTR because passwords are typed in a mix of scripts. A name field for a native speaker stays RTL for Arabic names. The `dir="auto"` attribute on an input asks the browser to guess direction from the first strong character, which is correct for most user-input fields. Use `dir="auto"` on every text input that accepts user-generated content. Override with explicit `dir="ltr"` for URL, email, and numeric fields.

Search across RTL and LTR content is a separate engineering problem. Elasticsearch with ICU analyzers handles tokenization correctly, but the query UI needs to accept mixed-direction input without breaking. A user searching for an English product name in an Arabic UI types the English query in an RTL-default field. The field must accept LTR input, render it LTR (via `dir="auto"`), and send the query unchanged to the search backend. The highlighting of matches in results must use isolates so the highlighted LTR fragment does not break the RTL paragraph. This is the kind of detail that separates shipped-to-users RTL from demo-quality RTL.

Accessibility of RTL UIs has a screen-reader dimension. Arabic screen readers (like NVDA with Arabic voices, or VoiceOver with Arabic) pronounce the content based on the `lang` attribute on the enclosing element. If you set `dir="rtl"` but leave `lang="en"`, the screen reader reads Arabic content with English phonetics, producing nonsense. Every locale-switched region of the page must have a correct `lang` attribute. For a page mostly in Arabic with an English product name, the English name should be wrapped in `<span lang="en" dir="ltr">...</span>`. This is non-negotiable for WCAG compliance.

Cultural review is the final layer. Colors, icons, date formats, name fields, and address fields have cultural expectations in Arabic-speaking, Hebrew-speaking, and Persian-speaking markets that diverge from Western defaults. Name fields need to support non-Latin scripts and may not match Western given-name-family-name patterns (Arabic names often include patronymics). Address fields need per-country templates (Saudi vs Egyptian vs Moroccan addresses differ). Phone number formatting uses libphonenumber which respects country-specific formats. Your platform needs a cultural review checklist per launch market, run by someone native to that culture, not just a translator. This is an l10n operations item owned jointly with engineering.

---
