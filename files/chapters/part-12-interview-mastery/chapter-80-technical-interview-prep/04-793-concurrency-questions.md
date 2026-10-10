## 80.3 Concurrency Questions

### Goroutines and Channels

**Q: Explain goroutine scheduling. How many OS threads does a Go program use?**

```go
package main

import (
    "fmt"
    "runtime"
    "sync"
)

func main() {
    // GOMAXPROCS controls P count (logical processors)
    fmt.Println("GOMAXPROCS:", runtime.GOMAXPROCS(0))
    fmt.Println("NumCPU:", runtime.NumCPU())

    // G-M-P Model:
    // G = Goroutine (lightweight, ~2KB stack)
    // M = Machine (OS thread)
    // P = Processor (scheduling context)

    // Number of goroutines
    fmt.Println("NumGoroutine:", runtime.NumGoroutine())

    var wg sync.WaitGroup
    for i := 0; i < 1000; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()
            // Work
        }(i)
    }

    fmt.Println("NumGoroutine:", runtime.NumGoroutine())  // ~1000
    wg.Wait()
}
```

**Scheduler Deep Dive:**

```
┌────────────────────────────────────────────────────────────────┐
│                        Go Scheduler                            │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                       │
│  │  G  │ │  G  │ │  G  │ │  G  │ │  G  │  ← Goroutines         │
│  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘                       │
│     │       │       │       │       │                          │
│     └───────┴───┬───┴───────┴───────┘                          │
│                 ▼                                              │
│         ┌──────────────┐                                       │
│         │ Local Queue  │ ← Per-P run queue                     │
│         └──────┬───────┘                                       │
│                │                                               │
│         ┌──────▼───────┐                                       │
│         │      P       │ ← Processor (max = GOMAXPROCS)        │
│         └──────┬───────┘                                       │
│                │                                               │
│         ┌──────▼───────┐                                       │
│         │      M       │ ← OS Thread (machine)                 │
│         └──────────────┘                                       │
│                                                                │
│  Features:                                                     │
│  • Work stealing between P's local queues                      │
│  • Global run queue for overflow                               │
│  • Preemption at function prologues (Go 1.14+: async)          │
│  • Netpoller for efficient I/O                                 │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Interview Points:**
1. Default GOMAXPROCS = NumCPU()
2. Goroutines are ~2KB stack, grow as needed (up to 1GB)
3. M:N scheduling - many goroutines to fewer OS threads
4. Work stealing balances load across Ps
5. Cooperative preemption (Go 1.14+ has async preemption)

---

**Q: What causes goroutine leaks and how do you prevent them?**

```go
package main

import (
    "context"
    "fmt"
    "time"
)

// LEAK: Blocked goroutine with no receiver
func leak1() {
    ch := make(chan int)
    go func() {
        ch <- 42  // Blocked forever if no receiver
    }()
    // No one reads from ch - goroutine leaks
}

// FIX: Use buffered channel or ensure receiver
func fix1() {
    ch := make(chan int, 1)  // Buffered
    go func() {
        ch <- 42
    }()
    // Even without receiver, goroutine completes
}

// LEAK: Blocked on channel in select without timeout
func leak2(results chan int) {
    go func() {
        val := <-results  // If results is never sent to...
        fmt.Println(val)
    }()
}

// FIX: Use context for cancellation
func fix2(ctx context.Context, results chan int) {
    go func() {
        select {
        case val := <-results:
            fmt.Println(val)
        case <-ctx.Done():
            return  // Clean exit
        }
    }()
}

// LEAK: Infinite loop without exit condition
func leak3() {
    go func() {
        for {
            // Work without checking for stop signal
            time.Sleep(time.Second)
        }
    }()
}

// FIX: Use done channel or context
func fix3(ctx context.Context) {
    go func() {
        for {
            select {
            case <-ctx.Done():
                return
            default:
                // Work
                time.Sleep(time.Second)
            }
        }
    }()
}

// Goroutine leak detector in tests
func TestNoLeaks(t *testing.T) {
    before := runtime.NumGoroutine()

    // Run test code...

    // Give goroutines time to exit
    time.Sleep(100 * time.Millisecond)

    after := runtime.NumGoroutine()
    if after > before {
        t.Errorf("Goroutine leak: before=%d, after=%d", before, after)
    }
}
```

**Prevention Patterns:**
1. Always use context for cancellation
2. Buffered channels when sender shouldn't block
3. Select with timeout or done channel
4. Use `goleak` package in tests

---

**Q: Explain channel operations - when do they block? When do they panic?**

```go
package main

import "fmt"

func main() {
    // Blocking operations
    demonstrateBlocking()

    // Panic operations
    demonstratePanics()
}

func demonstrateBlocking() {
    _ = make(chan int)       // Unbuffered
    buffered := make(chan int, 2)

    // Send to unbuffered blocks until receiver ready
    // Receive from unbuffered blocks until sender ready

    // Send to full buffered blocks
    buffered <- 1
    buffered <- 2
    // buffered <- 3  // Would block - buffer full

    // Receive from empty blocks
    // <-make(chan int)  // Would block forever
}

func demonstratePanics() {
    panicCh := make(chan int)

    // PANIC: Send on closed channel
    close(panicCh)
    // panicCh <- 1  // panic: send on closed channel

    // OK: Receive from closed channel returns zero value
    v, ok := <-panicCh
    fmt.Printf("value=%d, ok=%v\n", v, ok)  // 0, false

    // PANIC: Close already closed channel
    // close(ch)  // panic: close of closed channel

    // PANIC: Close nil channel
    var nilCh chan int
    _ = nilCh  // nil channel - used in comments below
    // close(nilCh)  // panic: close of nil channel

    // BLOCK FOREVER: Send/receive on nil channel
    // nilCh <- 1   // blocks forever
    // <-nilCh      // blocks forever
}

// Channel behavior summary
func channelBehaviorTable() {
    /*
    ┌────────────────┬─────────────┬─────────────┬─────────────┐
    │ Operation      │ Nil Channel │ Closed Chan │ Open Chan   │
    ├────────────────┼─────────────┼─────────────┼─────────────┤
    │ Send (<-)      │ Block       │ PANIC       │ Block/Send  │
    │ Receive (<-)   │ Block       │ Zero, false │ Block/Recv  │
    │ Close          │ PANIC       │ PANIC       │ Closes      │
    │ Len            │ 0           │ # buffered  │ # buffered  │
    │ Cap            │ 0           │ buffer size │ buffer size │
    └────────────────┴─────────────┴─────────────┴─────────────┘
    */
}
```

---

### Synchronization Primitives

**Q: When would you use sync.Mutex vs sync.RWMutex vs channels?**

```go
package main

import (
    "sync"
)

// sync.Mutex: Simple exclusive access
type Counter struct {
    mu    sync.Mutex
    count int
}

func (c *Counter) Increment() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++
}

// sync.RWMutex: Many readers OR one writer
type Cache struct {
    mu   sync.RWMutex
    data map[string]string
}

func (c *Cache) Get(key string) (string, bool) {
    c.mu.RLock()  // Multiple readers allowed
    defer c.mu.RUnlock()
    v, ok := c.data[key]
    return v, ok
}

func (c *Cache) Set(key, value string) {
    c.mu.Lock()  // Exclusive access
    defer c.mu.Unlock()
    c.data[key] = value
}

// Channels: Communication and coordination
func worker(jobs <-chan int, results chan<- int) {
    for job := range jobs {
        results <- job * 2
    }
}

// Decision framework
/*
Use sync.Mutex when:
- Simple state protection
- Lock held for short duration
- No readers/writers distinction

Use sync.RWMutex when:
- Many more reads than writes (>10x)
- Read operations don't modify state
- Contention would hurt performance

Use channels when:
- Transferring ownership of data
- Coordinating between goroutines
- Building pipelines
- One-time events (done channels)

Quote: "Share memory by communicating, don't communicate by sharing memory"
But: For simple counters and caches, mutexes are often clearer and faster
*/
```

---

**Q: What is sync.Once and when would you use it?**

```go
package main

import (
    "fmt"
    "sync"
)

// Classic singleton pattern with sync.Once
type Database struct {
    connection string
}

var (
    dbInstance *Database
    dbOnce     sync.Once
)

func GetDatabase() *Database {
    dbOnce.Do(func() {
        fmt.Println("Initializing database...")
        dbInstance = &Database{connection: "postgres://..."}
    })
    return dbInstance
}

// Lazy initialization of expensive resources
type ExpensiveResource struct {
    once     sync.Once
    computed []int
}

func (r *ExpensiveResource) GetData() []int {
    r.once.Do(func() {
        fmt.Println("Computing expensive data...")
        r.computed = make([]int, 1000000)
        for i := range r.computed {
            r.computed[i] = i * i
        }
    })
    return r.computed
}

// sync.Once is goroutine-safe
func main() {
    var wg sync.WaitGroup

    for i := 0; i < 100; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            db := GetDatabase()  // Only first call initializes
            _ = db
        }()
    }
    wg.Wait()
    // "Initializing database..." prints exactly once
}

// Common mistake: sync.Once per instance, not per call
type BadService struct {
    // WRONG: once is per-call, not per-instance
}

func (s *BadService) BadInit() {
    var once sync.Once  // Created every call!
    once.Do(func() {
        // This runs EVERY time BadInit is called
    })
}

type GoodService struct {
    once sync.Once  // Per-instance
}

func (s *GoodService) GoodInit() {
    s.once.Do(func() {
        // This runs once per GoodService instance
    })
}
```

---

### Junior → FAANG: Concurrency as a First-Class Interview Skill

Concurrency questions separate Go candidates more than almost any other category. The common junior trap is treating goroutines as "threads" and channels as "queues" without understanding the scheduler implications. Before your first FAANG screen, be able to answer these four questions cold: what happens when you send on a closed channel, what is the difference between a buffered and unbuffered channel in terms of blocking semantics, how does `sync.WaitGroup` prevent goroutine leaks, and what is the data race detector and how do you run it.

Practice writing concurrent Go from a blank file without IDE autocomplete. Typing `go func() { defer wg.Done(); ... }()` from memory, including the `defer` placement, is the kind of muscle memory that prevents panic moments during screenshares.

Entry-point interview framing: when asked to implement something concurrent, start by asking whether the problem requires concurrency at all. This question alone signals maturity. Then state your synchronization strategy before writing a line: "I will use a mutex to protect the shared map and a WaitGroup to join the goroutines."

### Senior @ FAANG: Concurrency as a Production Systems Lens

At the senior level, concurrency interview questions are proxies for production system design judgment. The interviewer is not testing whether you know the channel semantics. They are testing whether your concurrency instincts translate to correct, observable, debuggable systems at scale.

The L5/L6 concurrency bar: be able to design a bounded worker pool from scratch, explain why the pool needs a context for cancellation, describe how you would detect goroutine leaks in production using pprof's goroutine profile, and identify the correct `sync` primitive for each access pattern (RWMutex for read-heavy shared state, atomic for single-value counters, channel for ownership transfer).

Advanced signal: knowledge of Go's memory model. The Go memory model defines the happens-before relationship between goroutine operations. A staff-level candidate can explain why `sync.Once` provides the correct synchronization guarantee for a singleton initializer, and why a plain boolean flag with no synchronization is incorrect even if it "works in practice" on current amd64 hardware. This reasoning demonstrates that you think about program correctness in terms of formal guarantees, not empirical behavior.

Maturity model for concurrency design at FAANG: L5 candidates design correct concurrent systems. L6 candidates design correct systems that are also debuggable (structured logging with goroutine IDs, pprof-ready, context propagation through the entire call tree). L7/Staff candidates define the concurrency patterns adopted by their organization, review others' designs for correctness, and contribute to internal guidelines that prevent entire classes of bugs at scale.
