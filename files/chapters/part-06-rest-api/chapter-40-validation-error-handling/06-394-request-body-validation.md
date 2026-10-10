## 40.4 Request Body Validation

### Safe JSON Decoding

`DecodeJSONBody` wraps the body with `http.MaxBytesReader` to cap memory usage before any decoding begins, then enables `DisallowUnknownFields` so clients are told immediately when they send unsupported keys rather than silently ignoring them. Checking `dec.More()` after decoding prevents smuggled payloads where a second JSON document is appended after the expected object.

`mime.ParseMediaType` does the Content-Type parsing rather than a hand-rolled `strings.Split` on `;`. It handles parameters, casing, and whitespace per the grammar, so `application/json; charset=utf-8` parses to the `application/json` media type and is accepted, while a malformed header returns an error and is rejected along with everything else that is not JSON.

```go
// ... imports omitted for brevity (encoding/json, errors, fmt, io, mime, net/http, strings)

const MaxBodySize = 1 << 20 // 1 MB

// DecodeJSONBody safely decodes JSON request body
func DecodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) error {
    // Check Content-Type. Note there is no `if ct != ""` guard here: a
    // missing Content-Type must be rejected too, otherwise an attacker
    // simply omits the header and walks past the check. That also keeps
    // this useful as CSRF defense in depth, since a simple cross-origin
    // form post cannot set application/json without a CORS preflight.
    ct := r.Header.Get("Content-Type")
    mediaType, _, err := mime.ParseMediaType(ct)
    if err != nil || mediaType != "application/json" {
        return &RequestError{
            Status:  http.StatusUnsupportedMediaType,
            Code:    "UNSUPPORTED_MEDIA_TYPE",
            Message: "Content-Type must be application/json",
        }
    }

    // Limit body size
    r.Body = http.MaxBytesReader(w, r.Body, MaxBodySize)

    dec := json.NewDecoder(r.Body)
    dec.DisallowUnknownFields()

    if err := dec.Decode(dst); err != nil {
        return parseJSONError(err)
    }

    // Ensure only single JSON value
    if dec.More() {
        return &RequestError{
            Status:  http.StatusBadRequest,
            Code:    "INVALID_JSON",
            Message: "Request body must contain a single JSON object",
        }
    }

    return nil
}

// RequestError represents a request parsing error
type RequestError struct {
    Status  int
    Code    string
    Message string
    Field   string
}

func (e *RequestError) Error() string {
    return e.Message
}

func parseJSONError(err error) *RequestError {
    var syntaxError *json.SyntaxError
    var unmarshalTypeError *json.UnmarshalTypeError
    var maxBytesError *http.MaxBytesError

    switch {
    case errors.As(err, &syntaxError):
        return &RequestError{
            Status:  http.StatusBadRequest,
            Code:    "INVALID_JSON",
            Message: fmt.Sprintf("Malformed JSON at position %d", syntaxError.Offset),
        }

    case errors.Is(err, io.ErrUnexpectedEOF):
        return &RequestError{
            Status:  http.StatusBadRequest,
            Code:    "INVALID_JSON",
            Message: "Malformed JSON",
        }

    case errors.As(err, &unmarshalTypeError):
        return &RequestError{
            Status:  http.StatusBadRequest,
            Code:    "INVALID_TYPE",
            Message: fmt.Sprintf("Invalid type for field '%s': expected %s",
                unmarshalTypeError.Field, unmarshalTypeError.Type.String()),
            Field:   unmarshalTypeError.Field,
        }

    case strings.HasPrefix(err.Error(), "json: unknown field"):
        field := strings.TrimPrefix(err.Error(), "json: unknown field ")
        return &RequestError{
            Status:  http.StatusBadRequest,
            Code:    "UNKNOWN_FIELD",
            Message: fmt.Sprintf("Unknown field: %s", field),
            Field:   strings.Trim(field, "\""),
        }

    case errors.As(err, &maxBytesError):
        return &RequestError{
            Status:  http.StatusRequestEntityTooLarge,
            Code:    "REQUEST_TOO_LARGE",
            Message: fmt.Sprintf("Request body exceeds %d bytes", MaxBodySize),
        }

    case errors.Is(err, io.EOF):
        return &RequestError{
            Status:  http.StatusBadRequest,
            Code:    "EMPTY_BODY",
            Message: "Request body is required",
        }

    default:
        return &RequestError{
            Status:  http.StatusBadRequest,
            Code:    "INVALID_JSON",
            Message: "Unable to parse request body",
        }
    }
}
```

### Query Parameter Validation

`QueryValidator` accumulates all parameter errors before returning rather than failing on the first, giving API consumers a complete picture of what is wrong. Each helper method (`String`, `Int`, `UUID`) encapsulates parsing and type conversion so handler code never calls `strconv` directly, keeping the parsing logic testable in isolation.

```go
// ... imports omitted for brevity (fmt, net/http, strconv, strings)

// QueryValidator validates query parameters
type QueryValidator struct {
    r      *http.Request
    errors []ErrorDetail
}

func NewQueryValidator(r *http.Request) *QueryValidator {
    return &QueryValidator{r: r}
}

func (v *QueryValidator) String(name string, required bool) string {
    value := v.r.URL.Query().Get(name)
    if required && value == "" {
        v.errors = append(v.errors, ErrorDetail{
            Field:    name,
            Code:     "REQUIRED",
            Message:  fmt.Sprintf("%s is required", name),
            Location: "query",
        })
    }
    return value
}

func (v *QueryValidator) Int(name string, defaultVal int, min, max int) int {
    str := v.r.URL.Query().Get(name)
    if str == "" {
        return defaultVal
    }

    val, err := strconv.Atoi(str)
    if err != nil {
        v.errors = append(v.errors, ErrorDetail{
            Field:    name,
            Code:     "INVALID_TYPE",
            Message:  fmt.Sprintf("%s must be an integer", name),
            Value:    str,
            Location: "query",
        })
        return defaultVal
    }

    if val < min {
        v.errors = append(v.errors, ErrorDetail{
            Field:    name,
            Code:     "TOO_SMALL",
            Message:  fmt.Sprintf("%s must be at least %d", name, min),
            Value:    val,
            Location: "query",
        })
        return min
    }

    if val > max {
        v.errors = append(v.errors, ErrorDetail{
            Field:    name,
            Code:     "TOO_LARGE",
            Message:  fmt.Sprintf("%s must be at most %d", name, max),
            Value:    val,
            Location: "query",
        })
        return max
    }

    return val
}

func (v *QueryValidator) Enum(name string, allowed []string, defaultVal string) string {
    value := v.r.URL.Query().Get(name)
    if value == "" {
        return defaultVal
    }

    for _, a := range allowed {
        if value == a {
            return value
        }
    }

    v.errors = append(v.errors, ErrorDetail{
        Field:    name,
        Code:     "INVALID_VALUE",
        Message:  fmt.Sprintf("%s must be one of: %s", name, strings.Join(allowed, ", ")),
        Value:    value,
        Location: "query",
    })
    return defaultVal
}

func (v *QueryValidator) StringSlice(name string, separator string) []string {
    value := v.r.URL.Query().Get(name)
    if value == "" {
        return nil
    }
    return strings.Split(value, separator)
}

func (v *QueryValidator) Errors() []ErrorDetail {
    return v.errors
}

func (v *QueryValidator) HasErrors() bool {
    return len(v.errors) > 0
}

// Usage example
func listUsersHandler(w http.ResponseWriter, r *http.Request) {
    qv := NewQueryValidator(r)

    page := qv.Int("page", 1, 1, 1000)
    pageSize := qv.Int("page_size", 20, 1, 100)
    sortBy := qv.Enum("sort_by", []string{"created_at", "name", "email"}, "created_at")
    sortOrder := qv.Enum("sort_order", []string{"asc", "desc"}, "desc")
    status := qv.Enum("status", []string{"active", "inactive", "pending"}, "")
    roles := qv.StringSlice("roles", ",")

    if qv.HasErrors() {
        ValidationErrorResponse(w, r, qv.Errors())
        return
    }

    // Use validated parameters...
}
```

### Junior → FAANG: Prerequisites and Worked Example

Before you can reason about the code above, you need four mental models locked in. First, HTTP is a stream of bytes, not a parsed object. `r.Body` is an `io.ReadCloser` that you can read exactly once. If you read it inside a logger and then try to decode, the decoder sees EOF and returns a confusing error. Second, `json.Decoder` reads incrementally from a stream, while `json.Unmarshal` requires the full byte slice in memory. For request bodies you almost always want the decoder because it composes with `http.MaxBytesReader`. Third, `DisallowUnknownFields` is a safety net, not a validation system. It rejects keys the struct does not declare, which catches typos like `emial` instead of `email` and also blocks mass-assignment attacks where a client sends `is_admin: true` hoping the backend silently binds it. Fourth, `Content-Type` is client-supplied metadata. You enforce it defensively because a browser form posting `application/x-www-form-urlencoded` to a JSON endpoint will produce garbage decode errors that look like bugs in your handler.

Worked example for a first on-call shift. A teammate pages you because `POST /api/v1/users` returns 500 for some clients and 400 for others with the same payload. You tail structured logs and see two distinct errors: `http: request body too large` and `json: cannot unmarshal string into Go struct field User.age of type int`. The first means a client sent more than `MaxBodySize` bytes, which should be 413 not 500. The second means a client sent `"age": "30"` as a string. Fix path: wire `parseJSONError` into the handler so `*http.MaxBytesError` maps to 413 and `*json.UnmarshalTypeError` maps to 400 with the offending field surfaced. Add a regression test that posts a 2 MB body and asserts 413. This is the exact debugging loop a first-year engineer owns end-to-end.

Interview entry-point questions you should be able to answer in two minutes each. Why is `dec.More()` called after `Decode`? Because `Decode` only consumes the first JSON value in the stream, so a client could send `{"name":"a"}{"admin":true}` and the second object would be silently ignored unless you explicitly check. Why cap body size before decoding rather than after? Because the decoder would otherwise allocate memory proportional to the body, so an attacker could exhaust heap with a 2 GB payload before you ever see it. What is the difference between `errors.Is` and `errors.As`? `Is` checks sentinel identity via the `Is` method chain, `As` walks the wrapping chain looking for a target type and assigns it. You use `As` for `*json.SyntaxError` because you want the `Offset` field, and `Is` for `io.EOF` because EOF is a sentinel with no payload.

### Senior @ FAANG: Request Body Governance at Scale

At staff level, request body validation stops being a per-handler concern and becomes a platform contract. The first shift is treating body size as a resource budget rather than a constant. A `POST /comments` endpoint has no business accepting more than 16 KB, while `POST /documents/upload` might legitimately stream 100 MB. A single global `MaxBodySize` is an anti-pattern. You publish a per-route size table in the route registry, the middleware reads it, and capacity planning treats the sum of `size * rps * concurrent_replicas` as the working-set ceiling for the pod. When a product team wants to raise a limit, it goes through a review that checks queue memory, ingress buffer config at the load balancer, and whether the timeout budget still covers transfer at p99 client bandwidth. This matters because the load balancer in front of your Go service almost certainly has its own body-size cap (nginx `client_max_body_size`, Envoy `max_request_bytes`, ALB 1 MB for Lambda targets) and a mismatch produces 502s instead of clean 413s.

The second shift is JSON DoS as a first-class threat model. `encoding/json` in the standard library recurses on nested objects, so a payload like `[[[[[[...]]]]]]` nested 10,000 deep will blow the goroutine stack or cost disproportionate CPU. Go 1.25 introduced `encoding/json/v2` behind a GOEXPERIMENT flag, bringing explicit depth limits and a streaming decode mode that never materializes the full document tree. With json/v2 reaching general availability in Go 1.27, the migration posture is: v2 for new services, v1 plus a depth-counting `io.Reader` wrapper for anything that cannot move yet. For YAML parsers wired to JSON-equivalent endpoints, reject the billion laughs attack by disabling or capping anchor and alias expansion in whichever parser you use. A JSON bomb variant that does not need any nesting at all is the "long string" attack, where a single field is tens of megabytes of `"a"` characters. It fits under a generous `MaxBodySize`, then gets copied into a database column, a log line, and a trace span, so one accepted request costs you several multiples of its own size downstream. Mitigation is a per-field length cap enforced at decode time, which means a named string type with its own `UnmarshalJSON` that checks length before assigning, not a check bolted on in the business logic layer.

The third shift is content-type enforcement as part of CSRF defense in depth. Browsers will not set `Content-Type: application/json` on a cross-origin fetch without triggering a CORS preflight, so strict content-type checking is a cheap second line after SameSite cookies and origin validation. This is why the snippet above rejects every request whose media type is not `application/json`, and why it rejects a request with no Content-Type at all rather than waving it through. Parameters are a separate question from the media type: `application/json; charset=utf-8` carries the right media type and is accepted, which is exactly why parsing with `mime.ParseMediaType` beats string-splitting. At FAANG scale you standardize on a single allowed media type per endpoint, log a distinct metric for mismatches, and alert when the rate spikes, because that is often the first signal that a client team shipped a broken SDK build.

The fourth shift is error schema as a versioned contract. `RequestError` above is fine for a single service, but across 400 microservices you need a central error catalog where codes like `INVALID_JSON` and `REQUEST_TOO_LARGE` are registered, documented in the developer portal, and emit a consistent Problem Details for HTTP APIs (RFC 9457) body. When a client parses `"code": "REQUEST_TOO_LARGE"` they should get the same string shape from every service, including the trace ID, the retryability hint, and a stable `type` URI. Rolling this out without breakage requires a dual-write period where services emit both the legacy shape and the RFC 9457 shape behind a feature flag, monitored via a client-reported "unknown error code" metric before cutover.

The fifth shift is observability of the validation layer itself. You emit one structured log per rejection with fields `route`, `error_code`, `field`, `bytes_read`, and `client_id`. You sample aggressively (1 in 1000 for common 400s, 1 in 1 for 413s and unknown-field errors) because a noisy deploy can otherwise push your log bill seven figures in a single week. The sampled stream feeds an anomaly detector that flags when a specific route starts emitting 10x more `UNKNOWN_FIELD` errors than baseline, which almost always means a client SDK shipped a field your server has not deployed yet, and that is how you catch rollout-order bugs before the pager fires.

---
