## Exercises

### Exercise 1: Container Selection

For each scenario, choose the optimal STL container and justify your choice:

1. A web server needs to cache the 1000 most recently accessed URLs with their response data. Lookups must be O(1).
2. An event system where listeners subscribe and unsubscribe frequently, and events are dispatched to all listeners in order.
3. A leaderboard that always shows the top 10 scores, updated in real-time with millions of score submissions.
4. A task scheduler that processes highest-priority tasks first.
5. A text editor's undo/redo system.
6. A dictionary that maps words to definitions, where you need to support prefix search ("find all words starting with 'pre'").
7. A system that tracks unique visitor IPs, where you need to count uniques at the end but order doesn't matter.

### Exercise 2: Implement an LRU Cache

Build a Least Recently Used cache using STL containers. It must support O(1) `get` and O(1) `put`. This is LeetCode problem #146 and a classic FAANG interview question.

```cpp
#include <unordered_map>
#include <list>
#include <stdexcept>
#include <iostream>

template <typename Key, typename Value>
class LRUCache {
public:
    explicit LRUCache(size_t capacity) : capacity_(capacity) {}
    
    Value get(const Key& key) {
        auto it = map_.find(key);
        if (it == map_.end()) {
            throw std::runtime_error("Key not found");
        }
        // Move accessed item to front of list (most recently used)
        order_.splice(order_.begin(), order_, it->second);
        return it->second->second;
    }
    
    void put(const Key& key, const Value& value) {
        auto it = map_.find(key);
        if (it != map_.end()) {
            // Update existing: move to front, update value
            it->second->second = value;
            order_.splice(order_.begin(), order_, it->second);
            return;
        }
        
        // Evict LRU (back of list) if at capacity
        if (map_.size() >= capacity_) {
            auto lru = order_.back();
            map_.erase(lru.first);
            order_.pop_back();
        }
        
        // Insert new item at front
        order_.emplace_front(key, value);
        map_[key] = order_.begin();
    }
    
private:
    size_t capacity_;
    // Doubly-linked list: front = most recent, back = least recent
    std::list<std::pair<Key, Value>> order_;
    // Hash map: key -> iterator into the list
    std::unordered_map<Key, typename std::list<std::pair<Key, Value>>::iterator> map_;
};

int main() {
    LRUCache<std::string, int> cache(3);
    
    cache.put("a", 1);
    cache.put("b", 2);
    cache.put("c", 3);
    
    std::cout << cache.get("a") << "\n";  // 1 (moves "a" to front)
    
    cache.put("d", 4);  // Evicts "b" (least recently used)
    
    try {
        cache.get("b");  // Throws: "b" was evicted
    } catch (const std::runtime_error& e) {
        std::cout << "Caught: " << e.what() << "\n";
    }
    
    std::cout << cache.get("c") << "\n";  // 3
    std::cout << cache.get("d") << "\n";  // 4
    
    return 0;
}
```

**Why `list` + `unordered_map`?** The list provides O(1) move-to-front (via `splice`) and O(1) eviction from the back (via `pop_back`). The hash map provides O(1) key-to-node lookup. List iterators are never invalidated by splice or other list operations, which is critical for the map values to remain valid. This is one of the few cases where `std::list` is genuinely the best container choice.

### Exercise 3: Range Pipeline

Using C++20 ranges, write a single pipeline expression that:
1. Takes a vector of integers
2. Filters out negative numbers
3. Squares each remaining number
4. Takes only the first 5 results
5. Prints them

```cpp
#include <ranges>
#include <vector>
#include <iostream>

int main() {
    std::vector<int> data = {-3, 1, -7, 4, 2, -1, 8, 3, -5, 6, 9, -2};
    
    auto result = data
        | std::views::filter([](int x) { return x >= 0; })
        | std::views::transform([](int x) { return x * x; })
        | std::views::take(5);
    
    for (int x : result) {
        std::cout << x << " ";
    }
    std::cout << "\n";  // 1 16 4 64 9
    
    return 0;
}
```

### Exercise 4: Custom Iterator

Implement a `FibonacciIterator` that generates Fibonacci numbers lazily. It should be a forward iterator that works with `std::ranges::take_while` and other STL algorithms. Test it by printing all Fibonacci numbers less than 1000.

### Exercise 5: Performance Comparison

Write a benchmark that compares:
- `std::vector` (sorted, with `std::lower_bound`) vs `std::set` vs `std::unordered_set` for 1 million lookups after inserting 100,000 elements.
- Measure insert time and lookup time separately.
- Explain why sorted vector often wins for read-heavy workloads despite O(log n) search vs O(1) hash lookup.

Hint: the answer involves cache line utilization. Binary search on a contiguous array touches O(log n) cache lines, while the hash table may touch 2+ cache lines per lookup (one for the bucket array, one or more for the chain). For small to medium datasets that fit in L2/L3 cache, the sorted vector's superior cache locality often wins.

### Exercise 6: Iterator Invalidation Bug Hunt

Find and fix the bug in this code:

```cpp
std::unordered_map<int, std::string> m = {{1,"a"}, {2,"b"}, {3,"c"}, {4,"d"}};
for (auto it = m.begin(); it != m.end(); ++it) {
    if (it->first % 2 == 0) {
        m.erase(it);
    }
}
```

---

### Junior → FAANG: STL Exercises as Algorithm Fluency Drills

The container selection and algorithm exercises here are the STL equivalent of LeetCode problems: they test whether you know which tool to reach for in each scenario. A Go engineer who can answer "when would you use `std::deque` over `std::vector`?" (when you need O(1) front insertion/removal without invalidating all iterators) and "when would you use `std::partition` over `std::sort`?" (when you only need elements separated, not fully sorted, and O(n) beats O(n log n)) has developed the STL fluency that FAANG C++ interviews test.

### Senior @ FAANG: STL Proficiency as a Code Review Standard

At the staff level, requiring idiomatic STL usage in code review is a compounding quality investment. Every raw loop that is replaced by an algorithm reduces the code's cognitive load, reduces the surface area for off-by-one errors, and signals to the next maintainer that the intent is clear. A staff engineer establishes this as a code review standard, with specific guidance: "if this loop can be expressed as a single STL algorithm call, it should be." The standard does not ban raw loops (they are appropriate when the intent is complex or the performance profile requires manual optimization). It raises the bar for using them without justification.

