export default `## 6.4 Standard Library Interfaces

Go's standard library defines a small set of interfaces that appear across nearly every package. Knowing these interfaces, their contracts, their quirks, and how they compose, is a prerequisite for writing Go that integrates cleanly with the ecosystem.

### io.Reader and io.Writer

\`io.Reader\` and \`io.Writer\` are the two most pervasive interfaces in Go. They abstract byte-level I/O so that a function written against \`io.Reader\` works with files, network sockets, in-memory buffers, compression streams, and anything else that produces bytes.

\`\`\`go
type Reader interface {
    Read(p []byte) (n int, err error)
}

type Writer interface {
    Write(p []byte) (n int, err error)
}
\`\`\`

Everything uses them: files, network connections, HTTP bodies, compression, encryption.

\`\`\`go
// Reading from any source
func countBytes(r io.Reader) (int64, error) {
    var total int64
    buf := make([]byte, 1024)
    for {
        n, err := r.Read(buf)
        total += int64(n)
        if err == io.EOF {
            return total, nil
        }
        if err != nil {
            return total, err
        }
    }
}

// Works with files
f, _ := os.Open("file.txt")
countBytes(f)

// Works with HTTP responses
resp, _ := http.Get("https://example.com")
countBytes(resp.Body)

// Works with strings
countBytes(strings.NewReader("hello world"))
\`\`\`

### Complete io.Reader Implementation

Implementing \`io.Reader\` requires satisfying a single-method interface, yet it integrates the custom type with the entire \`io\` package ecosystem including \`io.Copy\`, \`bufio.Scanner\`, and compression libraries.

\`\`\`go
// RandomReader generates random bytes
type RandomReader struct {
    rng *rand.Rand
}

func NewRandomReader(seed int64) *RandomReader {
    return &RandomReader{
        rng: rand.New(rand.NewPCG(uint64(seed), 0)),
    }
}

func (r *RandomReader) Read(p []byte) (n int, err error) {
    for i := range p {
        p[i] = byte(r.rng.Intn(256))
    }
    return len(p), nil // Never returns EOF
}

// LimitedRandomReader generates limited random bytes
type LimitedRandomReader struct {
    rng       *rand.Rand
    remaining int64
}

func NewLimitedRandomReader(seed int64, limit int64) *LimitedRandomReader {
    return &LimitedRandomReader{
        rng:       rand.New(rand.NewPCG(uint64(seed), 0)),
        remaining: limit,
    }
}

func (r *LimitedRandomReader) Read(p []byte) (n int, err error) {
    if r.remaining <= 0 {
        return 0, io.EOF
    }

    // Don't read more than remaining
    if int64(len(p)) > r.remaining {
        p = p[:r.remaining]
    }

    for i := range p {
        p[i] = byte(r.rng.Intn(256))
    }

    r.remaining -= int64(len(p))
    return len(p), nil
}

// Verify interface compliance
var _ io.Reader = (*RandomReader)(nil)
var _ io.Reader = (*LimitedRandomReader)(nil)
\`\`\`

### io.Closer

The \`io.Closer\` interface signals that a resource must be released after use. It is typically composed with \`io.Reader\` or \`io.Writer\` into \`io.ReadCloser\` to represent resources like files and network connections.

\`\`\`go
type Closer interface {
    Close() error
}

// Common pattern
func processFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()  // Always close

    // Use f...
    return nil
}
\`\`\`

### Stripe's Closer Pattern

When a function opens multiple closeable resources, a \`ResourceManager\` collects them and closes all of them in reverse order (LIFO) during cleanup. This prevents resource leaks when a later allocation fails after earlier resources have already been opened.

\`\`\`go
// ResourceManager handles cleanup of multiple resources
type ResourceManager struct {
    closers []io.Closer
    mu      sync.Mutex
}

func NewResourceManager() *ResourceManager {
    return &ResourceManager{}
}

func (rm *ResourceManager) Add(c io.Closer) {
    rm.mu.Lock()
    defer rm.mu.Unlock()
    rm.closers = append(rm.closers, c)
}

func (rm *ResourceManager) CloseAll() error {
    rm.mu.Lock()
    defer rm.mu.Unlock()

    var errs []error
    // Close in reverse order (LIFO)
    for i := len(rm.closers) - 1; i >= 0; i-- {
        if err := rm.closers[i].Close(); err != nil {
            errs = append(errs, err)
        }
    }

    if len(errs) > 0 {
        return fmt.Errorf("close errors: %v", errs)
    }
    return nil
}

// Usage in service
func (s *Service) ProcessBatch(ctx context.Context) error {
    rm := NewResourceManager()
    defer rm.CloseAll()

    db, err := s.getDBConnection()
    if err != nil {
        return err
    }
    rm.Add(db)

    cache, err := s.getCacheConnection()
    if err != nil {
        return err
    }
    rm.Add(cache)

    // Process...
    return nil
}
\`\`\`

### fmt.Stringer

The \`fmt.Stringer\` interface lets a type control how it appears in formatted output. When \`fmt.Println\` or \`fmt.Sprintf\` encounters a value that implements \`String() string\`, it calls that method instead of using the default struct formatting.

\`\`\`go
type Stringer interface {
    String() string
}

type Point struct {
    X, Y int
}

func (p Point) String() string {
    return fmt.Sprintf("(%d, %d)", p.X, p.Y)
}

p := Point{3, 4}
fmt.Println(p)  // (3, 4)
\`\`\`

### error Interface

The \`error\` interface is the simplest in the standard library: a single \`Error() string\` method. Every custom error type satisfies this interface, making error values first-class citizens that carry structured information.

\`\`\`go
type error interface {
    Error() string
}

// Custom error
type ValidationError struct {
    Field   string
    Message string
}

func (e ValidationError) Error() string {
    return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

func validate(email string) error {
    if !strings.Contains(email, "@") {
        return ValidationError{
            Field:   "email",
            Message: "must contain @",
        }
    }
    return nil
}
\`\`\`

### sort.Interface

The \`sort.Interface\` requires three methods that describe how to compare and swap elements. Any type implementing these three methods gains access to the full \`sort\` package, including stable sort.

\`\`\`go
type Interface interface {
    Len() int
    Less(i, j int) bool
    Swap(i, j int)
}

type People []Person

func (p People) Len() int           { return len(p) }
func (p People) Less(i, j int) bool { return p[i].Age < p[j].Age }
func (p People) Swap(i, j int)      { p[i], p[j] = p[j], p[i] }

people := People{{Name: "Bob", Age: 30}, {Name: "Alice", Age: 25}}
sort.Sort(people)  // Sorted by age
\`\`\`

### http.Handler

The \`http.Handler\` interface decouples request handling logic from the HTTP server machinery. Any type with a \`ServeHTTP\` method can serve HTTP requests, enabling composable middleware chains.

\`\`\`go
type Handler interface {
    ServeHTTP(ResponseWriter, *Request)
}

type HelloHandler struct{}

func (h HelloHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "Hello, World!")
}

// http.HandlerFunc is a convenience
http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "Hello!")
})
\`\`\`

### json.Marshaler and Unmarshaler

The \`json.Marshaler\` and \`json.Unmarshaler\` interfaces allow types to control their own JSON serialization. This is essential for types with custom representations or non-standard encodings.

\`\`\`go
type Marshaler interface {
    MarshalJSON() ([]byte, error)
}

type Unmarshaler interface {
    UnmarshalJSON([]byte) error
}

type CustomTime struct {
    time.Time
}

func (t CustomTime) MarshalJSON() ([]byte, error) {
    return []byte(\`"\` + t.Format("2006-01-02") + \`"\`), nil
}

func (t *CustomTime) UnmarshalJSON(data []byte) error {
    s := strings.Trim(string(data), \`"\`)
    parsed, err := time.Parse("2006-01-02", s)
    if err != nil {
        return err
    }
    t.Time = parsed
    return nil
}
\`\`\`

### context.Context

The \`context.Context\` interface propagates deadlines, cancellation signals, and request-scoped values across API boundaries. Passing a \`Context\` as the first parameter is the idiomatic Go convention for cancellation.

\`\`\`go
type Context interface {
    Deadline() (deadline time.Time, ok bool)
    Done() <-chan struct{}
    Err() error
    Value(key any) any
}

func fetchData(ctx context.Context, url string) ([]byte, error) {
    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, err
    }

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    return io.ReadAll(resp.Body)
}
\`\`\`

### Reading the Standard Library as a Design Reference

The standard library is the single best Go interface-design reference. Every interface in \`io\`, \`net\`, \`sort\`, \`database/sql\`, \`encoding/json\`, and \`context\` is worth studying as a worked example of "how to design an interface". The patterns worth memorising:

1. **Small interfaces compose into larger ones.** \`io.Reader\` + \`io.Writer\` = \`io.ReadWriter\`. The compound type is just the name for the method-set union.
2. **Error types are interfaces.** \`error\` has one method. Custom error types implement it and add structured data via method calls or assertion.
3. **Zero value usefulness.** \`bytes.Buffer\`, \`strings.Builder\`, \`sync.Mutex\` all work at their zero value. No constructor needed.
4. **Context flows through.** Every I/O function in modern Go takes a \`context.Context\` as the first argument.

### Code-Review Lens (Senior Track)

Three patterns to flag:

1. **A function that reads from a file without taking \`io.Reader\`.** Generalise the parameter type. The file argument is accidental.
2. **A custom error type without an \`Error() string\` method.** The compiler catches this, but only when the type is actually used as an \`error\`. Add the method.
3. **A method on a long-running service that does not accept a \`context.Context\`.** Always a finding in modern Go.

### Newer Standard Interfaces Worth Knowing (Go 1.16 to 1.26)

Go has kept adding small, well-designed interfaces. Four are worth the trip:

- \`io/fs.FS\` (Go 1.16): abstract filesystem. \`Open(name) (File, error)\`. Testing that touches the filesystem should take \`fs.FS\`, not \`os.DirFS\` directly. Pair with \`fstest.MapFS\` for in-memory test fixtures.
- \`slog.Handler\` (Go 1.21): the backend contract for structured logging. Custom log sinks implement \`Handle(ctx, Record) error\`. The interface surface is deliberately narrow so alternative backends (Datadog, OTEL, JSON-lines) can implement it without committing to a framework.
- \`iter.Seq\` and \`iter.Seq2\` (Go 1.23): range-over-function iterators. Not strictly interfaces, but function types with interface-like contracts. Relevant when designing APIs that emit streams of values.
- \`errors.Unwrap\`, \`errors.Is\`, \`errors.As\` conventions: not an interface per se, but the \`Unwrap() error\` and \`Unwrap() []error\` method contracts are the idioms every error type must understand.

A function signature that takes \`io/fs.FS\` in 2026 is strictly better than one that takes a directory path. The test story is simpler, the production story is the same, and the parameter signals the right abstraction.

### Staff Lens: Fit Into the Ecosystem, Do Not Fight It

When a team ships a package with its own \`Logger\` interface instead of accepting \`*slog.Logger\` or \`slog.Handler\`, the team has just forked the ecosystem. Every downstream caller now has two logging abstractions. The staff-track instinct: before defining a new interface in a shared package, search for a stdlib or de-facto-standard interface that already fits. Reuse beats reinvention. The stdlib interface has documentation, tooling, debugger support, and an ecosystem of adapters. A custom one has none of that until you build it. The budget for "we are special enough to need our own interface" is small and it should be spent on the things that actually are special, not on logging, filesystem access, or context propagation.

---
`;
