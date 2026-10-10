## 16.15 Exercises with Solutions

### Exercise 1: Fix the Race Condition

**Problem**: The `Cache` type below is used from multiple goroutines simultaneously, but has no synchronization. Identify the race and add the minimum locking needed to make it safe.

```go
type Cache struct {
    data map[string]string
}

func (c *Cache) Get(key string) (string, bool) {
    v, ok := c.data[key]
    return v, ok
}

func (c *Cache) Set(key, value string) {
    c.data[key] = value
}
```

**Solution**:
```go
type Cache struct {
    mu   sync.RWMutex
    data map[string]string
}

func NewCache() *Cache {
    return &Cache{
        data: make(map[string]string),
    }
}

func (c *Cache) Get(key string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    v, ok := c.data[key]
    return v, ok
}

func (c *Cache) Set(key, value string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.data[key] = value
}

// Test to verify fix
func TestCacheConcurrency(t *testing.T) {
    cache := NewCache()
    var wg sync.WaitGroup

    for i := 0; i < 100; i++ {
        wg.Add(2)
        key := fmt.Sprintf("key%d", i)

        go func() {
            defer wg.Done()
            cache.Set(key, "value")
        }()

        go func() {
            defer wg.Done()
            cache.Get(key)
        }()
    }

    wg.Wait()
}
```

### Exercise 2: Implement Goroutine Leak Detection

**Problem**: Write a function that detects goroutine leaks in test code.

This is worth building once to understand the mechanics, and then replacing with `go.uber.org/goleak`. The retry loop below is the essential part, since a fixed `time.Sleep` either flakes on a slow-but-correct goroutine or wastes time on every test. Even with retries, a bare count comparison is fragile: background goroutines from the runtime, `testing`, and idle HTTP transports drift the number on their own. `goleak` handles that by filtering known-benign stacks, which is the part that is tedious to reproduce.

**Solution**:
```go
// leakcheck.go
package leakcheck

import (
    "runtime"
    "testing"
    "time"
)

// Check verifies no goroutines leaked after fn completes
func Check(t *testing.T, fn func()) {
    t.Helper()

    before := runtime.NumGoroutine()

    fn()

    // Give goroutines time to exit
    deadline := time.Now().Add(time.Second * 5)
    var after int

    for time.Now().Before(deadline) {
        after = runtime.NumGoroutine()
        if after <= before {
            return // No leak
        }
        time.Sleep(time.Millisecond * 100)
    }

    // Leak detected
    t.Errorf("goroutine leak: before=%d, after=%d", before, after)

    // Print goroutine stacks for debugging. Grow the buffer rather
    // than truncating: runtime.Stack silently fills what you give it,
    // and the leaky run is exactly the one that will not fit in 1MB.
    size := 1 << 20
    for {
        buf := make([]byte, size)
        n := runtime.Stack(buf, true)
        if n < len(buf) {
            t.Logf("Goroutine stacks:\n%s", buf[:n])
            return
        }
        size *= 2
    }
}

// Usage
func TestNoLeak(t *testing.T) {
    Check(t, func() {
        // Your concurrent code here
        ch := make(chan int, 1)
        go func() {
            ch <- 42
        }()
        <-ch
    })
}
```

### Exercise 3: Fix the Deadlock

**Problem**: This bank transfer code deadlocks when two transfers run concurrently in opposite directions (A to B and B to A). Find the lock ordering violation and fix it. There is a second deadlock hiding in the obvious fix, so keep looking after you find the first one.

```go
type Transfer struct {
    from, to *Account
    amount   int
}

type Account struct {
    mu      sync.Mutex
    balance int
}

func (t *Transfer) Execute() error {
    t.from.mu.Lock()
    defer t.from.mu.Unlock()

    t.to.mu.Lock()
    defer t.to.mu.Unlock()

    if t.from.balance < t.amount {
        return errors.New("insufficient funds")
    }

    t.from.balance -= t.amount
    t.to.balance += t.amount
    return nil
}
```

**Solution**:
```go
type Account struct {
    id      int  // Unique identifier for ordering
    mu      sync.Mutex
    balance int
}

func (t *Transfer) Execute() error {
    // Handle self-transfer BEFORE locking.
    //
    // With from == to, first and second are the same *Account, so the
    // second Lock blocks forever on a mutex this goroutine already
    // holds: sync.Mutex is not reentrant. Lock ordering does not save
    // you here, because there is only one lock. This is reachable
    // whenever a user or a retry names the same account twice.
    if t.from == t.to {
        return nil // Transferring to yourself is a no-op
    }

    // Lock accounts in consistent order (by ID)
    first, second := t.from, t.to
    if t.from.id > t.to.id {
        first, second = t.to, t.from
    }

    first.mu.Lock()
    defer first.mu.Unlock()
    second.mu.Lock()
    defer second.mu.Unlock()

    if t.from.balance < t.amount {
        return errors.New("insufficient funds")
    }

    t.from.balance -= t.amount
    t.to.balance += t.amount
    return nil
}

// Alternative: Use a single lock for all accounts
type Bank struct {
    mu       sync.Mutex
    accounts map[int]*Account
}

func (b *Bank) Transfer(from, to int, amount int) error {
    b.mu.Lock()
    defer b.mu.Unlock()

    fromAcc := b.accounts[from]
    toAcc := b.accounts[to]

    if fromAcc.balance < amount {
        return errors.New("insufficient funds")
    }

    fromAcc.balance -= amount
    toAcc.balance += amount
    return nil
}
```

### Senior at FAANG Track

4. **goleak CI rollout.** For one team, add `goleak.VerifyTestMain` to every package. Fix the leaks it catches. Document the count.

5. **Race-detector CI enforcement.** Audit whether every test suite runs with `-race` in CI. Add it where missing. Measure the catches over a month.

6. **Mutex-profile workflow.** Build the team's playbook for enabling mutex profiling, capturing a profile, identifying hot contention, and proposing fixes. Document and train.

### Staff / Principal Track

7. **Anti-pattern catalog.** Build the org's internal anti-pattern catalog with before/after examples for each pattern. Publish. Maintain quarterly.

8. **Concurrency incident dashboard.** Build a dashboard that tracks concurrency-related incidents over time. Categorise each by anti-pattern type. Use the data to prioritize prevention investments.

9. **Postmortem template for concurrency bugs.** Standardise the postmortem format: which anti-pattern, why it reached production, what prevention would have caught it. Apply to three past incidents. Extract systemic fixes.

10. **Org-wide concurrency training.** Design a concurrency bootcamp for new hires. Include hands-on exercises with the race detector, goleak, and mutex profiling. Deliver quarterly.

11. **Linter rule authoring.** Identify three anti-patterns the team encounters frequently. Author custom `golangci-lint` rules. Wire into CI. Measure false-positive and catch rates.

---
