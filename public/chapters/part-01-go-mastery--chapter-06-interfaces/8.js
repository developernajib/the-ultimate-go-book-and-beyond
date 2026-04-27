export default `## 6.7 Interface Patterns

### Functional Options

The functional options pattern solves the problem of constructors with many optional parameters. Instead of a config struct or long parameter list, each option is a self-contained function that modifies the object being built. This keeps the constructor signature stable as new options are added.

\`\`\`go
type Server struct {
    addr    string
    timeout time.Duration
    logger  Logger
    tls     *tls.Config
}

type Option func(*Server)

func WithTimeout(d time.Duration) Option {
    return func(s *Server) {
        s.timeout = d
    }
}

func WithLogger(l Logger) Option {
    return func(s *Server) {
        s.logger = l
    }
}

func WithTLS(cfg *tls.Config) Option {
    return func(s *Server) {
        s.tls = cfg
    }
}

func NewServer(addr string, opts ...Option) *Server {
    s := &Server{
        addr:    addr,
        timeout: 30 * time.Second,  // default
        logger:  defaultLogger,      // default
    }
    for _, opt := range opts {
        opt(s)
    }
    return s
}

// Usage
server := NewServer("localhost:8080",
    WithTimeout(60*time.Second),
    WithLogger(customLogger),
)
\`\`\`

### Uber's Functional Options with Validation

Uber's variation promotes \`Option\` from a plain function type to an interface with an \`apply\` method that returns an error. This lets each option validate its input at construction time rather than requiring a separate validation pass after all options have been applied.

\`\`\`go
type Option interface {
    apply(*Server) error
}

type optionFunc func(*Server) error

func (f optionFunc) apply(s *Server) error {
    return f(s)
}

func WithTimeout(d time.Duration) Option {
    return optionFunc(func(s *Server) error {
        if d <= 0 {
            return errors.New("timeout must be positive")
        }
        s.timeout = d
        return nil
    })
}

func WithMaxConnections(max int) Option {
    return optionFunc(func(s *Server) error {
        if max < 1 || max > 10000 {
            return fmt.Errorf("max connections must be 1-10000, got %d", max)
        }
        s.maxConns = max
        return nil
    })
}

func NewServer(addr string, opts ...Option) (*Server, error) {
    s := &Server{
        addr:     addr,
        timeout:  30 * time.Second,
        maxConns: 100,
    }

    for _, opt := range opts {
        if err := opt.apply(s); err != nil {
            return nil, fmt.Errorf("invalid option: %w", err)
        }
    }

    return s, nil
}
\`\`\`

### Decorator Pattern

The decorator pattern wraps an interface implementation with additional behavior, logging, metrics, retries, caching, without modifying the original. Because the wrapper satisfies the same interface, callers are unaware of the added layer. Multiple decorators can be stacked.

\`\`\`go
type LoggingWriter struct {
    w      io.Writer
    logger *log.Logger
}

func (lw *LoggingWriter) Write(p []byte) (n int, err error) {
    n, err = lw.w.Write(p)
    lw.logger.Printf("wrote %d bytes", n)
    return
}

func NewLoggingWriter(w io.Writer, logger *log.Logger) io.Writer {
    return &LoggingWriter{w: w, logger: logger}
}

// Usage
var out io.Writer = os.Stdout
out = NewLoggingWriter(out, log.Default())
out.Write([]byte("hello"))  // Logs: wrote 5 bytes
\`\`\`

### Netflix's Middleware Chain Pattern

HTTP middleware in Go follows a specific shape: a function that takes an \`http.Handler\` and returns a new \`http.Handler\`. Each middleware wraps the next handler, adding behavior before or after the call. A \`Chain\` function applies multiple middleware in order, building a layered handler stack.

\`\`\`go
type Middleware func(http.Handler) http.Handler

// Logging middleware
func Logging(logger *zap.Logger) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()

            // Wrap response writer to capture status
            wrapped := &responseWriter{ResponseWriter: w, statusCode: 200}

            next.ServeHTTP(wrapped, r)

            logger.Info("request",
                zap.String("method", r.Method),
                zap.String("path", r.URL.Path),
                zap.Int("status", wrapped.statusCode),
                zap.Duration("duration", time.Since(start)),
            )
        })
    }
}

// Rate limiting middleware
func RateLimit(rps int) Middleware {
    limiter := rate.NewLimiter(rate.Limit(rps), rps)
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if !limiter.Allow() {
                http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

// Recovery middleware
func Recovery(logger *zap.Logger) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            defer func() {
                if err := recover(); err != nil {
                    logger.Error("panic recovered",
                        zap.Any("error", err),
                        zap.Stack("stack"),
                    )
                    http.Error(w, "internal error", http.StatusInternalServerError)
                }
            }()
            next.ServeHTTP(w, r)
        })
    }
}

// Chain applies middleware in order
func Chain(h http.Handler, middlewares ...Middleware) http.Handler {
    // Apply in reverse so first middleware is outermost
    for i := len(middlewares) - 1; i >= 0; i-- {
        h = middlewares[i](h)
    }
    return h
}

// Usage
handler := Chain(
    myHandler,
    Recovery(logger),
    Logging(logger),
    RateLimit(100),
)

type responseWriter struct {
    http.ResponseWriter
    statusCode int
}

func (w *responseWriter) WriteHeader(code int) {
    w.statusCode = code
    w.ResponseWriter.WriteHeader(code)
}
\`\`\`

### Strategy Pattern

The strategy pattern defines a family of interchangeable algorithms behind a common interface. The calling code selects which strategy to use at runtime without changing its own logic. This is useful for compression, serialization, routing, and any case where multiple approaches to the same problem coexist.

\`\`\`go
type Compressor interface {
    Compress([]byte) ([]byte, error)
    Decompress([]byte) ([]byte, error)
    Name() string
}

type GzipCompressor struct{}

func (g GzipCompressor) Name() string { return "gzip" }

func (g GzipCompressor) Compress(data []byte) ([]byte, error) {
    var buf bytes.Buffer
    w := gzip.NewWriter(&buf)
    if _, err := w.Write(data); err != nil {
        return nil, err
    }
    if err := w.Close(); err != nil {
        return nil, err
    }
    return buf.Bytes(), nil
}

func (g GzipCompressor) Decompress(data []byte) ([]byte, error) {
    r, err := gzip.NewReader(bytes.NewReader(data))
    if err != nil {
        return nil, err
    }
    defer r.Close()
    return io.ReadAll(r)
}

type ZstdCompressor struct {
    level int
}

func (z ZstdCompressor) Name() string { return "zstd" }

func (z ZstdCompressor) Compress(data []byte) ([]byte, error) {
    encoder, err := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.EncoderLevel(z.level)))
    if err != nil {
        return nil, err
    }
    return encoder.EncodeAll(data, nil), nil
}

func (z ZstdCompressor) Decompress(data []byte) ([]byte, error) {
    decoder, err := zstd.NewReader(nil)
    if err != nil {
        return nil, err
    }
    return decoder.DecodeAll(data, nil)
}

// Storage uses strategy pattern
type Storage struct {
    compressor Compressor
    backend    StorageBackend
}

func (s *Storage) Save(key string, data []byte) error {
    compressed, err := s.compressor.Compress(data)
    if err != nil {
        return fmt.Errorf("compression failed: %w", err)
    }
    return s.backend.Put(key, compressed)
}
\`\`\`

### Adapter Pattern

An adapter translates one interface into another, bridging incompatible APIs without modifying either side. This commonly appears when integrating third-party libraries whose interfaces differ from your application's internal contracts.

\`\`\`go
// Third-party logger
type ExternalLogger interface {
    LogMessage(level int, msg string)
}

// Your interface
type Logger interface {
    Debug(msg string, fields ...Field)
    Info(msg string, fields ...Field)
    Error(msg string, fields ...Field)
}

// Adapter
type LoggerAdapter struct {
    external ExternalLogger
}

func (a *LoggerAdapter) Debug(msg string, fields ...Field) {
    a.external.LogMessage(0, formatMessage(msg, fields))
}

func (a *LoggerAdapter) Info(msg string, fields ...Field) {
    a.external.LogMessage(1, formatMessage(msg, fields))
}

func (a *LoggerAdapter) Error(msg string, fields ...Field) {
    a.external.LogMessage(2, formatMessage(msg, fields))
}

func formatMessage(msg string, fields []Field) string {
    // Format fields into message
    var parts []string
    for _, f := range fields {
        parts = append(parts, fmt.Sprintf("%s=%v", f.Key, f.Value))
    }
    if len(parts) > 0 {
        return msg + " " + strings.Join(parts, " ")
    }
    return msg
}
\`\`\`

### Optional Interface Pattern

Sometimes a base interface covers the minimum contract, but specific implementations support additional capabilities like flushing or syncing. A type assertion at runtime checks whether the concrete value behind the interface supports the optional behavior, and calls it only when available.

\`\`\`go
type Writer interface {
    Write([]byte) (int, error)
}

type Flusher interface {
    Flush() error
}

type Syncer interface {
    Sync() error
}

func writeAndFlush(w Writer, data []byte) error {
    if _, err := w.Write(data); err != nil {
        return err
    }

    // Check if writer supports flushing
    if f, ok := w.(Flusher); ok {
        if err := f.Flush(); err != nil {
            return fmt.Errorf("flush failed: %w", err)
        }
    }

    // Check if writer supports syncing
    if s, ok := w.(Syncer); ok {
        if err := s.Sync(); err != nil {
            return fmt.Errorf("sync failed: %w", err)
        }
    }

    return nil
}
\`\`\`

### Interface Upgrade Pattern

The standard library's \`io.Copy\` uses this pattern internally. Before falling back to a manual read-write loop, it checks whether the source implements \`io.WriterTo\` or the destination implements \`io.ReaderFrom\`. If either optimized path is available, \`io.Copy\` uses it for a zero-copy or kernel-assisted transfer. You can apply the same technique in your own code.

\`\`\`go
func copyBuffer(dst io.Writer, src io.Reader, buf []byte) (int64, error) {
    // Check for optimized implementations
    if wt, ok := src.(io.WriterTo); ok {
        return wt.WriteTo(dst)
    }
    if rf, ok := dst.(io.ReaderFrom); ok {
        return rf.ReadFrom(src)
    }

    // Fallback to manual copy
    var written int64
    for {
        nr, rerr := src.Read(buf)
        if nr > 0 {
            nw, werr := dst.Write(buf[:nr])
            written += int64(nw)
            if werr != nil {
                return written, werr
            }
        }
        if rerr == io.EOF {
            return written, nil
        }
        if rerr != nil {
            return written, rerr
        }
    }
}
\`\`\`

### When to Reach for Each Pattern

For a senior engineer, the interface patterns library is a toolkit. The decision tree:

- **Strategy / polymorphism.** Use when the caller needs to pick between several implementations at runtime. Example: payment processor per provider.
- **Decorator / middleware.** Use when layering cross-cutting concerns (logging, metrics, retries) around a core implementation.
- **Factory.** Use when construction needs to choose between implementations based on runtime state (config, feature flag).
- **Adapter.** Use when integrating a third-party type whose API does not match your interface.
- **Functional options.** Use when a constructor has many optional parameters.
- **Type assertions and type switches.** Use sparingly. The default is polymorphism through interfaces, not dispatch on concrete types.

### Code-Review Lens (Senior Track)

Two patterns to flag:

1. **A decorator chain six layers deep.** The execution path becomes hard to debug. Simplify.
2. **A type assertion in a hot path that could be an interface method.** Move the branch into the concrete type.

### Staff Lens: Patterns as Shared Team Vocabulary

The concrete benefit of a named pattern is not the code. It is the conversation. When a reviewer writes "this is a functional option with validation" in a PR comment, every senior engineer on the team recognizes the shape in ten seconds instead of reading the code line by line. At staff level, the work is less about inventing patterns and more about enforcing a small, shared vocabulary so reviews go fast and new engineers ramp up quickly. Pick the five patterns the team uses (typically: functional options, middleware, strategy, adapter, optional-interface) and write a one-page internal doc with a canonical example of each. Add a link in CONTRIBUTING.md. This single artifact, refreshed annually, turns "let me explain this pattern in a review thread" into "see the pattern doc, section 3". It is one of the highest-leverage documentation investments a staff engineer can make for a Go team.

### Generics as a Pattern Alternative (Go 1.18+)

Several of the patterns above have a generic alternative in modern Go. Strategy with a single-method interface is sometimes better expressed as a function parameter. Decorator over a homogeneous type can become a generic wrapper. The rule: if the pattern dispatches on the concrete type at runtime, the interface version is correct. If the pattern parameterizes over types known at compile time, the generic version is smaller and faster. Do not rewrite working interface code into generics for its own sake. Do reach for generics when designing new code where the type is a parameter, not a runtime decision.

---
`;
