export default `## Composition Pitfalls and Idiomatic Go Mistakes

Even experienced developers make mistakes with Go's composition model. This section covers anti-patterns and their fixes based on real production code reviews and open-source project issues.

### Embedding Confusion: Promotion vs Inheritance

The most common mistake is treating embedding like inheritance:

\`\`\`go
// WRONG MENTAL MODEL: "User is a Person"
type Person struct {
    Name string
    Age  int
}

type User struct {
    Person  // Embedding
    Email string
}

// This is NOT inheritance! It's composition with method promotion.

// GOTCHA #1: Embedded fields are directly accessible
u := User{Person: Person{Name: "Alice", Age: 30}, Email: "alice@example.com"}
fmt.Println(u.Name)       // Works (promoted field)
fmt.Println(u.Person.Name) // Also works (explicit access)

// But JSON encoding sees the structure:
json.Marshal(u)  // {"Name":"Alice","Age":30,"Email":"alice@example.com"}
// Not: {"Person":{"Name":"Alice","Age":30},"Email":"alice@example.com"}

// GOTCHA #2: Method promotion creates surprising behavior
type Counter struct {
    count int
}

func (c *Counter) Inc() { c.count++ }
func (c *Counter) Value() int { return c.count }

type LabeledCounter struct {
    Counter  // Embedded
    label string
}

func main() {
    lc := LabeledCounter{label: "requests"}
    lc.Inc()              // Calls Counter.Inc() - works
    fmt.Println(lc.Value()) // Calls Counter.Value() - prints 1
    fmt.Println(lc.count)   // Direct field access - prints 1

    // BUT: If you override a method, the embedded method doesn't "see" it
}

// GOTCHA #3: Interface satisfaction with embedding
type Writer interface {
    Write([]byte) (int, error)
}

type BufferedWriter struct {
    *bytes.Buffer  // Embedded - satisfies Writer automatically
    flushThreshold int
}

// BufferedWriter satisfies Writer through promotion
// But what if Buffer is nil?

func (bw *BufferedWriter) Write(p []byte) (int, error) {
    if bw.Buffer == nil {
        bw.Buffer = new(bytes.Buffer)  // Lazy init
    }
    n, err := bw.Buffer.Write(p)
    if bw.Buffer.Len() > bw.flushThreshold {
        // Flush logic
    }
    return n, err
}

// CORRECT: Be explicit about what you're composing
type SafeBufferedWriter struct {
    buf            *bytes.Buffer
    flushThreshold int
}

func NewSafeBufferedWriter(threshold int) *SafeBufferedWriter {
    return &SafeBufferedWriter{
        buf:            new(bytes.Buffer),
        flushThreshold: threshold,
    }
}

func (w *SafeBufferedWriter) Write(p []byte) (int, error) {
    return w.buf.Write(p)  // Explicit delegation
}
\`\`\`

### The "Accept Interfaces, Return Structs" Violation

This is Go's most important design principle and frequently violated:

\`\`\`go
// WRONG: Returning interface
type UserService interface {
    GetUser(id string) (*User, error)
}

func NewUserService(db Database) UserService {  // Returns interface
    return &userService{db: db}
}

// Problems:
// 1. Caller can't access concrete type methods
// 2. Harder to test (can't type-assert to check internals)
// 3. Less clear what the implementation actually is

// CORRECT: Return concrete type
func NewUserService(db Database) *UserService {  // Returns concrete
    return &UserService{db: db}
}

// The caller can still use it as an interface:
var svc UserServiceInterface = NewUserService(db)

// WRONG: Accepting concrete type when interface would work
func ProcessUser(svc *PostgresUserService, id string) error {
    user, err := svc.GetUser(id)
    // ...
}

// CORRECT: Accept interface (define at point of use)
type userGetter interface {
    GetUser(id string) (*User, error)
}

func ProcessUser(svc userGetter, id string) error {
    user, err := svc.GetUser(id)
    // ...
}

// Now testable with any implementation!
\`\`\`

### Constructor Anti-patterns

Go lacks language-level constructors, but the \`New\` function convention serves the same purpose. Problems arise when types have broken zero values and no constructor enforces valid state:

\`\`\`go
// WRONG: Relying on zero value when it's not useful
type Server struct {
    addr    string
    timeout time.Duration
    logger  Logger
}

// Zero value has:
// - addr: "" (invalid)
// - timeout: 0 (no timeout - dangerous!)
// - logger: nil (will panic)

func main() {
    s := Server{}  // All defaults are broken
    s.Start()      // Might crash, definitely misbehaves
}

// CORRECT: Enforce creation through constructor
type Server struct {
    addr    string
    timeout time.Duration
    logger  Logger
}

func NewServer(addr string, opts ...Option) (*Server, error) {
    if addr == "" {
        return nil, errors.New("addr is required")
    }

    s := &Server{
        addr:    addr,
        timeout: 30 * time.Second,  // Safe default
        logger:  defaultLogger,      // Safe default
    }

    for _, opt := range opts {
        if err := opt(s); err != nil {
            return nil, err
        }
    }

    return s, nil
}

// BETTER: Make zero value useful with lazy init
type SafeServer struct {
    addr    string
    timeout time.Duration
    logger  Logger
    once    sync.Once
}

func (s *SafeServer) init() {
    s.once.Do(func() {
        if s.timeout == 0 {
            s.timeout = 30 * time.Second
        }
        if s.logger == nil {
            s.logger = defaultLogger
        }
    })
}

func (s *SafeServer) Start() error {
    s.init()  // Lazy initialization
    // ...
}
\`\`\`

### Functional Options Done Wrong

The functional options pattern is powerful but often misused:

\`\`\`go
// WRONG: Options without validation
type ServerOption func(*Server)

func WithTimeout(d time.Duration) ServerOption {
    return func(s *Server) {
        s.timeout = d  // What if d is negative?
    }
}

// WRONG: Options modifying unrelated fields
func WithEverything(addr string, timeout time.Duration, logger Logger) ServerOption {
    return func(s *Server) {
        s.addr = addr
        s.timeout = timeout
        s.logger = logger
    }
}
// This defeats the purpose of options!

// WRONG: Non-composable options
type ServerConfig struct {
    Addr    string
    Timeout time.Duration
    Logger  Logger
}

func NewServer(cfg ServerConfig) *Server {
    // Not composable, requires all fields at once
}

// CORRECT: Validating functional options
type ServerOption func(*Server) error

func WithTimeout(d time.Duration) ServerOption {
    return func(s *Server) error {
        if d <= 0 {
            return errors.New("timeout must be positive")
        }
        if d > 5*time.Minute {
            return errors.New("timeout too large")
        }
        s.timeout = d
        return nil
    }
}

func NewServer(addr string, opts ...ServerOption) (*Server, error) {
    s := &Server{
        addr:    addr,
        timeout: 30 * time.Second,
    }

    for _, opt := range opts {
        if err := opt(s); err != nil {
            return nil, fmt.Errorf("option error: %w", err)
        }
    }

    return s, nil
}

// Usage with clear errors:
s, err := NewServer("localhost:8080",
    WithTimeout(-1 * time.Second),  // Returns error!
)
\`\`\`

### Method Receiver Consistency

Mixing value and pointer receivers causes subtle bugs:

\`\`\`go
// WRONG: Inconsistent receivers
type Counter struct {
    value int
}

func (c Counter) Get() int {     // Value receiver
    return c.value
}

func (c *Counter) Increment() {  // Pointer receiver
    c.value++
}

// This causes problems with interfaces:
type Incrementable interface {
    Get() int
    Increment()
}

func process(i Incrementable) {
    i.Increment()
    fmt.Println(i.Get())
}

func main() {
    c := Counter{}

    // process(c)   // ERROR: Counter doesn't implement Incrementable
    process(&c)    // OK: *Counter implements it

    // BUT:
    var i Incrementable = &c
    // The interface holds *Counter, so Increment works on the original
}

// CORRECT: Be consistent - usually all pointers or all values
type Counter struct {
    value int
}

func (c *Counter) Get() int {      // Pointer receiver
    return c.value
}

func (c *Counter) Increment() {    // Pointer receiver
    c.value++
}

// Now both Counter and *Counter work predictably
// (Well, only *Counter satisfies Incrementable, but that's clear)

// GUIDELINE: Use pointer receivers when:
// 1. Method modifies the receiver
// 2. Struct is large (avoid copying)
// 3. Consistency with other methods
// Use value receivers when:
// 1. Struct is small and immutable
// 2. It's a basic type (time.Time, etc.)
// 3. You want to allow value copies
\`\`\`

### Dependency Injection Mistakes

Go's constructor injection through struct fields replaces the DI frameworks that other languages require. The mistakes below show three common anti-patterns: globals, per-call creation, and accepting concrete types instead of interfaces:

\`\`\`go
// WRONG: Global dependencies
var db *sql.DB

func GetUser(id string) (*User, error) {
    return db.QueryRow(...)  // Global state!
}

// WRONG: Creating dependencies inside functions
func ProcessOrder(orderID string) error {
    db, err := sql.Open("postgres", connectionString)  // Creates new connection!
    if err != nil {
        return err
    }
    defer db.Close()

    // ...process order using db...
}

// CORRECT: Constructor injection
type OrderService struct {
    db     *sql.DB
    logger Logger
}

func NewOrderService(db *sql.DB, logger Logger) *OrderService {
    return &OrderService{db: db, logger: logger}
}

func (s *OrderService) ProcessOrder(ctx context.Context, orderID string) error {
    // Use s.db - injected dependency
}

// CORRECT: Interface injection for testability
type orderStore interface {
    GetOrder(ctx context.Context, id string) (*Order, error)
    SaveOrder(ctx context.Context, order *Order) error
}

type OrderService struct {
    store  orderStore  // Interface, not concrete type
    logger Logger
}

// Now testable with mock store
type mockOrderStore struct {
    orders map[string]*Order
    err    error
}

func (m *mockOrderStore) GetOrder(ctx context.Context, id string) (*Order, error) {
    if m.err != nil {
        return nil, m.err
    }
    return m.orders[id], nil
}
\`\`\`

### Table-Driven Test Mistakes

Table-driven tests are the standard Go pattern, but three mistakes appear repeatedly: loop variable capture in parallel subtests (fixed in Go 1.22 but still relevant for older codebases), missing error test cases, and testing implementation details rather than behavior:

\`\`\`go
// WRONG: Loop variable capture (pre-Go 1.22)
func TestProcess(t *testing.T) {
    tests := []struct {
        name  string
        input string
        want  string
    }{
        {"empty", "", ""},
        {"hello", "hello", "HELLO"},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            t.Parallel()  // DANGER: tt is captured by reference!
            got := Process(tt.input)  // All tests use last tt value!
            if got != tt.want {
                t.Errorf("got %q, want %q", got, tt.want)
            }
        })
    }
}

// CORRECT: Copy the variable (works in all Go versions)
for _, tt := range tests {
    tt := tt  // Shadow with local copy
    t.Run(tt.name, func(t *testing.T) {
        t.Parallel()
        got := Process(tt.input)
        // ...
    })
}

// WRONG: Not testing error cases
tests := []struct {
    input string
    want  string
}{
    {"hello", "HELLO"},
    {"", ""},  // Empty is valid
}

// CORRECT: Include error cases
tests := []struct {
    name    string
    input   string
    want    string
    wantErr bool
}{
    {"valid", "hello", "HELLO", false},
    {"empty", "", "", false},
    {"too long", strings.Repeat("a", 1000), "", true},
    {"invalid chars", "hello\\x00", "", true},
}

// WRONG: Testing implementation details
func TestUserService_GetUser(t *testing.T) {
    svc := NewUserService(mockDB)

    user, err := svc.GetUser("123")

    // Don't test internal state:
    // assert(svc.cache["123"] == user)  // WRONG - implementation detail

    // Test behavior:
    assert(user.ID == "123")
    assert(err == nil)
}
\`\`\`

### Overusing Getters and Setters

Go is not Java, and one of the most visible anti-patterns transplanted from Java codebases is wrapping every field in getter/setter methods. Effective Go addresses this directly: *"Go doesn't provide automatic support for getters and setters. There's nothing wrong with providing getters and setters yourself, and it's often appropriate to do so, but it's neither idiomatic nor necessary to put Get into the getter's name."*

\`\`\`go
// WRONG: Java-style over-engineered struct
// This is a direct translation from Java thinking into Go syntax.
// Every field has a getter and setter, adding verbosity without value.
type Employee struct {
    name       string
    department string
    salary     float64
    active     bool
}

func NewEmployee(name, department string, salary float64) *Employee {
    return &Employee{
        name:       name,
        department: department,
        salary:     salary,
        active:     true,
    }
}

func (e *Employee) GetName() string        { return e.name }       // Wrong: "Get" prefix
func (e *Employee) SetName(n string)       { e.name = n }
func (e *Employee) GetDepartment() string  { return e.department } // Wrong: "Get" prefix
func (e *Employee) SetDepartment(d string) { e.department = d }
func (e *Employee) GetSalary() float64     { return e.salary }    // Wrong: "Get" prefix
func (e *Employee) SetSalary(s float64)    { e.salary = s }       // No validation!
func (e *Employee) IsActive() bool         { return e.active }
func (e *Employee) SetActive(a bool)       { e.active = a }

// Caller code is unnecessarily verbose:
emp := NewEmployee("Alice", "Engineering", 95000)
fmt.Println(emp.GetName())          // Reads like Java, not Go
emp.SetDepartment("Platform")
\`\`\`

\`\`\`go
// CORRECT: Idiomatic Go - export fields that don't need protection
// Only use accessor methods when they provide real value.
type Employee struct {
    Name       string  // Exported directly - no validation needed
    Department string  // Exported directly - simple data
    Active     bool    // Exported directly - simple flag

    salary float64 // Unexported: needs validation (business invariant)
}

// Getter follows Go convention: Name() not GetName()
// Only needed because salary is unexported for a reason.
func (e *Employee) Salary() float64 { return e.salary }

// Setter justified: enforces a business rule (salary must be positive)
func (e *Employee) SetSalary(amount float64) error {
    if amount < 0 {
        return fmt.Errorf("salary cannot be negative: %.2f", amount)
    }
    e.salary = amount
    return nil
}

// Caller code is clean and direct:
emp := &Employee{
    Name:       "Alice",
    Department: "Engineering",
    Active:     true,
}
emp.SetSalary(95000)              // Setter justified: validates input
fmt.Println(emp.Name)             // Direct field access - idiomatic
fmt.Printf("Salary: %.2f\\n", emp.Salary()) // Getter: no "Get" prefix
\`\`\`

Use accessor methods when they serve a real purpose:

\`\`\`go
// JUSTIFIED: Lazy initialization - the value is computed on first access
type Config struct {
    path     string
    settings map[string]string
    once     sync.Once
}

func (c *Config) Settings() map[string]string {
    c.once.Do(func() {
        // Load settings from file on first access
        c.settings = loadFromFile(c.path)
    })
    return c.settings
}

// JUSTIFIED: Computed value - not stored, derived from other fields
type Rectangle struct {
    Width  float64
    Height float64
}

func (r Rectangle) Area() float64 {
    return r.Width * r.Height
}

// JUSTIFIED: Maintaining invariants - fields must change together
type Account struct {
    balance    float64
    lastUpdate time.Time
}

func (a *Account) Balance() float64 { return a.balance }

func (a *Account) Deposit(amount float64) error {
    if amount <= 0 {
        return errors.New("deposit amount must be positive")
    }
    a.balance += amount
    a.lastUpdate = time.Now() // Invariant: balance and lastUpdate stay in sync
    return nil
}
\`\`\`

The rule of thumb: export the field unless you have a concrete reason to hide it. Validation, lazy initialization, computed values, and invariant maintenance are concrete reasons. "It might need protection someday" is not.

### Using a Filename as a Function Input

Functions that accept a filename string instead of an \`io.Reader\` are hard to test, impossible to compose, and violate the Dependency Inversion Principle. This is Mistake #46 from *100 Go Mistakes and How to Avoid Them*, and it shows up frequently in file-processing code.

\`\`\`go
// WRONG: Function coupled to the filesystem
// This function can only read from files. Testing requires creating
// temporary files, cleaning them up, and handling OS-specific paths.
func CountWords(filename string) (int, error) {
    f, err := os.Open(filename)
    if err != nil {
        return 0, fmt.Errorf("opening file: %w", err)
    }
    defer f.Close()

    scanner := bufio.NewScanner(f)
    scanner.Split(bufio.ScanWords)

    count := 0
    for scanner.Scan() {
        count++
    }

    if err := scanner.Err(); err != nil {
        return 0, fmt.Errorf("scanning: %w", err)
    }

    return count, nil
}

// Testing requires real files - slow, fragile, platform-dependent:
func TestCountWords(t *testing.T) {
    // Must create a temp file, write content, close it, then test
    tmpFile, err := os.CreateTemp("", "test-*.txt")
    if err != nil {
        t.Fatal(err)
    }
    defer os.Remove(tmpFile.Name())

    _, err = tmpFile.WriteString("hello world foo bar")
    if err != nil {
        t.Fatal(err)
    }
    tmpFile.Close()

    count, err := CountWords(tmpFile.Name())
    if err != nil {
        t.Fatal(err)
    }
    if count != 4 {
        t.Errorf("got %d, want 4", count)
    }
}
\`\`\`

\`\`\`go
// CORRECT: Accept io.Reader - works with any data source
// The function doesn't know or care where the bytes come from.
func CountWords(r io.Reader) (int, error) {
    scanner := bufio.NewScanner(r)
    scanner.Split(bufio.ScanWords)

    count := 0
    for scanner.Scan() {
        count++
    }

    if err := scanner.Err(); err != nil {
        return 0, fmt.Errorf("scanning: %w", err)
    }

    return count, nil
}

// Production code opens the file and passes the reader:
func CountWordsInFile(filename string) (int, error) {
    f, err := os.Open(filename)
    if err != nil {
        return 0, fmt.Errorf("opening file: %w", err)
    }
    defer f.Close()

    return CountWords(f) // Delegate to the testable function
}

// Testing is trivial - no filesystem, no cleanup, no platform issues:
func TestCountWords(t *testing.T) {
    tests := []struct {
        name  string
        input string
        want  int
    }{
        {"empty", "", 0},
        {"single word", "hello", 1},
        {"multiple words", "hello world foo bar", 4},
        {"extra whitespace", "  hello   world  ", 2},
        {"newlines", "hello\\nworld\\nfoo", 3},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            r := strings.NewReader(tt.input)
            got, err := CountWords(r)
            if err != nil {
                t.Fatalf("unexpected error: %v", err)
            }
            if got != tt.want {
                t.Errorf("CountWords() = %d, want %d", got, tt.want)
            }
        })
    }
}
\`\`\`

This pattern extends to writing as well:

\`\`\`go
// WRONG: Output coupled to filesystem
func WriteReport(filename string, data *Report) error {
    f, err := os.Create(filename)
    if err != nil {
        return err
    }
    defer f.Close()
    return json.NewEncoder(f).Encode(data)
}

// CORRECT: Accept io.Writer - write anywhere
func WriteReport(w io.Writer, data *Report) error {
    return json.NewEncoder(w).Encode(data)
}

// Write to file:
f, _ := os.Create("report.json")
defer f.Close()
WriteReport(f, report)

// Write to HTTP response:
func handleReport(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    WriteReport(w, report) // Same function, different destination
}

// Capture in tests:
var buf bytes.Buffer
WriteReport(&buf, report)
// Assert on buf.String()
\`\`\`

The thin wrapper function (\`CountWordsInFile\`) that opens the file and delegates to the \`io.Reader\`-based function is the standard Go pattern. The core logic stays testable and composable. The filesystem interaction is isolated at the edge.

### Not Using the Accept Interfaces, Return Structs Principle

Go has a well-known proverb: *"Accept interfaces, return structs."* Functions should accept the narrowest interface they need (giving callers maximum freedom in what they pass) and return concrete types (giving callers maximum information about what they receive). Violating either half of this principle creates rigid, hard-to-use APIs.

\`\`\`go
// WRONG: Accepting a broader interface than needed
// This function only calls Read, but demands io.ReadCloser.
// Callers with a strings.Reader, bytes.Buffer, or any other
// io.Reader are forced to wrap their type unnecessarily.
func ProcessData(rc io.ReadCloser) ([]byte, error) {
    defer rc.Close() // Closing is not this function's responsibility
    return io.ReadAll(rc)
}

// Caller must jump through hoops:
data := strings.NewReader("hello world")
// strings.Reader doesn't implement io.ReadCloser!
// Forced to wrap it:
result, err := ProcessData(io.NopCloser(data)) // Awkward
\`\`\`

\`\`\`go
// CORRECT: Accept the narrowest interface
// This function only reads, so it accepts io.Reader.
// Any type with a Read method works - files, buffers, network
// connections, strings, compressed streams, anything.
func ProcessData(r io.Reader) ([]byte, error) {
    return io.ReadAll(r)
}

// Callers pass whatever they have - no wrapping needed:
result, _ := ProcessData(strings.NewReader("hello world"))
result, _ = ProcessData(os.Stdin)
result, _ = ProcessData(resp.Body) // resp.Body is io.ReadCloser, which satisfies io.Reader
\`\`\`

The return side is equally important:

\`\`\`go
// WRONG: Returning an interface hides information from callers
type userRepository struct {
    db *sql.DB
}

// Returning the interface prevents callers from accessing
// any methods or fields specific to userRepository.
func NewUserRepository(db *sql.DB) UserRepository {
    return &userRepository{db: db}
}

// Callers cannot type-assert safely without knowing the concrete type.
// They also cannot access any additional methods you add later.
\`\`\`

\`\`\`go
// CORRECT: Return the concrete type
type UserRepository struct {
    db *sql.DB
}

// Returning *UserRepository gives callers full access.
// They can still assign it to a UserRepository interface variable
// if they want - Go's implicit interface satisfaction handles that.
func NewUserRepository(db *sql.DB) *UserRepository {
    return &UserRepository{db: db}
}

// Callers choose how to use the return value:
repo := NewUserRepository(db)       // Full concrete type
var svc UserStore = NewUserRepository(db) // As interface - their choice
\`\`\`

\`\`\`go
// The exception: return an interface when you genuinely need to
// hide implementation details (e.g., a factory with multiple backends)
type Cache interface {
    Get(key string) ([]byte, bool)
    Set(key string, value []byte, ttl time.Duration)
}

// Factory returns interface because the concrete type depends on config.
// Callers should NOT know or care whether it's Redis, memcached, or in-memory.
func NewCache(cfg CacheConfig) (Cache, error) {
    switch cfg.Backend {
    case "redis":
        return newRedisCache(cfg.RedisAddr)
    case "memcached":
        return newMemcachedCache(cfg.MemcachedAddr)
    default:
        return newInMemoryCache(), nil
    }
}
\`\`\`

Applying both halves together:

\`\`\`go
// Idiomatic function signature:
// - Accepts io.Reader (narrow interface - caller provides any source)
// - Returns *ParseResult (concrete type - caller gets full access)
func ParseConfig(r io.Reader) (*ParseResult, error) {
    data, err := io.ReadAll(r)
    if err != nil {
        return nil, fmt.Errorf("reading config: %w", err)
    }

    result := &ParseResult{}
    if err := json.Unmarshal(data, result); err != nil {
        return nil, fmt.Errorf("parsing config: %w", err)
    }

    return result, nil
}
\`\`\`

### Embedding Interfaces in Structs Without Implementing All Methods

Embedding an interface in a struct makes the struct automatically satisfy the interface at compile time. But this creates a dangerous trap: any method you do not explicitly implement will compile fine but panic at runtime with a nil pointer dereference when called.

\`\`\`go
// DANGEROUS: Struct embeds io.ReadWriter but only implements Read
type PartialImpl struct {
    io.ReadWriter // Embeds the interface - satisfies it at compile time
    data []byte
    pos  int
}

func (p *PartialImpl) Read(buf []byte) (int, error) {
    if p.pos >= len(p.data) {
        return 0, io.EOF
    }
    n := copy(buf, p.data[p.pos:])
    p.pos += n
    return n, nil
}

// Write is NOT implemented - it's "inherited" from the embedded interface.
// The embedded io.ReadWriter field is nil, so calling Write panics.

func main() {
    p := &PartialImpl{data: []byte("hello")}

    // This works - Read is explicitly implemented:
    buf := make([]byte, 5)
    p.Read(buf)
    fmt.Println(string(buf)) // "hello"

    // This compiles but PANICS at runtime:
    p.Write([]byte("world")) // nil pointer dereference!
    // The Write call is dispatched to the embedded io.ReadWriter,
    // which is nil because we never assigned a concrete value to it.
}
\`\`\`

This is particularly insidious because the compiler gives you zero warnings. The code type-checks, the struct satisfies the interface, and everything looks correct until it runs:

\`\`\`go
// The compiler is perfectly happy with this:
var rw io.ReadWriter = &PartialImpl{data: []byte("test")} // Compiles fine
rw.Write([]byte("boom")) // Runtime panic: nil pointer dereference
\`\`\`

The correct patterns:

\`\`\`go
// CORRECT PATTERN 1: Implement all methods explicitly
type FullImpl struct {
    data []byte
    pos  int
    out  bytes.Buffer
}

func (f *FullImpl) Read(buf []byte) (int, error) {
    if f.pos >= len(f.data) {
        return 0, io.EOF
    }
    n := copy(buf, f.data[f.pos:])
    f.pos += n
    return n, nil
}

func (f *FullImpl) Write(buf []byte) (int, error) {
    return f.out.Write(buf) // Explicitly implemented - no nil surprise
}

// CORRECT PATTERN 2: Compile-time interface check
// This is the idiomatic way to verify your type satisfies an interface.
// Place this at package level - it costs nothing at runtime.
var _ io.ReadWriter = (*FullImpl)(nil)

// If FullImpl is missing Read or Write, you get a compile error:
// "cannot use (*FullImpl)(nil) (value of type *FullImpl) as io.ReadWriter
//  value in variable declaration: *FullImpl does not implement io.ReadWriter
//  (missing method Write)"
\`\`\`

\`\`\`go
// CORRECT PATTERN 3: Embed the interface only when you have a concrete value
// This is legitimate - you're wrapping an existing implementation and
// selectively overriding methods (decorator pattern).
type ReadCounter struct {
    io.Reader     // Embedded with a REAL value assigned at construction
    bytesRead int64
}

func NewReadCounter(r io.Reader) *ReadCounter {
    return &ReadCounter{Reader: r} // r is not nil - safe to delegate
}

func (rc *ReadCounter) Read(buf []byte) (int, error) {
    n, err := rc.Reader.Read(buf) // Delegates to the real Reader
    rc.bytesRead += int64(n)
    return n, err
}

func (rc *ReadCounter) BytesRead() int64 {
    return rc.bytesRead
}

// Usage:
counter := NewReadCounter(strings.NewReader("hello world"))
io.ReadAll(counter)
fmt.Println(counter.BytesRead()) // 11
\`\`\`

The rule: embed an interface in a struct only when you will assign a concrete implementation to it at construction time (decorator/wrapper pattern). Never embed an interface just to satisfy it at compile time without providing all methods, use the \`var _ Interface = (*Type)(nil)\` check instead.

### Misusing Context Values as Function Parameters

\`context.WithValue\` exists to carry request-scoped metadata across API boundaries, not to smuggle function parameters past the type system. When developers use context values to pass database connections, loggers, or configuration, they create APIs with hidden dependencies that are type-unsafe, impossible to discover from function signatures, and nightmares to test.

\`\`\`go
// WRONG: Passing dependencies through context values
// The function signature lies - it claims to need only a context,
// but it secretly depends on a database, logger, and config.

func HandleOrder(ctx context.Context, orderID string) error {
    // Hidden dependency 1: database connection
    db, ok := ctx.Value("db").(*sql.DB)
    if !ok {
        return errors.New("database not found in context") // Runtime surprise
    }

    // Hidden dependency 2: logger
    logger, ok := ctx.Value("logger").(*slog.Logger)
    if !ok {
        return errors.New("logger not found in context") // Runtime surprise
    }

    // Hidden dependency 3: config
    cfg, ok := ctx.Value("config").(*Config)
    if !ok {
        return errors.New("config not found in context") // Runtime surprise
    }

    logger.Info("processing order", "id", orderID)
    // ...use db and cfg...
    return nil
}

// Caller must remember to stuff everything into context:
ctx := context.Background()
ctx = context.WithValue(ctx, "db", db)           // String key - collision risk
ctx = context.WithValue(ctx, "logger", logger)    // No compile-time safety
ctx = context.WithValue(ctx, "config", config)    // Type assertion can fail
HandleOrder(ctx, "order-123")

// Problems:
// 1. String keys can collide across packages
// 2. Type assertions can fail at runtime - no compile-time checking
// 3. Dependencies are invisible in the function signature
// 4. Testing requires building a context with the right keys - fragile
// 5. Adding a new dependency doesn't break any callers at compile time
\`\`\`

\`\`\`go
// CORRECT: Explicit function parameters for dependencies
// The signature tells you exactly what this function needs.
// Missing a dependency? The compiler catches it immediately.

type OrderService struct {
    db     *sql.DB
    logger *slog.Logger
    cfg    *Config
}

func NewOrderService(db *sql.DB, logger *slog.Logger, cfg *Config) *OrderService {
    return &OrderService{db: db, logger: logger, cfg: cfg}
}

func (s *OrderService) HandleOrder(ctx context.Context, orderID string) error {
    s.logger.Info("processing order", "id", orderID)
    // ...use s.db and s.cfg...
    return nil
}

// Context carries only request-scoped metadata:
ctx := context.Background()
svc := NewOrderService(db, logger, config)
svc.HandleOrder(ctx, "order-123") // Clean, explicit, type-safe
\`\`\`

When you do use context values (for request-scoped data like request IDs, auth tokens, and trace IDs), use typed keys to prevent collisions:

\`\`\`go
// WRONG: String keys risk collision across packages
ctx = context.WithValue(ctx, "requestID", "abc-123")
// Another package might also use "requestID" as a key - silent collision

// CORRECT: Unexported struct type as key - impossible to collide
// Each package defines its own key type. Since the type is unexported,
// no other package can create a value of this type, preventing collisions.

type contextKey struct{} // Unexported - only this package can use it

var (
    requestIDKey = contextKey{}
)

// Provide typed accessor functions so callers don't deal with keys directly:
func WithRequestID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, requestIDKey, id)
}

func RequestIDFrom(ctx context.Context) (string, bool) {
    id, ok := ctx.Value(requestIDKey).(string)
    return id, ok
}

// Usage in middleware:
func RequestIDMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        id := r.Header.Get("X-Request-ID")
        if id == "" {
            id = uuid.NewString()
        }
        ctx := WithRequestID(r.Context(), id)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// Usage in handler:
func handleOrder(w http.ResponseWriter, r *http.Request) {
    reqID, _ := RequestIDFrom(r.Context()) // Type-safe, documented
    slog.Info("handling order", "request_id", reqID)
}
\`\`\`

The guideline is clear: context values are for request-scoped data that transits API boundaries (request IDs, authentication tokens, trace/span IDs, deadlines). Everything else, database connections, loggers, configuration, service dependencies, belongs in struct fields or function parameters where the compiler can verify them.

### Quick Reference: Composition Best Practices

| Pattern | Do | Don't |
|---------|-----|-------|
| Type composition | Embed for method promotion | Embed for "is-a" relationships |
| Interface return | Return concrete types | Return interfaces from constructors |
| Interface accept | Accept minimal interfaces | Accept concrete types |
| Constructor | Validate and set safe defaults | Rely on broken zero values |
| Method receivers | Be consistent (usually pointer) | Mix value and pointer randomly |
| Dependency injection | Pass dependencies to constructor | Use globals or create inline |
| Functional options | Validate and return errors | Silently accept invalid values |

### Using the Pitfall List in Review

The senior-track discipline: the pitfall list is the review checklist. Each pattern has a specific thing to flag. The team that internalises the list catches the mistakes consistently. The team that does not re-learns each lesson per engineer.

### Staff Lens: Pitfall Detection via Tooling

Several pitfalls in this list are mechanically detectable. \`staticcheck\` and \`revive\` already flag most of them. \`govet\` catches context-value-key issues (string keys instead of typed keys) in some cases. Custom linters can catch team-specific pitfalls (example: "no function may accept \`filename string\` as input, use \`io.Reader\` or \`fs.FS\`"). The staff-level move is to add the rule to the team's \`.golangci.yml\`. Every linter rule added is a review dimension automated away, freeing reviewers to focus on semantics and design. A mature Go codebase has ten to twenty custom linter rules encoding team decisions. A less mature one has zero and relies on reviewer vigilance. The former scales. The latter does not.

### Principal Lens: Pitfalls Age

Some pitfalls in this list were more severe in older Go. Loop-variable capture was a routine bug before Go 1.22 and is now mostly a non-issue. \`interface{}\` everywhere was a real cost before Go 1.18 generics and is now rare in new code. The principal-level work is keeping the pitfall list current: removing pitfalls the language has fixed, adding pitfalls that emerge with new features. When Go 1.25 shipped \`testing/synctest\`, hand-rolled clock interfaces became a pitfall. When Go 1.23 shipped iter, hand-rolled iterator types became a pitfall. The list is a living artifact, not a fixed one. Schedule a quarterly review. Teams that do this stay ahead of the language. Teams that do not ship Go that reads like it was written three versions ago.

---
`;
