## Algorithms

The `<algorithm>` header contains over 100 algorithms that operate on iterator ranges. They are generic, efficient, and the preferred way to manipulate data in C++. The header `<numeric>` adds numerical algorithms like `accumulate`, `inner_product`, and `partial_sum`.

### Sorting

`std::sort` uses **introsort**: a hybrid of quicksort, heapsort, and insertion sort. It starts with quicksort for its excellent average performance, switches to heapsort if the recursion depth exceeds 2 * log2(n) (to guarantee O(n log n) worst case), and uses insertion sort for small partitions (typically less than 16 elements) because insertion sort has lower overhead for nearly-sorted small arrays.

```cpp
#include <algorithm>
#include <vector>
#include <iostream>
#include <string>

int main() {
    std::vector<int> v = {5, 2, 8, 1, 9, 3, 7, 4, 6};
    
    // Basic sort: O(n log n), introsort
    std::sort(v.begin(), v.end());
    // v: {1, 2, 3, 4, 5, 6, 7, 8, 9}
    
    // Sort descending with custom comparator
    std::sort(v.begin(), v.end(), std::greater<int>());
    // v: {9, 8, 7, 6, 5, 4, 3, 2, 1}
    
    // Stable sort preserves relative order of equal elements
    // Uses merge sort (O(n log n) with O(n) extra memory)
    struct Student {
        std::string name;
        int grade;
    };
    std::vector<Student> students = {
        {"Alice", 90}, {"Bob", 85}, {"Charlie", 90}, {"Diana", 85}
    };
    
    std::stable_sort(students.begin(), students.end(),
        [](const Student& a, const Student& b) {
            return a.grade > b.grade;
        });
    // Order: Alice(90), Charlie(90), Bob(85), Diana(85)
    // Same-grade students maintain original relative order
    
    // Partial sort: get top-k elements sorted, rest unspecified
    // O(n log k) - faster than full sort when k << n
    std::vector<int> data = {9, 3, 7, 1, 5, 8, 2, 6, 4};
    std::partial_sort(data.begin(), data.begin() + 3, data.end());
    // First 3 elements are {1, 2, 3}, rest are unspecified order
    
    // nth_element: O(n) average, partitions around nth element
    // Uses introselect (quickselect + median of medians fallback)
    std::vector<int> scores = {50, 20, 80, 10, 90, 30, 70, 40, 60};
    std::nth_element(scores.begin(), scores.begin() + 4, scores.end());
    // scores[4] == 50 (the median)
    // Elements before index 4 are all <= 50
    // Elements after index 4 are all >= 50
    std::cout << "Median: " << scores[4] << "\n";
    
    return 0;
}
```

**Choosing the right sort**:
- Need full sort: `std::sort` (fastest general purpose)
- Need stability (equal elements keep original order): `std::stable_sort`
- Need only top-k sorted: `std::partial_sort` (faster when k is small)
- Need only the k-th element (no sorting needed): `std::nth_element` (linear time)
- Need to check if already sorted: `std::is_sorted`

### Binary Search Operations

These require a sorted range. They all use O(log n) comparisons.

```cpp
#include <algorithm>
#include <vector>
#include <iostream>

int main() {
    std::vector<int> v = {1, 2, 4, 4, 4, 6, 7, 9};
    
    // binary_search: returns bool (not an iterator!)
    bool found = std::binary_search(v.begin(), v.end(), 4);
    std::cout << "Found 4: " << found << "\n";  // 1
    
    // lower_bound: iterator to first element >= value
    auto lo = std::lower_bound(v.begin(), v.end(), 4);
    std::cout << "lower_bound(4) at index " 
              << (lo - v.begin()) << "\n";  // index 2
    
    // upper_bound: iterator to first element > value
    auto hi = std::upper_bound(v.begin(), v.end(), 4);
    std::cout << "upper_bound(4) at index " 
              << (hi - v.begin()) << "\n";  // index 5
    
    // Count of 4s: upper_bound - lower_bound
    std::cout << "Count of 4: " << (hi - lo) << "\n";  // 3
    
    // equal_range: returns pair of (lower_bound, upper_bound)
    auto [first, last] = std::equal_range(v.begin(), v.end(), 4);
    std::cout << "Range of 4: [" << (first - v.begin()) 
              << ", " << (last - v.begin()) << ")\n";
    
    // Practical use: insert maintaining sorted order
    std::vector<int> sorted = {1, 3, 5, 7, 9};
    auto pos = std::lower_bound(sorted.begin(), sorted.end(), 6);
    sorted.insert(pos, 6);
    // sorted: {1, 3, 5, 6, 7, 9}
    
    // Practical use: check if value is NOT in sorted range
    auto it = std::lower_bound(sorted.begin(), sorted.end(), 8);
    bool exists = (it != sorted.end() && *it == 8);
    std::cout << "8 exists: " << exists << "\n";  // 0
    
    return 0;
}
```

**lower_bound vs upper_bound**: Think of it this way: for a value `x` in a sorted range, `lower_bound` returns an iterator to where `x` would be inserted to maintain order (before any existing copies of `x`), and `upper_bound` returns where `x` would be inserted after any existing copies. The range `[lower_bound, upper_bound)` contains all copies of `x`.

### Partitioning

`std::partition` rearranges elements so all that satisfy the predicate come before those that do not, returning an iterator to the first non-satisfying element. `std::stable_partition` preserves relative order within each group at the cost of O(n log n) time. Both are the idiomatic alternative to manually writing a two-pointer partition loop.
```cpp
#include <algorithm>
#include <vector>
#include <iostream>

int main() {
    std::vector<int> v = {1, 8, 3, 7, 2, 9, 4, 6, 5};
    
    // partition: rearranges so predicate-true elements come first
    // Returns iterator to first predicate-false element
    auto pivot = std::partition(v.begin(), v.end(),
                                [](int x) { return x <= 5; });
    
    std::cout << "Partition point value: " << *pivot << "\n";
    std::cout << "<= 5: ";
    for (auto it = v.begin(); it != pivot; ++it) {
        std::cout << *it << " ";
    }
    std::cout << "\n> 5: ";
    for (auto it = pivot; it != v.end(); ++it) {
        std::cout << *it << " ";
    }
    std::cout << "\n";
    
    // stable_partition: preserves relative order within each group
    std::vector<int> v2 = {1, 8, 3, 7, 2, 9, 4, 6, 5};
    auto pivot2 = std::stable_partition(v2.begin(), v2.end(),
                                        [](int x) { return x % 2 == 0; });
    // Even numbers in original order, then odd numbers in original order
    for (int x : v2) std::cout << x << " ";
    std::cout << "\n";  // 8 2 4 6 1 3 7 9 5
    
    // partition_point: finds the partition point of an already-partitioned range
    // O(log n) - uses binary search
    auto pp = std::partition_point(v2.begin(), v2.end(),
                                    [](int x) { return x % 2 == 0; });
    std::cout << "First odd: " << *pp << "\n";  // 1
    
    return 0;
}
```

### Transform, Accumulate, and Functional Operations

`std::transform` maps a unary or binary function over one or two input ranges into an output range. `std::accumulate` folds a range into a single value using an initial accumulator and a binary operation (defaulting to addition). Together they compose the functional map/reduce pattern familiar from Go's manual loops, but expressed declaratively without hand-written iteration.
```cpp
#include <algorithm>
#include <numeric>
#include <vector>
#include <string>
#include <iostream>
#include <functional>

int main() {
    std::vector<int> v = {1, 2, 3, 4, 5};
    
    // transform: apply function to each element
    std::vector<int> squared;
    std::transform(v.begin(), v.end(), std::back_inserter(squared),
                   [](int x) { return x * x; });
    // squared: {1, 4, 9, 16, 25}
    
    // In-place transform
    std::transform(v.begin(), v.end(), v.begin(),
                   [](int x) { return x * 2; });
    // v: {2, 4, 6, 8, 10}
    
    // transform with two input ranges
    std::vector<int> a = {1, 2, 3};
    std::vector<int> b = {10, 20, 30};
    std::vector<int> sums;
    std::transform(a.begin(), a.end(), b.begin(), std::back_inserter(sums),
                   std::plus<int>());
    // sums: {11, 22, 33}
    
    // accumulate: fold/reduce
    v = {1, 2, 3, 4, 5};
    int sum = std::accumulate(v.begin(), v.end(), 0);
    std::cout << "Sum: " << sum << "\n";  // 15
    
    int product = std::accumulate(v.begin(), v.end(), 1, std::multiplies<int>());
    std::cout << "Product: " << product << "\n";  // 120
    
    // accumulate for string concatenation
    std::vector<std::string> words = {"Hello", " ", "World", "!"};
    std::string sentence = std::accumulate(words.begin(), words.end(), std::string());
    std::cout << sentence << "\n";  // Hello World!
    
    // inner_product: dot product
    std::vector<double> x = {1.0, 2.0, 3.0};
    std::vector<double> y = {4.0, 5.0, 6.0};
    double dot = std::inner_product(x.begin(), x.end(), y.begin(), 0.0);
    std::cout << "Dot product: " << dot << "\n";  // 32.0
    
    // partial_sum: running total (prefix sum)
    std::vector<int> prefix;
    std::partial_sum(v.begin(), v.end(), std::back_inserter(prefix));
    // prefix: {1, 3, 6, 10, 15}
    
    // iota: fill with incrementing values
    std::vector<int> indices(10);
    std::iota(indices.begin(), indices.end(), 0);
    // indices: {0, 1, 2, 3, 4, 5, 6, 7, 8, 9}
    
    // C++17 parallel reduce (can be parallelized, unlike accumulate)
    // #include <execution>
    // auto par_sum = std::reduce(std::execution::par, v.begin(), v.end(), 0);
    
    return 0;
}
```

**accumulate vs reduce**: `std::accumulate` processes elements strictly left-to-right. `std::reduce` (C++17) can process in any order, which enables parallel execution with `std::execution::par`. For operations that are both associative and commutative (like integer addition), the results are identical. For floating-point addition (which is not truly associative due to rounding), results may differ slightly.

### The remove-erase Idiom and Other Erasure Patterns

The remove-erase idiom is the canonical pattern for removing elements from standard sequence containers in C++:
```cpp
#include <algorithm>
#include <vector>
#include <iostream>

int main() {
    std::vector<int> v = {1, 2, 3, 2, 5, 2, 7};
    
    // std::remove does NOT actually remove elements!
    // It moves non-matching elements to the front and returns
    // an iterator to the "new end"
    auto new_end = std::remove(v.begin(), v.end(), 2);
    // v is now {1, 3, 5, 7, ?, ?, ?} where ? is unspecified
    // new_end points to first ?
    
    // Must erase the tail
    v.erase(new_end, v.end());
    // v: {1, 3, 5, 7}
    
    // One-liner: erase-remove idiom
    std::vector<int> v2 = {1, 2, 3, 2, 5, 2, 7};
    v2.erase(std::remove(v2.begin(), v2.end(), 2), v2.end());
    
    // C++20 made this simpler:
    // std::erase(v2, 2);
    // std::erase_if(v2, [](int x) { return x % 2 == 0; });
    
    // unique: remove consecutive duplicates (sort first for all duplicates)
    std::vector<int> v3 = {3, 1, 2, 1, 3, 2, 1};
    std::sort(v3.begin(), v3.end());
    v3.erase(std::unique(v3.begin(), v3.end()), v3.end());
    // v3: {1, 2, 3}
    
    for (int x : v3) std::cout << x << " ";
    std::cout << "\n";
    
    return 0;
}
```

**Why `std::remove` doesn't actually remove**: STL algorithms operate on iterator ranges, not containers. They have no knowledge of the container that owns the iterators, so they cannot change the container's size. They can only rearrange elements within the range. The container's `erase` method, which does know the container, is needed to actually shrink it.

### Other Essential Algorithms

`std::minmax_element` finds both the minimum and maximum in a single O(n) pass using at most 3n/2 comparisons, which is fewer than calling `min_element` and `max_element` separately. `std::count_if`, `std::any_of`, and `std::all_of` provide expressive one-liners for querying predicates over a range without requiring explicit loops.
```cpp
#include <algorithm>
#include <vector>
#include <iostream>

int main() {
    std::vector<int> v = {3, 1, 4, 1, 5, 9, 2, 6};
    
    // min_element / max_element: O(n)
    auto min_it = std::min_element(v.begin(), v.end());
    auto max_it = std::max_element(v.begin(), v.end());
    std::cout << "Min: " << *min_it << " Max: " << *max_it << "\n";
    
    // minmax_element: finds both in a single pass (fewer comparisons)
    auto [lo, hi] = std::minmax_element(v.begin(), v.end());
    
    // all_of / any_of / none_of
    bool all_positive = std::all_of(v.begin(), v.end(), [](int x) { return x > 0; });
    bool has_negative = std::any_of(v.begin(), v.end(), [](int x) { return x < 0; });
    
    // for_each: apply function to each element (side effects)
    std::for_each(v.begin(), v.end(), [](int& x) { x *= 2; });
    
    // copy_if: selective copy
    std::vector<int> evens;
    std::copy_if(v.begin(), v.end(), std::back_inserter(evens),
                 [](int x) { return x % 2 == 0; });
    
    // rotate: rotate elements left
    std::vector<int> r = {1, 2, 3, 4, 5};
    std::rotate(r.begin(), r.begin() + 2, r.end());
    // r: {3, 4, 5, 1, 2}
    
    // next_permutation: generates permutations in lexicographic order
    std::vector<int> p = {1, 2, 3};
    do {
        for (int x : p) std::cout << x << " ";
        std::cout << "\n";
    } while (std::next_permutation(p.begin(), p.end()));
    // Prints all 6 permutations of {1, 2, 3}
    
    return 0;
}
```

---

### Junior → FAANG: Replacing Raw Loops With Algorithms

The single biggest readability improvement a Go engineer can make in C++ code is replacing raw loops with algorithms. A raw `for` loop that finds the minimum element is less readable and no faster than `std::min_element`. A raw loop that copies elements satisfying a condition is less readable than `std::copy_if`.

Practice: take five Go loops from your recent work, identify the intent of each (transform, filter, find, sort, accumulate), and write the C++ algorithm equivalent. This exercise builds the algorithm vocabulary that separates C++ engineers who write idiomatic code from those who write C with classes.

Interview signal: mentioning `std::partition` as an O(n) alternative to sorting when you only need elements separated by a condition, or mentioning `std::nth_element` as O(n) for finding the k-th element, signals algorithmic depth.

### Senior @ FAANG: Algorithm Policy, Parallel STL, and C++20 Ranges

At the staff level, algorithm usage is a code quality and performance policy.

**Parallel STL execution policies.** C++17 added execution policies (`std::execution::par`, `std::execution::par_unseq`) that request parallel or vectorized execution of standard algorithms. `std::sort(std::execution::par, v.begin(), v.end())` uses thread parallelism. `std::for_each(std::execution::par_unseq, v.begin(), v.end(), f)` uses both thread parallelism and SIMD. A staff engineer evaluates parallel algorithms for data-parallel workloads before writing custom thread pool code, since the standard library implementation (TBB on many platforms) is well-tuned.

**C++20 ranges as the modern algorithm interface.** `std::ranges::sort(v)` replaces `std::sort(v.begin(), v.end())` with a cleaner interface that also enables composable range adaptors (`v | std::views::filter(pred) | std::views::transform(f)`). A staff engineer adopts ranges in new code (where the compiler supports them) and migrates iterator-pair algorithms incrementally. The transition reduces error surface (no mismatched begin/end iterators) and improves readability.

