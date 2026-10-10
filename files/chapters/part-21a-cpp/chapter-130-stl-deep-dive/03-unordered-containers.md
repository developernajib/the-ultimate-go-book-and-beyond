## Unordered Containers

Unordered containers provide average O(1) lookup using hash tables. The STL provides `unordered_map`, `unordered_set`, `unordered_multimap`, and `unordered_multiset`.

### Hash Table Internals

The STL unordered containers use **separate chaining**. The internal structure is:

1. A **bucket array**: a contiguous array of pointers, where each pointer is the head of a linked list (chain).
2. To insert key `k`: compute `hash(k) % bucket_count`, then append to that bucket's chain.
3. To find key `k`: compute the bucket, then linear-scan the chain.

```
Bucket array:
[0] -> nullptr
[1] -> Node("Bob":25) -> nullptr
[2] -> Node("Alice":30) -> Node("Charlie":35) -> nullptr
[3] -> nullptr
[4] -> Node("Diana":28) -> nullptr
```

In practice, most implementations use a single linked list for all elements, with the bucket array storing iterators into that list. This design (used by GCC's libstdc++) simplifies rehashing because elements don't need to be moved, only the bucket array is reallocated and the list is repartitioned.

**Load factor** is `size / bucket_count`. When it exceeds `max_load_factor()` (default 1.0), the table **rehashes**: allocates a larger bucket array (typically 2x), then re-inserts every element. This is O(n) and invalidates all iterators. With a load factor of 1.0, the average chain length is 1, so the expected number of comparisons per lookup is approximately 1 (assuming good hash distribution).

```cpp
#include <unordered_map>
#include <iostream>
#include <string>

int main() {
    std::unordered_map<std::string, int> um;
    
    // Pre-allocate buckets to avoid rehashing
    um.reserve(100);  // Allocates enough buckets for 100 elements
    
    um["Alice"] = 30;
    um["Bob"] = 25;
    um["Charlie"] = 35;
    
    std::cout << "bucket_count: " << um.bucket_count() << "\n";
    std::cout << "load_factor: " << um.load_factor() << "\n";
    std::cout << "max_load_factor: " << um.max_load_factor() << "\n";
    
    // Examine individual buckets
    for (size_t i = 0; i < um.bucket_count(); ++i) {
        if (um.bucket_size(i) > 0) {
            std::cout << "Bucket " << i << " has " 
                      << um.bucket_size(i) << " elements\n";
        }
    }
    
    // O(1) average lookup
    auto it = um.find("Alice");
    if (it != um.end()) {
        std::cout << it->first << ": " << it->second << "\n";
    }
    
    // try_emplace (C++17): insert only if key doesn't exist
    // Does NOT move from the argument if key already exists
    um.try_emplace("Alice", 999);  // No-op, Alice already exists
    um.try_emplace("Eve", 22);     // Inserts Eve:22
    
    // insert_or_assign (C++17): insert or overwrite
    um.insert_or_assign("Alice", 31);  // Updates Alice to 31
    
    return 0;
}
```

### Controlling Rehashing and Performance

Without a pre-allocated bucket count, inserting 1 million elements triggers repeated rehash operations as the load factor exceeds the default maximum. Calling `reserve(n)` before insertion sets enough buckets to hold `n` elements at the current `max_load_factor`, eliminating all rehashes and significantly reducing insertion time for large collections.
```cpp
#include <unordered_set>
#include <iostream>
#include <chrono>

int main() {
    // Bad: frequent rehashing
    {
        std::unordered_set<int> s;
        auto start = std::chrono::high_resolution_clock::now();
        for (int i = 0; i < 1'000'000; ++i) {
            s.insert(i);
        }
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
        std::cout << "Without reserve: " << ms.count() << " ms\n";
    }
    
    // Good: reserve upfront
    {
        std::unordered_set<int> s;
        s.reserve(1'000'000);
        auto start = std::chrono::high_resolution_clock::now();
        for (int i = 0; i < 1'000'000; ++i) {
            s.insert(i);
        }
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start);
        std::cout << "With reserve:    " << ms.count() << " ms\n";
    }
    
    // Adjust max_load_factor for speed vs memory trade-off
    std::unordered_set<int> s;
    s.max_load_factor(0.5);  // Fewer collisions, more memory
    // s.max_load_factor(2.0);  // More collisions, less memory
    
    return 0;
}
```

**Hash collision attacks**: If an attacker can control the keys inserted into an `unordered_map`, they can craft keys that all hash to the same bucket, degrading every operation to O(n). This is a real denial-of-service attack vector in web servers and parsers. Defenses include: randomized hash seeds (some implementations do this), switching to a hash function that is hard to predict (like SipHash), or using `std::map` when processing untrusted input. Go's built-in map uses randomized hash seeds by default for exactly this reason.

**When to use unordered containers**: When you need average O(1) lookup and don't need sorted order. They outperform ordered containers for large datasets when the hash function distributes well. Beware worst-case O(n) per operation if all keys hash to the same bucket. Always call `reserve()` when you know the approximate number of elements to avoid expensive rehashing during insertion.

### Alternative Hash Map Implementations

The STL's `unordered_map` uses separate chaining, which has poor cache locality due to linked list traversal. In performance-critical code, many teams replace it with open-addressing hash maps:

- **Abseil's `flat_hash_map`** (Google): Uses open addressing with Swiss table probing. 2-3x faster than `std::unordered_map` for most workloads.
- **Robin Hood hashing**: Reduces variance in probe lengths by "stealing" from rich buckets. Available in `robin_hood::unordered_map`.
- **`boost::unordered_flat_map`** (Boost 1.81+): Open-addressing implementation with excellent performance.

If you are using `unordered_map` in a hot path and profiling shows it as a bottleneck, consider these alternatives before switching to a different data structure entirely.

---

### Junior → FAANG: Hash Map Selection Is Not Trivial

Go's built-in map (since Go 1.24, a Swiss Table implementation similar to Abseil's) is well-tuned for general use. C++'s `std::unordered_map` is the standard but not the best choice for performance-critical code. Know the hierarchy: `std::unordered_map` (standard, slowest), `absl::flat_hash_map` (Swiss Table, 2x faster, SIMD probing), `folly::F14FastMap` (Meta's Swiss Table implementation, similar performance).

Interview answer to "which hash map would you use in a C++ service that does 10M lookups per second?": `absl::flat_hash_map` if you are using Abseil (Google-origin codebase), `folly::F14FastMap` if you are using Folly (Meta-origin codebase), and `std::unordered_map` only if neither is available and you cannot vendor a faster alternative.

### Senior @ FAANG: Hash Map Security, Denial of Service, and Randomized Hashing

At the staff level, hash maps in production services that accept external input have a security concern: hash collision DoS. An attacker who knows your hash function can craft input keys that all hash to the same bucket, degrading lookups from O(1) to O(n) and causing a DoS.

**Randomized hashing.** `absl::flat_hash_map` uses per-process randomization by default, making hash collision DoS attacks impractical. `std::unordered_map` with the default `std::hash<std::string>` is implementation-defined: libstdc++ uses a non-randomized hash for strings, making it vulnerable. A staff engineer ensures that hash maps used with external input keys use a randomized hash (Abseil's default, or by providing `absl::Hash` as the hasher).

**Monitoring hash map performance.** In a production service, a sudden increase in hash map lookup latency (from hash collisions or resize operations) can masquerade as a service-level latency increase. A staff engineer adds a metric for hash map load factor (or resize frequency) to the service's observability layer, allowing correlation between latency spikes and hash map events.

