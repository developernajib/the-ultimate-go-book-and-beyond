## Custom Comparators and Hash Functions

When you use user-defined types as keys in `std::map`, `std::set`, or their unordered counterparts, you need to tell the container how to compare or hash your type.

### Custom Comparators for Ordered Containers

Ordered containers accept a comparator type parameter, so a `std::set` or `std::map` can order elements by any strict-weak-ordering you define rather than by `operator<`.
```cpp
#include <set>
#include <map>
#include <string>
#include <iostream>

struct Point {
    double x, y;
    
    // Option 1: operator< for default ordering
    bool operator<(const Point& other) const {
        if (x != other.x) return x < other.x;
        return y < other.y;
    }
};

// Option 2: External comparator (functor)
struct PointByDistance {
    bool operator()(const Point& a, const Point& b) const {
        double da = a.x * a.x + a.y * a.y;
        double db = b.x * b.x + b.y * b.y;
        return da < db;
    }
};

int main() {
    // Uses operator<
    std::set<Point> points = {{1.0, 2.0}, {0.5, 3.0}, {1.0, 1.0}};
    
    // Uses custom comparator - sorted by distance from origin
    std::set<Point, PointByDistance> by_distance = {
        {3.0, 4.0},   // distance 5.0
        {1.0, 0.0},   // distance 1.0
        {2.0, 2.0}    // distance ~2.83
    };
    
    for (const auto& p : by_distance) {
        std::cout << "(" << p.x << ", " << p.y << ")\n";
    }
    // (1, 0), (2, 2), (3, 4) - sorted by distance
    
    // Lambda comparator with map
    auto case_insensitive = [](const std::string& a, const std::string& b) {
        return std::lexicographical_compare(
            a.begin(), a.end(), b.begin(), b.end(),
            [](char c1, char c2) { return std::tolower(c1) < std::tolower(c2); }
        );
    };
    
    std::map<std::string, int, decltype(case_insensitive)> ci_map(case_insensitive);
    ci_map["Alice"] = 1;
    ci_map["alice"] = 2;  // Same key (case-insensitive), overwrites
    ci_map["BOB"] = 3;
    
    for (const auto& [k, v] : ci_map) {
        std::cout << k << ": " << v << "\n";
    }
    // Alice: 2, BOB: 3
    
    return 0;
}
```

**Strict weak ordering requirement**: Your comparator must satisfy: irreflexivity (`!(a < a)`), asymmetry (if `a < b` then `!(b < a)`), transitivity (if `a < b` and `b < c` then `a < c`), and transitivity of incomparability. Violating these requirements is undefined behavior and can cause infinite loops, crashes, or corrupted data in the tree. A common bug is using `<=` instead of `<` as the comparator, which violates irreflexivity.

### Custom Hash Functions for Unordered Containers

Unordered containers need two things from a custom key type: a hash function and an equality predicate. Supplying both as template parameters lets `std::unordered_map` key on any type you own.
```cpp
#include <unordered_set>
#include <unordered_map>
#include <string>
#include <iostream>
#include <functional>

struct Point {
    double x, y;
    
    bool operator==(const Point& other) const {
        return x == other.x && y == other.y;
    }
};

// Option 1: Specializing std::hash
namespace std {
    template<>
    struct hash<Point> {
        size_t operator()(const Point& p) const {
            // Combine hashes of members
            size_t h1 = std::hash<double>{}(p.x);
            size_t h2 = std::hash<double>{}(p.y);
            // Boost-style hash combine
            return h1 ^ (h2 * 0x9e3779b9 + (h1 << 6) + (h1 >> 2));
        }
    };
}

// Option 2: External hash functor
struct PointHash {
    size_t operator()(const Point& p) const {
        auto h1 = std::hash<double>{}(p.x);
        auto h2 = std::hash<double>{}(p.y);
        return h1 ^ (h2 << 32);
    }
};

// Hashing composite keys (e.g., for memoization). This must live at
// namespace scope: local classes inside a function cannot declare
// member templates.
struct PairHash {
    template <typename T1, typename T2>
    size_t operator()(const std::pair<T1, T2>& p) const {
        auto h1 = std::hash<T1>{}(p.first);
        auto h2 = std::hash<T2>{}(p.second);
        return h1 ^ (h2 * 0x9e3779b9 + (h1 << 6) + (h1 >> 2));
    }
};

int main() {
    // Uses std::hash<Point> specialization
    std::unordered_set<Point> points;
    points.insert({1.0, 2.0});
    points.insert({3.0, 4.0});
    
    // Uses external functor
    std::unordered_set<Point, PointHash> points2;
    points2.insert({1.0, 2.0});
    
    std::unordered_map<std::pair<int, int>, std::string, PairHash> grid;
    grid[{0, 0}] = "origin";
    grid[{1, 2}] = "point A";
    
    std::cout << grid[{0, 0}] << "\n";  // origin
    
    return 0;
}
```

### Writing Good Hash Functions

A good hash function should:

1. **Distribute uniformly**: Minimize collisions across the bucket array.
2. **Be deterministic**: Same input always produces same output.
3. **Be fast**: Hash computation should not dominate lookup time.
4. **Use all fields**: Include all fields that participate in `operator==`. If two objects are equal, they must produce the same hash (but unequal objects may share a hash).

The boost-style hash combine formula `h1 ^ (h2 * 0x9e3779b9 + (h1 << 6) + (h1 >> 2))` is widely used because `0x9e3779b9` is derived from the golden ratio (`(sqrt(5)-1)/2 * 2^32`) and provides excellent bit mixing. Simple XOR (`h1 ^ h2`) is a poor combiner because it is symmetric (`hash(a,b) == hash(b,a)`) and `hash(x,x) == 0` for all x. A generic utility:

```cpp
#include <cstdint>
#include <functional>
#include <cstddef>

// Generic hash_combine utility
inline void hash_combine(size_t& seed, size_t value) {
    seed ^= value + 0x9e3779b9 + (seed << 6) + (seed >> 2);
}

template <typename T>
void hash_combine(size_t& seed, const T& val) {
    hash_combine(seed, std::hash<T>{}(val));
}

// Variadic helper: hash any number of fields
template <typename... Args>
size_t hash_values(const Args&... args) {
    size_t seed = 0;
    (hash_combine(seed, args), ...);  // C++17 fold expression
    return seed;
}

// Usage:
struct Employee {
    std::string name;
    int department;
    int64_t salary_cents;
    
    bool operator==(const Employee&) const = default;  // C++20
};

struct EmployeeHash {
    size_t operator()(const Employee& e) const {
        return hash_values(e.name, e.department, e.salary_cents);
    }
};
```

---

### Junior → FAANG: Implementing `operator<=>` and `absl::Hash` Before Custom Hash Functions

Go uses `==` for equality with comparable types and relies on map's built-in comparison. C++ requires either a custom comparator, a `<` operator (for ordered containers), or a custom hash (for unordered containers).

The modern C++ approach: define `operator<=>` (the spaceship operator, C++20) for your type, which generates all six comparison operators automatically. For hashing, use `absl::Hash` and implement `AbslHashValue` (Abseil's composable hash interface) rather than specializing `std::hash` manually. Abseil's hash is composable and avoids the pitfalls of naive hash implementations (XOR-only hashes have terrible collision behavior for structured data).

Interview note: "what is a well-distributed hash function for a struct with two integer fields?" The answer: combine the two hashes using a technique like FNV-1a folding, Boost's `hash_combine`, or Abseil's `AbslHashValue`. XOR of the two hashes is incorrect (XOR has symmetry that makes hash(x, y) == hash(y, x), causing extra collisions).

### Senior @ FAANG: Hash Function Quality as a Security and Performance Concern

At the staff level, the quality of hash functions for user-defined types is both a performance and security concern.

**Collision resistance.** A poorly distributed hash function degrades hash map performance from O(1) to O(n) in the worst case, and an adversarially chosen input distribution can trigger this worst case deliberately (hash DoS). Abseil's `absl::Hash` uses a high-quality hash (based on cityhash or similar) with per-process seed randomization, providing both quality distribution and DoS resistance. A staff engineer requires that all hash specializations for keys that may come from external input use `absl::Hash` rather than hand-rolled hash functions.

**Benchmarking hash quality.** A custom hash function should be validated for distribution quality before production use. Tools: `smhasher` (a hash function benchmark and distribution test suite). A staff engineer adds a smhasher test for any new hash function used on high-cardinality keys. Failures indicate clustering that will degrade map performance.

