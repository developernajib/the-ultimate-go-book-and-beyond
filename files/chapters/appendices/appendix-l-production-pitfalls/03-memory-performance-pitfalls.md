## Memory & Performance Pitfalls

Go's garbage collector automates memory reclamation, but it does not prevent memory leaks or catastrophic allocation cliffs. High-performance Go services must manage heap escape behavior, slice backing arrays, and time tickers to maintain deterministic sub-millisecond latencies.

---

### 1. Sub-Slice Backing Array Memory Pinning

#### Root Cause Mechanics
A Go slice is a 24-byte header: a pointer to an underlying array, length, and capacity. When you create a small sub-slice from a massive array (e.g. `data[:10]`), the small slice continues to hold a pointer to the **entire** original backing array. The garbage collector cannot free the original 500MB array because a 10-byte slice references it.

#### Vulnerable Code
```go
// BUG: Pinned 100MB buffer in memory for a 16-byte ID
func ExtractUUID(r io.Reader) []byte {
    hugePayload := make([]byte, 100*1024*1024) // 100MB
    _, _ = io.ReadFull(r, hugePayload)
    return hugePayload[:16] // LEAK: The entire 100MB cannot be garbage collected!
}
```

#### Production-Grade Solution
```go
// FIX: Explicitly copy the required bytes into a newly allocated, bounded slice
func ExtractUUIDSafe(r io.Reader) []byte {
    hugePayload := make([]byte, 100*1024*1024)
    _, _ = io.ReadFull(r, hugePayload)

    uuid := make([]byte, 16)
    copy(uuid, hugePayload[:16]) // Breaks reference to hugePayload
    return uuid                  // hugePayload is now safely freed by the GC
}
```

---

### 2. Leaking `time.Ticker` Goroutines

#### Root Cause Mechanics
`time.Tick()` creates a ticker that never stops. The runtime ticker channel is held in an internal runtime table and will never be collected by the GC. In long-running services or request handlers, calling `time.Tick()` leaks runtime timers until memory is exhausted.

#### Vulnerable Code
```go
// BUG: time.Tick cannot be stopped and leaks forever
func PollHealth(ctx context.Context) {
    for range time.Tick(1 * time.Second) { // LEAK: Ticker never stopped!
        if ctx.Err() != nil {
            return
        }
        check()
    }
}
```

#### Production-Grade Solution
```go
// FIX: Always use time.NewTicker with an explicit defer ticker.Stop()
func PollHealthSafe(ctx context.Context) {
    ticker := time.NewTicker(1 * time.Second)
    defer ticker.Stop() // Guarantees release of runtime timer resources

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            check()
        }
    }
}
```

---

### 3. Unbounded Map Growth and Lack of Shrinking

#### Root Cause Mechanics
Go's built-in `map` is an incremental hash table. When you insert millions of keys, the map allocates buckets. When you delete those keys with `delete(m, k)`, Go marks the entries as empty, but it **never frees or shrinks the allocated bucket memory**. A map that once held 10 million elements will continue to consume gigabytes of memory even after every key is deleted.

#### Production-Grade Solution
```go
// FIX: Periodic map rotation / rebuild pattern
type EphemeralCache struct {
    mu sync.RWMutex
    data map[string]Value
}

func (c *EphemeralCache) Compact() {
    c.mu.Lock()
    defer c.mu.Unlock()

    fresh := make(map[string]Value, len(c.data))
    for k, v := range c.data {
        if !v.Expired() {
            fresh[k] = v
        }
    }
    c.data = fresh // Old bucket array is finally freed by the GC
}
```

---

### 4. Unclosed HTTP Response Bodies & Connection Starvation

#### Root Cause Mechanics
If your code does not read and close an HTTP response body (`resp.Body.Close()`), the underlying TCP socket connection is not returned to the client's connection pool. Over time, the operating system runs out of ephemeral socket ports (`TIME_WAIT` exhaustion), and subsequent HTTP requests hang indefinitely.

#### Production-Grade Solution
```go
resp, err := client.Do(req)
if err != nil {
    return err
}
// ALWAYS drain and close response body
defer func() {
    _, _ = io.Copy(io.Discard, resp.Body)
    _ = resp.Body.Close()
}()
```
