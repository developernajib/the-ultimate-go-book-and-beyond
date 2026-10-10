## Go Comparison: Go Slices and Maps vs STL Containers

Go takes a radically different approach to data structures. Where C++ provides a rich taxonomy of containers with distinct performance characteristics, Go provides exactly two built-in container types: **slices** and **maps**. Everything else you build yourself or import from a library.

### Slices vs vector

Go's `slice` is the closest analog to `std::vector`. Both are dynamically-sized, contiguous arrays with amortized O(1) append. But the mechanics differ significantly.

```go
// Go slice
package main

import "fmt"

func main() {
    // Go slice - backed by an array
    s := []int{1, 2, 3, 4, 5}
    s = append(s, 6)  // May reallocate (like push_back)
    
    fmt.Println(len(s), cap(s))  // len and cap, like size and capacity
    
    // Slicing creates a view (not a copy!)
    sub := s[1:4]  // {2, 3, 4} - shares underlying array
    sub[0] = 99    // Modifies s[1] too!
    fmt.Println(s)  // [1 99 3 4 5 6]
    
    // Full slice expression to limit capacity
    safe := s[1:4:4]  // len=3, cap=3 - append on safe won't affect s
    fmt.Println(len(safe), cap(safe))
}
```

```cpp
// C++ vector equivalent
#include <vector>
#include <span>  // C++20

int main() {
    std::vector<int> v = {1, 2, 3, 4, 5};
    v.push_back(6);
    
    // span is the C++ equivalent of a Go slice (view without ownership)
    std::span<int> sub(v.begin() + 1, 3);  // {2, 3, 4}
    sub[0] = 99;  // Modifies v[1] too, like Go slices
    
    // Unlike Go slices, span has no append - it's a pure view
    // Go slices blur the line between "owned container" and "view"
    
    return 0;
}
```

**Key differences:**

| Feature | Go Slice | C++ vector |
|---------|:---|:---|
| Growth factor | 2x (small), ~1.25x (large, since Go 1.18) | 2x (GCC) or 1.5x (MSVC) |
| Slicing | Built-in syntax, creates view | `std::span` (C++20), separate type |
| Type safety | Runtime only | Compile-time templates |
| Move semantics | N/A (GC handles memory) | Must understand move/copy |
| Iterator invalidation | N/A (no iterators) | Complex rules (see above) |
| Nil/empty distinction | `nil` slice vs empty slice | No equivalent (empty is empty) |
| Thread safety | Not safe for concurrent R/W | Not safe for concurrent R/W |

A subtle difference: Go's `append` returns a new slice header. If the underlying array was reallocated, the old slice still points to the old array. This means multiple slices can diverge silently after an append causes reallocation. In C++, there is only one vector object, and reallocation invalidates all iterators/pointers, a more explicit model, though one that requires more discipline.

### Maps vs map/unordered_map

Go's built-in `map` is a hash map (like `unordered_map`). Go has no built-in equivalent to `std::map` (ordered/sorted).

```go
// Go map
package main

import "fmt"

func main() {
    m := map[string]int{
        "Alice": 30,
        "Bob":   25,
    }
    
    // Check existence with comma-ok idiom
    age, ok := m["Charlie"]
    if !ok {
        fmt.Println("Charlie not found")
    }
    _ = age
    
    // Iteration order is deliberately randomized in Go!
    for k, v := range m {
        fmt.Printf("%s: %d\n", k, v)
    }
    
    // Delete
    delete(m, "Alice")
    
    // Zero value for missing keys (no insertion!)
    count := m["nonexistent"]  // Returns 0, does NOT insert
    fmt.Println(count)
}
```

```cpp
// C++ unordered_map equivalent
#include <unordered_map>
#include <iostream>
#include <string>

int main() {
    std::unordered_map<std::string, int> m = {
        {"Alice", 30},
        {"Bob", 25}
    };
    
    // Check existence
    auto it = m.find("Charlie");
    if (it == m.end()) {
        std::cout << "Charlie not found\n";
    }
    
    // CAUTION: operator[] inserts if key missing (unlike Go)
    // Use find() for read-only lookup
    
    // Iteration order is unspecified (similar to Go)
    for (const auto& [k, v] : m) {
        std::cout << k << ": " << v << "\n";
    }
    
    m.erase("Alice");
    
    return 0;
}
```

**Key differences:**

| Feature | Go map | C++ unordered_map |
|---------|:---|:---|
| Implementation | Hash map (Swiss table since Go 1.24) | Hash map (separate chaining) |
| Ordered alternative | None built-in | `std::map` (red-black tree) |
| Concurrency | NOT safe (race detector catches misuse) | NOT safe (use mutex) |
| Custom hash | Not directly supported (uses built-in hashing) | Full control via template parameter |
| Missing key lookup | Returns zero value, no insertion | `operator[]` inserts default. `find()` does not |
| Iteration order | Deliberately randomized | Unspecified but deterministic per run |
| Pointer to values | Values NOT addressable (may move during growth) | References stable if no rehash |
| Deletion during iteration | Safe in Go (`delete` during `range`) | Must use erase idiom carefully |

### What Go Lacks (and How to Work Around It)

Go does not have built-in equivalents to many STL containers. Here is how Go developers handle each case:

| C++ Container | Go Equivalent |
|---------------|:---|
| `std::list` | `container/list` package (non-generic, stores `any` / requires type assertions) |
| `std::set` | `map[T]struct{}` idiom (wastes some memory) |
| `std::deque` | No standard library equivalent. Use a ring buffer or `container/ring` |
| `std::priority_queue` | `container/heap` interface (you implement the interface on a slice) |
| `std::array` | Fixed-size arrays `[5]int` (value types, stack allocated) |
| Sorted containers | `slices.Sort()` on a slice + `slices.BinarySearch()`, or third-party B-tree libraries |
| `std::stack` | Use a slice: `append` to push, `s[:len(s)-1]` to pop |
| `std::queue` | Use a slice: `s[1:]` to dequeue (but wastes memory. Use ring buffer for production) |

Go's philosophy is that two data structures (slice and map) cover 95% of use cases, and the language should be simple. C++'s philosophy is that different problems need different data structures, and the standard library should provide them all with zero-overhead abstractions. Neither approach is universally better, they reflect fundamentally different values about simplicity versus control.

---
