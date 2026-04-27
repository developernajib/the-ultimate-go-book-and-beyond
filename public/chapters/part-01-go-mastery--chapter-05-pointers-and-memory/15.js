export default `## Production Pointer Pitfalls and Memory Management Wisdom

Production Go services surface pointer and memory bugs that unit tests rarely catch. This section catalogs the most frequent failure patterns, explains the root cause of each, and shows the defensive coding style that prevents them.

### The Nil Pointer Panic: Go's Most Common Runtime Error

Nil pointer dereferences are the most common cause of Go panics in production. The following patterns appear repeatedly in post-mortem reports:

\`\`\`go
// COMMON CRASH #1: Forgetting to check error before using result
func getUserBad(id string) {
    user, err := db.FindUser(id)
    fmt.Println(user.Name)  // PANIC if err != nil and user is nil!
    if err != nil {
        log.Error(err)
    }
}

// CORRECT: Always check error first
func getUserGood(id string) {
    user, err := db.FindUser(id)
    if err != nil {
        log.Error(err)
        return
    }
    fmt.Println(user.Name)  // Safe - we know user isn't nil
}

// COMMON CRASH #2: Nil receiver method call
type Config struct {
    Timeout time.Duration
}

func (c *Config) TimeoutOrDefault() time.Duration {
    if c == nil {
        return 30 * time.Second  // Handle nil receiver gracefully
    }
    if c.Timeout == 0 {
        return 30 * time.Second
    }
    return c.Timeout
}

// This pattern allows:
var cfg *Config  // nil
timeout := cfg.TimeoutOrDefault()  // Returns 30s, no panic!

// COMMON CRASH #3: Nil map access
func countWordsBad(words []string) map[string]int {
    var counts map[string]int  // nil map
    for _, w := range words {
        counts[w]++  // PANIC: assignment to entry in nil map
    }
    return counts
}

// CORRECT: Initialize the map
func countWordsGood(words []string) map[string]int {
    counts := make(map[string]int)  // Initialized
    for _, w := range words {
        counts[w]++  // Safe
    }
    return counts
}

// DEFENSIVE PATTERN: Factory functions that guarantee initialization
type Service struct {
    cache    map[string]Item
    clients  []*Client
    settings *Settings
}

// WRONG: Returns partially initialized struct
func NewServiceBad() *Service {
    return &Service{}  // cache is nil, settings is nil
}

// CORRECT: Initialize all fields
func NewService() *Service {
    return &Service{
        cache:    make(map[string]Item),
        clients:  make([]*Client, 0),
        settings: &Settings{Timeout: 30 * time.Second},
    }
}
\`\`\`

### Escape Analysis Surprises: When Stack Becomes Heap

Several common Go patterns cause heap allocations that developers do not expect. Running \`go build -gcflags="-m"\` on hot code paths often reveals surprises:

\`\`\`go
// SURPRISE #1: Interface conversion causes escape
func processIntBad(n int) {
    // The interface conversion causes n to escape to heap!
    fmt.Println(n)  // fmt.Println takes any
}

// This allocates because:
// 1. fmt.Println signature: func Println(a ...any)
// 2. int must be boxed into any (requires heap allocation)

// MITIGATION: For hot paths, avoid any conversions
func processIntFast(n int) {
    // Direct formatting avoids some allocations
    fmt.Printf("%d\\n", n)  // Still allocates, but less
}

// BEST: Use strconv for zero allocations
func processIntZeroAlloc(w io.Writer, n int) {
    var buf [20]byte  // Stack allocated
    b := strconv.AppendInt(buf[:0], int64(n), 10)
    w.Write(b)
}

// SURPRISE #2: Returning a pointer to local variable
func createUserBad() *User {
    user := User{Name: "Alice"}  // Would be stack allocated...
    return &user  // ...but escapes to heap because pointer is returned
}

// go build -gcflags='-m' shows:
// ./main.go:XX: moved to heap: user

// SURPRISE #3: Closures capture by reference, causing escape
func processItemsBad(items []Item) []func() {
    var funcs []func()
    for _, item := range items {
        funcs = append(funcs, func() {
            fmt.Println(item.Name)  // Captures loop variable
        })
    }
    return funcs  // All closures reference the same item (last one)
}

// CORRECT: Capture by value
func processItemsGood(items []Item) []func() {
    funcs := make([]func(), 0, len(items))
    for _, item := range items {
        item := item  // Create new variable (or use parameter)
        funcs = append(funcs, func() {
            fmt.Println(item.Name)  // Each closure has its own copy
        })
    }
    return funcs
}

// SURPRISE #4: Large stack frames cause escape
func bigStackFrame() {
    // Arrays larger than typical stack limit escape
    var huge [10 * 1024 * 1024]byte  // 10MB - definitely escapes
    _ = huge
}

// MITIGATION: Use slices for large data
func managedMemory() {
    huge := make([]byte, 10*1024*1024)  // Heap, but explicit
    _ = huge
}
\`\`\`

### The sync.Pool Gotchas

\`sync.Pool\` reduces allocation pressure effectively, but three gotchas trip up most teams on first use:

\`\`\`go
// GOTCHA #1: Pool items can be garbage collected at any time
var bufferPool = sync.Pool{
    New: func() any {
        return new(bytes.Buffer)
    },
}

// WRONG: Expecting pool to maintain items
func processManyBad(items []Item) {
    // Items might be GC'd between these calls!
    for _, item := range items {
        buf := bufferPool.Get().(*bytes.Buffer)
        buf.Reset()
        // ... use buffer
        bufferPool.Put(buf)
    }
}

// The pool may be cleared during GC, so:
// - Don't rely on pool for persistent storage
// - Don't store precious objects in pool
// - Pool is for reducing allocation pressure, not caching

// GOTCHA #2: Forgetting to reset pooled objects
type Request struct {
    Headers map[string]string
    Body    []byte
    err     error  // Internal state
}

var requestPool = sync.Pool{
    New: func() any {
        return &Request{Headers: make(map[string]string)}
    },
}

// WRONG: Not resetting before reuse
func handleRequestBad() *Request {
    req := requestPool.Get().(*Request)
    // Previous request's data might leak through!
    return req
}

// CORRECT: Reset all fields
func handleRequestGood() *Request {
    req := requestPool.Get().(*Request)
    // Clear all fields
    for k := range req.Headers {
        delete(req.Headers, k)
    }
    req.Body = req.Body[:0]
    req.err = nil
    return req
}

// BETTER: Implement Reset method
func (r *Request) Reset() {
    for k := range r.Headers {
        delete(r.Headers, k)
    }
    r.Body = r.Body[:0]
    r.err = nil
}

// GOTCHA #3: Type assertions can panic
func unsafePoolUsage() {
    pool := sync.Pool{
        New: func() any {
            return new(bytes.Buffer)
        },
    }

    // Someone puts wrong type
    pool.Put("string")  // This compiles!

    // Later...
    buf := pool.Get().(*bytes.Buffer)  // PANIC: string is not *bytes.Buffer
}

// PRODUCTION PATTERN: Type-safe wrapper
type BufferPool struct {
    pool sync.Pool
}

func NewBufferPool() *BufferPool {
    return &BufferPool{
        pool: sync.Pool{
            New: func() any {
                return new(bytes.Buffer)
            },
        },
    }
}

func (p *BufferPool) Get() *bytes.Buffer {
    return p.pool.Get().(*bytes.Buffer)
}

func (p *BufferPool) Put(buf *bytes.Buffer) {
    buf.Reset()
    p.pool.Put(buf)  // Type-safe - only accepts *bytes.Buffer
}
\`\`\`

### Memory Leaks in Go: Yes, They're Possible

Go's garbage collector frees unreachable objects, but it cannot free objects that are still reachable through references the program forgot to release. The following patterns cause memory to grow without bound:

\`\`\`go
// LEAK #1: Goroutine holding references forever
func leakyGoroutine(data []byte) {
    go func() {
        for {
            select {}  // Blocks forever, holds reference to data
        }
    }()
    // data can never be GC'd while goroutine exists
}

// LEAK #2: Slice header without releasing backing array
func subsetLeaky(data []byte) []byte {
    // Returns small slice but backing array is huge
    return data[:10]  // Original data can't be GC'd
}

// CORRECT: Copy to release backing array
func subsetSafe(data []byte) []byte {
    result := make([]byte, 10)
    copy(result, data[:10])
    return result  // Original data can be GC'd
}

// LEAK #3: String interning gotcha
var internedStrings = make(map[string]string)

func internBad(s string) string {
    // If s is a substring, we're keeping the whole parent string!
    if existing, ok := internedStrings[s]; ok {
        return existing
    }
    internedStrings[s] = s
    return s
}

// CORRECT: Force a copy for interning
func internSafe(s string) string {
    if existing, ok := internedStrings[s]; ok {
        return existing
    }
    // strings.Clone creates a new string with minimal allocation
    copied := strings.Clone(s)
    internedStrings[copied] = copied
    return copied
}

// LEAK #4: Time.After in loops (pre-Go 1.23)
func timeLeakBad(done <-chan struct{}) {
    for {
        select {
        case <-done:
            return
        case <-time.After(1 * time.Second):  // Creates new timer each iteration!
            // Each timer might not be GC'd until it fires
            doWork()
        }
    }
}

// If loop runs 1000 times/second, that's 1000 timer objects accumulating!

// CORRECT: Reuse timer
func timeLeakFixed(done <-chan struct{}) {
    ticker := time.NewTicker(1 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-done:
            return
        case <-ticker.C:  // Reuses same ticker
            doWork()
        }
    }
}

// LEAK #5: Finalizers preventing GC
type Resource struct {
    data []byte
}

func createResourceBad() *Resource {
    r := &Resource{data: make([]byte, 1024*1024)}
    runtime.SetFinalizer(r, func(r *Resource) {
        // Intentionally empty - but finalizer prevents collection
        // until finalizer goroutine runs!
    })
    return r
}

// Finalizers delay GC and can cause memory pressure
// Use explicit Close() methods instead
\`\`\`

### Pointer Arithmetic: When and How (Safely)

Go intentionally omits pointer arithmetic, but the \`unsafe\` package provides escape hatches for performance-critical code that needs direct memory access. These patterns are rare in application code but appear in serialization libraries, network protocol parsers, and runtime internals:

\`\`\`go
import "unsafe"

// LEGITIMATE USE: Efficient struct field access
type Header struct {
    Magic   uint32
    Version uint16
    Flags   uint16
    Length  uint32
}

func parseHeaderFast(data []byte) *Header {
    if len(data) < int(unsafe.Sizeof(Header{})) {
        return nil
    }
    return (*Header)(unsafe.Pointer(&data[0]))
}

// WARNING: This only works if:
// 1. Data is properly aligned
// 2. Byte order matches (use encoding/binary for portability)
// 3. Data outlives the returned pointer

// SAFER ALTERNATIVE: Use encoding/binary
func parseHeaderSafe(data []byte) (*Header, error) {
    if len(data) < 12 {
        return nil, errors.New("data too short")
    }
    h := &Header{
        Magic:   binary.LittleEndian.Uint32(data[0:4]),
        Version: binary.LittleEndian.Uint16(data[4:6]),
        Flags:   binary.LittleEndian.Uint16(data[6:8]),
        Length:  binary.LittleEndian.Uint32(data[8:12]),
    }
    return h, nil
}

// LEGITIMATE USE: Accessing unexported fields (testing only!)
// This is fragile and should only be used in tests
type privateStruct struct {
    public  int
    private int  // unexported
}

func accessPrivate(s *privateStruct) int {
    // Get pointer to struct, add offset to reach private field
    ptr := unsafe.Pointer(s)
    privatePtr := (*int)(unsafe.Add(ptr, unsafe.Offsetof(s.private)))
    return *privatePtr
}

// PRODUCTION PATTERNS for unsafe:
// 1. String ↔ []byte conversion without copy
func stringToBytes(s string) []byte {
    return unsafe.Slice(unsafe.StringData(s), len(s))  // Go 1.20+
}

func bytesToString(b []byte) string {
    return unsafe.String(&b[0], len(b))  // Go 1.20+
}

// WARNING: The []byte must not be modified after this!
// The string might share memory with the byte slice.
\`\`\`

### Quick Reference: Pointer and Memory Checklist

| Scenario | Correct Pattern | Avoid |
|----------|-----------------|-------|
| Return pointer to local | Let escape analysis work | Manual heap allocation |
| Large struct parameter | Pass by pointer | Pass by value (copies) |
| Small struct parameter | Pass by value | Unnecessary pointer |
| Optional value | \`*Type\` (nil = absent) | Zero value ambiguity |
| Pooled objects | Reset before Put | Leaving state |
| Subslice of large slice | Copy needed bytes | Keep backing array |
| Timer in loop | NewTicker + Stop | time.After |
| Interface nil check | \`x == nil\` may not work | Assume nil interface check |
| Map initialization | make(map[K]V) | var m map[K]V |
| Struct with map field | Initialize in constructor | Leave nil |

### Production Wisdom Worth Repeating

For a senior engineer setting team discipline, the table above is a starting point. The non-mechanical wisdom that does not fit in a table:

1. **Memory bugs are silent until they are catastrophic.** A leak that grows by 1MB per hour will not page anyone for weeks. Then the service OOMs at 3 AM and you have no idea why. The discipline is to trend memory usage over time and alert on drift, not just on absolute values.
2. **Allocation-rate metrics are more actionable than memory-usage metrics.** A service whose allocation rate doubles between deploys is leaking, even if the GC keeps the heap stable. Wire \`runtime.MemStats.TotalAlloc\` (via the \`runtime\` package) into your metrics and alert on changes.
3. **The fix for a memory bug is rarely "force more GC".** Manual \`runtime.GC()\` calls disrupt the pacer. The fix is to not allocate the memory in the first place, or to release it sooner.
4. **\`unsafe\` is a sharp tool with narrow uses.** Reach for it for byte-to-string conversion in zero-copy paths, for reading C-format binary data, and for lock-free data structures that the standard library does not provide. Do not reach for it because "it would be faster". The compiler's optimisations are usually better than what you would write with unsafe.
5. **Profiling beats reasoning.** The performance hot spot is almost never where you think it is. Run pprof, look at the actual data, then optimise. Programmers who optimise based on intuition spend half their time on the wrong thing.

The team that internalises these is the team that does not have memory-related production incidents. The team that does not internalises them in the post-mortem after the incident.

---
`;
