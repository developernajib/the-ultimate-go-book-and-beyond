## Part 8: HTTP API with i18n

The i18n middleware resolves the request locale from Accept-Language, a `lang` query parameter, or a user-preference cookie in priority order, then stores the resolved `message.Printer` in the request context. API error messages are localized using the printer from the context, so validation errors returned to French clients read in French while the server logs remain in English. Language tags in URL paths (e.g., `/fr/products`) are extracted by the router as path parameters and merged into the locale negotiation logic, taking precedence over header-based negotiation.

```go
package api

import (
	"context"
	"encoding/json"
	"net/http"

	"myapp/internal/i18n"
	"myapp/internal/locale"
)

// I18nMiddleware injects a localizer into the request context
func I18nMiddleware(bundle *i18n.Bundle, detector *locale.Detector) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			loc := detector.DetectFromRequest(r)
			localizer := bundle.NewLocalizer(i18n.Locale(loc))

			ctx := r.Context()
			ctx = locale.WithLocale(ctx, loc)
			ctx = withLocalizer(ctx, localizer)

			r = r.WithContext(ctx)
			w.Header().Add("Vary", "Accept-Language")
			next.ServeHTTP(w, r)
		})
	}
}

type localizerKey struct{}

func withLocalizer(ctx context.Context, loc *i18n.Localizer) context.Context {
	return context.WithValue(ctx, localizerKey{}, loc)
}

func GetLocalizer(ctx context.Context) *i18n.Localizer {
	loc, _ := ctx.Value(localizerKey{}).(*i18n.Localizer)
	return loc
}

// LocalizedError is an API error with translated message
type LocalizedError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ErrorResponse returns a localized error response
func ErrorResponse(w http.ResponseWriter, r *http.Request, statusCode int, errorKey string) {
	loc := GetLocalizer(r.Context())
	msg := errorKey
	if loc != nil {
		msg = loc.T(errorKey)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	json.NewEncoder(w).Encode(LocalizedError{
		Code:    errorKey,
		Message: msg,
	})
}

// Example handler
func GetUserHandler(w http.ResponseWriter, r *http.Request) {
	loc := GetLocalizer(r.Context())
	userID := r.PathValue("id")

	user, err := getUserByID(userID)
	if err != nil {
		ErrorResponse(w, r, http.StatusNotFound, "error.not_found")
		return
	}

	currentLocale := locale.FromContext(r.Context())
	df := format.NewDateTimeFormatter(currentLocale, user.Timezone)

	type UserResponse struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Email       string `json:"email"`
		CreatedAt   string `json:"created_at"`
		WelcomeMsg  string `json:"welcome_message"`
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(UserResponse{
		ID:         user.ID,
		Name:       user.Name,
		Email:      user.Email,
		CreatedAt:  df.FormatDateTime(user.CreatedAt),
		WelcomeMsg: loc.Tf("welcome", map[string]any{"name": user.Name}),
	})
}
```

### Junior to FAANG: structuring a localized API correctly the first time

The rookie mistake is returning a pre-formatted localized string to the client. "Your account has $25.50 remaining" as a single JSON string forces every client (web, iOS, Android, partner integrations) to display that string verbatim. A partner who wants to reformat the amount in their own UI cannot. A client that wants to show the balance in a different visual treatment cannot. Localized-string-as-API-value couples the server's view layer to the client's view layer.

The correct contract returns structured data. `{"amount_minor": 2550, "currency": "USD"}` plus a localized message template that the client renders: `{"template_key": "account.balance_remaining", "params": {"amount": {...}}}`. The client owns the final rendering. The server owns the data. This separation is non-negotiable in production APIs that serve heterogeneous clients.

Error responses follow the same rule. Return `{"code": "error.not_found", "message": "Resource not found"}` where `code` is the stable key and `message` is an optional human-readable default in the negotiated locale. Clients that want to provide a custom error UI key off `code`, ignore `message`. Clients that display raw errors use `message`. Never return only `message`, because clients cannot program against localized strings without fragility.

Worked example. A signup form rejects an email that is already registered. The API returns `{"code": "signup.email_taken", "message": "This email is already registered."}` with an appropriate 4xx status. The iOS client reads `code`, looks up its own translation for `signup.email_taken` in its bundled catalog, and displays a custom UI with a "Log in instead" button. The web client reads `message` and displays it directly. The partner integration logs `code` for analytics. Three consumers, three UX, one API response.

Interview framing. "How do you return error messages from a localized API." The correct answer is "structured error codes as stable identifiers, optional localized message as a convenience field, client owns final rendering." Say "never localize business-logic values like amounts or dates into the error string" and you are at the senior bar.

### Senior at FAANG: API contracts, versioning, and the i18n implications

The platform-level decision is whether to serialize localized content in the API at all, or to return only raw data and let clients handle i18n. Full-client-side i18n has appeal: the server is locale-agnostic, the bundle ships with the client, the round-trip per-locale version of every response is eliminated. It has costs: the client bundle grows with every locale (200 locales is real download weight on constrained networks), catalog updates require client deploys, and older clients can go stale with missing keys. Server-side i18n has opposite trade-offs.

The production answer is hybrid. Stable strings (button labels, navigation, error codes) ship with the client, versioned with the client. Dynamic content (product names, user-generated content, ML-generated copy) is localized server-side and delivered as part of the response. The boundary is drawn by content velocity: content that changes more often than client deploys is server-localized, content that changes less often is client-bundled.

Accept-Language header parsing must be hardened against adversarial input. A malicious header like `"*"` or one with 1000 comma-separated entries or with non-BCP-47 tokens cannot crash the parser, consume unbounded memory, or produce a locale that bypasses your matcher. `golang.org/x/text/language` handles this well in recent versions, but your wrapper code (the detector priority logic, cookie fallback, URL parameter parsing) also must be hardened. Fuzz-test the detector with a corpus of real-world Accept-Language headers plus deliberately malformed inputs. The goal is not to pass every test but to never panic.

Content negotiation via URL path (`/en/products`, `/fr/products`) versus query parameter (`/products?lang=fr`) versus subdomain (`fr.example.com/products`) is an SEO and architecture decision. Path-based is preferred for SEO because Google treats path segments as strong signals and hreflang tags are easiest to emit. Subdomain-based is useful when you run per-market infrastructure and want DNS-level traffic splitting. Query-parameter-based is the weakest for SEO but the cheapest to retrofit onto an existing service. Pick one. Document it. Emit hreflang consistently. Do not mix.

URL canonicalization for localized paths is its own ADR. If a user requests `/fr/products` and your platform does not support French, do you 404, 302 to `/en/products`, or 200 with English content? Each is a defensible choice. 404 is SEO-cleanest (Google does not index an English page at a French URL). 302 preserves the user flow. 200 is user-friendly but produces duplicate content without proper canonical tags. The right answer depends on your market mix and SEO strategy. Write it down.

JSON API response locale-awareness has edge cases. A response that embeds user-generated content in one language inside a templated string in another language creates a mixed-locale response. The `lang` attribute on an HTML element solves this in rendering, but a JSON API must carry the locale of each user-generated fragment separately so the client renders it with correct typography, bidi, and screen-reader pronunciation. The response might look like `{"title": {"text": "Introducing", "lang": "en"}, "body": {"text": "مرحبا بالعالم", "lang": "ar"}}`. This is verbose but correct for mixed-language content platforms like Twitter, LinkedIn, or Reddit.

API versioning and locale evolution are intertwined. A v1 API returns localized error messages in the message field. A v2 API returns only codes. Migrating consumers across this break is multi-quarter work. Build the break into your API versioning policy from the start. Stable clients continue to receive messages for the life of their version. New clients get codes. Never change the localization contract within a major version.

Rate limiting error responses in localized form is a subtle security concern. A 429 response that includes retry-after time formatted in the user locale is slightly more complex to parse programmatically. Bots do not care. Humans debugging from curl want the retry-after in a stable format (ISO 8601) in the header and a localized string in the body. Keep machine-readable values (headers, numeric fields) locale-independent. Localize only human-readable fields.

Observability data (logs, metrics, traces) is always locale-independent. Log messages are always in English. Metric labels are stable identifiers, not translated text. Trace span names are stable identifiers. If a translator "localizes" a log message by checking a translation key, your ops team cannot correlate incidents across locales. The rule: the user sees localized content, the operator sees English, and the boundary is enforced by code review.

Testing localized APIs requires a test matrix, not a test case. For every endpoint, run the test against at least English, one LTR non-English locale (German or French), one RTL locale (Arabic or Hebrew), and one CJK locale (Japanese or Chinese). Assert on structure and key presence, not on exact translated strings (because translations change with catalog updates). Snapshot-test structure. Parameterize-test translated content. Your CI matrix multiplies by locales, which affects runtime. Parallelize and filter to launch-blocking locales for PR builds, run the full matrix on main branch.

Multi-tenant and per-brand overrides at the API layer need careful request plumbing. The tenant is resolved from subdomain, header, or authenticated user. The locale is resolved independently. The localizer is constructed per-request with `(tenant, locale)` as the key. Caching the localizer across tenants breaks isolation. Caching within a tenant across locales also breaks. Each request gets a fresh localizer derived from a shared catalog and tenant-override layer. This is the kind of detail that hides subtle bugs for months (a user in Tenant A sees strings from Tenant B's override because the localizer was cached incorrectly).

Performance of localized APIs at high QPS comes down to the catalog lookup cost and the printer construction cost. In `golang.org/x/text`, a `message.Printer` allocation is O(1) in locale count but non-zero. A catalog message resolution is a map lookup. For a handler that emits 20 localized fields, you are doing 20 lookups plus one printer construction per request. At 100k QPS, this is a measurable but not dominant cost. Premature optimization is wrong. Profile first. If localization is a hotspot, pool printers per locale in a `sync.Pool` or cache the resolved message strings in a per-locale LRU for high-volume keys.

---
