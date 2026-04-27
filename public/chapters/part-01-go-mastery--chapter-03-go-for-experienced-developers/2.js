export default `## 3.1 Mental Model Shifts

Coming from object-oriented languages, you will need to unlearn some patterns and learn new ones. This section addresses the most significant mental shifts.

### From Classes to Structs and Interfaces

In Java or C#, you define classes that combine data and behavior, often with inheritance hierarchies:

\`\`\`java
// Java
public abstract class Animal {
    protected String name;
    public abstract void speak();
}

public class Dog extends Animal {
    public Dog(String name) { this.name = name; }
    public void speak() { System.out.println("Woof!"); }
}

public class Cat extends Animal {
    public Cat(String name) { this.name = name; }
    public void speak() { System.out.println("Meow!"); }
}

// Usage with polymorphism
Animal pet = new Dog("Rex");
pet.speak();  // "Woof!"
\`\`\`

In Go, you separate data (structs) from behavior (methods), and there is no inheritance:

\`\`\`go
// Go
type Animal interface {
    Speak() string
}

type Dog struct {
    Name string
}

func (d Dog) Speak() string {
    return "Woof!"
}

type Cat struct {
    Name string
}

func (c Cat) Speak() string {
    return "Meow!"
}

// Usage - implicit interface satisfaction
var pet Animal = Dog{Name: "Rex"}
fmt.Println(pet.Speak())  // "Woof!"
\`\`\`

The key differences:
- **Interfaces define behavior. Structs define data**
- **No inheritance means no "is-a" relationships**
- **Any type can implement an interface by having the right methods, no explicit declaration needed**
- **Composition replaces inheritance**
- **Duck typing: if it walks like a duck and quacks like a duck, it is a duck**

### How Google's gRPC Team Uses This Pattern

Google's gRPC library demonstrates this approach in practice. The \`TransportCredentials\` interface defines a contract for per-RPC authentication without coupling the framework to any specific credential type:

\`\`\`go
// google.golang.org/grpc/credentials/credentials.go
// TransportCredentials is the interface that defines the methods
// for per-RPC credentials
type TransportCredentials interface {
    ClientHandshake(ctx context.Context, addr string, rawConn net.Conn) (net.Conn, AuthInfo, error)
    ServerHandshake(rawConn net.Conn) (net.Conn, AuthInfo, error)
    Info() ProtocolInfo
    Clone() TransportCredentials
    OverrideServerName(serverNameOverride string) error
}

// TLS, mTLS, or custom auth all implement this interface
// Users can swap them without changing any code
\`\`\`

This allows gRPC to support TLS, mTLS, ALTS (Google's internal protocol), and custom authentication schemes without any code changes.

### From Inheritance to Composition

Where you'd use inheritance in Java, use embedding in Go. An embedded struct promotes its methods to the outer type, giving you code reuse without the tight coupling of an inheritance hierarchy:

\`\`\`go
// Instead of inheritance
type Writer struct {
    destination string
}

func (w *Writer) Write(data []byte) (int, error) {
    // Write to destination
    return len(data), nil
}

type BufferedWriter struct {
    Writer      // Embedded - gains all Writer methods
    bufferSize int
    buffer     []byte
}

// BufferedWriter now has Write() method from Writer
bw := &BufferedWriter{
    Writer:     Writer{destination: "/var/log/app.log"},
    bufferSize: 4096,
}
bw.Write([]byte("hello"))  // Calls embedded Writer.Write
\`\`\`

Embedding promotes the embedded type's methods to the outer type. It is not inheritance. There is no polymorphism between \`BufferedWriter\` and \`Writer\`, but it achieves code reuse without tight coupling.

### Real-World Composition: How Uber Builds Services

Uber's Go services heavily use composition to share common infrastructure across different transport protocols. A \`BaseService\` struct holds cross-cutting concerns like logging and metrics, while protocol-specific structs embed it and add their own fields:

\`\`\`go
// Base service functionality
type BaseService struct {
    config     *Config
    logger     *zap.Logger
    metrics    *prometheus.Registry
    tracer     opentracing.Tracer
}

func (s *BaseService) Config() *Config         { return s.config }
func (s *BaseService) Logger() *zap.Logger     { return s.logger }
func (s *BaseService) Metrics() *prometheus.Registry { return s.metrics }

// HTTP service composes BaseService
type HTTPService struct {
    BaseService  // Embed base functionality
    router      *mux.Router
    server      *http.Server
}

// gRPC service composes BaseService
type GRPCService struct {
    BaseService  // Same base functionality
    server      *grpc.Server
    listener    net.Listener
}

// Both HTTPService and GRPCService have Config(), Logger(), Metrics()
// but add their own protocol-specific functionality
\`\`\`

### From Exceptions to Error Values

Most languages use exceptions for error handling. The try-catch model separates the error path from the success path, which can hide control flow in larger functions:

\`\`\`python
# Python
try:
    result = do_something()
    data = parse_result(result)
except ValueError as e:
    handle_error(e)
except NetworkError as e:
    retry_operation()
\`\`\`

Java follows the same pattern with checked exceptions:

\`\`\`java
// Java
try {
    Result result = doSomething();
    Data data = parseResult(result);
} catch (ValueError e) {
    handleError(e);
} catch (NetworkException e) {
    retryOperation();
}
\`\`\`

Go takes a fundamentally different approach. Instead of throwing exceptions, functions return errors as their last value. The caller checks the error immediately:

\`\`\`go
// Go
result, err := doSomething()
if err != nil {
    return fmt.Errorf("failed to do something: %w", err)
}

data, err := parseResult(result)
if err != nil {
    return fmt.Errorf("failed to parse result: %w", err)
}
\`\`\`

This seems verbose at first, but it has advantages:
- **Errors are explicit** - you cannot accidentally ignore them (the compiler warns about unused variables)
- **Control flow is obvious** - no hidden jumps
- **You handle errors where they occur**, with full context
- **No performance cost of stack unwinding**
- **Errors are just values** - you can combine, transform, and pass them around

### Why Stripe Chose Go's Error Model

Stripe's payment infrastructure processes billions of dollars. Their engineering blog explains why Go's explicit error handling matters for financial systems: every error path must be visible and auditable, with no hidden exception flows that could silently swallow a failed charge.

\`\`\`go
// From Stripe's internal codebase (reconstructed from blog posts)
func ProcessPayment(ctx context.Context, req *PaymentRequest) (*PaymentResult, error) {
    // Validate request
    if err := req.Validate(); err != nil {
        return nil, &ValidationError{
            Field:   err.Field,
            Message: err.Message,
            Code:    "invalid_request",
        }
    }

    // Check fraud
    fraudScore, err := s.fraudService.Score(ctx, req)
    if err != nil {
        // Log but don't fail - fraud check is non-critical
        s.logger.Warn("fraud check failed", zap.Error(err))
        fraudScore = DefaultFraudScore
    }

    if fraudScore > s.config.FraudThreshold {
        return nil, &FraudError{
            Score:  fraudScore,
            Reason: "high_risk_transaction",
        }
    }

    // Process with payment provider
    result, err := s.provider.Charge(ctx, req)
    if err != nil {
        // Explicit handling based on error type
        var networkErr *NetworkError
        if errors.As(err, &networkErr) {
            // Network errors: retry with exponential backoff
            return s.retryCharge(ctx, req, 3)
        }

        var providerErr *ProviderError
        if errors.As(err, &providerErr) {
            // Provider declined: return specific error
            return nil, &PaymentDeclinedError{
                Reason: providerErr.DeclineCode,
                Message: providerErr.Message,
            }
        }

        // Unknown error: fail safely
        return nil, fmt.Errorf("unexpected error processing payment: %w", err)
    }

    return result, nil
}
\`\`\`

### From Threads to Goroutines

In Java, you create threads explicitly:

\`\`\`java
// Java
Thread t = new Thread(() -> {
    doWork();
});
t.start();
t.join();  // Wait for completion

// Or with ExecutorService
ExecutorService executor = Executors.newFixedThreadPool(10);
Future<Result> future = executor.submit(() -> doWork());
Result result = future.get();
\`\`\`

In Go, you prefix any function call with \`go\`:

\`\`\`go
// Go
go doWork()  // Starts goroutine, returns immediately

// Wait for completion using channels
done := make(chan struct{})
go func() {
    doWork()
    close(done)
}()
<-done  // Wait

// Or use WaitGroup for multiple goroutines
var wg sync.WaitGroup
for i := 0; i < 10; i++ {
    wg.Add(1)
    go func() {
        defer wg.Done()
        doWork()
    }()
}
wg.Wait()
\`\`\`

Goroutines are:
- **Extremely lightweight** (2KB initial stack, grows as needed vs 1MB+ for OS threads)
- **Scheduled by the Go runtime**, not the OS
- **Multiplexed onto OS threads** (you can run millions)
- **Communicate through channels**, not shared memory

### Netflix's Goroutine Patterns

Netflix processes millions of streaming requests per second. Their Go services use a fan-out/fan-in pattern: spawn goroutines to fetch data from multiple backend services concurrently, then collect results through a shared channel with a context-based timeout:

\`\`\`go
// Pattern from Netflix's Go services
func (s *StreamingService) GetPersonalizedContent(ctx context.Context, userID string) (*Content, error) {
    // Fan-out: fetch data from multiple services concurrently
    results := make(chan result, 4)

    go func() {
        recommendations, err := s.recommendationService.Get(ctx, userID)
        results <- result{data: recommendations, err: err, source: "recommendations"}
    }()

    go func() {
        watchHistory, err := s.historyService.Get(ctx, userID)
        results <- result{data: watchHistory, err: err, source: "history"}
    }()

    go func() {
        trending, err := s.trendingService.Get(ctx)
        results <- result{data: trending, err: err, source: "trending"}
    }()

    go func() {
        userPrefs, err := s.preferencesService.Get(ctx, userID)
        results <- result{data: userPrefs, err: err, source: "preferences"}
    }()

    // Fan-in: collect results with timeout
    var recommendations, watchHistory, trending, userPrefs any
    for i := 0; i < 4; i++ {
        select {
        case r := <-results:
            if r.err != nil {
                s.logger.Warn("service call failed",
                    zap.String("source", r.source),
                    zap.Error(r.err))
                continue  // Graceful degradation
            }
            switch r.source {
            case "recommendations":
                recommendations = r.data
            case "history":
                watchHistory = r.data
            case "trending":
                trending = r.data
            case "preferences":
                userPrefs = r.data
            }
        case <-ctx.Done():
            return nil, ctx.Err()
        }
    }

    // Combine results
    return s.mergeContent(recommendations, watchHistory, trending, userPrefs), nil
}
\`\`\`

### From Callbacks to Channels

Node.js handles asynchronous work through callbacks and promises. Go replaces both with channels, which provide typed, synchronized communication between goroutines:

\`\`\`javascript
// JavaScript/Node.js
fetchData(url)
    .then(data => process(data))
    .then(result => save(result))
    .catch(err => handleError(err));

// Or with async/await
async function handleRequest() {
    try {
        const data = await fetchData(url);
        const result = await process(data);
        await save(result);
    } catch (err) {
        handleError(err);
    }
}
\`\`\`

Go uses channels:

\`\`\`go
// Go
func handleRequest(ctx context.Context) error {
    dataCh := make(chan Data)
    errCh := make(chan error)

    go func() {
        data, err := fetchData(ctx, url)
        if err != nil {
            errCh <- err
            return
        }
        dataCh <- data
    }()

    select {
    case data := <-dataCh:
        result, err := process(data)
        if err != nil {
            return fmt.Errorf("process failed: %w", err)
        }
        return save(result)
    case err := <-errCh:
        return fmt.Errorf("fetch failed: %w", err)
    case <-ctx.Done():
        return ctx.Err()
    }
}
\`\`\`

Channels provide synchronized communication between goroutines, making concurrent code easier to reason about.

### From Null to Zero Values

In most languages, uninitialized variables are null, undefined, or contain garbage data. Go takes a different approach: every type has a well-defined zero value that the runtime assigns automatically:

\`\`\`java
// Java
String s;     // null - NullPointerException waiting to happen
Integer i;    // null
List<String> list;  // null
\`\`\`

\`\`\`python
# Python
s = None  # Explicit None
# Or don't initialize at all (NameError)
\`\`\`

In Go, every type has a zero value:

\`\`\`go
// Go
var s string              // "" (empty string)
var i int                 // 0
var f float64             // 0.0
var b bool                // false
var p *int                // nil (but nil is a valid value you can check)
var m map[string]int      // nil (safe to read, panics on write)
var sl []int              // nil (safe to append, length 0)
var ch chan int           // nil (blocks forever on send/receive)
var fn func()             // nil (panics if called)
var iface io.Reader       // nil (type and value both nil)
\`\`\`

This eliminates a class of bugs, though you still need to understand each type's zero value behavior.

### Zero Value Design: How the Standard Library Uses This

The Go standard library is designed so that many types are immediately usable at their zero value, requiring no constructor call or initialization:

\`\`\`go
// bytes.Buffer is usable without initialization
var buf bytes.Buffer
buf.WriteString("hello")  // Works!
fmt.Println(buf.String()) // "hello"

// sync.Mutex is usable without initialization
var mu sync.Mutex
mu.Lock()
// critical section
mu.Unlock()

// http.Client is usable with defaults
var client http.Client
resp, err := client.Get("https://example.com")  // Works!

// Design your types the same way
type Counter struct {
    mu    sync.Mutex
    count int  // Zero value: 0, which is a valid count
}

func (c *Counter) Increment() {
    c.mu.Lock()
    c.count++
    c.mu.Unlock()
}

// Usable without initialization
var counter Counter
counter.Increment()  // Works! Count is now 1
\`\`\`

### From Try-Catch to If Err != Nil

The pattern you will write thousands of times:

\`\`\`go
result, err := someFunction()
if err != nil {
    return fmt.Errorf("context about what failed: %w", err)
}
// use result
\`\`\`

Embrace it. Every explicit error check is a conscious decision about how to handle that error. The Go community has found this produces more reliable software than exception-based error handling.

### From Constructors to Factory Functions

Go has no constructors. Instead, types are initialized through exported factory functions, typically named \`New\` or \`New<Type>\`. For types with many optional settings, the functional options pattern provides a clean API:

\`\`\`go
// By convention, New<Type> or just New if unambiguous
func NewServer(addr string, port int) *Server {
    return &Server{
        addr:    addr,
        port:    port,
        logger:  log.Default(),
        timeout: 30 * time.Second,
    }
}

// Functional options pattern for complex construction
func NewServer(addr string, opts ...ServerOption) *Server {
    s := &Server{
        addr:    addr,
        timeout: 30 * time.Second,  // Default
    }
    for _, opt := range opts {
        opt(s)
    }
    return s
}

type ServerOption func(*Server)

func WithTimeout(d time.Duration) ServerOption {
    return func(s *Server) {
        s.timeout = d
    }
}

func WithLogger(l *log.Logger) ServerOption {
    return func(s *Server) {
        s.logger = l
    }
}

// Usage
srv := NewServer("localhost:8080",
    WithTimeout(60*time.Second),
    WithLogger(customLogger),
)
\`\`\`

Sometimes you do not need a constructor at all. Struct literals work fine:

\`\`\`go
srv := &Server{Addr: "localhost", Port: 8080}
\`\`\`

### From Getters/Setters to Exported Fields

Go discourages boilerplate getter/setter methods. If a field needs to be accessible, export it directly by capitalizing its name:

\`\`\`go
// Instead of this (Java-style)
type User struct {
    name string
}
func (u *User) GetName() string { return u.name }
func (u *User) SetName(n string) { u.name = n }

// Just do this
type User struct {
    Name string  // Exported (capital letter)
}
\`\`\`

Use methods only when you need computed values or validation:

\`\`\`go
type Circle struct {
    Radius float64
}

func (c Circle) Area() float64 {
    return math.Pi * c.Radius * c.Radius
}

func (c Circle) Diameter() float64 {
    return c.Radius * 2
}
\`\`\`

### The Senior-Track Argument for Each Shift

The patterns above are not just "Go does it differently". Each one corresponds to an architectural argument that a staff-plus engineer needs in their pocket when defending the choice in a design review. The talking points below are what the rest of this chapter (and the rest of the book) is ammunition for.

**Composition over inheritance.** The argument is not "inheritance is bad". It is "inheritance hierarchies become liabilities at the five-year horizon, because the cost of refactoring a deep hierarchy that the original author has long since left grows superlinearly with the depth". Composition with embedding is shallow by design. There is no "diamond problem" to defend against, no virtual-method-table surprises, no "I changed the base class and broke fifteen subclasses I did not know existed". The cost is that some patterns (template methods, visitor patterns) become more verbose. The benefit is that the codebase stays refactorable indefinitely. Java teams that have lived through a JBoss-or-Spring-or-Hibernate-style framework migration know the cost of inheritance hierarchies. Go's choice is calibrated to make that cost impossible to incur.

**Implicit interface satisfaction.** The single most under-appreciated feature in Go for senior engineers is the ability to define an interface in the consuming package, not the implementing package. This inverts the dependency direction. In Java or C# you cannot make a third-party class implement your interface without an adapter. In Go you can, because the third-party type satisfies your interface the moment its method set matches, with no declaration required. This collapses the "I need an adapter for every external type" boilerplate that JVM teams accumulate over years. The downside is that interface satisfaction is invisible at the implementing type's declaration site, which can make "who implements this interface?" hard to grep for. The fix is \`gopls\`-style tooling, which Go has, and the discipline of declaring small interfaces close to the consumer.

**Errors as values.** The argument that survives a hostile review is not "exceptions are bad". It is "exceptions create invisible control-flow paths, and at the 200-service horizon every invisible control-flow path is a future incident". Go's error model forces the call site to acknowledge every failure. The cost is verbose-looking code. The benefit is that there is no "this exception leaked through three layers of middleware and crashed the cron job at 3 AM" debugging story. Stripe's choice (referenced above) is the canonical case study. The org-design implication is that Go services tend to have flatter call stacks and more localised failure handling than the equivalent JVM or Python service, which makes them easier to operate at scale.

**Goroutines and channels over thread pools.** The advantage is not raw concurrency throughput, although that is real. The advantage is that the goroutine-and-channel model lets engineers write straight-line code that happens to be concurrent, instead of callback chains or future composition. The complexity of an N-service fan-out in Node.js (Promise.all with timeout, race condition between the timeout and the result, error propagation through the chain) collapses to a \`select\` block over a \`chan result\` and \`ctx.Done()\` in Go. Netflix's pattern (referenced above) is unremarkable in idiomatic Go and would be a 200-line undertaking in Node or Java. This is the single biggest productivity win when Node or JVM teams migrate to Go for I/O-bound services.

**Zero values that are useful.** The senior-track payoff is that you can design types so that callers do not need a constructor for the common case. \`var buf bytes.Buffer; buf.WriteString("hi")\` is shorter than \`Buffer buf = new Buffer(); buf.append("hi")\` and one less thing to teach a new hire. The discipline is to design your own types the same way: pick field types so that the zero value of the struct is a usable starting state. When that is impossible (because some field has no useful zero value), use a \`New...\` constructor and document that the zero value is invalid. The half-and-half option ("the zero value is sort of usable but you have to call Init first") is the worst of both worlds and shows up as bug reports forever.

**Functional options over builder classes.** The argument is type safety plus discoverability. A \`NewServer("addr", WithTimeout(30*time.Second), WithLogger(myLogger))\` call is self-documenting at the call site, type-checked at compile time, and trivially extensible by adding new \`With...\` functions without breaking existing callers. The Builder pattern in Java solves the same problem more verbosely and with worse type-safety guarantees (the builder typically has to allow any subset of methods to be called, which means the type system cannot enforce required fields). Functional options is one of the patterns that Java and C# engineers most often miss when they move to Go, and it is one of the patterns most often misused (turned into "every parameter must be an option") in the other direction.

**Exported fields over getters and setters.** The argument is that getters and setters that just read and write a field are dead weight. They add no encapsulation (the field is still mutable from the outside, just through a method instead of directly), they add no validation (because they do nothing), and they add typing noise to every call site. The discipline is: if the field needs validation or invariants, hide it and provide a method that enforces the invariant. If it does not, export the field directly. The discipline is enforced by the linter \`revive\`'s \`unused-receiver\` rule and by code review attention. Engineers from Java and C# routinely write Go that is full of getters and setters for no reason, and the senior-track code-review job is to call this out kindly.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags when an experienced developer first lands a PR in a Go codebase:

1. **Inheritance modelled as embedding.** When a junior author embeds a "BaseFoo" type into every "FooImpl" type and treats the result as inheritance with overrides, the reviewer should ask whether the BaseFoo is doing real work (in which case keep it) or is acting as a vestigial Java parent class (in which case delete it and inline the relevant behaviour). The smell is that BaseFoo has no callers other than the embedding types and exists purely to share fields.
2. **\`interface{}\` (or \`any\`) as the type for "I do not know what to put here".** This is the Java \`Object\` type, imported into Go. The fix is almost always to introduce a small interface (\`type Encoder interface { Encode(any) ([]byte, error) }\`) or, post-1.18, a generic type parameter. The standard library uses \`any\` sparingly, almost always at the API boundary where the type is genuinely unknowable. Internal code rarely needs it.
3. **\`init()\` functions that do runtime configuration.** \`init()\` is for things that must happen at import time, with no dependencies on user input. Reading environment variables, opening database connections, or registering things with a global registry from \`init()\` is a recurring anti-pattern, because it makes the package's behaviour depend on import order and global state in ways that are hard to test. Move runtime configuration to a \`New...\` function called from \`main\`, and reserve \`init()\` for things like registering image decoders with \`image.RegisterFormat\`.

### Migration Lens

Coming from Java, the biggest mental shift is that you do not own the types you implement interfaces for, and that is a feature. Coming from Python, the biggest shift is that the compiler will catch the duck-typing mistakes that previously surfaced as runtime AttributeErrors. Coming from JavaScript, the biggest shift is that errors are returned, not thrown, and the verbose explicit handling is the price you pay for having no invisible control-flow paths. Coming from Rust, the biggest shift is that there is no ownership system, no \`?\` operator, and no enums-with-payloads, and the discipline is to compensate with explicit error wrapping and small interfaces. Coming from C++, the biggest shift is that you do not manage memory and you cannot template your way out of every problem (though generics in 1.18+ help in the cases where they should). The chapters that follow apply each of these shifts to specific Go subsystems.

---
`;
