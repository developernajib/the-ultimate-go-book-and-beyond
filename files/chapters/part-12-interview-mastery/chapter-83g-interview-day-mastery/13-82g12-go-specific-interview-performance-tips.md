## 83G.12 Go-Specific Interview Performance Tips

When you are writing Go under pressure, certain mistakes become much more likely. This section covers the specific Go errors that interviewers see most often and the idioms that differentiate strong Go candidates.

### Writing Clean Go on a Whiteboard

Go's syntax is relatively simple, which makes it a good whiteboard language. But pressure creates specific issues:

**Keep these Go constructs automatic (practice until they require zero thought):**

```go
// 1. Function signature with error return
func processData(input []int) (int, error) {
    // ...
}

// 2. Error handling pattern
result, err := someOperation()
if err != nil {
    return 0, fmt.Errorf("processing failed: %w", err)
}

// 3. Map initialization and check
cache := make(map[string]int)
if val, exists := cache[key]; exists {
    // use val
}

// 4. Slice operations
items := make([]int, 0, expectedSize) // pre-allocate capacity
items = append(items, newItem)
last := items[len(items)-1]           // peek
items = items[:len(items)-1]          // pop

// 5. Range loop
for i, v := range slice {
    // i is index, v is value
}
for k, v := range mapVar {
    // k is key, v is value
}

// 6. Goroutine with WaitGroup
var wg sync.WaitGroup
for _, item := range items {
    wg.Add(1)
    go func(it Item) { // In Go 1.22+, loop vars are per-iteration scoped, but passing explicitly remains robust
        defer wg.Done()
        process(it)
    }(item)
}
wg.Wait()

// 7. Channel operations
ch := make(chan int, bufferSize)
ch <- value  // send
v := <-ch    // receive
v, ok := <-ch // receive with closed check

// 8. Defer for cleanup
f, err := os.Open(filename)
if err != nil {
    return err
}
defer f.Close()

// 9. Interface definition
type Reader interface {
    Read(p []byte) (n int, err error)
}

// 10. Struct with methods
type Cache struct {
    mu   sync.RWMutex
    data map[string]string
}

func (c *Cache) Get(key string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    val, ok := c.data[key]
    return val, ok
}
```

### Common Go Interview Mistakes to Avoid

These are the mistakes interviewers flag most often. Under pressure, they become more likely.

**1. Forgetting `if err != nil`**

```go
// BAD: Ignoring the error
result, _ := riskyOperation()
use(result) // result might be zero value if operation failed

// GOOD: Always handle errors
result, err := riskyOperation()
if err != nil {
    return fmt.Errorf("operation failed: %w", err)
}
use(result)
```

In an interview, you can abbreviate error handling verbally: "I'd check the error here --- let me write the full check for the important operations and abbreviate the others to keep moving."

**2. Not handling goroutine cleanup**

```go
// BAD: Goroutine leak
func process(ctx context.Context) {
    go func() {
        for {
            doWork() // Runs forever if parent returns
        }
    }()
}

// GOOD: Goroutine respects cancellation
func process(ctx context.Context) {
    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            default:
                doWork()
            }
        }
    }()
}
```

**What to Say if the interviewer asks about goroutine cleanup:**
> "In production, I'd always use context cancellation to signal goroutines to exit. I'd also use a WaitGroup or errgroup to wait for all goroutines to finish before returning."

**3. Using string concatenation instead of strings.Builder**

```go
// BAD: O(n^2) string building
result := ""
for _, s := range parts {
    result += s // Creates a new string each iteration
}

// GOOD: O(n) string building
var sb strings.Builder
for _, s := range parts {
    sb.WriteString(s)
}
result := sb.String()
```

**4. Forgetting to initialize maps**

```go
// BAD: Panic at runtime (nil map write)
var counts map[string]int
counts["hello"] = 1 // PANIC: assignment to entry in nil map

// GOOD: Initialize with make
counts := make(map[string]int)
counts["hello"] = 1
```

This is the most common Go runtime panic in interviews. Under pressure, it is easy to declare a map without initializing it.

**5. Off-by-one in slice operations**

```go
// Common mistake: accessing arr[len(arr)]
arr := []int{1, 2, 3}
last := arr[len(arr)] // PANIC: index out of range

// Correct
last := arr[len(arr)-1] // 3

// Common mistake: wrong slice bounds
sub := arr[1:3] // [2, 3] --- does NOT include index 3
sub := arr[1:4] // PANIC: index out of range (arr only has 3 elements)
```

### Go Shortcuts for Speed

These standard library shortcuts save time in interviews:

```go
// Sorting
sort.Ints(nums)                         // sort int slice ascending
sort.Sort(sort.Reverse(sort.IntSlice(nums))) // sort descending
sort.Slice(items, func(i, j int) bool { // custom sort
    return items[i].Priority > items[j].Priority
})
// Go 1.21+: slices.Sort, slices.SortFunc (simpler API)
slices.Sort(nums)

// Min/Max (Go 1.21+)
smallest := min(a, b)
largest := max(a, b)

// String/rune conversion
runes := []rune(str)    // string to rune slice (handles Unicode)
str := string(runes)    // rune slice back to string
char := str[i]          // byte, not rune --- be careful with Unicode
charStr := string(str[i]) // single byte to string

// Math utilities
abs := int(math.Abs(float64(x))) // no int abs in stdlib
// Or write your own:
func abs(x int) int {
    if x < 0 {
        return -x
    }
    return x
}

// Heap (container/heap)
// Implement heap.Interface with Len, Less, Swap, Push, Pop
// Then: heap.Init(&h), heap.Push(&h, item), heap.Pop(&h)

// Quick map check with comma-ok
if v, ok := m[key]; ok {
    // key exists, v is the value
}

// Bit manipulation
x & (x - 1)  // removes lowest set bit
x & (-x)     // isolates lowest set bit
bits.OnesCount(uint(x)) // count set bits (popcount)
```

### When to Use Channels vs. Mutexes in Interview Answers

This question comes up frequently in Go interviews. The answer demonstrates whether you understand Go's concurrency philosophy.

**Use channels when:**
- You are communicating data between goroutines
- You need to signal completion or cancellation
- You are implementing a pipeline or fan-out/fan-in pattern
- The concurrency pattern involves producer-consumer relationships

**Use mutexes when:**
- You are protecting shared state that multiple goroutines read/write
- The critical section is short (lock, read/write, unlock)
- You need read-heavy access (sync.RWMutex)
- The pattern is simpler with direct locking than with channel orchestration

**What to Say:**
> "Go's proverb is 'Don't communicate by sharing memory. share memory by communicating.' I'd use channels here because we're passing data between stages of a pipeline. But for a simple shared cache with concurrent reads and writes, a sync.RWMutex would be more straightforward."

### Go Idioms That Impress Interviewers

Interviewers fluent in Go notice idiomatic instincts immediately. These are the ones that register:

```go
// 1. Functional options pattern (shows API design knowledge)
type ServerOption func(*Server)

func WithTimeout(d time.Duration) ServerOption {
    return func(s *Server) { s.timeout = d }
}

func NewServer(opts ...ServerOption) *Server {
    s := &Server{timeout: 30 * time.Second} // sensible defaults
    for _, opt := range opts {
        opt(s)
    }
    return s
}

// 2. Table-driven tests (shows testing maturity)
func TestAdd(t *testing.T) {
    tests := []struct {
        name     string
        a, b     int
        expected int
    }{
        {"positive", 2, 3, 5},
        {"negative", -1, -1, -2},
        {"zero", 0, 0, 0},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            if got := Add(tt.a, tt.b); got != tt.expected {
                t.Errorf("Add(%d, %d) = %d, want %d", tt.a, tt.b, got, tt.expected)
            }
        })
    }
}

// 3. Context propagation (shows production awareness)
func (s *Service) HandleRequest(ctx context.Context, req *Request) (*Response, error) {
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    result, err := s.db.QueryContext(ctx, req.Query)
    if err != nil {
        return nil, fmt.Errorf("query failed: %w", err)
    }
    return &Response{Data: result}, nil
}

// 4. Error wrapping with %w (shows Go 1.13+ awareness)
func getUser(userID int) (*User, error) {
    user, err := fetchUserFromDB(userID)
    if err != nil {
        return nil, fmt.Errorf("fetching user %d: %w", userID, err)
    }
    return user, nil
}
// Caller can use errors.Is() and errors.As() to inspect the chain

// 5. Graceful shutdown (shows production readiness)
func main() {
    srv := &http.Server{Addr: ":8080"}

    go func() {
        if err := srv.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatalf("server error: %v", err)
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    if err := srv.Shutdown(ctx); err != nil {
        log.Fatalf("shutdown error: %v", err)
    }
}
```

### Go Anti-Patterns That Concern Interviewers

These will raise red flags:

1. **Ignoring errors with `_`** --- Signals carelessness about reliability
2. **Using `interface{}` / `any` instead of concrete types** --- Suggests lack of type safety awareness
3. **Passing large structs by value instead of pointer** --- Suggests ignorance of memory implications
4. **Not using defer for cleanup** --- Suggests risk of resource leaks
5. **Global mutable state** --- Suggests poor design and testability
6. **Using `init()` functions** --- Often a code smell. Prefer explicit initialization
7. **Channels for everything** --- Shows a misunderstanding of when mutexes are more appropriate
8. **Not closing HTTP response bodies** --- `defer resp.Body.Close()` should be automatic
9. **Panic in library code** --- Return errors. let the caller decide how to handle them
10. **String-typed constants** --- Use custom types with `iota` for type safety


### Junior → FAANG: Go-Specific Coding Interview Performance

When coding in Go during an interview, use idiomatic Go patterns rather than translating from another language: prefer range loops over index-based loops, use make for slice/map initialization with known capacity, use defer for cleanup, and prefer multiple return values for error handling over try/catch patterns. Know the standard library well enough to use it fluently: strings, strconv, sort, container/heap, and sync. Using the standard library correctly signals genuine Go experience.

### Senior @ FAANG: Go Expertise as a Differentiator at the Senior Bar

Senior candidates coding in Go during interviews should demonstrate mastery that goes beyond syntax fluency. Specifically: choose the right concurrency primitive for the problem (channel versus sync.Mutex, sync.WaitGroup versus errgroup), use context.Context correctly in any I/O operation, and write error handling that is idiomatic (wrap errors with context using fmt.Errorf('%w', err), check error types explicitly when the type matters). The Go runtime knowledge signals include: articulating Go 1.22+ per-iteration loop variable scoping (and knowing why pre-1.22 code required explicit shadowing/passing to avoid capture bugs), recognizing when a slice append may or may not allocate a new backing array, and knowing when an interface value is nil versus when a typed pointer inside an interface is nil. These subtleties are the difference between a candidate who has used Go and one who understands Go.

---
