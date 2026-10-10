## 38.5 Content Negotiation

Content negotiation lets one resource URL return different representations depending on what the client asks for. Three request headers drive it:

- **`Accept`**: what response *media type* the client can consume (`application/json`, `application/xml`, `application/problem+json`).
- **`Accept-Encoding`**: what *compression* the client supports (`gzip`, `br`, `zstd`). Handled by a compression middleware or an HTTP server wrapper, not by your application logic.
- **`Accept-Language`**: preferred natural language for error messages and localized content.

Whenever the response body varies based on a request header, **set the `Vary` header** so caches (browser, CDN, reverse proxy) keep separate cache entries per variant. Forgetting `Vary: Accept-Encoding` is a common source of "gzipped response served to a client that did not ask for it" bugs behind Cloudflare, Fastly, and Varnish.

```go
// When a response varies by Accept and Accept-Encoding:
w.Header().Set("Vary", "Accept, Accept-Encoding")
```

### Accept Header Handling

The `Responder` type parses the `Accept` header, selects the best matching media type, and writes the correct `Content-Type` before encoding the response, ensuring clients that request XML receive XML rather than silently falling back to JSON. The accompanying `AcceptMiddleware` rejects requests for unsupported formats before they reach the handler, returning `406 Not Acceptable` early. Production implementations should also respect **quality values** (`Accept: application/xml;q=0.9, application/json;q=1.0`), so parse them with a library like `github.com/elnormous/contenttype` rather than hand-rolling.

```go
// ... imports omitted for brevity (encoding/json, encoding/xml, net/http, strings)

// ContentType constants
const (
    ContentTypeJSON = "application/json"
    ContentTypeXML  = "application/xml"
    ContentTypeText = "text/plain"
)

// Responder handles content negotiation
type Responder struct{}

func (resp *Responder) Respond(w http.ResponseWriter, r *http.Request, status int, data any) {
    accept := r.Header.Get("Accept")
    contentType := negotiateContentType(accept)

    w.Header().Set("Content-Type", contentType)
    w.WriteHeader(status)

    switch contentType {
    case ContentTypeXML:
        xml.NewEncoder(w).Encode(data)
    case ContentTypeText:
        // Handle text response
    default:
        json.NewEncoder(w).Encode(data)
    }
}

func negotiateContentType(accept string) string {
    if accept == "" {
        return ContentTypeJSON
    }

    // Parse Accept header (simplified)
    // Full implementation should handle quality values
    types := strings.Split(accept, ",")
    for _, t := range types {
        mediaType := strings.TrimSpace(strings.Split(t, ";")[0])
        switch mediaType {
        case ContentTypeJSON, "application/*", "*/*":
            return ContentTypeJSON
        case ContentTypeXML:
            return ContentTypeXML
        case ContentTypeText:
            return ContentTypeText
        }
    }

    return ContentTypeJSON
}

// AcceptMiddleware validates Accept header
func AcceptMiddleware(allowed ...string) func(http.Handler) http.Handler {
    allowedSet := make(map[string]bool)
    for _, a := range allowed {
        allowedSet[a] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            accept := r.Header.Get("Accept")
            if accept != "" && accept != "*/*" {
                types := strings.Split(accept, ",")
                found := false
                for _, t := range types {
                    mediaType := strings.TrimSpace(strings.Split(t, ";")[0])
                    if allowedSet[mediaType] || mediaType == "*/*" {
                        found = true
                        break
                    }
                }
                if !found {
                    http.Error(w, "Not Acceptable", http.StatusNotAcceptable)
                    return
                }
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

### Content-Type Handling

The `BodyDecoder` strips the charset suffix from the `Content-Type` header before switching on the media type, which prevents the common bug where `application/json; charset=utf-8` is not recognized as JSON. Returning a distinct error for unsupported content types lets the caller respond with `415 Unsupported Media Type` rather than a misleading parse failure.

```go
// ... imports omitted for brevity

// BodyDecoder decodes request body based on Content-Type
type BodyDecoder struct{}

func (d *BodyDecoder) Decode(r *http.Request, dst any) error {
    contentType := r.Header.Get("Content-Type")
    mediaType := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))

    switch mediaType {
    case ContentTypeXML, "text/xml":
        return xml.NewDecoder(r.Body).Decode(dst)
    case ContentTypeJSON, "":
        return json.NewDecoder(r.Body).Decode(dst)
    default:
        return &UnsupportedMediaTypeError{MediaType: mediaType}
    }
}

type UnsupportedMediaTypeError struct {
    MediaType string
}

func (e *UnsupportedMediaTypeError) Error() string {
    return "unsupported media type: " + e.MediaType
}

// ContentTypeMiddleware validates Content-Type for requests with body
func ContentTypeMiddleware(allowed ...string) func(http.Handler) http.Handler {
    allowedSet := make(map[string]bool)
    for _, a := range allowed {
        allowedSet[a] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Only check methods that have bodies
            if r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch {
                ct := r.Header.Get("Content-Type")
                if ct == "" {
                    http.Error(w, "Content-Type required", http.StatusUnsupportedMediaType)
                    return
                }

                mediaType := strings.ToLower(strings.TrimSpace(strings.Split(ct, ";")[0]))
                if !allowedSet[mediaType] {
                    http.Error(w, "Unsupported Media Type", http.StatusUnsupportedMediaType)
                    return
                }
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

### Junior → FAANG: content negotiation prerequisites

Content negotiation feels abstract until you ship an API and a mobile client on the same week. The mental model is that `Accept` is a wish list, `Content-Type` is a declaration, and your server's job is to find the intersection. Three concrete rules cover 90 percent of junior interview questions.

First, `Accept: */*` means "I will take whatever you send", which is what curl and most HTTP libraries default to. Your server picks its canonical format (almost always JSON) and returns it. Second, `Accept` missing entirely is equivalent to `*/*`, not an error. RFC 9110 is explicit about this and many junior implementations incorrectly return 406 for missing Accept, which breaks every default HTTP client in existence. Third, `Content-Type` on a request with no body is allowed but meaningless, and `Content-Type` on GET or DELETE should be ignored because those methods traditionally have no body (though RFC 9110 now permits it).

Worked example for a first job. Your team ships a `/reports/:id` endpoint that returns JSON. Finance asks for CSV export "for Excel". The naive fix is a new endpoint `/reports/:id/csv`. The negotiation-aware fix is to accept `Accept: text/csv` on the same URL and emit CSV. Both are valid. The negotiation approach keeps URLs resource-oriented and lets a CLI tool toggle formats with a header, the separate-endpoint approach is easier to cache and easier for a Swagger generator to describe. Senior engineers will ask you to defend your choice. The correct answer is usually "separate endpoint for formats with different semantics (CSV drops nested structure), same endpoint with negotiation for formats that are purely serializations of the same model (JSON versus XML versus MessagePack)".

Interview entry-point: be ready to explain q-values. `Accept: application/json;q=0.9, application/xml;q=1.0` means the client prefers XML over JSON. The default q is 1.0. A media type not listed has implicit q=0 unless a wildcard covers it. The tiebreaker when two types have equal q is specificity (`application/json` beats `application/*` which beats `*/*`). Hand-parsing this is a bug farm, use `github.com/elnormous/contenttype` or the stdlib `mime.ParseMediaType` as building blocks.

### Senior @ FAANG: content negotiation at staff and principal scope

At staff scope content negotiation is a coupling surface between API evolution, CDN caching, and client SDK versioning. The `negotiateContentType` function shown above is a teaching example, the production concerns are substantially larger.

Versioning through Accept is the most consequential decision. The two real choices in 2026 are URL path versioning (`/v2/users`) and media type versioning (`Accept: application/vnd.acme.v2+json`). Path versioning is easier for humans, easier to cache, easier to route at the load balancer, and trivially visible in logs. Media type versioning is correct by HTTP-purist standards, allows per-resource version skew, and keeps URLs stable across versions. FAANG-scale APIs overwhelmingly choose path versioning for customer-facing endpoints and media type versioning for internal RPC-over-HTTP where the client library is co-released. The wrong answer is header versioning via a custom `X-API-Version` header, which breaks the `Vary` semantics and surprises every CDN. If you inherit an API that uses `X-API-Version`, wrap it in middleware that translates to a canonical internal representation and do not propagate the custom header to the cache key.

Compression negotiation is where most production incidents actually live. `Accept-Encoding: gzip, br, zstd` gives you three realistic choices in 2026. Brotli at quality 4 beats gzip at quality 6 on both compression ratio and CPU for typical JSON, which is why every major CDN defaults to it for cacheable responses. Zstd is faster than both for large payloads (over 100 KiB) and has better streaming characteristics, but browser support is uneven (Chrome and Firefox shipped it in 2024, Safari lagged) and older mobile clients will not send `zstd` in Accept-Encoding. The middleware pattern is to prefer zstd if offered, fall back to brotli, fall back to gzip, never negotiate on CPU-starved paths. Compress only responses over a threshold (1400 bytes matches a typical MTU, below that compression wastes CPU for no wire gain). Do not compress already-compressed content (images, video, pre-gzipped tarballs), detect via `Content-Type` sniffing. Critical security note: do not compress responses that mix secret and attacker-controlled data on the same response. That is the BREACH attack vector from 2013 and it still works. Token endpoints, password reset flows, CSRF token emitters should all set `Cache-Control: no-store` and skip compression, or pad responses to a fixed length.

The `Vary` header is where caching correctness lives. Every response whose body depends on a request header must list that header in `Vary`. The common set is `Vary: Accept, Accept-Encoding, Accept-Language, Authorization`. Listing `Authorization` is essential for any per-user response because otherwise a shared CDN will serve user A's data to user B, which is a CVE waiting to happen. But listing too many headers destroys cache hit rate because each combination is a separate cache entry. The engineering judgment is to make the cache key as narrow as it can be while still correct. For responses that vary only on compression, use `Vary: Accept-Encoding` alone. For versioned APIs using media-type versioning, include `Vary: Accept`. Test this with your actual CDN, Cloudflare, Fastly, and CloudFront all have slightly different Vary interpretation, and some normalize header values before hashing while others do not.

Content-Type validation is a security surface, not just a correctness surface. Accepting `application/json` on a POST is correct. Accepting `text/plain` on the same endpoint because the client forgot to set the header is a CSRF vulnerability, because `text/plain` is a "simple" content type under the CORS spec and can be sent cross-origin without preflight. The strict rule for any state-changing endpoint is: require `Content-Type: application/json` exactly (with optional charset), reject everything else with 415, and enable CORS preflight enforcement. This single rule closes a class of CSRF attacks that survived the `SameSite=Lax` cookie transition because mobile webviews and older browsers do not always honor SameSite.

Finally, streaming negotiation for large responses. When the client sends `Accept: application/x-ndjson` or `application/json-seq`, switch to a newline-delimited streaming encoder and set `Transfer-Encoding: chunked`. This lets a log-tailing client consume records as they arrive rather than waiting for a full array. The senior move is to expose a single endpoint that emits either a batched JSON array or an NDJSON stream based on Accept, sharing the same service layer. The service returns an iterator (`iter.Seq` in Go 1.23+), the handler chooses the encoder, the client picks its poison. This pattern extracts the transport concern cleanly from the domain layer and is the direction every modern REST API is moving.

---
