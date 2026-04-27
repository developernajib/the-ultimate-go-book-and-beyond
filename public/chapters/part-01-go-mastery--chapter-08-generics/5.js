export default `## 8.4 Generic Functions

### Functional Programming Patterns

Generic functions make classic functional programming combinators type-safe in Go. \`Map\`, \`Filter\`, and \`Reduce\` implemented with type parameters operate on slices of any element type without runtime type assertions.

\`\`\`go
// Filter returns elements that satisfy the predicate
func Filter[T any](s []T, pred func(T) bool) []T {
    result := make([]T, 0, len(s)/2)  // Guess half will match
    for _, v := range s {
        if pred(v) {
            result = append(result, v)
        }
    }
    return result
}

// Map transforms each element
func Map[T, U any](s []T, fn func(T) U) []U {
    result := make([]U, len(s))
    for i, v := range s {
        result[i] = fn(v)
    }
    return result
}

// Reduce combines elements into a single value
func Reduce[T, U any](s []T, init U, fn func(U, T) U) U {
    result := init
    for _, v := range s {
        result = fn(result, v)
    }
    return result
}

// FlatMap maps and flattens
func FlatMap[T, U any](s []T, fn func(T) []U) []U {
    var result []U
    for _, v := range s {
        result = append(result, fn(v)...)
    }
    return result
}

// Partition splits into two slices based on predicate
func Partition[T any](s []T, pred func(T) bool) (trueItems, falseItems []T) {
    for _, v := range s {
        if pred(v) {
            trueItems = append(trueItems, v)
        } else {
            falseItems = append(falseItems, v)
        }
    }
    return
}

// GroupBy groups elements by a key function
func GroupBy[T any, K comparable](s []T, keyFn func(T) K) map[K][]T {
    result := make(map[K][]T)
    for _, v := range s {
        key := keyFn(v)
        result[key] = append(result[key], v)
    }
    return result
}

// Example usage
numbers := []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}

// Filter even numbers
evens := Filter(numbers, func(n int) bool { return n%2 == 0 })
// [2, 4, 6, 8, 10]

// Square each number
squares := Map(numbers, func(n int) int { return n * n })
// [1, 4, 9, 16, 25, 36, 49, 64, 81, 100]

// Sum all numbers
sum := Reduce(numbers, 0, func(acc, n int) int { return acc + n })
// 55

// Group by even/odd
type User struct {
    Name string
    Age  int
}
users := []User{
    {"Alice", 30}, {"Bob", 25}, {"Charlie", 30}, {"Diana", 25},
}
byAge := GroupBy(users, func(u User) int { return u.Age })
// map[25:[{Bob 25} {Diana 25}] 30:[{Alice 30} {Charlie 30}]]
\`\`\`

### Map Operations

Generic map operations abstract over the element type, enabling type-safe transformations of Go maps without the boilerplate of manual iteration and type assertion.

\`\`\`go
// Keys returns all keys from a map
func Keys[K comparable, V any](m map[K]V) []K {
    keys := make([]K, 0, len(m))
    for k := range m {
        keys = append(keys, k)
    }
    return keys
}

// Values returns all values from a map
func Values[K comparable, V any](m map[K]V) []V {
    values := make([]V, 0, len(m))
    for _, v := range m {
        values = append(values, v)
    }
    return values
}

// Entries returns key-value pairs
func Entries[K comparable, V any](m map[K]V) []struct{ Key K; Value V } {
    entries := make([]struct{ Key K; Value V }, 0, len(m))
    for k, v := range m {
        entries = append(entries, struct{ Key K; Value V }{k, v})
    }
    return entries
}

// FromEntries creates a map from entries
func FromEntries[K comparable, V any](entries []struct{ Key K; Value V }) map[K]V {
    m := make(map[K]V, len(entries))
    for _, e := range entries {
        m[e.Key] = e.Value
    }
    return m
}

// Merge combines multiple maps
func Merge[K comparable, V any](maps ...map[K]V) map[K]V {
    result := make(map[K]V)
    for _, m := range maps {
        for k, v := range m {
            result[k] = v
        }
    }
    return result
}

// MapValues transforms map values
func MapValues[K comparable, V, U any](m map[K]V, fn func(V) U) map[K]U {
    result := make(map[K]U, len(m))
    for k, v := range m {
        result[k] = fn(v)
    }
    return result
}

// FilterMap filters map entries
func FilterMap[K comparable, V any](m map[K]V, pred func(K, V) bool) map[K]V {
    result := make(map[K]V)
    for k, v := range m {
        if pred(k, v) {
            result[k] = v
        }
    }
    return result
}

// Invert swaps keys and values
func Invert[K, V comparable](m map[K]V) map[V]K {
    result := make(map[V]K, len(m))
    for k, v := range m {
        result[v] = k
    }
    return result
}
\`\`\`

### Concurrent Operations

Generic concurrent utilities combine generics with goroutines to apply typed operations concurrently, maintaining type safety across the concurrency boundary.

\`\`\`go
import "sync"

// ParallelMap processes elements concurrently
func ParallelMap[T, U any](items []T, fn func(T) U, workers int) []U {
    results := make([]U, len(items))

    ch := make(chan int, len(items))
    for i := range items {
        ch <- i
    }
    close(ch)

    var wg sync.WaitGroup
    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for idx := range ch {
                results[idx] = fn(items[idx])
            }
        }()
    }
    wg.Wait()

    return results
}

// ParallelFilter filters elements concurrently
func ParallelFilter[T any](items []T, pred func(T) bool, workers int) []T {
    type indexedResult struct {
        index int
        keep  bool
    }

    ch := make(chan int, len(items))
    for i := range items {
        ch <- i
    }
    close(ch)

    results := make(chan indexedResult, len(items))

    var wg sync.WaitGroup
    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for idx := range ch {
                results <- indexedResult{idx, pred(items[idx])}
            }
        }()
    }

    go func() {
        wg.Wait()
        close(results)
    }()

    // Collect results maintaining order
    keeps := make([]bool, len(items))
    for r := range results {
        keeps[r.index] = r.keep
    }

    var filtered []T
    for i, item := range items {
        if keeps[i] {
            filtered = append(filtered, item)
        }
    }
    return filtered
}
\`\`\`

### When a Generic Function Is Worth It

The single-line test: would the non-generic version force you to pick \`any\` or write N copies? If yes, generics. If no, the generic version is adding complexity without benefit. \`Map\`, \`Filter\`, \`Reduce\` qualify. A function with one call site does not.

---
`;
