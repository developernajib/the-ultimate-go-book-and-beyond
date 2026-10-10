## Part 4: Locale Detection and Negotiation

Locale negotiation parses the `Accept-Language` HTTP header into a priority-ordered list of language tags and matches it against the application's supported locales using `golang.org/x/text/language`. The idiomatic path parses each candidate string (URL parameter, cookie, and the `Accept-Language` header) into tags in priority order and calls `matcher.Match(tags...)`, which returns the best match, its index, and a confidence level (`language.Exact`, `language.High`, `language.Low`, `language.No`). Treat `No` and `Low` as a miss and fall back to the default locale rather than serving poorly matched content. The convenience wrapper `language.MatchStrings(matcher, ...string)` accepts the raw strings directly but returns only the tag and index and discards the confidence, so call `Match` when you need to branch on it. The resolved locale is stored in the request context so all downstream handlers and templates receive it without re-negotiating from the header.

```go
package locale

import (
	"context"
	"net/http"

	"golang.org/x/text/language"
)

// Detector detects the user's preferred locale from various sources
type Detector struct {
	supported []language.Tag
	matcher   language.Matcher
	fallback  string
}

func NewDetector(supported []string, fallback string) *Detector {
	tags := make([]language.Tag, 0, len(supported))
	for _, s := range supported {
		if tag, err := language.Parse(s); err == nil {
			tags = append(tags, tag)
		}
	}
	return &Detector{
		supported: tags,
		matcher:   language.NewMatcher(tags),
		fallback:  fallback,
	}
}

// DetectFromRequest determines the best locale for an HTTP request.
// Priority: URL param > Cookie > Accept-Language header > fallback.
// Candidate signals are parsed into tags in priority order and passed to
// matcher.Match, which returns the best available match plus a confidence
// level. language.MatchStrings is a convenience wrapper over the same logic
// but discards the confidence, so we call Match directly to branch on it.
func (d *Detector) DetectFromRequest(r *http.Request) string {
	urlLang := r.URL.Query().Get("lang")

	var cookieLang string
	if c, err := r.Cookie("locale"); err == nil {
		cookieLang = c.Value
	}

	accept := r.Header.Get("Accept-Language")

	var tags []language.Tag
	for _, s := range []string{urlLang, cookieLang} {
		if s == "" {
			continue
		}
		if t, err := language.Parse(s); err == nil {
			tags = append(tags, t)
		}
	}
	if accept != "" {
		if hdr, _, err := language.ParseAcceptLanguage(accept); err == nil {
			tags = append(tags, hdr...)
		}
	}

	tag, _, conf := d.matcher.Match(tags...)
	if conf <= language.Low {
		return d.fallback
	}
	return tag.String()
}

// LocaleMiddleware attaches locale to request context
func LocaleMiddleware(detector *Detector) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			locale := detector.DetectFromRequest(r)
			ctx := WithLocale(r.Context(), locale)
			r = r.WithContext(ctx)

			// Set Vary header for correct caching
			w.Header().Add("Vary", "Accept-Language")

			next.ServeHTTP(w, r)
		})
	}
}

// Context key for locale
type localeKey struct{}

func WithLocale(ctx context.Context, locale string) context.Context {
	return context.WithValue(ctx, localeKey{}, locale)
}

func FromContext(ctx context.Context) string {
	locale, _ := ctx.Value(localeKey{}).(string)
	if locale == "" {
		return "en-US"
	}
	return locale
}
```

### Junior to FAANG: the detection order and why it matters

The priority order in the middleware (URL param then cookie then Accept-Language then fallback) is not arbitrary. Each step represents a stronger signal of user intent than the next. The URL parameter is the strongest because the user either clicked a language switcher or shared a localized link. The cookie is next because the user previously chose a locale on this device. Accept-Language is weakest because it is set by the browser at install time and rarely reflects active preference (a Japanese expat in New York runs a US-English browser but reads content in Japanese). The fallback catches the case where all signals are absent or all matches are low-confidence.

Getting the order wrong is a common mistake. Putting Accept-Language first means a French user who explicitly clicked the German flag still sees French because their browser is configured that way. Putting cookie above URL means a deep link that explicitly sets `?lang=ja` still respects a stale cookie. The URL wins because it is the most intent-revealing signal available.

The `Vary: Accept-Language` header is critical for CDN correctness. Without it, a CDN cache keyed only on URL serves the French version to every user after the first French user hits the edge. With it, the CDN correctly keys cached responses by locale. But `Vary: Accept-Language` is insufficient if your real locale source is a cookie or URL parameter. The full header is `Vary: Accept-Language, Cookie` if cookie is a signal and the URL param is already part of the URL key. This interacts with your CDN's cache key policy, which you must verify, not assume.

Worked example. A user in France has their browser in `fr-FR`. They visit your site. The middleware matches `fr-FR`. They click a language switcher to Japanese. Your app sets a `locale=ja` cookie and redirects. The middleware reads the cookie first, matches `ja`, renders Japanese. The user shares a URL. The URL has no `?lang=` parameter. The recipient, in Germany, opens the link. The middleware sees no URL param, no cookie for your domain, an Accept-Language of `de-DE`, and correctly renders German. Every step in that flow is deterministic and each signal has a documented priority.

Interview framing. "How do you detect user locale on an HTTP request." The expected answer names URL, cookie, and Accept-Language, explains priority, mentions the `language.Matcher`, and addresses CDN caching via `Vary`. If you add "and I would log the confidence level for observability" you are ahead of the field.

### Senior at FAANG: locale negotiation as a multi-layer system

Locale negotiation at platform scale is not a single middleware. It is a layered system with explicit ownership. The edge layer (CDN or regional load balancer) may short-circuit locale by routing based on geo-IP before the request reaches origin. The origin layer (Go service) runs the negotiation middleware. The application layer (handler) may override based on authenticated user preferences. The view layer (template or JSON serializer) uses the resolved locale to format output. Each layer has a different signal set, a different failure mode, and a different SLA.

Geo-IP routing at the edge is tempting and wrong for most use cases. A user in Germany reading English content gets forced to German. A VPN user appears from a country they do not speak. Geo-IP is a weak prior, useful only as a final fallback before a platform default. Put it behind the `Accept-Language` header in priority, never ahead. The exception is regulated domains (gambling, banking) where the jurisdiction of the IP actually matters for compliance, and in that case the output is a legal-locale, not a display-locale, and they route to different middleware.

Authenticated user locale preference is the strongest signal but lives in your identity service, not the request headers. A signed-in user has a preferred locale on their profile, set during onboarding or in settings. This beats every signal except an explicit URL override for the current request. The negotiation flow for authenticated users is `?lang= override then user.preferred_locale then default`. Anonymous users use the cookie-plus-header flow. The two code paths share the matcher but differ in signal sources. Model this explicitly. Do not let the unauthenticated flow leak into the authenticated flow, because a stale cookie from before login can override the user's actual profile preference.

Fallback chains need explicit definition per language family. A user requesting `pt-PT` (European Portuguese) on a platform supporting only `pt-BR` and `en-US` should fall back to `pt-BR`, not English, because European and Brazilian Portuguese are mutually intelligible even with different spellings. A user requesting `zh-HK` on a platform supporting `zh-CN` and `zh-TW` should fall back to `zh-TW` because Hong Kong uses traditional Chinese, not simplified. The `language.Matcher` handles some of this via BCP 47 matching rules, but the defaults are not always right for your market mix. Build a fallback-chain table, register it with the matcher explicitly, and test it against every launch locale.

Confidence levels are observability signal, not branching logic. The matcher returns `Exact`, `High`, `Low`, or `No`. The naive approach is to treat `Low` as fallback. The production approach is to log the confidence, emit a metric tagged with the source signal (URL, cookie, header), and feed the metric into a dashboard that correlates confidence with conversion or engagement. Low-confidence locale matches are a leading indicator of expanding your supported-locale list. If 8 percent of sessions from Southeast Asia are matching `en-US` with `Low` confidence because the actual Accept-Language is `vi-VN` and you do not support Vietnamese, that is a product signal.

Locale persistence has a privacy dimension. The cookie that stores locale is usually considered functional and does not require consent under GDPR. But if you store locale server-side keyed by a persistent user identifier, and the user has not opted into tracking, you may be collecting preference data unlawfully. The safe pattern is: unauthenticated locale preference lives in a first-party cookie with no tracking semantics. Authenticated locale preference lives on the user profile. The profile field is covered by your privacy policy. The cookie is functional. Both are disclosed in your consent banner. The lawyer sign-off on this model is a staff-level deliverable.

Multi-brand and multi-tenant locale support adds a layer. A white-label SaaS customer may have a different default locale than your platform default. A brand within a platform may support a different subset of locales than the platform overall. The matcher per tenant differs. The cookie name is tenant-scoped to avoid cross-tenant leakage. The fallback table is tenant-scoped. Staff-level design: locale resolution is a function of `(request_signals, tenant_id, brand_id)`, not a function of request signals alone.

SEO hreflang tags are the external-facing contract of locale negotiation. Every page that has multiple locale variants must emit `<link rel="alternate" hreflang="...">` tags pointing to each variant. The x-default variant covers users with no match. Google uses these to route search results to the right locale version. Wrong or missing hreflang tags are an SEO bug that reduces traffic to international markets. The tags must match the URLs your locale negotiation actually produces. A common bug: hreflang advertises `/fr/product` but the negotiation only honors `?lang=fr` on the canonical URL. Unify the URL scheme. Pick path-based or query-based localization and stick to it. Path-based is canonical for SEO.

Payment locale decoupling is the most-missed production concern. A Stripe Checkout flow accepts a `locale` parameter that controls the checkout UI language. A user in French locale paying in USD wants the Stripe UI in French. Your server passes the user's negotiated display locale to Stripe, not the payment currency's locale. PayPal has similar parameters. Your integration layer between checkout and the payment provider must carry locale as a distinct signal from currency. Document this. Test it. I have seen an entire launch market fail on day one because the payment integration hardcoded `en-US` regardless of user locale.

Testing locale negotiation requires request-level fixtures. Unit tests that pass Accept-Language strings as parameters are not enough. Integration tests must drive the full stack (CDN hints if any, middleware, handler, view) with realistic header permutations including the edge cases: missing header, empty header, malformed header, header with a single `*`, header with 50 languages (yes, this happens, and the header parser must handle it without OOMing). A property-based test that generates valid Accept-Language strings from a grammar and asserts the matcher never panics is a good investment. The golang.org/x/text matcher has been hardened against this, but your own parsing and cookie logic may not be.

---
