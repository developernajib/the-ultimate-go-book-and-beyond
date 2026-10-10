## Part 14: Additional Exercises

The following exercises extend the exercises already in this chapter.

---

### Exercise 10: Locale-Aware API That Returns Formatted Prices, Dates, and Numbers

Build a Go HTTP API that returns product data formatted according to the caller's locale. The API must:
- Accept `Accept-Language` header or `?locale=` query parameter
- Return prices formatted with the correct currency symbol and decimal conventions
- Return dates in the locale's conventional format
- Return quantities with locale-appropriate number grouping
- Include `X-Content-Language` and `X-Content-Direction` in all responses

**Skeleton:**

```go
package main

import (
	"encoding/json"
	"net/http"
	"golang.org/x/text/currency"
	"golang.org/x/text/language"
)

type Product struct {
	ID           int    `json:"id"`
	Name         string `json:"name"`
	PriceCents   int64  `json:"-"`                // raw value, not exposed
	PriceDisplay string `json:"price"`             // locale-formatted
	Stock        int    `json:"-"`                 // raw value
	StockDisplay string `json:"stock"`             // locale-formatted
	CreatedAt    string `json:"created_at"`        // locale-formatted date
}

var products = []struct {
	ID         int
	Name       string
	PriceCents int64
	Stock      int
	CreatedRaw string // RFC3339
}{
	{1, "Wireless Headphones", 9999, 1234, "2025-06-15T00:00:00Z"},
	{2, "Mechanical Keyboard", 14999, 567, "2025-08-01T00:00:00Z"},
}

func productsHandler(w http.ResponseWriter, r *http.Request) {
	// TODO: Resolve locale from Accept-Language or ?locale= param
	// TODO: Format PriceCents, Stock, and CreatedRaw using locale-aware formatters
	// TODO: Set X-Content-Language and X-Content-Direction headers
	// TODO: Encode and return JSON
	_ = currency.USD
}

func main() {
	http.HandleFunc("/api/products", productsHandler)
	http.ListenAndServe(":8080", nil)
}
```

**Acceptance criteria:**
- `GET /api/products?locale=de-DE` returns `"price": "99,99 €"` and `"stock": "1.234"`
- `GET /api/products?locale=en-US` returns `"price": "$99.99"` and `"stock": "1,234"`
- `GET /api/products?locale=ja-JP` returns dates in `YYYY年MM月DD日` format
- Response includes `X-Content-Direction: ltr` (or `rtl` for Arabic)
- Missing locale param falls back gracefully to `en-US`

---

### Exercise 11: Pseudo-Localization Middleware for QA

Implement a Go HTTP middleware that intercepts JSON API responses and wraps all string values with `[!!! ... !!!]` pseudo-localization markers. This lets QA engineers browse the app with a `?pseudo=1` flag set and immediately identify any hardcoded (non-translated) strings visible in the UI.

**Requirements:**
- Activate only when request has `?pseudo=1` query parameter or `X-Pseudo-Locale: true` header
- Intercept the response body after the handler writes it
- Parse the JSON body, recursively walk all string values, apply pseudo-localization transform
- Re-encode and write the transformed JSON
- Do not transform string values that are: URLs (start with `http`), ISO dates (match `\d{4}-\d{2}-\d{2}`), currency codes (3 uppercase letters), numeric strings
- Preserve all non-string JSON values unchanged
- Add `X-Pseudo-Locale: active` to the response header when active

```go
package middleware

import (
	"bytes"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

var (
	reDate     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`)
	reCurrency = regexp.MustCompile(`^[A-Z]{3}$`)
	reNumeric  = regexp.MustCompile(`^\d+(\.\d+)?$`)
)

func shouldSkipPseudo(s string) bool {
	return strings.HasPrefix(s, "http") ||
		reDate.MatchString(s) ||
		reCurrency.MatchString(s) ||
		reNumeric.MatchString(s)
}

func pseudoLocalizeValue(v any) any {
	switch val := v.(type) {
	case string:
		if shouldSkipPseudo(val) {
			return val
		}
		return PseudoLocalize(val)
	case map[string]any:
		result := make(map[string]any, len(val))
		for k, inner := range val {
			result[k] = pseudoLocalizeValue(inner)
		}
		return result
	case []any:
		result := make([]any, len(val))
		for i, item := range val {
			result[i] = pseudoLocalizeValue(item)
		}
		return result
	default:
		return v
	}
}

type responseCapture struct {
	http.ResponseWriter
	buf    bytes.Buffer
	status int
}

func (rc *responseCapture) Write(b []byte) (int, error) {
	return rc.buf.Write(b)
}

func (rc *responseCapture) WriteHeader(code int) {
	rc.status = code
}

// PseudoLocaleMiddleware wraps JSON responses with pseudo-localization markers.
func PseudoLocaleMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		active := r.URL.Query().Get("pseudo") == "1" ||
			r.Header.Get("X-Pseudo-Locale") == "true"

		if !active {
			next.ServeHTTP(w, r)
			return
		}

		cap := &responseCapture{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(cap, r)

		body := cap.buf.Bytes()
		var parsed any
		if err := json.Unmarshal(body, &parsed); err != nil {
			// Not JSON - pass through unchanged
			w.WriteHeader(cap.status)
			w.Write(body)
			return
		}

		transformed := pseudoLocalizeValue(parsed)
		newBody, err := json.Marshal(transformed)
		if err != nil {
			w.WriteHeader(cap.status)
			w.Write(body)
			return
		}

		w.Header().Set("X-Pseudo-Locale", "active")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(cap.status)
		w.Write(newBody)
	})
}
```

**Acceptance criteria:**
- `GET /api/products` returns normal JSON
- `GET /api/products?pseudo=1` returns JSON where `"Wireless Headphones"` → `"[!!! Wîréléss Héàdphônésxxxxxxx !!!]"`
- Currency codes (`USD`), dates (`2025-06-15`), and URLs are not pseudo-localized
- Numeric strings (`"1234"`) pass through unchanged
- Response includes `X-Pseudo-Locale: active` header when active

### Junior to FAANG: how to approach these exercises

Exercise 10 is the "put everything together" exercise. Work in layers. First, get locale negotiation working with a known default. Then plug in the number formatter. Then plug in the currency formatter. Then plug in the date formatter. Test each layer independently before adding the next. The common mistake is trying to wire everything at once and debugging a pile of integrated bugs.

A specific hint for exercise 10: the API returns a mix of structured data and locale-formatted display strings. Do not return only formatted strings. Return both the raw value and the formatted display. The raw value is what partner integrations use. The formatted display is what the UI renders. Future you will thank present you for this shape.

Exercise 11 tests a subtler skill: response middleware. Capturing the response body, parsing it, transforming it, and rewriting it is a pattern you will use for other middleware (compression, rate limiting, redaction). The specific i18n detail is the skip rules for URLs, dates, currency codes, and numeric strings. Without skip rules, the pseudo-localizer mangles ISO dates and breaks API contracts. With them, only human-readable fields get wrapped.

Extend both exercises once you have passing tests. For exercise 10: add a pluralization case (stock count with "in stock" / "out of stock" / "only N left" based on count and locale). For exercise 11: add RTL simulation by reversing string direction, which catches components that do not support RTL layout.

Interview framing. Either exercise is a solid 30-minute take-home or a 60-minute live coding prompt. If an interviewer asks you to extend one live, show iteration: write a test first, implement to pass, refactor. This demonstrates engineering discipline, which is the signal beyond raw correctness.

### Senior at FAANG: what to add for platform-grade solutions

At staff level, the exercises above are warm-up. The platform-grade extensions are where real design sense shows.

For exercise 10, the staff-grade additions: the API emits observability signals for every locale-formatted field (which formatter was invoked, which locale, which currency, how long it took), exposed as Prometheus metrics. The API validates that incoming locale tags are in the supported set and emits a `locale_fallback_total` metric when an unsupported locale falls back. The API respects a `require_launch_locale` flag on each string so partial-translation responses fail loudly when a launch-blocking string is missing. The API carries per-tenant catalog overrides so white-label customers see their brand copy without code changes.

The currency handling needs a policy layer beyond formatting. Support multiple currencies per product (a marketplace where merchants set prices in different currencies). Support display-currency conversion (user in France sees a USD price converted to EUR at checkout). The conversion uses an FX rate service with rate caching and rate versioning. The display shows both "converted to EUR at today's rate" and the "original USD" for transparency. This is real ecommerce platform work.

For exercise 11, the staff-grade additions: the pseudo-localizer integrates with a visual regression system. A browser-based test harness (Playwright or Cypress) hits the API with `?pseudo=1`, renders the UI, and captures screenshots. A diff tool compares against a baseline. Text overflow or clipping fails the build. The baseline is reviewed when components change intentionally.

The pseudo-localizer also supports RTL simulation. A `?pseudo=rtl` parameter wraps strings in RTL markers and reverses character order (for layout testing, not correctness). This catches components that do not handle RTL at all, before a real RTL translator is involved. The simulation is not a replacement for real-language RTL testing but it catches the "component has hardcoded LTR assumptions" class of bug early.

Platform integration: the pseudo-localizer is not a middleware bolted onto each service. It is a standard edge-layer feature that every service inherits. The edge gateway (reverse proxy, API gateway) handles the activation flag and the response transformation. Individual services do not implement it. This keeps the pseudo-localizer logic in one place and ensures consistent behavior across the platform.

Test exercises like these expand into a larger assignment. "Implement a service that serves localized product data, with CLDR-backed formatting, locale fallback, observability, pseudo-localization support, and multi-tenant catalog overrides, with test coverage across at least five locales including one RTL, a passing visual regression suite, and a performance benchmark showing less than 5 percent overhead vs a non-localized baseline." That is a realistic staff-level take-home or design-round prompt. If you can architect and implement that in the interview window, you are at the staff bar.

The final extension: observability and alerting. Your service emits per-locale request rate, per-locale error rate, per-locale missing-key rate, per-locale fallback rate, and per-locale latency percentiles. A dashboard shows these rolled up and drilled down. Alerts fire when a metric breaks its SLO per locale. The on-call rotation for i18n platform issues is defined and tested. This is the platform-maturity expression of the work the exercises start.
