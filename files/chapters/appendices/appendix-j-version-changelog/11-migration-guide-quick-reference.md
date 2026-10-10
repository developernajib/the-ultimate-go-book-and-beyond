## Migration Guide Quick Reference

### 1.17 → 1.18

```go
// Before: Using interface{} and type assertions
func ProcessItems(items []interface{}) {
    for _, item := range items {
        if str, ok := item.(string); ok {
            fmt.Println(str)
        }
    }
}

// After: Using generics
func ProcessItems[T any](items []T, process func(T)) {
    for _, item := range items {
        process(item)
    }
}
```

### 1.18 → 1.19

```go
// Before: Manual atomic operations
var counter int64
atomic.AddInt64(&counter, 1)

// After: Atomic types (Go 1.19)
var counter atomic.Int64
counter.Add(1)
```

### 1.20 → 1.21

```go
// Before: Manual logging with fmt
fmt.Printf("user=%s action=%s status=%d\n", user, action, status)

// After: Structured logging with slog
slog.Info("user action",
    slog.String("user", user),
    slog.String("action", action),
    slog.Int("status", status),
)
```

### 1.21 → 1.22

```go
// Before: Closure bug workaround
for _, item := range items {
    item := item // Shadow variable
    go func() {
        process(item)
    }()
}

// After: No workaround needed
for _, item := range items {
    go func() {
        process(item) // Works correctly
    }()
}
```

### 1.22 → 1.23

```go
// Before: Manual iteration
type Tree struct {
    Value int
    Left  *Tree
    Right *Tree
}

func (t *Tree) Walk(f func(int)) {
    if t == nil {
        return
    }
    t.Left.Walk(f)
    f(t.Value)
    t.Right.Walk(f)
}

// Usage
tree.Walk(func(v int) {
    fmt.Println(v)
})

// After: Range-over-func
func (t *Tree) Inorder() func(func(int) bool) {
    return func(yield func(int) bool) {
        var walk func(*Tree) bool
        walk = func(node *Tree) bool {
            if node == nil {
                return true
            }
            return walk(node.Left) && yield(node.Value) && walk(node.Right)
        }
        walk(t)
    }
}

// Usage
for v := range tree.Inorder() {
    fmt.Println(v)
}
```

---
