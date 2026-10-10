## Question 14: Race Conditions and Data Races

**Level**: Senior

**Question**: What's the difference between a race condition and a data race? Identify the bugs in this code.

```go
type Counter struct {
    value int
}

func (c *Counter) Increment() {
    c.value++
}

func (c *Counter) Value() int {
    return c.value
}

func main() {
    counter := &Counter{}

    for i := 0; i < 1000; i++ {
        go counter.Increment()
    }

    time.Sleep(time.Second)
    fmt.Println("Final value:", counter.Value())
}
```

**Answer**:

The code has a **data race**. Final value will be less than 1000 (e.g., 947, 891, etc.) and different each run.

**Explanation**:

**Data Race**: When two goroutines access the same variable concurrently, and at least one access is a write, with no synchronization.

**Race Condition**: When the program's correctness depends on the timing or interleaving of goroutines.

- **All data races are bugs**
- **Not all race conditions are data races**

**Why `value++` is Not Atomic**:

```go
c.value++

// Expands to three operations:
// 1. Read:    tmp = c.value
// 2. Add:     tmp = tmp + 1
// 3. Write:   c.value = tmp

// Goroutine 1:       Goroutine 2:
// Read value (0)
//                    Read value (0)
// Add 1 (tmp=1)
//                    Add 1 (tmp=1)
// Write 1
//                    Write 1
// Final value: 1 (expected 2!)
```

**Fix 1 - Mutex**:

```go
type Counter struct {
    mu    sync.Mutex
    value int
}

func (c *Counter) Increment() {
    c.mu.Lock()
    c.value++
    c.mu.Unlock()
}

func (c *Counter) Value() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.value
}
```

**Fix 2 - Atomic Operations**:

```go
type Counter struct {
    value int64  // Must be int32 or int64 for atomic
}

func (c *Counter) Increment() {
    atomic.AddInt64(&c.value, 1)
}

func (c *Counter) Value() int64 {
    return atomic.LoadInt64(&c.value)
}
```

**Detecting Data Races**:

```bash
# Run with race detector
go run -race main.go
go test -race ./...
go build -race

# Output:
# ==================
# WARNING: DATA RACE
# Write at 0x00c0000b6008 by goroutine 7:
#   main.(*Counter).Increment()
#       /app/main.go:8 +0x4e
#
# Previous write at 0x00c0000b6008 by goroutine 6:
#   main.(*Counter).Increment()
#       /app/main.go:8 +0x4e
# ==================
```

**Race Condition Without Data Race**:

```go
// This has no data race but has a race condition
func processOrders() {
    var orders []Order
    var mu sync.Mutex

    // Producer
    go func() {
        for i := 0; i < 10; i++ {
            mu.Lock()
            orders = append(orders, Order{ID: i})
            mu.Unlock()
        }
    }()

    // Consumer
    go func() {
        for {
            mu.Lock()
            if len(orders) > 0 {
                order := orders[0]
                orders = orders[1:]
                mu.Unlock()

                // Process order (race condition on processing order!)
                process(order)
            } else {
                mu.Unlock()
            }
        }
    }()
}
// No data race (mutex protects slice)
// But race condition: which order gets processed first?
```

**Common Data Race Patterns**:

**Pattern 1: Shared Variable**:

```go
// ✗ DATA RACE
var count int

func increment() {
    go func() {
        count++  // Race!
    }()
}

// ✓ FIX: Use mutex or atomic
var count int64

func increment() {
    go func() {
        atomic.AddInt64(&count, 1)
    }()
}
```

**Pattern 2: Closure Loop Variable**:

```go
// ✗ DATA RACE (before Go 1.22)
for i := 0; i < 10; i++ {
    go func() {
        fmt.Println(i)  // Race on 'i'
    }()
}

// ✓ FIX: Pass as argument
for i := 0; i < 10; i++ {
    go func(n int) {
        fmt.Println(n)
    }(i)
}

// ✓ FIX: Shadow variable (before Go 1.22)
for i := 0; i < 10; i++ {
    i := i  // Create new variable
    go func() {
        fmt.Println(i)
    }()
}

// ✓ Go 1.22+: Loop variable is per-iteration
for i := 0; i < 10; i++ {
    go func() {
        fmt.Println(i)  // Safe in Go 1.22+
    }()
}
```

**Pattern 3: Map Access**:

```go
// ✗ DATA RACE
var cache = make(map[string]string)

func get(key string) string {
    return cache[key]  // Race!
}

func set(key, value string) {
    cache[key] = value  // Race!
}

// ✓ FIX 1: Use sync.Map
var cache sync.Map

func get(key string) string {
    v, _ := cache.Load(key)
    if v == nil {
        return ""
    }
    return v.(string)
}

func set(key, value string) {
    cache.Store(key, value)
}

// ✓ FIX 2: Use mutex
var (
    cache = make(map[string]string)
    mu    sync.RWMutex
)

func get(key string) string {
    mu.RLock()
    defer mu.RUnlock()
    return cache[key]
}

func set(key, value string) {
    mu.Lock()
    defer mu.Unlock()
    cache[key] = value
}
```

**Pattern 4: Slice Append**:

```go
// ✗ DATA RACE
var items []int

func addItem(item int) {
    items = append(items, item)  // Race!
}

// ✓ FIX: Use mutex
var (
    items []int
    mu    sync.Mutex
)

func addItem(item int) {
    mu.Lock()
    defer mu.Unlock()
    items = append(items, item)
}

// ✓ ALTERNATIVE: Use channel
func collector() {
    items := make(chan int, 100)

    go func() {
        var collected []int
        for item := range items {
            collected = append(collected, item)
        }
    }()

    return items
}
```

**Happens-Before Relationships**:

```go
var a string
var done = make(chan bool)

func setup() {
    a = "hello, world"
    done <- true
}

func main() {
    go setup()
    <-done
    fmt.Println(a)  // Guaranteed to print "hello, world"
}

// The send on done happens-before the receive
// The write to 'a' happens-before the send
// Therefore, write to 'a' happens-before read of 'a'
```

**False Sharing** (performance race):

```go
// ✗ FALSE SHARING: Both fields on same cache line
type Counter struct {
    a int64
    b int64
}

var c Counter

func incrementA() {
    for {
        atomic.AddInt64(&c.a, 1)
    }
}

func incrementB() {
    for {
        atomic.AddInt64(&c.b, 1)
    }
}

// ✓ FIX: Add padding
type Counter struct {
    a int64
    _ [56]byte  // Padding to separate cache lines
    b int64
}
```

**Companies that asked this**: Google, Meta, Uber, Netflix, Amazon

---

*[Due to length constraints, I'll continue with selected key questions from remaining sections...]*

---

## Memory and Performance
