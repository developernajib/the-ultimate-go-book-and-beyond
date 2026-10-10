## 29.4 Request Handling

### Request Parsing

Parsing an incoming request involves extracting path parameters, query strings, headers, and the body. On the server side, Go's HTTP server closes the request body automatically after the handler returns, so you do not need `defer r.Body.Close()` in handlers. The examples below show typed helpers for each input source: JSON bodies, query parameters, form data, and multipart file uploads.

```go
package handlers

import (
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "os"
    "path/filepath"
    "strconv"
)

type FormData struct {
    Name  string
    Email string
}

// Parse JSON body
func parseJSON[T any](r *http.Request) (T, error) {
    var v T
    if err := json.NewDecoder(r.Body).Decode(&v); err != nil {
        return v, err
    }
    return v, nil
}

// Parse query parameters
func parseQueryParams(r *http.Request) QueryParams {
    q := r.URL.Query()

    page, _ := strconv.Atoi(q.Get("page"))
    if page < 1 {
        page = 1
    }

    limit, _ := strconv.Atoi(q.Get("limit"))
    if limit < 1 || limit > 100 {
        limit = 20
    }

    return QueryParams{
        Page:   page,
        Limit:  limit,
        Sort:   q.Get("sort"),
        Filter: q.Get("filter"),
    }
}

type QueryParams struct {
    Page   int
    Limit  int
    Sort   string
    Filter string
}

// Parse form data
func parseForm(r *http.Request) (*FormData, error) {
    if err := r.ParseForm(); err != nil {
        return nil, err
    }

    return &FormData{
        Name:  r.FormValue("name"),
        Email: r.FormValue("email"),
    }, nil
}

// Parse multipart form (file upload)
func handleFileUpload(w http.ResponseWriter, r *http.Request) {
    // Max 10MB
    if err := r.ParseMultipartForm(10 << 20); err != nil {
        http.Error(w, "File too large", http.StatusBadRequest)
        return
    }

    file, header, err := r.FormFile("file")
    if err != nil {
        http.Error(w, "No file provided", http.StatusBadRequest)
        return
    }
    defer file.Close()

    // Save file (use filepath.Base to prevent path traversal attacks)
    safeName := filepath.Base(header.Filename)
    dst, err := os.Create(filepath.Join("uploads", safeName))
    if err != nil {
        http.Error(w, "Failed to save file", http.StatusInternalServerError)
        return
    }
    defer dst.Close()

    io.Copy(dst, file)

    w.WriteHeader(http.StatusOK)
    fmt.Fprintf(w, "Uploaded: %s (%d bytes)", header.Filename, header.Size)
}
```

### Response Helpers

Centralizing response writing in helper functions enforces a consistent envelope format, status code, error message, pagination metadata, across all endpoints. A `respond(w, status, payload)` helper encodes JSON, sets the `Content-Type` header, and writes the status code atomically.

```go
package handlers

import (
    "encoding/json"
    "net/http"
)

type Response struct {
    Data    any `json:"data,omitempty"`
    Error   string      `json:"error,omitempty"`
    Message string      `json:"message,omitempty"`
}

func respondJSON(w http.ResponseWriter, status int, data any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(Response{Data: data})
}

func respondError(w http.ResponseWriter, status int, message string) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(Response{Error: message})
}

func respondCreated(w http.ResponseWriter, data any, location string) {
    if location != "" {
        w.Header().Set("Location", location)
    }
    respondJSON(w, http.StatusCreated, data)
}

func respondNoContent(w http.ResponseWriter) {
    w.WriteHeader(http.StatusNoContent)
}

// Pagination response
type PaginatedResponse struct {
    Data       any `json:"data"`
    Page       int         `json:"page"`
    Limit      int         `json:"limit"`
    TotalItems int         `json:"total_items"`
    TotalPages int         `json:"total_pages"`
}

func respondPaginated(w http.ResponseWriter, data any, page, limit, total int) {
    totalPages := (total + limit - 1) / limit

    response := PaginatedResponse{
        Data:       data,
        Page:       page,
        Limit:      limit,
        TotalItems: total,
        TotalPages: totalPages,
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}
```

### Junior to FAANG: Parsing Input Without Shooting Yourself in the Foot

Three defaults to bake into every handler from day one. First, wrap `r.Body` in `http.MaxBytesReader(w, r.Body, maxBytes)` before decoding so a client cannot OOM your process with an unbounded JSON payload. Second, use `json.Decoder.DisallowUnknownFields()` so typos in client payloads fail loudly instead of silently dropping fields. Third, check `dec.More()` after the first decode to reject trailing garbage (a common smuggling trick is to append a second JSON object after a valid one).

```go
func decodeJSON[T any](w http.ResponseWriter, r *http.Request, maxBytes int64) (T, error) {
    var v T
    r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
    dec := json.NewDecoder(r.Body)
    dec.DisallowUnknownFields()
    if err := dec.Decode(&v); err != nil {
        return v, err
    }
    if dec.More() {
        return v, errors.New("body must contain a single JSON object")
    }
    return v, nil
}
```

File upload traps. `r.ParseMultipartForm(10 << 20)` caps memory used for form parsing, but the total request size is not capped by that alone. Combine with `http.MaxBytesReader` on `r.Body` for a hard ceiling. Always `filepath.Base` the filename. Never pass uploaded bytes directly to `os.Exec` or a shell. Scan for MIME type server-side with `http.DetectContentType` on the first 512 bytes, do not trust the `Content-Type` header.

Interview framing. "How would you handle a malicious client that sends `Content-Length: 100` but streams 10 GB?" Answer, `MaxBytesReader` fires an error on read before the full body is consumed, and the server writes the error and closes. Bonus, mention that without `MaxBytesReader` you have a DoS surface.

### Senior at FAANG: A Platform Decoder Contract

Publish `platform/request` with two functions. `Decode[T](w, r, opts) (T, error)` and `Query[T](r, opts) (T, error)`. Both enforce max body size, disallow unknown fields, validate via struct tags (integrate with `go-playground/validator`), and produce RFC 7807 problem+json errors on failure. Every handler decodes through this one path. The payoff. When you need to add request-signing verification, schema-registry enforcement, or PII redaction in logs, you change one library.

Response contract governance. The `data` wrapper shown in the snippet is fine for early-stage services, but at FAANG scale publish a response envelope spec (JSend, JSON:API, or a custom one) and enforce via contract tests. Pagination metadata must be consistent across services (`page`, `limit`, `total_items`, `next_cursor`). Clients written once should work against any service.

Content negotiation. Handlers should support `application/json`, `application/problem+json` for errors, and `application/vnd.corp.v2+json` for versioned payloads. Reject other `Accept` headers with 406. Write the negotiation into platform response helpers, not per handler.

Streaming responses. For large payloads, stream via `json.NewEncoder(w).Encode` in a loop over a cursor, or use NDJSON (`application/x-ndjson`). Do not load the full result set into memory. Combine with `http.ResponseController.SetWriteDeadline(time.Time{})` to disable the write timeout for long streams, and `Flusher.Flush()` after each record to send bytes to the client immediately.

Pagination strategy. Offset pagination (`page`, `limit`) is simple but degrades with deep pages (database scans get expensive). Cursor pagination (`?after=opaque-token`) is the FAANG standard for anything beyond 1000 rows. Publish both helpers, default new services to cursor, document the migration path for offset-based clients. Cursors must be signed HMAC tokens so clients cannot forge positions.

File upload at scale. Do not stream uploads through your Go service. Use presigned S3 or GCS URLs, have the client upload directly, then have your service process the post-upload metadata. This removes one of the biggest sources of goroutine-blocking, disk-filling, and connection-holding bugs. When an in-service upload path is unavoidable (regulatory, encryption), cap concurrent uploads with a semaphore and run them on a dedicated pod class with higher CPU and disk quota.

Request parsing performance. `encoding/json` in Go 1.25+ is fast, but for hot paths evaluate `go-json`, `sonic`, or `segmentio/encoding/json`. Benchmark with your actual payloads. Do not switch for the sake of it. `encoding/json` is the safer default because of its `DisallowUnknownFields` and standard-library CVE responsiveness.

Observability of request bodies. Never log bodies by default. For debugging, support a `/debug/tapper` endpoint behind strong auth that samples one request per 10000 into an encrypted S3 bucket with a 7-day retention. This is gold during incidents and a compliance disaster if rolled out naively. Write the ADR, get privacy signoff, enforce via a review gate.

Schema versioning. Every request and response type lives in a versioned schema (protobuf, JSON Schema, OpenAPI). A CI gate rejects breaking changes. Backward compatibility rules, additive-only. Clients must tolerate unknown fields (which is why server uses `DisallowUnknownFields` but documents that clients should not). Publish the rules in the API guidelines.

Staff archetype in request-handling work. The API Standards Lead owns the schema registry, the response envelope spec, and the pagination contract. Reviews every new public endpoint before launch. One of the most valuable roles in a platform team.

---
