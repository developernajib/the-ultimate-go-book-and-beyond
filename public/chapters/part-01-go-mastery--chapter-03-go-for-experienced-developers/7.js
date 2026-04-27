export default `## 3.6 Functions Advanced

Functions in Go support multiple return values, variadic parameters, closures, and deferred execution. These features interact in ways that differ from other languages, particularly around error handling and resource cleanup.

### Multiple Return Values

Go functions can return multiple values, which is the foundation of Go's error handling pattern. The convention is to return the result as the first value and an error as the last:

\`\`\`go
func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, errors.New("division by zero")
    }
    return a / b, nil
}

result, err := divide(10, 2)
\`\`\`

### Named Return Values

Return values can be given names, which declares them as local variables initialized to their zero values. A bare \`return\` statement (called a "naked return") then returns whatever those variables currently hold:

\`\`\`go
func divide(a, b float64) (result float64, err error) {
    if b == 0 {
        err = errors.New("division by zero")
        return  // naked return - returns named values
    }
    result = a / b
    return  // naked return
}
\`\`\`

Named returns are useful for:
- Documenting what the function returns
- Allowing modification in deferred functions
- Reducing repetition in complex functions

**Caveat**: Naked returns harm readability in long functions. Use them sparingly.

### Variadic Functions

A variadic function accepts any number of arguments of the same type. The variadic parameter must be the last parameter and is received as a slice inside the function:

\`\`\`go
func sum(nums ...int) int {
    total := 0
    for _, n := range nums {
        total += n
    }
    return total
}

sum(1, 2, 3)       // 6
sum(1, 2, 3, 4, 5) // 15

// Spread a slice
nums := []int{1, 2, 3}
sum(nums...)  // 6
\`\`\`

### Closures

Go functions are first-class values. You can assign them to variables, pass them as arguments, and return them from other functions. A closure is a function that captures variables from its enclosing scope, maintaining references to those variables even after the enclosing function returns:

\`\`\`go
func counter() func() int {
    count := 0
    return func() int {
        count++
        return count
    }
}

c := counter()
fmt.Println(c())  // 1
fmt.Println(c())  // 2
fmt.Println(c())  // 3

c2 := counter()   // New counter, independent state
fmt.Println(c2()) // 1
\`\`\`

The returned function "closes over" \`count\`, maintaining its state between calls.

### Closures in Production: Rate Limiters

Closures are particularly useful for encapsulating mutable state behind a clean function signature. This token bucket rate limiter stores its state in closed-over variables, with a mutex protecting concurrent access:

\`\`\`go
// Token bucket rate limiter using closure
func NewRateLimiter(rate float64, burst int) func() bool {
    var (
        tokens    = float64(burst)
        lastTime  = time.Now()
        mu        sync.Mutex
    )

    return func() bool {
        mu.Lock()
        defer mu.Unlock()

        now := time.Now()
        elapsed := now.Sub(lastTime).Seconds()
        lastTime = now

        // Add tokens based on elapsed time
        tokens += elapsed * rate
        if tokens > float64(burst) {
            tokens = float64(burst)
        }

        // Try to consume a token
        if tokens >= 1 {
            tokens--
            return true
        }
        return false
    }
}

// Usage
limiter := NewRateLimiter(100, 10)  // 100 req/sec, burst of 10
if limiter() {
    handleRequest()
}
\`\`\`

### Defer

The \`defer\` keyword schedules a function call to execute when the surrounding function returns, regardless of whether it returns normally or through a panic. This is Go's primary mechanism for cleanup, closing files, releasing locks, and flushing buffers:

\`\`\`go
func readFile(path string) error {
    f, err := os.Open(path)
    if err != nil {
        return err
    }
    defer f.Close()  // Runs when readFile returns

    // Use f...
    return nil
}
\`\`\`

Defer is LIFO (last in, first out):

\`\`\`go
defer fmt.Println("first")
defer fmt.Println("second")
defer fmt.Println("third")
// Output: third, second, first
\`\`\`

**Important**: Defer arguments are evaluated immediately:

\`\`\`go
i := 0
defer fmt.Println(i)  // Prints 0, not 10
i = 10
\`\`\`

### Panic and Recover

\`panic\` halts normal execution and begins unwinding the stack, running deferred functions along the way. \`recover\`, when called inside a deferred function, stops the unwinding and returns the panic value:

\`\`\`go
func safeDivide(a, b int) (result int, err error) {
    defer func() {
        if r := recover(); r != nil {
            err = fmt.Errorf("recovered: %v", r)
        }
    }()

    if b == 0 {
        panic("division by zero")
    }
    return a / b, nil
}
\`\`\`

**When to panic**:
- Programmer errors (index out of bounds, nil pointer)
- Impossible situations that indicate bugs
- In \`init()\` when program cannot start correctly

**When NOT to panic**:
- Expected errors (file not found, network timeout)
- User input validation
- Anything a caller might reasonably want to handle

### Defer Has Three Sharp Edges

Worth memorising before they bite you in production:

1. **Arguments are captured at the \`defer\` line.** \`defer log.Println(time.Now())\` captures the current time at the point the \`defer\` runs, not at function return. To capture at return time, wrap in a closure: \`defer func() { log.Println(time.Now()) }()\`.
2. **\`defer\` in a loop accumulates.** A loop that opens 10,000 files and \`defer\`s \`f.Close()\` inside the loop holds 10,000 file descriptors until the function returns. The fix is to extract the loop body into a helper function so each defer fires per iteration.
3. **\`defer\` interacts with named returns.** A deferred function can read and modify named return values, which is the basis of the panic-to-error conversion pattern shown above. It is also a footgun: a deferred closure that accidentally captures a named return can change the function's return value at return time, sometimes silently.

### The Functional Options Pattern Done Right

The functional options pattern (introduced in Section 3.1) is the idiomatic Go answer to "constructors with many optional parameters". The full pattern, with senior-track guidance, looks like this:

\`\`\`go
type Server struct {
    addr    string
    port    int
    timeout time.Duration
    logger  *slog.Logger
}

type ServerOption func(*Server)

func WithTimeout(d time.Duration) ServerOption {
    return func(s *Server) { s.timeout = d }
}

func WithLogger(l *slog.Logger) ServerOption {
    return func(s *Server) { s.logger = l }
}

func NewServer(addr string, port int, opts ...ServerOption) *Server {
    s := &Server{
        addr:    addr,
        port:    port,
        timeout: 30 * time.Second,         // sensible default
        logger:  slog.Default(),           // sensible default
    }
    for _, opt := range opts {
        opt(s)
    }
    return s
}
\`\`\`

Three rules a senior reviewer applies to functional options:

1. **Required parameters are positional, optional parameters are options.** \`NewServer("localhost", 8080, WithTimeout(...))\` makes the required parameters obvious and the optional ones discoverable.
2. **Defaults are set before applying options.** The struct is initialised with sensible defaults, then options overwrite them. This guarantees that callers who pass no options still get a working object.
3. **Options should not return errors.** If an option needs to validate, the validation happens at apply time inside the option's closure, and the error is stored in the struct (\`s.err = err\`) and reported by the constructor at the end. This keeps the call-site signature clean.

The anti-pattern is to use functional options for required parameters or for parameters that will always be set. That turns every call site into \`NewServer(WithAddr("localhost"), WithPort(8080), ...)\` which is verbose and obscures which parameters are actually optional.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer flags in function-heavy PRs:

1. **Functions over five parameters.** Past five, callers have trouble keeping the order straight. Promote to a struct, split into two functions, or use functional options. Five is a smell threshold, not a hard rule.
2. **Boolean parameters.** \`send(msg, true, false)\` is unreadable at the call site. Replace with named types (\`type Mode int\` plus typed constants) or split into \`SendAsync\` and \`SendSync\`.
3. **\`recover\` outside a deferred function or used as exception handling.** \`recover\` only works inside a \`defer\`d function. Using it elsewhere is a bug. Using it as a general-purpose exception handler (recovering panics that should have crashed) is an anti-pattern that hides bugs and makes debugging harder.

### Migration Lens

Coming from Java, the absence of method overloading and default parameter values is the biggest function-related shift. The replacements are functional options for optional parameters, distinct names for "overloads" (\`SendString\` and \`SendBytes\` rather than two \`Send\` methods), and explicit struct parameters when there are too many of either. Coming from Python, the absence of \`*args\` and \`**kwargs\` simplifies the signature but removes the keyword-argument flexibility. The Go answer is options structs or functional options. Coming from JavaScript, the absence of \`arguments\` and the explicit variadic syntax is more disciplined. Coming from C#, extension methods do not exist, so the equivalent of "add a method to a third-party type" is an interface plus a wrapper, not a method on the original type.

---
`;
