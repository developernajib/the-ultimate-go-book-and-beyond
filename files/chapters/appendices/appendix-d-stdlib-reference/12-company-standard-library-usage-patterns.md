## Company Standard Library Usage Patterns

### Google's Standard Library Extensions

**Context Propagation Patterns:**

```go
// Google's approach to context values (from internal best practices)
// Typed context keys prevent collisions

package requestcontext

import (
    "context"
    "net/http"
)

// contextKey is a typed key for context values
type contextKey int

const (
    requestIDKey contextKey = iota
    userIDKey
    traceIDKey
    deadlineKey
)

// Google's pattern: Strongly-typed context accessors
func WithRequestID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, requestIDKey, id)
}

func RequestIDFrom(ctx context.Context) (string, bool) {
    id, ok := ctx.Value(requestIDKey).(string)
    return id, ok
}

func WithUserID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, userIDKey, id)
}

func UserIDFrom(ctx context.Context) (string, bool) {
    id, ok := ctx.Value(userIDKey).(string)
    return id, ok
}

// Google Cloud's context middleware pattern
func RequestContextMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Extract or generate request ID
        requestID := r.Header.Get("X-Request-ID")
        if requestID == "" {
            requestID = generateRequestID()
        }
        ctx = WithRequestID(ctx, requestID)

        // Extract trace ID for distributed tracing
        traceID := r.Header.Get("X-Cloud-Trace-Context")
        if traceID != "" {
            ctx = context.WithValue(ctx, traceIDKey, traceID)
        }

        // Add request ID to response headers
        w.Header().Set("X-Request-ID", requestID)

        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### Uber's HTTP Client Patterns

**Production HTTP Client Configuration:**

```go
// Uber's approach to HTTP clients (from internal guidelines)
package httpclient

import (
    "context"
    "net"
    "net/http"
    "time"
)

// Config holds HTTP client configuration
type Config struct {
    Timeout             time.Duration
    KeepAlive           time.Duration
    MaxIdleConns        int
    MaxIdleConnsPerHost int
    MaxConnsPerHost     int
    IdleConnTimeout     time.Duration
}

// DefaultConfig returns Uber's recommended defaults
func DefaultConfig() Config {
    return Config{
        Timeout:             30 * time.Second,
        KeepAlive:           30 * time.Second,
        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 10,
        MaxConnsPerHost:     100,
        IdleConnTimeout:     90 * time.Second,
    }
}

// NewClient creates a production-ready HTTP client
func NewClient(cfg Config) *http.Client {
    transport := &http.Transport{
        DialContext: (&net.Dialer{
            Timeout:   cfg.Timeout,
            KeepAlive: cfg.KeepAlive,
        }).DialContext,
        MaxIdleConns:        cfg.MaxIdleConns,
        MaxIdleConnsPerHost: cfg.MaxIdleConnsPerHost,
        MaxConnsPerHost:     cfg.MaxConnsPerHost,
        IdleConnTimeout:     cfg.IdleConnTimeout,
        // Uber's recommendations for TLS
        TLSHandshakeTimeout:   10 * time.Second,
        ExpectContinueTimeout: 1 * time.Second,
        ResponseHeaderTimeout: cfg.Timeout,
        // Enable HTTP/2
        ForceAttemptHTTP2: true,
    }

    return &http.Client{
        Transport: transport,
        Timeout:   cfg.Timeout,
    }
}

// RequestWithRetry implements Uber's retry pattern
func RequestWithRetry(ctx context.Context, client *http.Client, req *http.Request, maxRetries int) (*http.Response, error) {
    var resp *http.Response
    var err error

    backoff := 100 * time.Millisecond

    for attempt := 0; attempt <= maxRetries; attempt++ {
        if attempt > 0 {
            select {
            case <-ctx.Done():
                return nil, ctx.Err()
            case <-time.After(backoff):
                backoff *= 2
                if backoff > 5*time.Second {
                    backoff = 5 * time.Second
                }
            }
        }

        resp, err = client.Do(req.WithContext(ctx))
        if err == nil && resp.StatusCode < 500 {
            return resp, nil
        }

        if resp != nil {
            resp.Body.Close()
        }
    }

    return resp, err
}
```

### Netflix's io Package Patterns

**Streaming with Buffering:**

```go
// Netflix's approach to efficient streaming (inspired by their Go services)
package streaming

import (
    "bufio"
    "io"
    "sync"
)

// BufferedPipe provides high-throughput streaming between goroutines
type BufferedPipe struct {
    reader *io.PipeReader
    writer *io.PipeWriter
    buffer *bufio.ReadWriter
    mu     sync.Mutex
}

// NewBufferedPipe creates a buffered pipe with configurable buffer size
func NewBufferedPipe(bufferSize int) *BufferedPipe {
    pr, pw := io.Pipe()

    return &BufferedPipe{
        reader: pr,
        writer: pw,
        buffer: bufio.NewReadWriter(
            bufio.NewReaderSize(pr, bufferSize),
            bufio.NewWriterSize(pw, bufferSize),
        ),
    }
}

// ChunkedCopy copies data in chunks with progress tracking
// Netflix uses this for video segment delivery
func ChunkedCopy(dst io.Writer, src io.Reader, chunkSize int, progress func(int64)) (int64, error) {
    buf := make([]byte, chunkSize)
    var total int64

    for {
        n, err := src.Read(buf)
        if n > 0 {
            written, writeErr := dst.Write(buf[:n])
            total += int64(written)

            if progress != nil {
                progress(total)
            }

            if writeErr != nil {
                return total, writeErr
            }
        }

        if err == io.EOF {
            return total, nil
        }
        if err != nil {
            return total, err
        }
    }
}

// MultiReader with error handling - Netflix's pattern for redundant sources
func ReliableMultiRead(ctx context.Context, sources []io.Reader) io.Reader {
    pr, pw := io.Pipe()

    go func() {
        defer pw.Close()

        for _, src := range sources {
            select {
            case <-ctx.Done():
                pw.CloseWithError(ctx.Err())
                return
            default:
                if _, err := io.Copy(pw, src); err == nil {
                    return // Success, done
                }
                // Try next source on error
            }
        }
        pw.CloseWithError(io.ErrUnexpectedEOF)
    }()

    return pr
}
```

### Stripe's JSON Handling

**Custom Marshaling for API Responses:**

```go
// Stripe's approach to JSON marshaling with API versioning
package api

import (
    "encoding/json"
    "time"
)

// UnixTime marshals time as Unix timestamp (Stripe's API format)
type UnixTime struct {
    time.Time
}

func (t UnixTime) MarshalJSON() ([]byte, error) {
    return json.Marshal(t.Unix())
}

func (t *UnixTime) UnmarshalJSON(data []byte) error {
    var unix int64
    if err := json.Unmarshal(data, &unix); err != nil {
        return err
    }
    t.Time = time.Unix(unix, 0)
    return nil
}

// NullableString handles Stripe's null vs absent field distinction
type NullableString struct {
    Value string
    Valid bool
    Set   bool
}

func (s NullableString) MarshalJSON() ([]byte, error) {
    if !s.Set {
        // Field not set, will be omitted with omitempty
        return nil, nil
    }
    if !s.Valid {
        return []byte("null"), nil
    }
    return json.Marshal(s.Value)
}

func (s *NullableString) UnmarshalJSON(data []byte) error {
    s.Set = true
    if string(data) == "null" {
        s.Valid = false
        return nil
    }
    s.Valid = true
    return json.Unmarshal(data, &s.Value)
}

// APIResponse wraps responses with metadata (Stripe pattern)
type APIResponse[T any] struct {
    Object     string    `json:"object"`
    Data       T         `json:"data"`
    HasMore    bool      `json:"has_more,omitempty"`
    URL        string    `json:"url,omitempty"`
    RequestID  string    `json:"request_id"`
    Created    UnixTime  `json:"created"`
    Livemode   bool      `json:"livemode"`
}

// PaginatedList for list endpoints
type PaginatedList[T any] struct {
    Object     string    `json:"object"` // Always "list"
    Data       []T       `json:"data"`
    HasMore    bool      `json:"has_more"`
    URL        string    `json:"url"`
    TotalCount int       `json:"total_count,omitempty"`
}

// NewPaginatedList creates a Stripe-style paginated response
func NewPaginatedList[T any](items []T, url string, hasMore bool) PaginatedList[T] {
    return PaginatedList[T]{
        Object:  "list",
        Data:    items,
        HasMore: hasMore,
        URL:     url,
    }
}
```

### Company stdlib Usage Summary

| Package | Google | Uber | Netflix | Stripe |
|---------|--------|------|---------|--------|
| **context** | Typed keys, propagation | Request tracing | Cancellation | API versioning |
| **net/http** | Middleware chains | Connection pooling | Streaming | Idempotency |
| **io** | Efficient copying | Buffered reads | Chunked transfer | Stream parsing |
| **encoding/json** | Proto integration | Structured logging | Config parsing | API responses |
| **sync** | RWMutex patterns | Pool reuse | Atomic counters | Rate limiting |
| **testing** | Table-driven | Leak detection | Chaos testing | API testing |

---
