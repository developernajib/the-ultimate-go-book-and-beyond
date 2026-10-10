## Interview Questions

### Conceptual Questions

**Q1: When would you choose `std::map` over `std::unordered_map`?**

Use `std::map` when you need: sorted iteration order, range queries (`lower_bound`/`upper_bound`), keys without a good hash function but with a natural ordering, predictable O(log n) worst case (no hash collision degradation), or when processing untrusted input where hash-flooding DoS is a concern. Also use `map` when the dataset is small enough (under ~100 elements) that the O(log n) vs O(1) distinction doesn't matter and the overhead of hashing may actually be more expensive than a few comparisons.

**Q2: What happens when you call `operator[]` on a `std::map` with a key that doesn't exist?**

It default-constructs a value for that key and inserts it into the map. This is why `operator[]` is not `const`-qualified and cannot be called on a `const map&`. For read-only lookups, use `find()` or `count()` or `contains()` (C++20). In contrast, Go's map returns the zero value for missing keys without inserting them.

**Q3: Explain iterator invalidation rules for `std::vector::push_back`.**

If `size() < capacity()`, only the `end()` iterator is invalidated. All other iterators, pointers, and references remain valid because no reallocation occurs. If `size() == capacity()`, the vector must reallocate, and **all** iterators, pointers, and references are invalidated because elements are moved to a new memory location. You can check whether reallocation will occur by comparing `size()` to `capacity()` before calling `push_back`. Calling `reserve()` upfront is the best way to prevent unexpected invalidation.

**Q4: What is the difference between `std::remove` and container `erase`?**

`std::remove` is an algorithm that moves elements to be kept to the front of the range and returns an iterator to the "new logical end". It does not actually erase anything or change the container's size, the container still holds the same number of elements, but the elements past the returned iterator are in an unspecified (but valid) state. You must call `.erase()` with the returned iterator to actually shrink the container. This is the "erase-remove idiom." C++20 added `std::erase` and `std::erase_if` as convenience functions that combine both steps.

**Q5: Why is `std::sort` not available for `std::list`?**

`std::sort` requires random access iterators (for introsort, which needs O(1) jumping to arbitrary positions for partitioning and median-of-three pivot selection). `std::list` only provides bidirectional iterators. Instead, `std::list` has its own `.sort()` member function that uses merge sort, which only needs sequential access and achieves O(n log n) time. The member sort also takes advantage of list's O(1) splice to merge sublists without copying elements.

**Q6: What is the time complexity of inserting n elements into an `std::unordered_map` that was created with `reserve(n)`?**

O(n) total, with each individual insert being O(1) amortized. The `reserve(n)` call pre-allocates enough buckets so that no rehashing occurs during the n insertions (specifically, it ensures `bucket_count >= n / max_load_factor()`). Without reserve, rehashing events occur when the load factor is exceeded, each costing O(current_size) to re-insert all elements. The total cost is still O(n) amortized over all insertions, but the constant factor is worse and latency spikes occur during rehash events.

**Q7: What is the difference between `std::stable_sort` and `std::sort`? When does it matter?**

`std::sort` uses introsort and does not guarantee the relative order of equal elements. `std::stable_sort` uses merge sort and guarantees that equal elements maintain their original relative order. This matters when you sort by one criterion after already sorting by another (multi-key sorting), when the original insertion order has semantic meaning, or when deterministic output is required for testing. `stable_sort` requires O(n) extra memory. If memory is not available, it falls back to an O(n log^2 n) in-place algorithm.

### Coding Questions

**Q8: Merge k sorted vectors into one sorted vector.**

```cpp
#include <vector>
#include <queue>
#include <iostream>

std::vector<int> merge_k_sorted(const std::vector<std::vector<int>>& lists) {
    // Min-heap of (value, list_index, element_index)
    using Entry = std::tuple<int, int, int>;
    std::priority_queue<Entry, std::vector<Entry>, std::greater<Entry>> pq;
    
    // Initialize with first element of each list
    for (int i = 0; i < static_cast<int>(lists.size()); ++i) {
        if (!lists[i].empty()) {
            pq.push({lists[i][0], i, 0});
        }
    }
    
    std::vector<int> result;
    while (!pq.empty()) {
        auto [val, li, ei] = pq.top();
        pq.pop();
        result.push_back(val);
        
        if (ei + 1 < static_cast<int>(lists[li].size())) {
            pq.push({lists[li][ei + 1], li, ei + 1});
        }
    }
    
    return result;
}

int main() {
    std::vector<std::vector<int>> lists = {
        {1, 4, 7},
        {2, 5, 8},
        {3, 6, 9}
    };
    
    auto merged = merge_k_sorted(lists);
    for (int x : merged) std::cout << x << " ";
    std::cout << "\n";  // 1 2 3 4 5 6 7 8 9
    
    return 0;
}
```

Time complexity: O(N log k) where N is the total number of elements and k is the number of lists. The priority queue always holds at most k elements.

**Q9: Find the k-th largest element in an unsorted array in O(n) average time.**

```cpp
#include <vector>
#include <algorithm>
#include <iostream>

int kth_largest(std::vector<int>& nums, int k) {
    // nth_element partitions so that the element at the nth position
    // is the element that would be there if the array were sorted.
    // Uses introselect: quickselect with median-of-medians fallback.
    int n = static_cast<int>(nums.size());
    std::nth_element(nums.begin(), nums.begin() + (n - k), nums.end());
    return nums[n - k];
}

int main() {
    std::vector<int> nums = {3, 2, 1, 5, 6, 4};
    std::cout << "2nd largest: " << kth_largest(nums, 2) << "\n";  // 5
    
    // Alternative: use partial_sort for top-k sorted
    std::vector<int> v = {3, 2, 1, 5, 6, 4};
    std::partial_sort(v.begin(), v.begin() + 3, v.end(), std::greater<int>());
    // First 3 elements are {6, 5, 4} (top 3, sorted)
    std::cout << "Top 3: ";
    for (int i = 0; i < 3; ++i) std::cout << v[i] << " ";
    std::cout << "\n";
    
    return 0;
}
```

**Q10: Implement a frequency counter and return the k most frequent elements.**

```cpp
#include <unordered_map>
#include <vector>
#include <queue>
#include <algorithm>
#include <iostream>

std::vector<int> top_k_frequent(const std::vector<int>& nums, int k) {
    // Count frequencies - O(n)
    std::unordered_map<int, int> freq;
    for (int n : nums) freq[n]++;
    
    // Method 1: Min-heap of size k - O(n log k)
    using Pair = std::pair<int, int>;  // (frequency, value)
    std::priority_queue<Pair, std::vector<Pair>, std::greater<Pair>> min_heap;
    
    for (const auto& [val, count] : freq) {
        min_heap.push({count, val});
        if (static_cast<int>(min_heap.size()) > k) {
            min_heap.pop();  // Remove least frequent
        }
    }
    
    std::vector<int> result;
    while (!min_heap.empty()) {
        result.push_back(min_heap.top().second);
        min_heap.pop();
    }
    
    return result;
    
    // Method 2: nth_element - O(n) average
    // Convert freq to vector, nth_element by count, take first k
}

int main() {
    std::vector<int> nums = {1, 1, 1, 2, 2, 3, 3, 3, 3};
    auto result = top_k_frequent(nums, 2);
    
    std::cout << "Top 2 frequent: ";
    for (int x : result) std::cout << x << " ";
    std::cout << "\n";  // 3 1 (or 1 3)
    
    return 0;
}
```

**Q11: Given an unsorted array, find if any two elements sum to a target. Do it in O(n).**

```cpp
#include <unordered_set>
#include <unordered_map>
#include <vector>
#include <iostream>

bool two_sum_exists(const std::vector<int>& nums, int target) {
    std::unordered_set<int> seen;
    for (int n : nums) {
        if (seen.count(target - n)) {
            return true;
        }
        seen.insert(n);
    }
    return false;
}

// Return indices version (classic LeetCode #1)
std::pair<int, int> two_sum_indices(const std::vector<int>& nums, int target) {
    std::unordered_map<int, int> seen;  // value -> index
    for (int i = 0; i < static_cast<int>(nums.size()); ++i) {
        int complement = target - nums[i];
        auto it = seen.find(complement);
        if (it != seen.end()) {
            return {it->second, i};
        }
        seen[nums[i]] = i;
    }
    return {-1, -1};
}

int main() {
    std::vector<int> nums = {2, 7, 11, 15};
    std::cout << "Sum to 9: " << two_sum_exists(nums, 9) << "\n";  // 1
    
    auto [i, j] = two_sum_indices(nums, 9);
    std::cout << "Indices: " << i << ", " << j << "\n";  // 0, 1
    
    return 0;
}
```

**Q12: Implement a sliding window maximum using a deque.**

```cpp
#include <deque>
#include <vector>
#include <iostream>

std::vector<int> max_sliding_window(const std::vector<int>& nums, int k) {
    std::deque<int> dq;  // Stores indices, front is always the max
    std::vector<int> result;
    
    for (int i = 0; i < static_cast<int>(nums.size()); ++i) {
        // Remove indices outside the window
        while (!dq.empty() && dq.front() <= i - k) {
            dq.pop_front();
        }
        // Remove smaller elements from the back (they'll never be the max)
        while (!dq.empty() && nums[dq.back()] <= nums[i]) {
            dq.pop_back();
        }
        dq.push_back(i);
        
        // Window is full, record the max
        if (i >= k - 1) {
            result.push_back(nums[dq.front()]);
        }
    }
    return result;
}

int main() {
    std::vector<int> nums = {1, 3, -1, -3, 5, 3, 6, 7};
    auto result = max_sliding_window(nums, 3);
    for (int x : result) std::cout << x << " ";
    std::cout << "\n";  // 3 3 5 5 6 7
    return 0;
}
```

This is O(n) because each element is pushed and popped from the deque at most once. The deque maintains a monotonically decreasing sequence of candidate maximums, demonstrating why `std::deque` with O(1) operations at both ends is the right container for this problem.

---
