export default `## 16.15 Exercises with Solutions

### Exercise 1: Fix the Race Condition

**Problem**: The \`Cache\` type below is used from multiple goroutines simultaneously, but has no synchronization. Identify the race and add the minimum locking needed to make it safe.

\`\`\`go
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
\`\`\`

**Solution**:
\`\`\`go
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
\`\`\`

### Exercise 2: Implement Goroutine Leak Detection

**Problem**: Write a function that detects goroutine leaks in test code.

**Solution**:
\`\`\`go
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

    // Print goroutine stacks for debugging
    buf := make([]byte, 1024*1024)
    n := runtime.Stack(buf, true)
    t.Logf("Goroutine stacks:\\n%s", buf[:n])
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
\`\`\`

### Exercise 3: Fix the Deadlock

**Problem**: This bank transfer code deadlocks when two transfers run concurrently in opposite directions (A to B and B to A). Find the lock ordering violation and fix it.

\`\`\`go
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
\`\`\`

**Solution**:
\`\`\`go
type Account struct {
    id      int  // Unique identifier for ordering
    mu      sync.Mutex
    balance int
}

func (t *Transfer) Execute() error {
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
\`\`\`

### Senior at FAANG Track

4. **goleak CI rollout.** For one team, add \`goleak.VerifyTestMain\` to every package. Fix the leaks it catches. Document the count.

5. **Race-detector CI enforcement.** Audit whether every test suite runs with \`-race\` in CI. Add it where missing. Measure the catches over a month.

6. **Mutex-profile workflow.** Build the team's playbook for enabling mutex profiling, capturing a profile, identifying hot contention, and proposing fixes. Document and train.

### Staff / Principal Track

7. **Anti-pattern catalog.** Build the org's internal anti-pattern catalog with before/after examples for each pattern. Publish. Maintain quarterly.

8. **Concurrency incident dashboard.** Build a dashboard that tracks concurrency-related incidents over time. Categorise each by anti-pattern type. Use the data to prioritise prevention investments.

9. **Postmortem template for concurrency bugs.** Standardise the postmortem format: which anti-pattern, why it reached production, what prevention would have caught it. Apply to three past incidents. Extract systemic fixes.

10. **Org-wide concurrency training.** Design a concurrency bootcamp for new hires. Include hands-on exercises with the race detector, goleak, and mutex profiling. Deliver quarterly.

11. **Linter rule authoring.** Identify three anti-patterns the team encounters frequently. Author custom \`golangci-lint\` rules. Wire into CI. Measure false-positive and catch rates.

---
`;
