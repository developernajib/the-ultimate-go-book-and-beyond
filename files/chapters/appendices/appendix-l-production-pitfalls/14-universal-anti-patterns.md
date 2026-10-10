## Universal Anti-Patterns

Some anti-patterns appear so frequently across Go codebases that they account for the vast majority of architectural debt, performance degradation, and operational outages. Understanding these anti-patterns and applying proven idiomatic fixes is the hallmark of a senior Go systems engineer.

---

### 1. Interface Pollution (Producer-Side Interfaces)

#### The Anti-Pattern
Engineers transitioning from Java or C# often reflexively create an interface for every single struct they write, placing the interface in the same package as the implementation (producer-side):
```go
// ANTI-PATTERN: Producer package defining its own interface
package user

type UserRepository interface {
    FindByID(id string) (*User, error)
}

type sqlUserRepository struct { ... } // Only one implementation ever exists!
```
This creates redundant boilerplate, prevents IDE navigation, and violates the Go philosophy: **"Accept interfaces, return structs."**

#### The Idiomatic Fix
In Go, interfaces are intended for the **consumer**:
- The producer package exports the concrete struct (`*UserRepo`).
- The consuming package (e.g., `orderservice`) defines its own minimal interface containing *only the specific methods it actually needs*.

```go
// IDIOMATIC: Consumer package defines what it needs
package orderservice

type UserFinder interface {
    FindByID(id string) (*User, error)
}

type OrderService struct {
    users UserFinder // Accepts ANY type that satisfies FindByID
}
```

---

### 2. Naked Goroutine Spawning (The "Fire-and-Forget" Anti-Pattern)

#### The Anti-Pattern
Spawning goroutines with zero lifecycle ownership or panic shielding:
```go
// ANTI-PATTERN: Naked goroutine
func HandleEvent(evt Event) {
    go processEvent(evt) // If this panics, the ENTIRE process crashes!
}
```
- If `processEvent` panics, the unhandled panic terminates the entire Go process and drops all active user traffic.
- If the service receives a SIGTERM graceful shutdown signal, this goroutine is abruptly killed mid-transaction, causing data corruption.

#### The Idiomatic Fix
Every goroutine must have:
1. Panic recovery boundary.
2. Context propagation for cancellation.
3. WaitGroup or worker pool registration for graceful draining.

```go
func SafeGo(wg *sync.WaitGroup, fn func()) {
    wg.Add(1)
    go func() {
        defer wg.Done()
        defer func() {
            if r := recover(); r != nil {
                slog.Error("recovered from goroutine panic", "panic", r, "stack", string(debug.Stack()))
            }
        }()
        fn()
    }()
}
```

---

### 3. Premature Use of sync.Map

#### The Anti-Pattern
Developers frequently reach for `sync.Map` assuming it is a "faster, thread-safe hash map":
```go
// ANTI-PATTERN: Using sync.Map for standard read/write workloads
var cache sync.Map
cache.Store("key", value)
val, _ := cache.Load("key")
```
`sync.Map` uses internal `any` boxing, causing every read and write to allocate heap memory and require runtime type assertions.

#### When to Use What
- **Standard Workloads (99% of cases)**: Use a regular Go `map` protected by a `sync.RWMutex`. It is fully type-safe and 2x–3x faster.
- **sync.Map**: Only beneficial in two specific scenarios:
  1. An entry is written once but read millions of times (append-only cache).
  2. Multiple goroutines read, write, and overwrite keys for disjoint sets of keys.

---

### 4. Error Swallowing & Shadowing

#### The Anti-Pattern
```go
// ANTI-PATTERN: Masking error with variable shadowing
func LoadAccount(id string) (*Account, error) {
    acc, err := fetchFromCache(id)
    if err == nil {
        return acc, nil
    }

    // Shadowing err using := hides previous error
    acc, err := fetchFromDB(id) 
    if err != nil {
        return nil, err // Returns DB error, completely erasing cache error context!
    }
    return acc, nil
}
```

#### The Idiomatic Fix
Explicitly distinguish error channels and use structured error wrapping (`fmt.Errorf("%w")` or `errors.Join`).

---
