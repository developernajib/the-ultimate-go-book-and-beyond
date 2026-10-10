## 37J.9 Cache Poisoning Prevention

### Secure Cache Key Design

Cache poisoning occurs when an attacker tricks a CDN into storing a malicious or incorrect response and serving it to other users. The primary defense is strict cache key normalization: strip unknown query parameters, canonicalize the host, sort remaining parameters, and only vary on safe headers like `Accept-Encoding`. The code below implements these protections along with response cacheability validation and security headers.

```go
package cdn

import (
	"crypto/subtle"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

// CacheKeyNormalizer generates consistent, safe cache keys
type CacheKeyNormalizer struct {
	allowedParams   map[string]bool
	stripHeaders    []string
}

// NormalizeRequest creates a normalized cache key from an HTTP request
func (n *CacheKeyNormalizer) NormalizeRequest(r *http.Request) string {
	// 1. Normalize URL: lowercase scheme + host
	u := &url.URL{
		Scheme: "https",
		Host:   strings.ToLower(r.Host),
		Path:   r.URL.Path,
	}

	// 2. Filter and sort query parameters (prevent cache variation from param order)
	params := url.Values{}
	for k, v := range r.URL.Query() {
		// Only include allowed parameters (prevent cache poisoning via unknown params)
		if n.allowedParams[k] {
			// Sort values for consistency
			slices.Sort(v)
			params[k] = v
		}
	}
	u.RawQuery = params.Encode()

	// 3. Add relevant headers to key (for Vary support)
	// Only include safe, non-spoofable headers
	var varyParts []string
	if enc := r.Header.Get("Accept-Encoding"); enc != "" {
		if strings.Contains(enc, "br") {
			varyParts = append(varyParts, "enc:br")
		} else if strings.Contains(enc, "gzip") {
			varyParts = append(varyParts, "enc:gz")
		}
	}
	if lang := normalizeLanguage(r.Header.Get("Accept-Language")); lang != "" {
		varyParts = append(varyParts, "lang:"+lang)
	}

	key := u.String()
	if len(varyParts) > 0 {
		key += "#" + strings.Join(varyParts, "&")
	}
	return key
}

// ValidateCacheability checks if a response should be cached
func ValidateCacheability(r *http.Request, w http.ResponseWriter) bool {
	// Never cache:
	// - Requests with Authorization header
	if r.Header.Get("Authorization") != "" {
		return false
	}
	// - POST/PUT/PATCH/DELETE
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	// - Requests with cookies (may contain session data)
	if r.Header.Get("Cookie") != "" {
		return false
	}
	// - Responses with Set-Cookie
	if w.Header().Get("Set-Cookie") != "" {
		return false
	}
	return true
}

// SecureHeaders adds security headers that prevent cache poisoning
func SecureHeaders(w http.ResponseWriter) {
	// Prevent content-type sniffing (could affect cache decisions)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Prevent clickjacking
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	// HSTS: force HTTPS
	w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	// CSP: prevent XSS which could poison JS bundles
	w.Header().Set("Content-Security-Policy", "default-src 'self'")
	// Prevent MIME confusion
	w.Header().Set("X-XSS-Protection", "1; mode=block")
}

// ConstantTimeHeaderValidation prevents timing attacks on cache keys
func ConstantTimeHeaderValidation(expected, received string) bool {
	return subtle.ConstantTimeCompare([]byte(expected), []byte(received)) == 1
}

func normalizeLanguage(lang string) string {
	if lang == "" {
		return ""
	}
	// Only use primary language tag
	parts := strings.Split(lang, ",")
	if len(parts) > 0 {
		primary := strings.TrimSpace(strings.Split(parts[0], ";")[0])
		// Only the language code, not region (en-US → en)
		langParts := strings.Split(primary, "-")
		return strings.ToLower(langParts[0])
	}
	return ""
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

Cache poisoning is a class of attack where a malicious request causes a CDN or reverse proxy to cache a harmful response under a cache key that legitimate users later hit. The canonical example: attacker sends `GET /home HTTP/1.1` with `X-Forwarded-Host: evil.com`, the origin naively templates the host into the HTML (`<script src="//evil.com/app.js">`), the CDN caches this response against the cache key `/home`, and every subsequent user gets the poisoned response. The attacker poisoned once, thousands of users got compromised.

The prerequisite concept is cache-key composition. The cache key is whatever the CDN uses to decide "are these two requests the same cached object." Typically it is the URL plus any header listed in `Vary`. Anything in the request that affects the response but is NOT in the cache key is called an "unkeyed input" and is the attack surface. If your origin templates `X-Forwarded-Host` into the response but the CDN does not include `X-Forwarded-Host` in the cache key, you are poisonable.

The worked example every new appsec engineer should do: spin up a local Varnish plus a Go origin that returns `<h1>Welcome to {{.Host}}</h1>`, send a curl with `-H 'X-Forwarded-Host: evil.com'`, confirm the cached response serves `evil.com` to subsequent requests without that header. Then fix it by either (a) not templating unkeyed inputs, or (b) adding `X-Forwarded-Host` to the Vary list, or (c) stripping the header at CDN edge.

The interview entry-point question is "what is an unkeyed input and how do you find them." The entry-level answer is "any header or param the origin reads that the cache does not key on," and the deeper answer references James Kettle's 2018 and 2020 Black Hat research which turned cache poisoning into a named, tooled attack class. First-job context: the code in this file is a template. You will customize `allowedParams` and `stripHeaders` per service. Do not ship it as-is without auditing every header your origin code reads.

### Senior @ FAANG: Kettle's Research, CPDoS, Web Cache Deception, and Cache-Key Governance

James Kettle (PortSwigger) published "Practical Web Cache Poisoning" in 2018 and the follow-up "Web Cache Entanglement" in 2020. These two papers are required reading for anyone doing staff-level work on CDN security, and they established the modern taxonomy. Kettle's 2018 technique finds unkeyed inputs by sending a request with a unique canary header like `X-Forwarded-Host: canary.attacker.com` and checking whether the response reflects it. If yes and the request was cached, you have a poisoning primitive. His 2020 paper extended the class to internal cache behaviors (caching in Akamai's parent-child layers, normalization inconsistencies between CDN tiers, and "fat GET" attacks where the request body is ignored by the cache but parsed by origin).

CPDoS (Cache-Poisoned Denial of Service) was published by Nguyen, Iannone, and Federrath in 2019. The idea: send a request with a malformed header that origin rejects with a cacheable error (400, 404, 500), the CDN caches the error against a benign cache key, and legitimate users now get the cached error for a valid URL. Variants include HTTP Header Oversize (HHO) where a massive header crashes origin with a cached 400, HTTP Meta Character (HMC) where a null byte triggers a 400, and HTTP Method Override (HMO) where `X-HTTP-Method-Override: POST` converts a cacheable GET into an origin-side POST that 403s. The defense is strict: never cache 4xx or 5xx responses by default unless the origin explicitly sets `Cache-Control: public, max-age=N` on error paths, and audit every CDN's default error caching config. CloudFront caches 404s for 10 seconds by default, Fastly caches 5xx for 120 seconds by default in VCL, both are CPDoS footguns until you override them.

Web Cache Deception was coined by Omer Gil in 2017 and it is distinct from poisoning. The attack: a victim is tricked into visiting `https://bank.com/profile/foo.jpg`, the app routes this to the profile handler (which ignores the trailing `.jpg`) and returns sensitive account data, the CDN sees a `.jpg` suffix and caches it as a public static asset, the attacker fetches `/profile/foo.jpg` and retrieves the victim's data from CDN cache. Defenses: normalize path extensions at CDN edge, do not cache based on suffix alone, require explicit `Cache-Control: public` from origin for any authenticated path, and use `Cache-Control: private` on all authenticated responses regardless of extension. AWS had a high-profile WCD disclosure in 2019 on cloudfront.net assets, and it recurs yearly in bug-bounty reports.

The unkeyed input headers to audit per service: `Host` (standard but frequently reflected), `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-For`, `X-Forwarded-Scheme`, `X-Original-URL`, `X-Rewrite-URL`, `X-HTTP-Method-Override`, `X-Host`, `X-Forwarded-Server`, `Forwarded` (RFC 7239), and `True-Client-IP` (Akamai). Frameworks that auto-parse these are dangerous: Symfony's `TrustedProxy`, Flask's `PROXY_FIX`, Rails' `ActionDispatch::RemoteIp`, and Go's `httputil.ReverseProxy` with improperly configured `Director`. The senior pattern is to strip all `X-Forwarded-*` and `X-Original-*` at CDN edge, then set known-good values yourself (e.g., `X-Real-IP` from the CDN's client IP variable), and never read anything else upstream.

`Vary: Accept-Encoding` is a well-known trap. If origin sends `Vary: Accept-Encoding` but the CDN normalizes `Accept-Encoding` to one of three values (none, gzip, br), you are fine. If the CDN does not normalize, an attacker who sends a crafted `Accept-Encoding` value like `gzip, br, identity, deflate` with quality parameters creates a unique cache variant that only they will ever hit again, which is useless for poisoning but useful for cache-key exhaustion (DoS via cache fragmentation, sometimes called "cache-key amplification"). Fastly VCL pattern: `set req.http.Accept-Encoding = "gzip";` if the client supports gzip, else strip, giving at most two variants per object. Cloudflare normalizes automatically. CloudFront requires explicit configuration via Compress origin settings and a normalized cache policy.

Cache-key normalization governance is the staff-level deliverable. Write a spec that enumerates (a) the exact composition of the cache key per service, (b) the allowed query parameters with type and length bounds, (c) the `Vary` list and how each entry is normalized, (d) the header allowlist at CDN ingress with everything else stripped. Version this spec, review it in every new-service design review, and add a nightly security test that probes every endpoint with a battery of unkeyed-input canaries (from param-miner wordlists plus your own service-specific candidates) and asserts the response does not reflect them. PortSwigger's Param Miner BApp is the standard tool for the manual audit, and you can encode the same checks into a Go test suite that runs in CI against a staging environment with the real CDN in front.

The code in this file is a good start but missing three things. First, it does not enforce `Cache-Control: private` on any response that could carry user data, which is the single most effective cache-poisoning defense because a private response is never stored in a shared cache. Second, `ValidateCacheability` should also reject responses with `Vary: *` and responses whose `Content-Length` exceeds a configured bound (oversized poisoning). Third, the normalizer treats `Host` as lowercased but does not reject requests where `req.Host` does not match the expected virtual host, which is the entry point for Host-header poisoning. Add `if r.Host != expectedHost { return "" }` and 400 the request, do not cache.

Finally, the organizational control: treat cache-key composition as a security-sensitive configuration. Changes go through appsec review, not just the service team. The first time a developer adds a new query parameter to the allowlist without review and that parameter turns out to be reflected in the response, you will be writing a postmortem. Avoid that by making the cache-key spec part of the threat model every new service writes at design review.

---
