## Sequence Containers

Sequence containers maintain elements in the order you insert them. The STL provides five: `vector`, `deque`, `list`, `forward_list`, and `array`. Each has a fundamentally different internal structure, which determines its performance characteristics.

### std::vector: The Default Choice

A `vector` is a dynamically-sized contiguous array. Internally, it manages three pointers: one to the beginning of allocated memory, one to the end of constructed elements (size), and one to the end of allocated capacity.

```cpp
#include <vector>
#include <iostream>

int main() {
    std::vector<int> v;
    
    // Observe capacity growth
    for (int i = 0; i < 20; ++i) {
        v.push_back(i);
        std::cout << "size=" << v.size() 
                  << " capacity=" << v.capacity() << "\n";
    }
    // Typical output: capacity doubles (1,2,4,8,16,32...)
    // GCC/libstdc++ doubles - MSVC uses factor of 1.5
    
    // Reserve to avoid reallocations when size is known
    std::vector<int> known(0);
    known.reserve(1000);  // Allocates space for 1000, size still 0
    
    // Contiguous memory means pointer arithmetic works
    int* raw = v.data();
    std::cout << raw[5] << "\n";  // Same as v[5]
    
    // Shrink wasted capacity
    v.shrink_to_fit();  // Non-binding request to reduce capacity to size
    
    return 0;
}
```

**Internal mechanics of reallocation**: When `push_back` exceeds capacity, the vector allocates a new buffer (typically 2x the current capacity), move-constructs all existing elements into the new buffer, destroys the old elements, and deallocates the old buffer. This is why `push_back` is amortized O(1) but worst-case O(n). The growth factor choice matters: a factor of 2 means previously freed blocks can never be reused by the same vector (the sum of all previous allocations is always less than the current allocation). MSVC's 1.5x factor allows memory reuse after several reallocations, which can reduce memory fragmentation in long-running systems.

**Why contiguous memory matters**: Modern CPUs fetch data in cache lines (typically 64 bytes). When you iterate a vector, each cache line prefetch loads multiple consecutive elements. With a linked list, each node could be anywhere in memory, causing a cache miss on nearly every access. For a vector of `int` (4 bytes), one cache line holds 16 elements. For a list of `int`, each node is 24+ bytes (value + two pointers), potentially scattered across the heap. Benchmarks consistently show that vector iteration is 10-100x faster than list iteration for this reason alone.

**When to use vector**: It should be your default container. Contiguous memory means excellent cache locality. Random access is O(1). Iteration is the fastest of any container. Even when you need to insert or erase in the middle, for small containers (under a few hundred elements), vector often beats list and deque due to cache effects.

```cpp
#include <vector>
#include <algorithm>
#include <iostream>

int main() {
    std::vector<int> v = {5, 3, 8, 1, 9, 2, 7};
    
    // Erase-remove idiom (pre-C++20)
    v.erase(std::remove_if(v.begin(), v.end(), 
            [](int x) { return x < 5; }), v.end());
    // v is now {5, 8, 9, 7}
    
    // C++20: simpler
    // std::erase_if(v, [](int x) { return x > 8; });
    
    // Insert at position - O(n) due to shifting
    auto it = std::find(v.begin(), v.end(), 8);
    v.insert(it, 6);  // Insert 6 before 8
    
    // Emplace constructs in-place, avoiding copies
    v.emplace_back(10);
    
    for (int x : v) std::cout << x << " ";
    std::cout << "\n";
    
    return 0;
}
```

**emplace_back vs push_back**: `push_back` takes an already-constructed object and copies or moves it into the vector. `emplace_back` forwards its arguments directly to the element's constructor, constructing the object in-place inside the vector's buffer. For simple types like `int`, the difference is negligible. For complex types with expensive constructors, `emplace_back` can avoid a temporary object entirely:

```cpp
#include <cstdint>
#include <string>
#include <vector>

struct Employee {
    std::string name;
    int id;
    int64_t salary_cents;
    Employee(std::string n, int i, int64_t sc) 
        : name(std::move(n)), id(i), salary_cents(sc) {}
};

int main() {
    std::vector<Employee> team;
    
    // push_back: constructs temporary, then moves it in
    team.push_back(Employee("Alice", 1, 100'000'00LL));
    
    // emplace_back: constructs directly inside vector
    team.emplace_back("Bob", 2, 95'000'00LL);  // No temporary created
    
    return 0;
}
```

### std::deque: Double-Ended Queue

A `deque` (pronounced "deck") provides O(1) insertion and removal at both ends. Internally, it is **not** a contiguous array. It uses a "map" (an array of pointers) where each pointer points to a fixed-size chunk of contiguous memory (typically 512 bytes or enough for a fixed number of elements).

```
Map array:  [ ptr0 | ptr1 | ptr2 | ptr3 | ... ]
              |       |       |       |
              v       v       v       v
            [chunk] [chunk] [chunk] [chunk]
            (each chunk holds N elements contiguously)
```

When you `push_front`, the deque allocates a new chunk at the beginning of the map array (or uses spare capacity at the front of an existing chunk). When you `push_back`, it does the same at the end. The map array itself can grow, but individual chunks never need to be moved. This is why both operations are O(1), unlike vector, which would need to shift all elements for a front insertion.

```cpp
#include <deque>
#include <iostream>

int main() {
    std::deque<int> dq;
    
    // O(1) at both ends
    dq.push_back(1);
    dq.push_back(2);
    dq.push_front(0);   // vector cannot do this efficiently
    dq.push_front(-1);
    
    // Random access is O(1), but slightly slower than vector
    // (requires: which chunk? + offset within chunk)
    std::cout << dq[2] << "\n";  // prints 1
    
    // Iteration
    for (int x : dq) std::cout << x << " ";
    // prints: -1 0 1 2
    std::cout << "\n";
    
    // Pop from both ends
    dq.pop_front();
    dq.pop_back();
    // dq is now {0, 1}
    
    return 0;
}
```

**When to use deque**: When you need fast insertion at both ends (implementing a sliding window, BFS queue, undo/redo buffer). It is also the default underlying container for `std::queue` and `std::stack`. Avoid it when you need contiguous memory (no `.data()` method) or when cache locality is paramount. Random access is O(1) but involves an extra indirection (compute chunk index, then offset within chunk), making it roughly 2-5x slower than vector random access in practice.

### std::list: Doubly-Linked List

A `list` is a doubly-linked list where each node is independently allocated on the heap. Every node stores the element plus two pointers (previous and next).

```cpp
#include <list>
#include <iostream>
#include <algorithm>

int main() {
    std::list<int> lst = {3, 1, 4, 1, 5, 9};
    
    // O(1) insert/erase when you have an iterator
    auto it = std::find(lst.begin(), lst.end(), 4);
    lst.insert(it, 99);  // Insert 99 before 4: {3, 1, 99, 4, 1, 5, 9}
    
    // O(1) erase at any position (no shifting)
    lst.erase(it);  // Erases the 4: {3, 1, 99, 1, 5, 9}
    
    // Splice: move elements between lists in O(1)
    std::list<int> other = {100, 200};
    auto pos = lst.begin();
    std::advance(pos, 2);
    lst.splice(pos, other);  // Moves all of 'other' into 'lst' before pos
    // lst: {3, 1, 100, 200, 99, 1, 5, 9}
    // other is now empty
    
    // list has its own sort (cannot use std::sort, which requires random access)
    lst.sort();
    
    // Merge two sorted lists in O(n)
    std::list<int> a = {1, 3, 5};
    std::list<int> b = {2, 4, 6};
    a.merge(b);  // a: {1, 2, 3, 4, 5, 6}, b is empty
    
    // unique: remove consecutive duplicates (after sorting)
    std::list<int> c = {1, 1, 2, 3, 3, 3, 4};
    c.unique();  // c: {1, 2, 3, 4}
    
    for (int x : lst) std::cout << x << " ";
    std::cout << "\n";
    
    return 0;
}
```

**Splice is the killer feature**. The `splice` operation transfers nodes from one list to another by rewiring pointers. No elements are copied, moved, or destroyed. No memory is allocated or freed. This is a constant-time operation regardless of how many elements are being spliced. No other standard container can do this.

**When to use list**: When you need O(1) splicing between lists, when you need stable iterators (iterators and references to other elements never invalidated by insert/erase), or when elements are large and you want to avoid move/copy costs during reordering. In practice, `std::list` is rarely the best choice due to poor cache locality from scattered heap allocations. Bjarne Stroustrup himself demonstrated that inserting into the middle of a vector and shifting elements is often faster than list insertion for up to 500,000 elements because of cache effects.

### std::forward_list: Singly-Linked List

A `forward_list` is a singly-linked list. Each node has one pointer (next only). It has no `size()` method (to keep it zero-overhead compared to a hand-written singly-linked list), no `push_back`, and you can only insert after a given position.

```cpp
#include <forward_list>
#include <iostream>

int main() {
    std::forward_list<int> fl = {1, 2, 3, 4, 5};
    
    // Insert after an element (not before - can't go backward)
    auto it = fl.begin();  // points to 1
    fl.insert_after(it, 99);  // {1, 99, 2, 3, 4, 5}
    
    // Insert at the front
    fl.push_front(0);  // {0, 1, 99, 2, 3, 4, 5}
    
    // Erase after
    fl.erase_after(fl.begin());  // Erases 1: {0, 99, 2, 3, 4, 5}
    
    // No size() - compute manually
    auto count = std::distance(fl.begin(), fl.end());
    std::cout << "count: " << count << "\n";
    
    // before_begin() returns an iterator before the first element
    // Useful for inserting at the front or erasing the first element
    fl.insert_after(fl.before_begin(), -1);  // {-1, 0, 99, 2, 3, 4, 5}
    
    for (int x : fl) std::cout << x << " ";
    std::cout << "\n";
    
    return 0;
}
```

**Why no `size()` method?** The C++ committee deliberately omitted `size()` from `forward_list` because maintaining a size counter would add overhead (one extra word of memory, one extra increment/decrement per insert/erase). The design goal was zero overhead compared to a hand-written C-style singly-linked list. If you need the count, call `std::distance(fl.begin(), fl.end())` which is O(n).

**When to use forward_list**: When memory is extremely constrained (saves one pointer per node versus `list`), or when you are building intrusive data structures. In practice, it is rarely used in application code.

### std::array: Fixed-Size Array

A `std::array` is a thin wrapper around a C-style array. Its size is fixed at compile time. It is stored entirely on the stack (no heap allocation) and provides the same interface as other containers (iterators, `.size()`, `.at()` with bounds checking).

```cpp
#include <array>
#include <algorithm>
#include <iostream>

int main() {
    std::array<int, 5> arr = {5, 3, 1, 4, 2};
    
    // Size known at compile time
    constexpr size_t n = arr.size();  // 5, at compile time
    
    // Works with standard algorithms
    std::sort(arr.begin(), arr.end());
    
    // Bounds-checked access
    try {
        arr.at(10) = 42;  // Throws std::out_of_range
    } catch (const std::out_of_range& e) {
        std::cout << "Caught: " << e.what() << "\n";
    }
    
    // Structured bindings (C++17)
    auto [a, b, c, d, e] = arr;
    std::cout << a << " " << b << " " << c << "\n";
    
    // Zero-overhead: sizeof(std::array<int,5>) == sizeof(int[5])
    static_assert(sizeof(arr) == 5 * sizeof(int));
    
    // Can be used in constexpr context
    constexpr std::array<int, 3> lookup = {10, 20, 30};
    static_assert(lookup[1] == 20);
    
    return 0;
}
```

**When to use array**: When the size is known at compile time and you want container interface benefits (algorithms, range-for, `.size()`) without heap allocation. It replaces C-style arrays in modern C++. Unlike C arrays, `std::array` does not decay to a pointer when passed to functions, its size is part of the type, and it supports value semantics (you can copy, assign, and compare arrays directly).

---
