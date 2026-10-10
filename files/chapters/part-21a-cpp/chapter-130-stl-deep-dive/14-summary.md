## Summary

The STL is not a monolithic library to memorize. It is a system built on three pillars: **containers** store data with specific performance trade-offs, **iterators** provide uniform traversal, and **algorithms** operate generically on any iterator range. C++20 ranges unify all three with lazy, composable pipelines.

The key decisions every C++ programmer must make:

1. **Default to `vector`**. Contiguous memory and cache locality beat asymptotic complexity for most real-world sizes. A sorted vector with `std::lower_bound` often outperforms `std::map` for read-heavy workloads.

2. **Use `unordered_map`/`unordered_set` when you need O(1) lookup** and don't need sorted order. Always `reserve()` when you know the approximate size. Consider Abseil's `flat_hash_map` for performance-critical paths.

3. **Use `map`/`set` when you need sorted order** or range queries. The O(log n) is predictable with no worst-case degradation. Also appropriate when processing untrusted input (no hash-flooding risk).

4. **Use `list` only when you need O(1) splice** or guaranteed iterator stability. The LRU cache is one of the few patterns where list genuinely shines.

5. **Know your iterator invalidation rules**. Using an invalidated iterator is undefined behavior, the program may crash, silently corrupt data, or appear to work until it doesn't. This is the single most important STL topic for interviews.

6. **Prefer algorithms over raw loops**. `std::sort`, `std::partition`, `std::transform`, and `std::accumulate` express intent clearly, are harder to get wrong, and can be parallelized with execution policies (C++17).

7. **Use `string_view` for read-only string parameters**. It eliminates unnecessary copies and works with any string-like type. But never store a `string_view` to data you don't control the lifetime of.

8. **Embrace C++20 ranges** for new code. Projections eliminate comparator boilerplate. Views enable functional-style composition. Lazy evaluation avoids unnecessary allocations.

Coming from Go, the STL may feel overwhelming in its breadth. Go's two built-in containers (slices and maps) cover most use cases with simplicity. C++ provides more tools for more specialized performance needs. Neither approach is universally better, they reflect different philosophies about simplicity versus control. Understanding both prepares you to make the right trade-off for each problem you face.

---

### Junior → FAANG: Choosing the Right Container Under Interview Pressure

Under interview pressure, junior candidates often reach for familiar structures without justifying tradeoffs. At FAANG, interviewers evaluate whether your container choices match data access patterns and memory constraints:
- **Default to contiguous memory**: Reach for `std::vector` first. Emphasize cache locality and vectorization benefits over pointer-chasing structures.
- **Defend asymptotic surprises**: Explain why a sorted `std::vector` with binary search outperforms `std::set` in read-heavy workloads due to cache-line density and zero node-allocation overhead.
- **Demonstrate lifecycle safety**: Articulate exact iterator invalidation boundaries for `std::vector` reallocations versus node-based containers like `std::list`.

### Senior @ FAANG: Standard Container Policy and Allocation Architectures

At the staff level, standard library container choices define latency bounds and memory fragmentation across distributed fleets:
- **Memory layout and custom allocators**: Production services handling millions of queries per second avoid default `std::allocator` heap allocations. Staff engineers mandate polymorphic allocators (`std::pmr`), arena allocators, or pool allocators for node-based containers (`std::map`, `std::list`) to eliminate heap lock contention and memory fragmentation.
- **Open-addressing vs node-chaining**: `std::unordered_map` relies on node chaining, incurring cache misses on every hash collision. Staff architectures standardize on open-addressing Swiss tables (such as Abseil's `flat_hash_map` or Folly's `F14`) across server-side backends.
- **Zero-allocation views**: String and memory processing standards mandate `std::string_view` and `std::span` over defensive copies, while establishing strict lifetime ownership guidelines to prevent dangling views.

---

| [◀ Chapter 129: Templates and Generics](../chapter-129-templates-generics/00-introduction.md) | [Chapter 130: STL Deep Dive](00-introduction.md) | [Chapter 131: Modern C++](../chapter-131-modern-cpp/00-introduction.md) ▶ |

