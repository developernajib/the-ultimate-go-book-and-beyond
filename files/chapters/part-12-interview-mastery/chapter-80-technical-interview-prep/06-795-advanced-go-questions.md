## 80.5 Advanced Go Questions

### Context Package

**Q: Explain the context package. When and how should it be used?**

```go
package main

import (
    "context"
    "errors"
    "net/http"
    "time"
)

// Context carries deadlines, cancellation signals, and request-scoped values
func main() {
    // 1. Background - root context, never canceled
    ctx := context.Background()

    // 2. TODO - placeholder when context is unclear
    ctx = context.TODO()

    // 3. WithCancel - manual cancellation
    ctx, cancel := context.WithCancel(context.Background())
    go func() {
        time.Sleep(time.Second)
        cancel()  // Signal cancellation
    }()

    // 4. WithTimeout - auto-cancel after duration
    ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()  // Always call cancel to release resources

    // 5. WithDeadline - auto-cancel at specific time
    deadline := time.Now().Add(time.Hour)
    ctx, cancel = context.WithDeadline(context.Background(), deadline)
    defer cancel()

    // 6. WithValue - request-scoped values
    ctx = context.WithValue(ctx, "requestID", "12345")
    _ = ctx // used to demonstrate context chaining
}

// Stub functions to demonstrate context propagation
func fetchData(ctx context.Context, data []byte) ([]string, error) {
    // In real code, this would make an API/DB call using ctx
    return []string{"item1", "item2"}, nil
}

func processItem(item string) {
    // Process a single item
}

func queryDatabase(ctx context.Context, userID string) ([]byte, error) {
    // In real code, this would query a database using ctx
    return nil, nil
}

// Proper context usage in functions
func ProcessRequest(ctx context.Context, data []byte) error {
    // Check cancellation before expensive work
    if ctx.Err() != nil {
        return ctx.Err()
    }

    // Pass context to child operations
    result, err := fetchData(ctx, data)
    if err != nil {
        return err
    }

    // Check cancellation periodically in loops
    for i := range result {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            processItem(result[i])
        }
    }

    return nil
}

// Context in HTTP handlers
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()  // Request context (canceled when client disconnects)

    // Extract request-scoped values
    userID := ctx.Value("userID").(string)

    // Use context for downstream calls
    data, err := queryDatabase(ctx, userID)
    if errors.Is(err, context.Canceled) {
        // Client disconnected
        return
    }
    if errors.Is(err, context.DeadlineExceeded) {
        http.Error(w, "timeout", http.StatusGatewayTimeout)
        return
    }
    _ = data // Use the fetched data in real handlers
}

// Context best practices
/*
1. Context should be first parameter: func DoWork(ctx context.Context, ...)
2. Never store context in structs
3. Don't use context.Value for function parameters
4. Always call cancel(), even if context times out
5. Context values should be immutable and thread-safe
6. Use type-safe keys for context values
*/

// Type-safe context key (avoid string collisions)
type contextKey string

const requestIDKey contextKey = "requestID"

func WithRequestID(ctx context.Context, id string) context.Context {
    return context.WithValue(ctx, requestIDKey, id)
}

func GetRequestID(ctx context.Context) string {
    id, _ := ctx.Value(requestIDKey).(string)
    return id
}
```

---

### Generics (Go 1.18+)

**Q: Explain Go generics. What are the constraints and best practices?**

```go
package main

import (
    "cmp"
    "fmt"
    "maps"
    "slices"
)

// Basic generic function
func Min[T cmp.Ordered](a, b T) T {
    if a < b {
        return a
    }
    return b
}

// Generic type
type Stack[T any] struct {
    items []T
}

func (s *Stack[T]) Push(item T) {
    s.items = append(s.items, item)
}

func (s *Stack[T]) Pop() (T, bool) {
    if len(s.items) == 0 {
        var zero T
        return zero, false
    }
    item := s.items[len(s.items)-1]
    s.items = s.items[:len(s.items)-1]
    return item, true
}

// Custom constraints
type Number interface {
    ~int | ~int64 | ~float64
}

func Sum[T Number](nums []T) T {
    var total T
    for _, n := range nums {
        total += n
    }
    return total
}

// Type sets with ~ (underlying type)
type MyInt int

func main() {
    // Works with MyInt because of ~int
    nums := []MyInt{1, 2, 3}
    fmt.Println(Sum(nums))  // 6
}

// Constraint with methods
type Stringer interface {
    String() string
}

func Print[T Stringer](items []T) {
    for _, item := range items {
        fmt.Println(item.String())
    }
}

// When NOT to use generics
/*
1. When any/any is sufficient and simpler
2. When only one type is ever used
3. When it makes code harder to read
4. For methods that need different behavior per type

Rule of thumb: "Don't use generics until you feel the repetition pain"
*/

// Good use cases for generics
/*
1. Container types (Stack, Queue, Tree)
2. Utility functions (Min, Max, Map, Filter)
3. Type-safe results/options (Result[T], Option[T])
*/

// Standard library generics (Go 1.21+)
func stdLibGenerics() {
    nums := []int{3, 1, 4, 1, 5, 9}

    slices.Sort(nums)                    // In-place sort
    slices.Reverse(nums)                 // In-place reverse
    min := slices.Min(nums)              // Find minimum
    idx, found := slices.BinarySearch(nums, 4)  // Binary search
    fmt.Println(min, idx, found)

    // maps package (Go 1.21+ / iterators in Go 1.23+)
    m := map[string]int{"a": 1, "b": 2}
    keys := slices.Collect(maps.Keys(m))
    values := slices.Collect(maps.Values(m))
    fmt.Println(keys, values)
}
```

---

### Junior → FAANG: Approaching Advanced Questions Without Panic

Advanced Go questions covering context, generics, and the `maps`/`slices` packages feel intimidating, but they follow recognizable patterns. For context: the rule is always "accept context as the first parameter, check `ctx.Done()` in any loop or blocking call, and never store context in a struct." If you remember only this rule, you can handle 90% of context questions in a phone screen.

For generics (introduced in Go 1.18): the entry-level bar is understanding type parameters and constraints well enough to write a simple generic function. Being able to explain `comparable` as a constraint required for map keys and set membership checks is sufficient for most L4/L5 screens.

Prerequisite gap: many candidates skip the `golang.org/x/exp` package and the built-in `maps` and `slices` packages added in Go 1.21. These are now tested in interviews because they reflect idiomatic modern Go. Know the three most common functions from each package.

### Senior @ FAANG: Advanced Packages as Architecture Signal

At L5 and above, advanced Go questions probe whether you make correct architectural choices, not just whether you know API signatures. The `context` package, for example, is not just a timeout mechanism. It is the primary dependency injection vector for request-scoped values in Go services. A senior candidate explains this structural role, not just the Cancel function.

For generics at senior level: the question is not "can you write a generic function" but "when do you reach for generics versus interfaces?" The answer requires nuance: generics for functions where the implementation is identical across types and you need compile-time type safety, interfaces when you need runtime dispatch and extensibility. Being able to give a concrete production example of each, and explain the trade-off you made, is the L6 bar.

Governance and platform thinking: the `maps.Clone`, `slices.Sort`, and related functions in Go 1.21 standardize patterns that previously required copy-paste across codebases. A staff engineer recognizes the organizational implication: standardized helpers reduce bug surface, improve code reviews (reviewers can recognize the pattern instead of auditing the implementation), and reduce the maintenance burden on internal utility packages. Articulating this kind of platform value from a language feature is an L7-level observation.
