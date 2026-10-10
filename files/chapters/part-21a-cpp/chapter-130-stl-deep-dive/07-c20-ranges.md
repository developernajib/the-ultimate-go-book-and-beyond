## C++20 Ranges

Ranges are the most significant addition to the STL since its creation. They replace iterator pairs with range objects, support lazy evaluation through views, and allow pipeline-style composition using the pipe operator. If you have ever used LINQ in C#, Java Streams, or Rust iterators, C++20 ranges will feel familiar.

### Why Ranges?

The traditional STL requires passing `begin()` and `end()` iterators everywhere, which is verbose and error-prone (you can accidentally pass iterators from different containers). Ranges solve this by treating an entire container as a single argument.

```cpp
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <ranges>
#include <vector>

int main() {
    std::vector<int> v = {5, 3, 8, 1, 9, 2, 7, 4, 6};
    
    // Traditional STL
    std::sort(v.begin(), v.end());
    
    // Ranges: pass the container directly
    std::ranges::sort(v);
    
    // Traditional: find
    auto it = std::find(v.begin(), v.end(), 5);
    
    // Ranges: cleaner
    auto it2 = std::ranges::find(v, 5);
    
    // Ranges with projections - no need for custom comparators
    struct Employee {
        std::string name;
        int64_t salary_cents;
    };
    
    std::vector<Employee> employees = {
        {"Alice", 90'000'00LL}, {"Bob", 75'000'00LL}, {"Charlie", 120'000'00LL}
    };
    
    // Sort by salary using projection instead of custom comparator
    std::ranges::sort(employees, {}, &Employee::salary_cents);
    // Sorted by salary ascending: Bob, Alice, Charlie
    
    // Find by name using projection
    auto emp = std::ranges::find(employees, "Alice", &Employee::name);
    if (emp != employees.end()) {
        std::cout << emp->name << " earns " << (emp->salary_cents / 100) << "\n";
    }
    
    // Projections work with any algorithm
    auto max_earner = std::ranges::max_element(employees, {}, &Employee::salary_cents);
    std::cout << "Highest paid: " << max_earner->name << "\n";
    
    return 0;
}
```

**Projections** eliminate a major source of verbosity. Instead of writing a custom comparator that extracts a member and compares it, you pass a "projection" function that tells the algorithm which field to look at. The default comparator (`{}`, which becomes `std::less<>`) then operates on the projected values. This eliminates a huge amount of boilerplate.

### Views: Lazy, Composable Transformations

Views are lightweight objects that describe a transformation without materializing it. They evaluate lazily, only computing elements when accessed. Creating a view is O(1), no data is copied or processed.

```cpp
#include <ranges>
#include <vector>
#include <iostream>
#include <string>

int main() {
    std::vector<int> v = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
    
    // filter + transform, composed with pipe operator
    auto result = v 
        | std::views::filter([](int x) { return x % 2 == 0; })
        | std::views::transform([](int x) { return x * x; });
    
    // Nothing computed yet - lazy evaluation
    for (int x : result) {
        std::cout << x << " ";
    }
    std::cout << "\n";  // 4 16 36 64 100
    
    // take: first N elements
    auto first_three = v | std::views::take(3);
    for (int x : first_three) std::cout << x << " ";
    std::cout << "\n";  // 1 2 3
    
    // drop: skip first N elements
    auto after_three = v | std::views::drop(3);
    for (int x : after_three) std::cout << x << " ";
    std::cout << "\n";  // 4 5 6 7 8 9 10
    
    // reverse
    auto reversed = v | std::views::reverse;
    for (int x : reversed) std::cout << x << " ";
    std::cout << "\n";  // 10 9 8 7 6 5 4 3 2 1
    
    // iota: generate a range of values
    for (int x : std::views::iota(1, 6)) {
        std::cout << x << " ";
    }
    std::cout << "\n";  // 1 2 3 4 5
    
    // Complex pipeline: FizzBuzz with ranges
    auto fizzbuzz = std::views::iota(1, 21)
        | std::views::transform([](int i) -> std::string {
            if (i % 15 == 0) return "FizzBuzz";
            if (i % 3 == 0)  return "Fizz";
            if (i % 5 == 0)  return "Buzz";
            return std::to_string(i);
        });
    
    for (const auto& s : fizzbuzz) {
        std::cout << s << " ";
    }
    std::cout << "\n";
    
    // take_while / drop_while
    auto until_big = v | std::views::take_while([](int x) { return x < 7; });
    for (int x : until_big) std::cout << x << " ";
    std::cout << "\n";  // 1 2 3 4 5 6
    
    return 0;
}
```

### Views Are Non-Owning and Cheap

A range view is a lazy description of a transformation, not a copy of the data. Constructing `even_squares` with `filter` and `transform` is O(1), no elements are processed. Elements are evaluated one by one only when iterated, so a pipeline of five views over a million-element vector does not allocate any intermediate storage.
```cpp
#include <ranges>
#include <vector>
#include <iostream>

int main() {
    std::vector<int> data = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
    
    // Create a view - O(1), no data copied
    auto even_squares = data
        | std::views::filter([](int x) { return x % 2 == 0; })
        | std::views::transform([](int x) { return x * x; });
    
    // The view is just a description of the computation.
    // It references `data` - does not own a copy.
    // Modifying `data` changes what the view sees.
    data[1] = 20;  // Change 2 to 20
    
    for (int x : even_squares) {
        std::cout << x << " ";
    }
    std::cout << "\n";  // 400 16 36 64 100  (20*20=400 instead of 2*2=4)
    
    // Materialize a view into a container
    auto view = std::views::iota(1, 6)
                | std::views::transform([](int x) { return x * 10; });
    
    std::vector<int> materialized(view.begin(), view.end());
    // materialized: {10, 20, 30, 40, 50}
    
    // In C++23: auto materialized = view | std::ranges::to<std::vector>();
    
    return 0;
}
```

### Keys and Values Views for Maps

`std::views::keys` and `std::views::values` produce lazy views over the first and second elements of a map's key-value pairs respectively. Combining them with `std::ranges::to<std::vector>` (C++23) or a loop avoids writing manual `for (const auto& [k, v] : map)` destructuring when you need only one part of the pair.
```cpp
#include <ranges>
#include <map>
#include <iostream>
#include <string>

int main() {
    std::map<std::string, int> scores = {
        {"Alice", 95}, {"Bob", 87}, {"Charlie", 92}
    };
    
    // Iterate over keys only
    std::cout << "Names: ";
    for (const auto& name : scores | std::views::keys) {
        std::cout << name << " ";
    }
    std::cout << "\n";  // Alice Bob Charlie
    
    // Iterate over values only
    std::cout << "Scores: ";
    for (int score : scores | std::views::values) {
        std::cout << score << " ";
    }
    std::cout << "\n";  // 95 87 92
    
    // Filter by value then extract keys
    auto high_scorers = scores
        | std::views::filter([](const auto& pair) { return pair.second >= 90; })
        | std::views::keys;
    
    std::cout << "High scorers: ";
    for (const auto& name : high_scorers) {
        std::cout << name << " ";
    }
    std::cout << "\n";  // Alice Charlie
    
    // enumerate (C++23) - like Python's enumerate
    // for (auto [i, val] : v | std::views::enumerate) { ... }
    
    return 0;
}
```

### Views Available in C++20 and C++23

| View | Description | Standard |
|------|:---|:---:|
| `filter` | Elements matching a predicate | C++20 |
| `transform` | Apply function to each element | C++20 |
| `take` | First N elements | C++20 |
| `drop` | Skip first N elements | C++20 |
| `take_while` | Elements until predicate fails | C++20 |
| `drop_while` | Skip until predicate fails | C++20 |
| `reverse` | Reverse order | C++20 |
| `keys` | First element of pairs/tuples | C++20 |
| `values` | Second element of pairs/tuples | C++20 |
| `elements<N>` | Nth element of tuples | C++20 |
| `iota` | Generate incrementing values | C++20 |
| `split` | Split range by delimiter | C++20 |
| `join` | Flatten range of ranges | C++20 |
| `common` | Convert to common iterator type | C++20 |
| `zip` | Combine multiple ranges | C++23 |
| `enumerate` | Add index to elements | C++23 |
| `chunk` | Split into fixed-size chunks | C++23 |
| `slide` | Sliding window over elements | C++23 |
| `stride` | Take every Nth element | C++23 |

---
