## Iterators

Iterators are the glue between containers and algorithms. They provide a uniform way to traverse any container without exposing its internal structure. The STL defines five iterator categories (six with C++20), arranged in a hierarchy from weakest to most powerful.

### The Five Iterator Categories

Iterators abstract over traversal, decoupling algorithms from container implementations and enabling the standard algorithms to work uniformly across arrays, linked lists, trees, and custom data structures. Implementing the required iterator concept integrates a custom type with the entire standard library algorithm suite.
```
Input Iterator ──────────────┐
                              ├── Forward Iterator ── Bidirectional Iterator ── Random Access Iterator ── Contiguous Iterator (C++20)
Output Iterator ─────────────┘
```

| Category | Can read | Can write | Multi-pass | Direction | Operations |
|----------|:---:|:---:|:---:|:---:|:---|
| Input | Yes | No | No | Forward | `++`, `*`, `==`, `!=` |
| Output | No | Yes | No | Forward | `++`, `*` |
| Forward | Yes | Yes | Yes | Forward | `++`, `*`, `==`, `!=` |
| Bidirectional | Yes | Yes | Yes | Both | `++`, `--`, `*`, `==`, `!=` |
| Random Access | Yes | Yes | Yes | Both | `++`, `--`, `+n`, `-n`, `[]`, `<`, `>` |
| Contiguous (C++20) | Yes | Yes | Yes | Both | Random Access + elements contiguous in memory |

**Input iterators** are single-pass: once you advance past an element, you cannot go back. Think of reading from `std::cin` or a network stream, the data is consumed. **Output iterators** are single-pass for writing: `std::ostream_iterator` writes to a stream and you cannot rewrite a previous position. **Forward iterators** add multi-pass capability: you can save your position and iterate the range again. **Bidirectional** adds backward movement. **Random access** adds O(1) jumping to arbitrary positions. **Contiguous** (C++20) guarantees that elements are laid out sequentially in memory, enabling pointer-to-iterator conversions.

**Which containers provide which iterators:**

| Container | Iterator Category |
|-----------|:---|
| `vector` | Contiguous (Random Access) |
| `array` | Contiguous (Random Access) |
| `deque` | Random Access |
| `list` | Bidirectional |
| `forward_list` | Forward |
| `map`, `set` | Bidirectional |
| `unordered_map`, `unordered_set` | Forward |

```cpp
#include <vector>
#include <list>
#include <algorithm>
#include <iostream>
#include <iterator>

int main() {
    // Random access iterator: supports arithmetic
    std::vector<int> v = {10, 20, 30, 40, 50};
    auto it = v.begin();
    it += 3;           // Jump to index 3
    std::cout << *it << "\n";  // 40
    std::cout << it[-1] << "\n";  // 30 (subscript operator)
    std::cout << (v.end() - v.begin()) << "\n";  // 5 (distance)
    
    // Bidirectional iterator: only ++ and --
    std::list<int> lst = {1, 2, 3, 4, 5};
    auto lit = lst.end();
    --lit;  // OK: bidirectional
    // lit += 3; // ERROR: not random access
    std::advance(lit, -2);  // Use advance for generic code
    std::cout << *lit << "\n";  // 3
    
    // Output iterator: write-only
    std::ostream_iterator<int> out(std::cout, " ");
    *out = 42;   // prints "42 "
    ++out;
    *out = 99;   // prints "99 "
    std::cout << "\n";
    
    // Using back_inserter as output iterator
    std::vector<int> src = {1, 2, 3, 4, 5};
    std::vector<int> dst;
    std::copy_if(src.begin(), src.end(), std::back_inserter(dst),
                 [](int x) { return x % 2 == 0; });
    // dst: {2, 4}
    
    // std::next and std::prev - generic iterator advancement
    auto third = std::next(v.begin(), 2);  // Works for any forward iterator
    auto second = std::prev(lst.end(), 4);  // Works for any bidirectional iterator
    
    return 0;
}
```

### Iterator Invalidation Rules: Critical for Interviews

Iterator invalidation is one of the most frequently tested topics in C++ interviews. Using an invalidated iterator is undefined behavior, the program may crash, silently corrupt data, or appear to work until it doesn't in production.

**std::vector:**

| Operation | Iterators invalidated |
|-----------|:---|
| `push_back` (no realloc) | Only `end()` |
| `push_back` (realloc) | **All** iterators, pointers, and references |
| `insert` (no realloc) | From insertion point to `end()` |
| `insert` (realloc) | **All** |
| `erase` | From erasure point to `end()` |
| `clear` | **All** |
| `reserve` (realloc) | **All** |
| `operator[]`, `at` | None |
| `shrink_to_fit` | May invalidate **all** (if reallocation occurs) |

**std::deque:**

| Operation | Iterators invalidated |
|-----------|:---|
| `push_back`, `push_front` | **All iterators** (but references and pointers remain valid!) |
| `insert` in middle | **All** iterators and references |
| `erase` at front/back | Only the erased element's iterator |
| `erase` in middle | **All** |

The deque invalidation rules are subtle: `push_back` and `push_front` invalidate all *iterators* (because the internal map array might be reallocated), but *references* and *pointers* to existing elements remain valid (because the chunks themselves are never moved). This distinction matters in interview discussions.

**std::list / std::forward_list:**

| Operation | Iterators invalidated |
|-----------|:---|
| `insert` | **None** (existing iterators stay valid) |
| `erase` | Only the erased element |
| `splice` | **None** (iterators follow their elements to the new list) |

**std::map / std::set (ordered):**

| Operation | Iterators invalidated |
|-----------|:---|
| `insert`, `emplace` | **None** |
| `erase` | Only the erased element |
| `extract` (C++17) | Only the extracted element |

**std::unordered_map / std::unordered_set:**

| Operation | Iterators invalidated |
|-----------|:---|
| `insert` (no rehash) | **None** |
| `insert` (rehash) | **All** |
| `erase` | Only the erased element |
| `reserve` | If it causes rehash, **all** |

```cpp
#include <vector>
#include <list>
#include <iostream>

int main() {
    // DANGER: iterator invalidation with vector
    std::vector<int> v = {1, 2, 3, 4, 5};
    
    // WRONG: modifying container while iterating
    // for (auto it = v.begin(); it != v.end(); ++it) {
    //     if (*it % 2 == 0) {
    //         v.erase(it);  // UB: 'it' is invalidated!
    //     }
    // }
    
    // CORRECT: erase returns iterator to next element
    for (auto it = v.begin(); it != v.end(); ) {
        if (*it % 2 == 0) {
            it = v.erase(it);  // Returns valid iterator
        } else {
            ++it;
        }
    }
    // v: {1, 3, 5}
    
    // SAFE: list iterators not invalidated by other inserts/erases
    std::list<int> lst = {1, 2, 3, 4, 5};
    auto it2 = lst.begin();
    std::advance(it2, 2);  // Points to 3
    lst.erase(lst.begin());  // Erase 1 - it2 still valid
    std::cout << *it2 << "\n";  // 3 (still valid)
    
    // DANGER: saving iterators across push_back
    std::vector<int> v2 = {1, 2, 3};
    auto saved = v2.begin();  // Points to 1
    v2.push_back(4);          // May reallocate!
    // *saved is now UB if reallocation occurred
    
    return 0;
}
```

### Writing a Custom Iterator

A custom iterator lets your own data structures work with STL algorithms. In C++20, you can use concepts to define iterator requirements more cleanly, but the traditional approach using type aliases still works everywhere.

```cpp
#include <iterator>
#include <iostream>
#include <algorithm>
#include <cstddef>
#include <numeric>

// A simple range that generates integers [start, end)
class IntRange {
public:
    class Iterator {
    public:
        // Required type aliases for std::iterator_traits
        using iterator_category = std::forward_iterator_tag;
        using value_type = int;
        using difference_type = std::ptrdiff_t;
        using pointer = const int*;
        using reference = int;  // Returns by value (generates on demand)
        
        explicit Iterator(int val) : value_(val) {}
        
        int operator*() const { return value_; }
        
        Iterator& operator++() { ++value_; return *this; }
        Iterator operator++(int) { Iterator tmp = *this; ++value_; return tmp; }
        
        bool operator==(const Iterator& other) const { return value_ == other.value_; }
        bool operator!=(const Iterator& other) const { return value_ != other.value_; }
        
    private:
        int value_;
    };
    
    IntRange(int start, int end) : start_(start), end_(end) {}
    
    Iterator begin() const { return Iterator(start_); }
    Iterator end() const { return Iterator(end_); }
    
private:
    int start_;
    int end_;
};

int main() {
    IntRange range(1, 11);
    
    // Works with range-for
    for (int x : range) {
        std::cout << x << " ";
    }
    std::cout << "\n";  // 1 2 3 4 5 6 7 8 9 10
    
    // Works with STL algorithms
    auto count = std::count_if(range.begin(), range.end(),
                               [](int x) { return x % 2 == 0; });
    std::cout << "Even count: " << count << "\n";  // 5
    
    // Works with accumulate
    int sum = std::accumulate(range.begin(), range.end(), 0);
    std::cout << "Sum: " << sum << "\n";  // 55
    
    return 0;
}
```

**The five type aliases are essential**: Without `iterator_category`, `value_type`, `difference_type`, `pointer`, and `reference`, `std::iterator_traits` cannot deduce the properties of your iterator, and most STL algorithms will fail to compile. In C++20, you can instead satisfy the `std::input_iterator` or `std::forward_iterator` concepts, which provide cleaner error messages when requirements are not met.

---
