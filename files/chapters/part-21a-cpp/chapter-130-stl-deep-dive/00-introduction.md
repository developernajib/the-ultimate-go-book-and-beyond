# Chapter 130: STL Deep Dive

> The Standard Template Library is not just a library. Alexander Stepanov built it as an argument about how software should be decomposed: algorithms and data structures as independent, composable parts.

The Standard Template Library is the backbone of professional C++ programming. Every FAANG interview, every production system, and every high-performance application relies on STL containers, algorithms, and iterators. Yet most developers use only a fraction of its power. They reach for `std::vector` and `std::unordered_map` without understanding when a `std::deque` would outperform both, or why `std::lower_bound` on a sorted vector often beats `std::map::find`. They write raw loops where a single `std::transform` or `std::partition` would express intent more clearly and execute faster.

This chapter is a thorough tour of the STL. You will learn every major container's internal data structure, understand exactly when each operation is O(1), O(log n), or O(n), master iterator invalidation rules that trip up even experienced engineers in interviews, and write code using modern C++20 ranges that composes like functional programming. You will also see how Go's simpler standard library compares, understanding the trade-offs each language makes.

We begin with the containers that store your data, move to the iterators that traverse it, then to the algorithms that transform it, and finally to C++20 ranges that unify everything.

---

### Junior → FAANG: Building the Container Decision Matrix

Go engineers reaching for a data structure choose between slice, map, and channel. C++ has a much richer container vocabulary. Build a decision matrix before you need it: sorted lookup with range queries (use `std::map` or sorted `vector` + `lower_bound`), fast unsorted lookup (use `absl::flat_hash_map`), ordered sequence with fast front and back insertion (use `std::deque`), priority-based access (use `std::priority_queue`), fixed-size sequence (use `std::array`).

The most common mistake for Go engineers: defaulting to `std::unordered_map` the way Go defaults to `map`. The STL `std::unordered_map` is not the fastest hash map. `absl::flat_hash_map` is typically 2x faster. Know the difference and know when to use which.

Interview entry point: "what is the time complexity of `std::map::find` vs. `std::unordered_map::find` vs. `absl::flat_hash_map::find`?" Answer: O(log n), O(1) amortized (but with high constant factor), O(1) amortized (with SIMD-accelerated Swiss Table probing, lower constant factor).

### Senior @ FAANG: Container Selection Policy and Absl vs. STL for Production Use

At the staff level, container selection is a policy decision with performance, memory, and maintenance implications.

**Absl container policy.** Google's published Abseil guidance recommends `flat_hash_map` and `flat_hash_set` over STL's `unordered_map` and `unordered_set` as the default for new code. The reason: higher throughput, lower memory usage (no linked list of bucket chains), better cache behavior. A staff engineer aligns the team's container policy with this recommendation and adds a clang-tidy deprecation warning for `std::unordered_map` in new code.

**Container invalidation rules as a safety concern.** Each STL container has specific iterator invalidation rules (when insertions/removals invalidate existing iterators). Violating these rules is UB. A staff engineer ensures the team's code review checklist includes: "does this loop modify the container while iterating?" The safe pattern for concurrent modification is to collect elements to remove in a separate pass, then remove after the loop.

**Memory layout for cache performance.** `std::map` and `std::set` (node-based, pointer-chasing structures) have poor cache performance because each node is a separate heap allocation. For lookup-heavy hot paths, a sorted `std::vector` + `std::lower_bound` is often faster despite O(log n) because the data is contiguous. A staff engineer profiles both before choosing: "sorted vector beats map below 1000 elements in most cache-sensitive workloads" is a useful rule of thumb, validated with benchmarks for each specific case.

