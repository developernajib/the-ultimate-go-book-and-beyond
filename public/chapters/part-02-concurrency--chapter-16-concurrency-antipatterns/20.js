export default `## 16.16 Additional Concurrency Anti-Patterns

### Mistake 6: Goroutines and Loop Variables (#63)

Before Go 1.22, the \`for\` loop reused a single variable across all iterations. Goroutines launched inside the loop captured a reference to that variable, not a copy of its value. By the time the goroutine executed, the loop variable had already advanced, often to its final value, so every goroutine saw the same (wrong) value.

\`\`\`go
package main

import (
    "fmt"
    "sync"
)

// BUG (pre-Go 1.22): All goroutines print the SAME value.
// The loop variable \`i\` is shared across iterations. By the time
// the goroutines start running, the loop has finished and \`i\`
// holds its final value (4 in this case).
func loopVarBugPreGo122() {
    var wg sync.WaitGroup
    for i := 0; i < 5; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            fmt.Println(i) // Captures the SAME variable \`i\`
        }()
    }
    wg.Wait()

    // Pre-Go 1.22 output (non-deterministic, but typically):
    // 5
    // 5
    // 5
    // 5
    // 5
    //
    // Expected output:
    // 0, 1, 2, 3, 4 (in some order)
}

// OLD WORKAROUND 1: Shadow the variable.
// Creating a new variable \`i := i\` inside the loop body gives each
// iteration its own copy. The goroutine's closure captures this copy.
func fixWithShadow() {
    var wg sync.WaitGroup
    for i := 0; i < 5; i++ {
        i := i // Shadow: creates a NEW variable scoped to this iteration
        wg.Add(1)
        go func() {
            defer wg.Done()
            fmt.Println(i) // Captures the shadowed copy
        }()
    }
    wg.Wait()
}

// OLD WORKAROUND 2: Pass as function parameter.
// The value is copied into the function parameter at the time of the call.
func fixWithParameter() {
    var wg sync.WaitGroup
    for i := 0; i < 5; i++ {
        wg.Add(1)
        go func(val int) {
            defer wg.Done()
            fmt.Println(val) // val is a copy, not a reference to i
        }(i) // i is copied here when the goroutine is launched
    }
    wg.Wait()
}

// Go 1.22+ BEHAVIOR: It just works.
// Starting with Go 1.22 (GOEXPERIMENT=loopvar, default in Go 1.23+),
// each iteration of the loop gets its own variable. The closure
// captures a per-iteration copy automatically.
func go122Behavior() {
    var wg sync.WaitGroup
    for i := 0; i < 5; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            fmt.Println(i) // Each goroutine gets its own \`i\` in Go 1.22+
        }()
    }
    wg.Wait()

    // Go 1.22+ output (non-deterministic order, but all values present):
    // 0
    // 3
    // 1
    // 4
    // 2
}

// STILL RELEVANT: Non-range loop contexts where closures capture variables.
// Even in Go 1.22+, be careful when the closure is NOT launched inside
// a for-range or for loop - closures in general still capture by reference.
func stillRelevant() {
    funcs := make([]func(), 5)
    for i := 0; i < 5; i++ {
        funcs[i] = func() {
            fmt.Println(i) // In Go 1.22+, each iteration gets its own i
        }
    }
    // In Go < 1.22, all funcs would print 5.
    // In Go 1.22+, each prints its iteration's value.
    for _, f := range funcs {
        f()
    }
}
\`\`\`

**Key point:** If you are maintaining code that must run on Go < 1.22, always use the shadow trick (\`v := v\`) or pass loop variables as function parameters. In Go 1.22+ the language handles this correctly, but understanding the underlying mechanism helps debug legacy code and reason about closure semantics in general.

### Mistake 7: Forgetting to Close Channels (Goroutine Leak)

A channel that is never closed causes any goroutine that \`range\`s over it to block forever. This is one of the most common sources of goroutine leaks. The rule is simple: **the sender closes the channel, not the receiver.** Closing a channel twice causes a panic.

\`\`\`go
package main

import (
    "fmt"
    "sync"
    "time"
)

// BUG: The producer never closes the channel.
// The consumer's \`range ch\` blocks forever after all values are sent,
// because range only exits when the channel is closed.
func leakyProducerConsumer() {
    ch := make(chan int)

    // Producer - sends values but NEVER closes ch.
    go func() {
        for i := 0; i < 10; i++ {
            ch <- i
        }
        // BUG: Missing close(ch) here!
        // The producer is done, but the consumer doesn't know.
    }()

    // Consumer - ranges over ch, waiting for close that never comes.
    go func() {
        for v := range ch {
            fmt.Println(v)
        }
        fmt.Println("consumer done") // NEVER REACHED - goroutine leaks
    }()

    time.Sleep(time.Second)
    // At this point, the consumer goroutine is leaked - blocked on
    // range ch forever. It will never be garbage collected.
}

// FIX: The producer closes the channel when done.
func fixedProducerConsumer() {
    ch := make(chan int)

    // Producer - closes channel when done sending.
    go func() {
        defer close(ch) // Sender closes - this is the rule
        for i := 0; i < 10; i++ {
            ch <- i
        }
    }()

    // Consumer - range exits cleanly when ch is closed.
    for v := range ch {
        fmt.Println(v)
    }
    fmt.Println("consumer done") // Reached after close
}

// MULTIPLE PRODUCERS: Use sync.WaitGroup to close after all are done.
// Only ONE goroutine should close the channel. When multiple producers
// share a channel, a coordinator goroutine waits for all producers
// to finish and then closes the channel.
func multipleProducers() {
    ch := make(chan int, 10)
    var wg sync.WaitGroup

    // Launch 5 producers.
    for id := 0; id < 5; id++ {
        wg.Add(1)
        go func(producerID int) {
            defer wg.Done()
            for i := 0; i < 3; i++ {
                ch <- producerID*100 + i
            }
        }(id)
    }

    // Coordinator: waits for all producers, then closes the channel.
    go func() {
        wg.Wait()
        close(ch) // Safe - called exactly once, after all producers are done
    }()

    // Consumer: ranges over ch.
    for v := range ch {
        fmt.Println(v)
    }
    fmt.Println("all producers done, consumer exiting")
}

// PANIC: Closing a channel twice.
func doublClosePanic() {
    ch := make(chan int)
    close(ch)
    close(ch) // panic: close of closed channel
}

// FIX: Use sync.Once to ensure a channel is closed exactly once.
type SafeCloser struct {
    ch   chan int
    once sync.Once
}

func (sc *SafeCloser) Close() {
    sc.once.Do(func() {
        close(sc.ch)
    })
}

// Multiple callers can safely call Close() - only the first one takes effect.
func safeCloseExample() {
    sc := &SafeCloser{ch: make(chan int)}

    var wg sync.WaitGroup
    for i := 0; i < 10; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            sc.Close() // Safe - only the first call closes the channel
        }()
    }
    wg.Wait()
}
\`\`\`

### Mistake 8: Using time.After in a Loop (Memory Leak) (#76)

\`time.After\` creates a new \`time.Timer\` each time it is called, and that timer is not garbage collected until it fires. In a hot loop or a \`select\` statement inside a loop, this leaks memory rapidly because timers accumulate faster than they expire.

\`\`\`go
package main

import (
    "fmt"
    "time"
)

// BUG: time.After creates a new timer every iteration.
// In a hot loop processing thousands of messages per second, this
// allocates thousands of timers that won't be GC'd until they fire.
// If the timeout is 30 seconds and you process 10,000 msgs/sec,
// you'll have 300,000 pending timers consuming memory.
func leakySelectLoop(messages <-chan string) {
    for {
        select {
        case msg := <-messages:
            fmt.Println("received:", msg)
        case <-time.After(30 * time.Second): // NEW timer every iteration!
            fmt.Println("timeout - no messages for 30s")
            return
        }
    }
    // Memory profile shows thousands of time.Timer allocations
    // that persist until their 30-second duration elapses.
}

// FIX: Use time.NewTimer with explicit Reset() and Stop().
// A single timer is reused across all iterations - no memory leak.
func fixedSelectLoop(messages <-chan string) {
    timer := time.NewTimer(30 * time.Second)
    defer timer.Stop() // Always stop the timer when done

    for {
        select {
        case msg := <-messages:
            fmt.Println("received:", msg)
            // Reset the timer for the next iteration.
            // Stop() returns false if the timer already fired.
            if !timer.Stop() {
                // Drain the channel if the timer already fired.
                // This prevents a stale value from being received
                // on the next iteration's select.
                select {
                case <-timer.C:
                default:
                }
            }
            timer.Reset(30 * time.Second)
        case <-timer.C:
            fmt.Println("timeout - no messages for 30s")
            return
        }
    }
}

// BENCHMARK: Comparing memory usage.
// The leaky version allocates O(n) timers where n = number of messages
// received before the timeout fires. The fixed version allocates exactly 1.
//
// BenchmarkLeakyLoop-8    1000    1523000 ns/op    480064 B/op    10001 allocs/op
// BenchmarkFixedLoop-8    1000    1201000 ns/op       144 B/op        2 allocs/op

// NOTE (Go 1.23+): Starting with Go 1.23, unreferenced timers are eligible
// for garbage collection even before they fire, which reduces the severity
// of this issue. However, the explicit timer pattern remains best practice
// because:
// 1. It's more efficient - no allocation per iteration.
// 2. It works correctly on all Go versions.
// 3. It makes the reset/stop semantics explicit and reviewable.
\`\`\`

### Mistake 9: Race Conditions with String Formatting (#68)

The \`fmt\` package calls the \`String()\` method on types that implement \`fmt.Stringer\`. If that method reads shared state without synchronization, you have a data race that the race detector will flag, but the race is in the \`String()\` method, not in the \`fmt.Sprintf\` call, making it non-obvious.

This exact bug caused a real-world incident in **etcd** (the distributed key-value store used by Kubernetes), where concurrent access to a struct's \`String()\` method triggered a data race on an internal map field.

\`\`\`go
package main

import (
    "fmt"
    "sync"
)

// BUG: String() reads a map field without synchronization.
// When multiple goroutines call fmt.Sprintf("%s", config) or
// log.Printf("%v", config), the fmt package calls config.String()
// concurrently, which reads the map without a lock.
type Config struct {
    mu       sync.RWMutex // Protects fields below
    settings map[string]string
}

// String implements fmt.Stringer - but it's UNSAFE.
// Maps are not safe for concurrent read when another goroutine might
// be writing. Even concurrent reads of a map are safe, but if ANY
// goroutine calls Set() while another calls String(), this is a race.
func (c *Config) StringUnsafe() string {
    // BUG: No lock acquired! This races with Set().
    result := "Config{"
    for k, v := range c.settings {
        result += fmt.Sprintf("%s=%s, ", k, v)
    }
    return result + "}"
}

func (c *Config) Set(key, value string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.settings[key] = value
}

// RACE: One goroutine calls Set(), another calls fmt.Println(config).
func demonstrateRace() {
    config := &Config{settings: make(map[string]string)}

    var wg sync.WaitGroup

    // Writer goroutine.
    wg.Add(1)
    go func() {
        defer wg.Done()
        for i := 0; i < 1000; i++ {
            config.Set(fmt.Sprintf("key%d", i), fmt.Sprintf("val%d", i))
        }
    }()

    // Reader goroutine - triggers String() via fmt.
    wg.Add(1)
    go func() {
        defer wg.Done()
        for i := 0; i < 1000; i++ {
            _ = fmt.Sprintf("%s", config) // Calls config.String()
            // ^^^ DATA RACE: String() reads map while Set() writes
        }
    }()

    wg.Wait()

    // go test -race output:
    // ==================
    // WARNING: DATA RACE
    // Read at 0x00c0000b4150 by goroutine 7:
    //   runtime.mapiterinit()
    //   main.(*Config).String()
    //       /tmp/main.go:21 +0x84
    //   fmt.(*pp).handleMethods()
    //       ...
    // Previous write at 0x00c0000b4150 by goroutine 6:
    //   runtime.mapassign_faststr()
    //   main.(*Config).Set()
    //       /tmp/main.go:29 +0x84
    // ==================
}

// FIX: Acquire RLock in String() to synchronize with writers.
func (c *Config) String() string {
    c.mu.RLock()
    defer c.mu.RUnlock()

    result := "Config{"
    for k, v := range c.settings {
        result += fmt.Sprintf("%s=%s, ", k, v)
    }
    return result + "}"
}

// FIX 2 (better for hot paths): Snapshot the data under lock,
// then format without holding the lock.
func (c *Config) StringEfficient() string {
    c.mu.RLock()
    // Copy the map entries under the lock.
    entries := make([]struct{ k, v string }, 0, len(c.settings))
    for k, v := range c.settings {
        entries = append(entries, struct{ k, v string }{k, v})
    }
    c.mu.RUnlock()

    // Format outside the lock - no contention with writers.
    result := "Config{"
    for _, e := range entries {
        result += fmt.Sprintf("%s=%s, ", e.k, e.v)
    }
    return result + "}"
}

// LESSON: Any method that the fmt package might call implicitly
// (String(), Error(), Format(), GoString()) must be safe for
// concurrent use if the type is shared across goroutines.
// This applies to:
//   - fmt.Stringer  (String() string)
//   - error         (Error() string)
//   - fmt.Formatter (Format(fmt.State, rune))
//   - fmt.GoStringer (GoString() string)
//   - encoding/json.Marshaler (MarshalJSON() ([]byte, error))
//   - log/slog.LogValuer (LogValue() slog.Value)
\`\`\`

### Staff Lens: Additional Anti-Patterns Worth Internalising

The less-obvious anti-patterns in this section catch senior engineers off guard. Teams that make these part of the review checklist catch them before they reach production. The incidents these patterns cause (panics, deadlocks) are high-severity. The review cost is low. This is a high-ROI discipline to establish.

### Principal Lens: The Long Tail of Anti-Patterns

Beyond the top ten anti-patterns, the long tail of less-common ones still produces incidents. Principal engineers should maintain an internal catalog that grows as the team encounters new patterns. Every postmortem should check: was this a pattern we have seen before? If yes, reference the prior incident and strengthen prevention. If no, add to the catalog. The catalog compounds in value over years.

---
`;
