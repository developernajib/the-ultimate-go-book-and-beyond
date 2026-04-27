export default `## 10.2 Functional Patterns

Go treats functions as first-class values: they can be assigned to variables, stored in data structures, passed as arguments, and returned from other functions. This opens up functional programming patterns that complement Go's imperative core without requiring a functional framework.

### First-Class Functions

In Go, functions are values. You can assign them to variables, store them in maps, pass them as arguments, and return them from other functions. This means you can select behavior at runtime the same way you select data:

\`\`\`go
// Function as variable
var operation func(int, int) int

operation = func(a, b int) int { return a + b }
fmt.Println(operation(1, 2))  // 3

operation = func(a, b int) int { return a * b }
fmt.Println(operation(1, 2))  // 2

// Function as map value
operations := map[string]func(int, int) int{
    "add":      func(a, b int) int { return a + b },
    "subtract": func(a, b int) int { return a - b },
    "multiply": func(a, b int) int { return a * b },
    "divide":   func(a, b int) int { return a / b },
}

result := operations["add"](10, 5)  // 15
\`\`\`

### Higher-Order Functions

A higher-order function either accepts a function as a parameter or returns one as its result. Combined with generics, higher-order functions let you write reusable collection operations that work across any type. The following examples implement the classic Map, Filter, and Reduce patterns:

\`\`\`go
// Map transforms each element
func Map[T, U any](slice []T, fn func(T) U) []U {
    result := make([]U, len(slice))
    for i, v := range slice {
        result[i] = fn(v)
    }
    return result
}

// Filter keeps elements matching predicate
func Filter[T any](slice []T, pred func(T) bool) []T {
    result := make([]T, 0, len(slice))
    for _, v := range slice {
        if pred(v) {
            result = append(result, v)
        }
    }
    return result
}

// Reduce combines elements into single value
func Reduce[T, U any](slice []T, init U, fn func(U, T) U) U {
    acc := init
    for _, v := range slice {
        acc = fn(acc, v)
    }
    return acc
}

// Find returns first matching element
func Find[T any](slice []T, pred func(T) bool) (T, bool) {
    for _, v := range slice {
        if pred(v) {
            return v, true
        }
    }
    var zero T
    return zero, false
}

// Any returns true if any element matches
func Any[T any](slice []T, pred func(T) bool) bool {
    for _, v := range slice {
        if pred(v) {
            return true
        }
    }
    return false
}

// All returns true if all elements match
func All[T any](slice []T, pred func(T) bool) bool {
    for _, v := range slice {
        if !pred(v) {
            return false
        }
    }
    return true
}

// Usage
numbers := []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}

doubled := Map(numbers, func(n int) int { return n * 2 })
// [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]

evens := Filter(numbers, func(n int) bool { return n%2 == 0 })
// [2, 4, 6, 8, 10]

sum := Reduce(numbers, 0, func(acc, n int) int { return acc + n })
// 55

firstEven, found := Find(numbers, func(n int) bool { return n%2 == 0 })
// 2, true

hasNegative := Any(numbers, func(n int) bool { return n < 0 })
// false

allPositive := All(numbers, func(n int) bool { return n > 0 })
// true
\`\`\`

### Closures

A closure is a function that captures variables from its enclosing scope. Each closure gets its own copy of the captured state, so two closures created by the same factory function operate independently. This is the foundation for stateful function values in Go:

\`\`\`go
// Counter with closure
func counter() func() int {
    count := 0
    return func() int {
        count++
        return count
    }
}

c1 := counter()
c2 := counter()
fmt.Println(c1(), c1(), c1())  // 1, 2, 3
fmt.Println(c2(), c2())        // 1, 2 (separate state)

// Closure with parameters
func accumulator(initial int) func(int) int {
    sum := initial
    return func(delta int) int {
        sum += delta
        return sum
    }
}

acc := accumulator(100)
fmt.Println(acc(10))  // 110
fmt.Println(acc(20))  // 130
fmt.Println(acc(-50)) // 80
\`\`\`

### Function Factories

A function factory returns a new function configured with specific parameters. This pattern eliminates repetitive code by generating specialized functions from a common template. Validators, loggers, and arithmetic operators all benefit from this approach:

\`\`\`go
// Multiplier factory
func makeMultiplier(factor int) func(int) int {
    return func(x int) int {
        return x * factor
    }
}

double := makeMultiplier(2)
triple := makeMultiplier(3)
fmt.Println(double(5), triple(5))  // 10, 15

// Validator factory
func makeRangeValidator(min, max int) func(int) bool {
    return func(value int) bool {
        return value >= min && value <= max
    }
}

isValidAge := makeRangeValidator(0, 150)
isValidPercent := makeRangeValidator(0, 100)

fmt.Println(isValidAge(25))      // true
fmt.Println(isValidPercent(150)) // false

// Logger factory with prefix
func makeLogger(prefix string) func(string) {
    return func(msg string) {
        log.Printf("[%s] %s", prefix, msg)
    }
}

infoLog := makeLogger("INFO")
errorLog := makeLogger("ERROR")

infoLog("Server started")    // [INFO] Server started
errorLog("Connection failed") // [ERROR] Connection failed
\`\`\`

### Middleware Pattern

Middleware wraps an HTTP handler to add cross-cutting behavior, logging, authentication, rate limiting, CORS, without modifying the handler itself. Each middleware takes a handler, returns a new handler, and the \`Chain\` function composes them into a pipeline. Requests flow through the chain in order, and each middleware decides whether to pass the request to the next handler or short-circuit with an error response:

\`\`\`go
// Middleware is a function that wraps a handler
type Middleware func(http.Handler) http.Handler

// Logging middleware
func Logging(logger *log.Logger) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            start := time.Now()

            // Wrap ResponseWriter to capture status code
            wrapped := &responseWrapper{ResponseWriter: w, status: 200}

            next.ServeHTTP(wrapped, r)

            logger.Printf("%s %s %d %v",
                r.Method, r.URL.Path, wrapped.status, time.Since(start))
        })
    }
}

type responseWrapper struct {
    http.ResponseWriter
    status int
}

func (w *responseWrapper) WriteHeader(status int) {
    w.status = status
    w.ResponseWriter.WriteHeader(status)
}

// Authentication middleware
func Auth(tokenValidator func(string) bool) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            token := r.Header.Get("Authorization")
            if token == "" || !tokenValidator(token) {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

// Rate limiting middleware
func RateLimit(rps int) Middleware {
    limiter := rate.NewLimiter(rate.Limit(rps), rps)
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if !limiter.Allow() {
                http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

// CORS middleware
func CORS(allowedOrigins []string) Middleware {
    allowed := make(map[string]bool)
    for _, origin := range allowedOrigins {
        allowed[origin] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")
            if allowed[origin] || allowed["*"] {
                w.Header().Set("Access-Control-Allow-Origin", origin)
                w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
                w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
            }

            if r.Method == "OPTIONS" {
                w.WriteHeader(http.StatusOK)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Chain applies middleware in order
func Chain(middlewares ...Middleware) Middleware {
    return func(final http.Handler) http.Handler {
        for i := len(middlewares) - 1; i >= 0; i-- {
            final = middlewares[i](final)
        }
        return final
    }
}

// Usage
func main() {
    logger := log.New(os.Stdout, "", log.LstdFlags)

    handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("Hello, World!"))
    })

    // Apply middleware chain
    chain := Chain(
        Logging(logger),
        Auth(validateToken),
        RateLimit(100),
        CORS([]string{"https://example.com"}),
    )

    http.Handle("/api/", chain(handler))
    http.ListenAndServe(":8080", nil)
}
\`\`\`

### Decorator Pattern

While middleware targets HTTP handlers specifically, the decorator pattern applies the same wrapping idea to any function. A decorator takes a function and returns a new function with added behavior like retry logic, timeouts, or caching. Because decorators share the same signature as the function they wrap, they compose naturally: you can stack retry on top of timeout on top of the original call:

\`\`\`go
// Retry decorator
func WithRetry[T any](attempts int, delay time.Duration, fn func() (T, error)) func() (T, error) {
    return func() (T, error) {
        var lastErr error
        var zero T

        for i := 0; i < attempts; i++ {
            result, err := fn()
            if err == nil {
                return result, nil
            }
            lastErr = err

            if i < attempts-1 {
                time.Sleep(delay * time.Duration(i+1))
            }
        }

        return zero, fmt.Errorf("after %d attempts: %w", attempts, lastErr)
    }
}

// Timeout decorator
func WithTimeout[T any](timeout time.Duration, fn func() (T, error)) func() (T, error) {
    return func() (T, error) {
        ctx, cancel := context.WithTimeout(context.Background(), timeout)
        defer cancel()

        type result struct {
            value T
            err   error
        }

        ch := make(chan result, 1)
        go func() {
            v, err := fn()
            ch <- result{v, err}
        }()

        select {
        case r := <-ch:
            return r.value, r.err
        case <-ctx.Done():
            var zero T
            return zero, ctx.Err()
        }
    }
}

// Cache decorator
func WithCache[K comparable, V any](ttl time.Duration, fn func(K) (V, error)) func(K) (V, error) {
    cache := make(map[K]struct {
        value  V
        expiry time.Time
    })
    var mu sync.RWMutex

    return func(key K) (V, error) {
        mu.RLock()
        if entry, ok := cache[key]; ok && time.Now().Before(entry.expiry) {
            mu.RUnlock()
            return entry.value, nil
        }
        mu.RUnlock()

        value, err := fn(key)
        if err != nil {
            var zero V
            return zero, err
        }

        mu.Lock()
        cache[key] = struct {
            value  V
            expiry time.Time
        }{value, time.Now().Add(ttl)}
        mu.Unlock()

        return value, nil
    }
}

// Usage
fetchData := func() (string, error) {
    // Simulated unreliable call
    return "data", nil
}

// Add retry with exponential backoff
reliableFetch := WithRetry(3, time.Second, fetchData)

// Add timeout
timedFetch := WithTimeout(5*time.Second, reliableFetch)

data, err := timedFetch()
\`\`\`

### Functional Patterns Discipline

Functions as values are powerful. Three rules:

1. **Name the function type when it is part of a public API.** \`type Handler func(context.Context, Request) (Response, error)\` reads better than repeating the signature.
2. **Middleware chains should be shallow.** Six layers deep becomes hard to debug. Flatten when possible.
3. **Closures that capture large state risk heap allocation.** Measure if it matters.

### Closure Capture Hazards

Two closure hazards that cause real bugs in production Go:

**Loop variable capture (pre-Go 1.22).** Closures created inside a \`for\` loop captured the shared loop variable by reference, so every goroutine saw the final value. Go 1.22 changed this: each iteration gets its own variable. Code that depended on the old behaviour silently changes. Code that paired-around the old behaviour via \`x := x\` now has a redundant shadow that does nothing. When maintaining code across the Go 1.22 boundary, be explicit about which semantics the code was written for.

**Accidental capture of large state.** A closure over a method receiver captures the entire receiver value, including fields the closure does not use. If the closure is stored long-term (on a goroutine, in a callback map), it pins the entire receiver on the heap. For a large struct, this is wasteful. For a struct that holds a resource (open file, mutex, connection), it is a leak. The mitigation: capture only the fields the closure actually uses, as locals, before returning the closure.

\`\`\`go
func (s *Service) Worker() func() error {
    log := s.logger // capture only what is needed
    return func() error { log.Info("tick"); return nil }
}
\`\`\`

### Staff Lens: Functional Patterns and the Debugger

Every layer of function wrapping is a frame in a stack trace that obscures the real code. A decorator chain six deep produces a stack trace where the meaningful frame is at depth 11, and every frame above it is \`func1.func2.func3\`. This is one of the recurring critiques of deeply functional Go. The balance: use functional patterns where they produce a clean shape (single middleware layer, single decorator) and fall back to explicit methods when the stack would otherwise be incomprehensible. The test: when a production panic happens in this code, can the on-call engineer read the stack trace and find the problem in under a minute? If not, the functional layering is too deep.

### Generics and Functional Patterns (Go 1.18+)

The map/filter/reduce implementations above predate the stdlib adding canonical versions in Go 1.21+ (\`slices.Map\` is still missing at the time of writing, but many teams have internal copies). The community has converged on a small set: \`slices.Sort\`, \`slices.Index\`, \`slices.Contains\`, \`slices.IndexFunc\`, \`maps.Keys\`, \`maps.Values\`. Use the stdlib versions when they exist. Avoid the cultural trap of over-functional Go: a for-range loop with a clear body is more idiomatic than \`slices.Collect(slices.Values(...))\` in all but a few cases. Go is not Haskell. A plain loop with a clear intent wins over an elegant functional chain in the review.

---
`;
