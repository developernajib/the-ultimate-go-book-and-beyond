## Associative Containers

Associative containers store elements in sorted order and provide O(log n) lookup. Internally, all four (`map`, `set`, `multimap`, `multiset`) use a **self-balancing binary search tree**, specifically a **red-black tree** in every major implementation (GCC, Clang, MSVC).

### Red-Black Tree Internals

A red-black tree is a BST with these invariants:

1. Every node is either red or black.
2. The root is black.
3. Every null leaf (NIL) is black.
4. A red node cannot have a red child (no two consecutive reds).
5. Every path from a node to its descendant NIL nodes has the same number of black nodes (the "black-height").

These constraints guarantee that the longest path from root to leaf is at most 2x the shortest, ensuring O(log n) height. Insertions and deletions may require rotations (O(1) each) and recoloring to maintain invariants. In the worst case, an insertion requires at most 2 rotations and O(log n) recolorings, while a deletion requires at most 3 rotations.

Each tree node contains: the element value (or key-value pair for maps), a color bit, and three pointers (parent, left child, right child). On a 64-bit system, this means at least 25 bytes of overhead per node (3 pointers at 8 bytes each plus a color bit, typically padded to a full byte). This is significant compared to contiguous containers where the per-element overhead is zero.

**Why red-black trees over AVL trees?** AVL trees maintain stricter balance (heights of siblings differ by at most 1), giving faster lookups. But red-black trees require fewer rotations during insertion and deletion, making mutation operations faster. Since the STL containers need to support frequent insertions and deletions alongside lookups, red-black trees offer the better overall trade-off. The C++ standard does not mandate red-black trees, but every major implementation uses them.

### std::map and std::set

`std::map` stores key-value pairs sorted by key in a red-black tree, giving O(log n) insert, erase, and lookup with stable iterators. `operator[]` inserts a default-constructed value if the key is absent, use `find()` when you need to distinguish presence from absence without inserting. `emplace` constructs the pair in-place, avoiding a temporary.
```cpp
#include <map>
#include <set>
#include <string>
#include <iostream>

int main() {
    // map: sorted key-value pairs, unique keys
    std::map<std::string, int> ages;
    ages["Alice"] = 30;
    ages["Bob"] = 25;
    ages.insert({"Charlie", 35});
    ages.emplace("Diana", 28);
    
    // Iteration is always in sorted key order
    for (const auto& [name, age] : ages) {
        std::cout << name << ": " << age << "\n";
    }
    // Alice: 30, Bob: 25, Charlie: 35, Diana: 28
    
    // O(log n) lookup
    auto it = ages.find("Bob");
    if (it != ages.end()) {
        std::cout << "Found Bob, age " << it->second << "\n";
    }
    
    // operator[] inserts default value if key not found!
    int val = ages["Eve"];  // Inserts Eve:0 silently
    std::cout << "Eve: " << val << "\n";  // 0
    
    // Use count() or contains() (C++20) for existence check
    if (ages.count("Alice")) { /* exists */ }
    // if (ages.contains("Alice")) { /* C++20 */ }
    
    // Lower/upper bound for range queries
    auto lo = ages.lower_bound("B");   // First element >= "B"
    auto hi = ages.upper_bound("D");   // First element > "D"
    std::cout << "Range [B, D]:\n";
    for (auto cur = lo; cur != hi; ++cur) {
        std::cout << "  " << cur->first << "\n";
    }
    
    // set: sorted unique elements
    std::set<int> s = {5, 3, 8, 1, 3, 5};  // duplicates removed
    std::cout << "set size: " << s.size() << "\n";  // 4
    
    // extract and merge (C++17) - move nodes between sets
    auto node = s.extract(3);
    if (!node.empty()) {
        node.value() = 42;  // Modify extracted node
        s.insert(std::move(node));  // Re-insert
    }
    // s: {1, 5, 8, 42}
    
    return 0;
}
```

**The `operator[]` trap**: One of the most common bugs in C++ is accidentally inserting elements into a map by using `operator[]` for a lookup. If the key does not exist, `operator[]` default-constructs a value, inserts the key-value pair, and returns a reference to the newly inserted value. This means `operator[]` cannot be `const`. Always use `find()`, `count()`, or `contains()` (C++20) when you only want to check for existence without modifying the map.

**C++17 node handles**: The `extract` method detaches a node from the tree without destroying it. You can then modify the key (which is normally `const` in a map/set) and re-insert the node. This avoids reallocation and is useful for bulk modifications. You can also use `merge` to transfer all nodes from one container to another:

```cpp
std::set<int> src = {1, 2, 3, 4, 5};
std::set<int> dst = {3, 6, 9};
dst.merge(src);
// dst: {1, 2, 3, 4, 5, 6, 9}
// src: {3}  - the duplicate stayed in src
```

### std::multimap and std::multiset

These allow duplicate keys. `equal_range` returns the range of all elements with a given key.

```cpp
#include <map>
#include <string>
#include <iostream>

int main() {
    std::multimap<std::string, int> scores;
    scores.insert({"Alice", 95});
    scores.insert({"Alice", 87});
    scores.insert({"Alice", 92});
    scores.insert({"Bob", 88});
    
    // Get all scores for Alice
    auto [lo, hi] = scores.equal_range("Alice");
    std::cout << "Alice's scores: ";
    for (auto it = lo; it != hi; ++it) {
        std::cout << it->second << " ";
    }
    std::cout << "\n";  // 95 87 92
    
    // count returns number of elements with key
    std::cout << "Alice entries: " << scores.count("Alice") << "\n";  // 3
    
    // Erase all entries for a key
    scores.erase("Alice");  // Removes all 3 Alice entries
    
    // Erase a single entry
    scores.insert({"Bob", 91});
    scores.insert({"Bob", 76});
    auto bob_it = scores.find("Bob");
    if (bob_it != scores.end()) {
        scores.erase(bob_it);  // Removes only the first Bob entry
    }
    
    return 0;
}
```

**When to use ordered associative containers**: When you need sorted iteration, range queries (`lower_bound`/`upper_bound`), or when your keys don't have a good hash function but do have a natural ordering. The O(log n) operations are predictable with no worst-case degradation (unlike hash tables). They also work well when you need to find the "nearest" element to a given key, an operation that hash tables fundamentally cannot support.

---

### Junior → FAANG: When Ordered Containers Beat Hash Tables

The default Go map is a hash map. Go engineers need to build an intuition for when ordered containers are the better choice. The two signal cases: (1) you need sorted iteration (Go `map` range order is undefined, `std::map` iteration is in sorted key order), (2) you need range queries (find all keys between X and Y, hash maps cannot do this efficiently).

Practice: take a problem that uses a hash map in Go and identify whether the solution would benefit from a sorted container in C++. A common example: finding the k-th largest element efficiently requires a sorted structure. A hash map requires a full sort after construction.

### Senior @ FAANG: Red-Black Tree Performance Characteristics in Production

At the staff level, the red-black tree implementation behind `std::map` and `std::set` has specific performance characteristics that affect production usage.

**Per-node allocation.** Each `std::map` insertion allocates a node from the heap. In a service that inserts and erases frequently, this creates allocator pressure. The alternative: `absl::btree_map` uses B-tree nodes (multiple elements per node) which reduces allocator calls and improves cache utilization for iteration. A staff engineer evaluating `std::map` vs. `absl::btree_map` for a production workload benchmarks both under the actual insert/erase/iterate pattern, not just lookup.

**Custom allocator for map containers.** For a `std::map` that is used intensively but has predictable maximum size, a custom pool allocator eliminates heap fragmentation. The `std::map<K, V, std::less<K>, PoolAllocator<...>>` form passes a custom allocator. This is an advanced optimization that a staff engineer uses when profiling shows allocator overhead as a bottleneck, not as a first choice.

