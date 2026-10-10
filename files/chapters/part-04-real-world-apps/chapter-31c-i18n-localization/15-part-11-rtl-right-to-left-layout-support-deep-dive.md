## Part 11: RTL (Right-to-Left) Layout Support - detailed look

The chapter's Part 5 introduced RTL basics. This section covers production-grade RTL implementation including the Unicode Bidirectional Algorithm, Go middleware, and mixed-direction content handling.

### The Unicode Bidirectional Algorithm (UBA)

The Unicode Bidi Algorithm (UAX #9) defines how text with mixed directionality is displayed. Key concepts:

- **Base paragraph direction**: The overall direction (LTR or RTL) determined from the first strong character.
- **Bidi levels**: Each character is assigned a nesting level (even = LTR, odd = RTL).
- **Bidi marks**: Zero-width control characters (`U+200F` RIGHT-TO-LEFT MARK, `U+200E` LEFT-TO-RIGHT MARK) that influence ordering without visible output.
- **Isolates**: Unicode 6.3 added `U+2066`-`U+2069` for directional isolates, preventing bidi contamination across element boundaries.

RTL locales that require full support: Arabic (`ar`), Hebrew (`he`), Persian/Farsi (`fa`), Urdu (`ur`), Pashto (`ps`), Sindhi (`sd`), Thaana/Maldivian (`dv`), and Yiddish (`yi`).

### Detecting RTL Locale in Go

Rather than maintaining a hardcoded list of language codes, the implementation below checks the Unicode script associated with the language tag. This approach is more maintainable because it automatically handles regional variants (e.g., `ar-EG`, `ar-MA`) and newly registered subtags without code changes. The `rtlScripts` map includes both modern scripts (Arabic, Hebrew, Thaana) and historical scripts for completeness.

```go
package rtl

import "golang.org/x/text/language"

// rtlScripts lists Unicode scripts that are right-to-left.
var rtlScripts = map[string]bool{
	"Arab": true, // Arabic
	"Hebr": true, // Hebrew
	"Thaa": true, // Thaana (Maldivian Dhivehi)
	"Cprt": true, // Cypriot (historical, included for completeness)
	"Khar": true, // Kharoshthi (historical)
	"Phnx": true, // Phoenician
	"Nkoo": true, // N'Ko
	"Lydi": true, // Lydian
	"Avst": true, // Avestan
	"Armi": true, // Imperial Aramaic
	"Orkh": true, // Old Turkic
	"Samr": true, // Samaritan
	"Mand": true, // Mandaic
	"Merc": true, // Meroitic Cursive
	"Mero": true, // Meroitic Hieroglyphs
	"Mani": true, // Manichaean
	"Nbat": true, // Nabataean
	"Palm": true, // Palmyrene
	"Phlp": true, // Psalter Pahlavi
	"Hatr": true, // Hatran
	"Hung": true, // Old Hungarian
	"Adlm": true, // Adlam
}

// IsRTL reports whether the given language tag uses a right-to-left script.
func IsRTL(tag language.Tag) bool {
	script, _ := tag.Script()
	return rtlScripts[script.String()]
}

// Dir returns "rtl" or "ltr" for use in HTML dir attributes.
func Dir(tag language.Tag) string {
	if IsRTL(tag) {
		return "rtl"
	}
	return "ltr"
}

// Usage
// Dir(language.Arabic)  → "rtl"
// Dir(language.Hebrew)  → "rtl"
// Dir(language.Persian) → "rtl"
// Dir(language.English) → "ltr"
// Dir(language.Chinese) → "ltr"
```

### Using golang.org/x/text/unicode/bidi

The `golang.org/x/text/unicode/bidi` package implements the Unicode Bidirectional Algorithm (UAX #9) in Go. `DetectDirection` below inspects each rune's bidi class until it finds the first strong character (L for left-to-right, R or AL for right-to-left), which determines the paragraph's base direction. `WrapBidiIsolate` wraps a text fragment in Unicode directional isolate characters (U+2066/U+2067 ... U+2069), preventing it from affecting the surrounding paragraph's reordering - this is the correct way to embed a URL or product code inside an RTL sentence.

```go
package rtl

import (
	"golang.org/x/text/unicode/bidi"
	"unicode/utf8"
)

// DetectDirection returns the base paragraph direction of the given text
// by inspecting the first strongly-typed character per UAX #9.
func DetectDirection(text string) bidi.Direction {
	for len(text) > 0 {
		r, size := utf8.DecodeRuneInString(text)
		text = text[size:]
		p, _ := bidi.LookupRune(r)
		switch p.Class() {
		case bidi.L:
			return bidi.LeftToRight
		case bidi.R, bidi.AL:
			return bidi.RightToLeft
		}
	}
	return bidi.LeftToRight // Default
}

// DirectionString converts a bidi.Direction to an HTML dir attribute value.
func DirectionString(d bidi.Direction) string {
	if d == bidi.RightToLeft {
		return "rtl"
	}
	return "ltr"
}

// AutoDir returns the detected direction of user-supplied content,
// useful for chat messages where the language is user-determined.
func AutoDir(userInput string) string {
	return DirectionString(DetectDirection(userInput))
}

// WrapBidiIsolate wraps text in Unicode bidi isolate characters so that
// it does not affect the surrounding paragraph direction.
func WrapBidiIsolate(text string, dir bidi.Direction) string {
	if dir == bidi.RightToLeft {
		// U+2067 RIGHT-TO-LEFT ISOLATE ... U+2069 POP DIRECTIONAL ISOLATE
		return "\u2067" + text + "\u2069"
	}
	// U+2066 LEFT-TO-RIGHT ISOLATE ... U+2069 POP DIRECTIONAL ISOLATE
	return "\u2066" + text + "\u2069"
}
```

### HTML Template Integration - Injecting dir Attributes

The `TemplateData` struct carries the resolved direction (`Dir`), language tag (`Lang`), and a boolean `IsRTL` flag into every HTML template. The base template uses these to set `lang` and `dir` attributes on the `<html>` element and conditionally load an RTL-specific stylesheet. This approach keeps direction logic server-side - the client receives a fully correct HTML document without needing JavaScript to detect and apply text direction.

```go
package templates

import (
	"html/template"
	"net/http"
	"golang.org/x/text/language"
)

// TemplateData carries locale-aware layout information to every template.
type TemplateData struct {
	Locale    string
	Dir       string        // "ltr" or "rtl"
	Lang      string        // BCP 47 tag, e.g. "ar", "he-IL"
	IsRTL     bool
	T         func(key string, args ...any) string
	Content   any
}

// NewTemplateData constructs TemplateData from a resolved language tag.
func NewTemplateData(tag language.Tag, t func(string, ...any) string, content any) TemplateData {
	dir := "ltr"
	isRTL := false
	if IsRTL(tag) {
		dir = "rtl"
		isRTL = true
	}
	return TemplateData{
		Locale:  tag.String(),
		Dir:     dir,
		Lang:    tag.String(),
		IsRTL:   isRTL,
		T:       t,
		Content: content,
	}
}

// Base HTML template demonstrating proper RTL/LTR switching
var baseTemplate = template.Must(template.New("base").Parse(`
<!DOCTYPE html>
<html lang="{{.Lang}}" dir="{{.Dir}}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{call .T "app.title"}}</title>
    <link rel="stylesheet" href="/static/app.css">
    {{if .IsRTL}}
    <link rel="stylesheet" href="/static/rtl.css">
    {{end}}
</head>
<body class="{{if .IsRTL}}rtl{{else}}ltr{{end}}">
    <header>
        <nav>
            <a href="/">{{call .T "nav.home"}}</a>
            <a href="/about">{{call .T "nav.about"}}</a>
        </nav>
    </header>
    <main>{{template "content" .}}</main>
</body>
</html>
`))
```

### Go Middleware That Adds RTL Headers

The middleware below resolves the user's locale, determines its text direction, and stores both in the request context. It also sets `X-Content-Direction` and `X-Content-Language` response headers so API clients (mobile apps, SPAs) can apply the correct layout direction without parsing the response body.

```go
package middleware

import (
	"context"
	"net/http"
	"golang.org/x/text/language"
)

type contextKey string

const (
	ctxKeyLocale    contextKey = "locale"
	ctxKeyDir       contextKey = "dir"
	ctxKeyIsRTL     contextKey = "isRTL"
)

// RTLMiddleware detects the user's locale and injects direction information
// into the request context and HTTP response headers.
func RTLMiddleware(localeResolver func(*http.Request) language.Tag) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tag := localeResolver(r)
			dir := Dir(tag) // "rtl" or "ltr"
			isRTL := IsRTL(tag)

			// Inject into response headers so API clients can adapt their UI
			w.Header().Set("X-Content-Direction", dir)
			w.Header().Set("X-Content-Language", tag.String())

			// Store in context for downstream handlers and templates
			ctx := context.WithValue(r.Context(), ctxKeyLocale, tag)
			ctx = context.WithValue(ctx, ctxKeyDir, dir)
			ctx = context.WithValue(ctx, ctxKeyIsRTL, isRTL)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// DirFromContext retrieves the text direction from context.
func DirFromContext(ctx context.Context) string {
	if dir, ok := ctx.Value(ctxKeyDir).(string); ok {
		return dir
	}
	return "ltr"
}

// IsRTLFromContext retrieves whether the locale is RTL from context.
func IsRTLFromContext(ctx context.Context) bool {
	if v, ok := ctx.Value(ctxKeyIsRTL).(bool); ok {
		return v
	}
	return false
}
```

### CSS Logical Properties for RTL/LTR Agnostic Layouts

Instead of using `margin-left`/`margin-right` which are physical, use CSS logical properties. The Go template layer can still output the right classes:

```go
// CSSClass returns a direction-aware CSS class suffix.
func CSSClass(tag language.Tag) string {
	if IsRTL(tag) {
		return "rtl"
	}
	return "ltr"
}
```

```css
/* rtl.css - loaded only for RTL locales */
/* CSS Logical Properties - no overrides needed with modern CSS */
.sidebar {
    margin-inline-start: 0;
    margin-inline-end: 1rem;
}
.icon {
    /* Flip chevron/arrow icons in RTL */
    transform: scaleX(-1);
}
/* Override Bootstrap or legacy float-based layouts */
.float-start { float: right !important; }
.float-end   { float: left  !important; }
.text-start  { text-align: right !important; }
.text-end    { text-align: left  !important; }
```

### Handling Mixed RTL/LTR Content

In a chat application, user A writes in Arabic (RTL) and user B replies in English (LTR). Each message must carry its own direction.

```go
package chat

import (
	"html/template"
)

// Message holds a chat message with auto-detected direction.
type Message struct {
	Author  string
	Content string
	Dir     string // "rtl" or "ltr", detected per message
}

// NewMessage creates a Message with auto-detected bidi direction.
func NewMessage(author, content string) Message {
	return Message{
		Author:  author,
		Content: content,
		Dir:     AutoDir(content), // Detect from first strong character
	}
}

// MessageTemplate renders each message bubble with correct dir attribute.
var MessageTemplate = template.Must(template.New("msg").Parse(`
<div class="message" dir="{{.Dir}}">
    <span class="author">{{.Author}}</span>
    <p class="content">{{.Content}}</p>
</div>
`))
```

### Junior to FAANG: where RTL gets confusing past the basics

The chat example is the right mental model for mixed-direction content. Every chunk of user-generated text carries its own direction, detected from the first strong character, set as the `dir` attribute on its enclosing element. The browser applies UAX #9 correctly within that scope. If you try to apply a single page-level direction to all content, you will see Arabic messages rendered in LTR layout (with text aligned left), which looks broken to an Arabic reader.

The pitfall beneath "auto-detect direction" is that detection fails for short strings with no strong characters (just numbers and punctuation). An Arabic user typing "50%" has a message with no strong direction. The auto-detector falls back to LTR. An Arabic user reading that in a chat thread sees the percent sign placed on the wrong side of the number. The fix is to inherit direction from the enclosing context when the content has no strong direction. The `dir="auto"` attribute does this natively in browsers. Prefer it over hand-rolled detection for user-generated content in HTML.

Worked example. An Arabic user in a chat sends three messages: "مرحبا" (pure Arabic), "Hello" (pure Latin), and "Call me at 555-1234" (English with digits). Each message needs its own direction. The first is RTL, the second is LTR, the third is LTR (starts with strong-LTR "Call"). If you apply a single page-level RTL, the Latin messages render with punctuation in wrong positions. If you apply per-message auto-detect, all three render correctly.

Interview framing. "How do you handle chat messages in mixed languages." The answer: per-message direction attribute, detect from first strong character, fall back to parent direction for neutral-only content, use `dir="auto"` in HTML to let the browser handle detection.

### Senior at FAANG: RTL correctness beyond the middleware

The middleware pattern in the example code is correct as far as it goes. The staff-level concerns start beyond it.

First, direction is a property of content, not of users. A French user on an Arabic news site reading an Arabic article is in an RTL page, regardless of the user's locale preference. A URL parameter, a Cookie, and a user profile all input into locale choice, but the rendered page direction is determined by what the user is looking at, not who is looking. Document this. Services that conflate user locale with page direction produce incorrect layouts when users browse content in languages other than their preferred one.

Second, bidi correctness in generated content (emails, PDFs, printable receipts) is a separate work track. The browser runs UAX #9 for you. A PDF generator does not. If you emit Arabic text to a PDF library that does not implement UAX #9 (many older libraries), the visual order is wrong. The text reads right-to-left in the code but left-to-right on the page, producing gibberish. Use a PDF library with explicit bidi support (HarfBuzz-backed libraries, `unipdf`, or wkhtmltopdf which inherits browser bidi). Test every generated artifact in RTL.

Third, form-field direction is independent from page direction and must be set per field. An email input on an Arabic page stays LTR. A name field stays `dir="auto"` to detect from user input. A numeric field (phone, credit card) stays LTR. A password field stays LTR (passwords contain mixed scripts, LTR is the expected input mode). The direction attribute goes on each input, not inherited from the page. Test this with real Arabic content. Users who type Arabic into a field that does not display Arabic correctly will abandon the form.

Fourth, tables and grids need per-axis attention. A table in an RTL page has column order reversed (first column on the right). Headers align with reversed content. Sort indicators (arrows) mirror. Numeric columns within the table may or may not align right (currency columns typically align trailing-end, which in RTL is the left side). The design system component `Table` must have explicit RTL support with tested visual regression, not inherit default CSS behavior. This is one or two engineer-weeks of work per component library.

Fifth, pagination, breadcrumbs, and stepper components are directional. "Next page" points right in LTR, left in RTL. Breadcrumb separators (">") mirror to ("<") in RTL. A stepper showing "Step 1 of 3" progresses right-to-left in RTL. Each of these is a design decision plus an implementation. Do not rely on default CSS. Explicitly mirror.

Sixth, character set completeness in fonts is a performance concern. The browser falls back to system fonts when a web font does not contain Arabic glyphs. Fallback is slow and produces mismatched typography. If your brand has a web font and you launch in Arabic markets, either source an Arabic variant of the brand font, or accept system-font fallback and document the brand concession. A third option (licensing an Arabic font and stitching `@font-face` ranges) is the staff-level correct answer but costs time and money.

Seventh, input method editors (IMEs) for RTL scripts are their own UX consideration. Arabic keyboards exist in multiple layouts. Persian uses a different keyboard than Arabic, though both use Arabic script. Urdu users may use Arabic keyboards or specialized Urdu keyboards. Your form fields must work correctly with any of them. This is usually transparent (the browser handles keyboard input), but autofocus behavior, caret positioning, and paste-handling can differ. Test with real RTL keyboards on real devices.

Eighth, screen reader compatibility in RTL is a WCAG 2.1 and WCAG 2.2 requirement. A screen reader reading Arabic content with an English `lang` attribute pronounces it with English phonetics, producing noise. Every localized region needs the correct `lang` attribute. Arabic has variants (Modern Standard Arabic `ar`, Saudi `ar-SA`, Egyptian `ar-EG`, Moroccan `ar-MA`) with distinct pronunciations. The `lang` attribute should match the content's variant, not the site's default. Professional screen readers (NVDA, JAWS, VoiceOver) have locale-specific voices, and the voice selected depends on the `lang` attribute. For WCAG AA compliance, this is mandatory.

Ninth, RTL regression testing at scale requires native-speaker review. Automated visual regression catches layout overflow and clipping. It does not catch "this Arabic translation is correct but reads awkwardly in context" or "this Persian translation uses colloquial forms not appropriate for business UX." Professional localization QA runs these reviews, and you budget for it per launch market. Large consumer platforms staff native-speaker QA engineers for their major RTL markets. Smaller orgs outsource to agencies. Either way, this is non-skippable.

Tenth, the handoff between design and engineering for RTL requires a shared vocabulary. Designers in a typical tool (Figma) can set direction to RTL, but their work on an RTL version is separate from the LTR version unless they use variables and constraints carefully. Engineers translating designs to code need RTL mockups that show exactly how each component mirrors, what stays in place, and what changes beyond direction (spacing, font, weight). The design system must document mirror policy per component. Without this, every launch in an RTL market repeats the same debate about icon mirroring and component behavior.

UBA edge cases worth naming. Nested bidi (RTL inside LTR inside RTL) needs isolates at each level. Bidi marks (LRM, RLM) are zero-width but present in the text. They can be copy-pasted into unexpected places and cause puzzling layout bugs weeks later. Some input normalization strips them, which may or may not be correct depending on user intent. A general rule: preserve bidi marks in user-generated content, strip them from identifiers and technical fields (usernames, URLs, code).

---
