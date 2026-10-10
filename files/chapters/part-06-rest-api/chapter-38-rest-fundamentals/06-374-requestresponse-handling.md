## 38.4 Request/Response Handling

### JSON Request Parsing

Parsing an incoming request involves extracting path parameters, query strings, headers, and the body. On the server side, `net/http` closes the request body automatically after the handler returns, so you do not need `defer r.Body.Close()`. The real concern is limiting body size and handling malformed input gracefully, which the `DecodeJSON` helper below addresses.

```go
// ... imports omitted for brevity (encoding/json, errors, fmt, io, net/http, strings)

// MaxBodySize limits request body size (1MB)
const MaxBodySize = 1 << 20

// DecodeJSON decodes JSON request body with validation
func DecodeJSON(r *http.Request, dst any) error {
    // Check content type
    ct := r.Header.Get("Content-Type")
    if ct != "" {
        mediaType := strings.ToLower(strings.TrimSpace(strings.Split(ct, ";")[0]))
        if mediaType != "application/json" {
            return fmt.Errorf("content-type must be application/json")
        }
    }

    // Limit body size
    r.Body = http.MaxBytesReader(nil, r.Body, MaxBodySize)

    dec := json.NewDecoder(r.Body)
    dec.DisallowUnknownFields() // Strict parsing

    if err := dec.Decode(dst); err != nil {
        var syntaxError *json.SyntaxError
        var unmarshalTypeError *json.UnmarshalTypeError
        var maxBytesError *http.MaxBytesError

        switch {
        case errors.As(err, &syntaxError):
            return fmt.Errorf("malformed JSON at position %d", syntaxError.Offset)

        case errors.Is(err, io.ErrUnexpectedEOF):
            return errors.New("malformed JSON")

        case errors.As(err, &unmarshalTypeError):
            return fmt.Errorf("invalid value for %q at position %d",
                unmarshalTypeError.Field, unmarshalTypeError.Offset)

        case strings.HasPrefix(err.Error(), "json: unknown field"):
            fieldName := strings.TrimPrefix(err.Error(), "json: unknown field ")
            return fmt.Errorf("unknown field %s", fieldName)

        case errors.As(err, &maxBytesError):
            return fmt.Errorf("request body too large (max %d bytes)", MaxBodySize)

        case errors.Is(err, io.EOF):
            return errors.New("request body is empty")

        default:
            return err
        }
    }

    // Check for multiple JSON objects
    if dec.More() {
        return errors.New("request body must contain a single JSON object")
    }

    return nil
}

// Handler using DecodeJSON
func createUserHandler(w http.ResponseWriter, r *http.Request) {
    var input struct {
        Name  string `json:"name"`
        Email string `json:"email"`
    }

    if err := DecodeJSON(r, &input); err != nil {
        WriteError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
        return
    }

    // Process input...
}
```

### JSON Response Writing

Encoding a struct to JSON and writing it as the response body is a two-step operation: set the `Content-Type` header before writing the status code, then call `json.NewEncoder(w).Encode(v)`. Setting headers after `WriteHeader` has no effect, so header setup must precede the status call.

```go
// ... imports omitted for brevity (encoding/json, net/http)

// Response wraps successful responses
type Response struct {
    Data any `json:"data"`
    Meta *Meta       `json:"meta,omitempty"`
}

type Meta struct {
    Page       int    `json:"page,omitempty"`
    PageSize   int    `json:"page_size,omitempty"`
    TotalCount int64  `json:"total_count,omitempty"`
    TotalPages int    `json:"total_pages,omitempty"`
    NextCursor string `json:"next_cursor,omitempty"`
}

// WriteJSON writes JSON response
func WriteJSON(w http.ResponseWriter, status int, data any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)

    if data != nil {
        if err := json.NewEncoder(w).Encode(data); err != nil {
            // Log error but don't try to write again
            // since headers are already sent
        }
    }
}

// WriteData writes successful response with data
func WriteData(w http.ResponseWriter, status int, data any) {
    WriteJSON(w, status, Response{Data: data})
}

// WriteDataWithMeta writes response with pagination metadata
func WriteDataWithMeta(w http.ResponseWriter, data any, meta Meta) {
    WriteJSON(w, http.StatusOK, Response{
        Data: data,
        Meta: &meta,
    })
}

// Example usage
func listUsersHandler(w http.ResponseWriter, r *http.Request) {
    params := ParseQueryParams(r)

    users, total, err := userService.List(r.Context(), params)
    if err != nil {
        WriteError(w, http.StatusInternalServerError, ErrCodeInternal, "Failed to list users")
        return
    }

    totalPages := int(total) / params.PageSize
    if int(total)%params.PageSize > 0 {
        totalPages++
    }

    WriteDataWithMeta(w, users, Meta{
        Page:       params.Page,
        PageSize:   params.PageSize,
        TotalCount: total,
        TotalPages: totalPages,
    })
}

// Response format:
// {
//   "data": [...],
//   "meta": {
//     "page": 1,
//     "page_size": 20,
//     "total_count": 150,
//     "total_pages": 8
//   }
// }
```

### Junior → FAANG: request and response handling prerequisites

If you are new to Go HTTP servers, the mental model is that `http.Request` is a struct populated by the server goroutine before your handler runs, and `http.ResponseWriter` is an interface that buffers headers until the first `Write` or explicit `WriteHeader` call. Once the status line goes out, header edits are silently ignored. That is the single most common junior mistake, setting `Content-Type` after calling `WriteHeader(200)` and wondering why curl shows `text/plain`.

Worked example for a first on-call rotation. A user reports that POST `/users` sometimes returns 201 with an empty body. You check the handler and find `json.NewEncoder(w).Encode(user)` called after `w.WriteHeader(http.StatusCreated)` but with a `user` value that has an exported field holding a `chan struct{}`. Encoder fails, but the status was already flushed, so the client sees 201 with no body. Fix: encode into a `bytes.Buffer` first, check the error, then write status and copy the buffer. The helper `WriteJSON` above hides this by encoding straight to `w`, which is acceptable only when you control the shape of `data` and know it cannot fail to marshal.

Four things an interviewer will probe at the entry level. First, why `r.Body.Close()` is not required on the server side but is required on the client side (the server runtime closes it, a client response body leaks the underlying TCP connection if you forget). Second, why `json.Unmarshal` loads the whole body into memory while `json.NewDecoder(r.Body).Decode` streams, and when each is appropriate (Decoder for network bodies, Unmarshal for small in-memory buffers where you already have the bytes). Third, why `DisallowUnknownFields` matters for API hygiene (catches client typos early, forces versioning discipline). Fourth, how `http.MaxBytesReader` differs from wrapping with `io.LimitReader` (MaxBytesReader returns `*http.MaxBytesError` and closes the connection, LimitReader silently truncates, which is a security bug for JSON input because truncated JSON parses as a syntax error and leaks nothing useful).

### Senior @ FAANG: request and response handling at staff and principal scope

At staff level the `DecodeJSON` helper above is a starting point, not a destination. The real questions are about the tail of the latency distribution, allocation pressure under load, and the interaction with deadlines propagated from upstream services. A principal engineer reviewing this code will ask five things before approving it for a tier-1 service.

First, body size policy. `1 << 20` as a global constant is wrong for any non-trivial API. Bulk ingest endpoints need 10 to 100 MiB, login endpoints need 4 KiB, file-upload endpoints stream through a multipart reader and never buffer. The correct shape is a per-route limit injected through middleware, with the global default set aggressively low and overrides explicit. `MaxBytesReader` returns `*http.MaxBytesError` which should map to 413 Payload Too Large, not 400, and should emit a metric tagged by route so capacity planners can see which endpoints are hitting the cap. Also note `MaxBytesReader` takes a `ResponseWriter` as its first argument so it can signal the server to close the connection after the limit is hit, preventing a slow-loris attacker from holding the goroutine while streaming past the cap. Passing nil (permitted since Go 1.20) gives up that signal, so pass the real writer in handlers.

Second, decode strategy. `json.Decoder` streams but allocates a bufio reader and holds a 4 KiB scratch buffer per call. For a service handling 50k RPS of small payloads, that is 200 MiB of transient allocation per second hitting the GC. The pattern senior engineers reach for in 2026 is either (a) `encoding/json/v2`, GA since Go 1.27 with no experiment flag, which fixes the allocation profile and adds `json.UnmarshalRead` for io.Reader sources without the Decoder overhead, or (b) third-party codecs such as bytedance/sonic on amd64 (SIMD-accelerated), goccy/go-json (pure Go, drop-in replacement), or segmentio/encoding/json (lowest allocation count). Benchmark your actual payloads. For payloads under 1 KiB the difference is noise, for 100 KiB payloads on the hot path sonic saves real CPU. Verify sonic's support for your non-amd64 targets before adopting it, historically it fell back to a slower compatibility path there.

Third, deadline and context propagation. `DecodeJSON` reads from `r.Body` which honors the server's `ReadTimeout` and `ReadHeaderTimeout` but does not automatically honor `r.Context()`. A malicious client streaming bytes slowly under the read timeout can hold a goroutine for the full ReadTimeout even if your handler's context has been canceled by an upstream load balancer. The fix is to wrap the body in a context-aware reader that returns `ctx.Err()` when the deadline trips, or to run the decode in a goroutine and select on `ctx.Done()`. Neither is free. The pragmatic production answer is to set `http.Server.ReadTimeout` to a value tighter than your p99 request arrival time and rely on it, while documenting the assumption in the handler. If you truly need per-handler deadlines that supersede the server, use `http.TimeoutHandler` at the middleware layer and accept the goroutine leak tradeoff it introduces (the handler goroutine keeps running until it returns on its own, so the body decode finishes even though the response was already 503'd).

Fourth, response encoding and backpressure. `json.NewEncoder(w).Encode` writes directly to the socket buffer, which means slow clients apply backpressure up the call stack and your handler goroutine sits in `write()`. For large responses this is fine and even desirable. For responses under 64 KiB on a high-QPS endpoint, encode into a pooled `bytes.Buffer` first so the handler releases the goroutine quickly and the server's write path can coalesce. A `sync.Pool` of `*bytes.Buffer` with a `Reset` on return cuts allocation by an order of magnitude. Add a `Content-Length` header when buffering, which enables keep-alive without chunked transfer encoding and lets the client pre-allocate. Set `Trailer` headers only when you actually need them, most HTTP/2 middleboxes handle trailers poorly.

Fifth, observability on the decode path. Every failure mode in the `DecodeJSON` switch should emit a distinct metric counter tagged with the failure class (`malformed`, `unknown_field`, `too_large`, `wrong_type`, `empty`), not a single `decode_error` counter. When a client library ships a bad release and starts sending `unknown_field` at 5 percent rate, you want to see that on a dashboard without grepping logs. Attach the failure class to the OpenTelemetry span as an attribute so traces are filterable. Never include the raw body in logs or spans, even truncated, because it is user-controlled and a PII exfiltration vector. Log the `Content-Length`, the `User-Agent`, the route pattern, and the failure class. That is enough to triage every real incident without creating a compliance problem.

A final architectural note. The `Response` and `Meta` envelope shown here is fine for new APIs, but do not retrofit it onto an existing API that returns bare arrays, you will break every client at once. If you inherit a bare-array API, introduce the envelope behind an `Accept: application/vnd.api.v2+json` version header, keep the old shape on the unversioned route, and deprecate on a documented schedule. The lesson every senior engineer learns the hard way is that the response envelope is a public contract and the cost of changing it is measured in client-library releases across every consumer team.

---
