## 65.7 Interview Questions

### Question 1: Analyze the complexity of this function

**Problem:** What is the time and space complexity?

```go
func mystery(n int) int {
    if n <= 1 {
        return 1
    }
    return mystery(n/2) + mystery(n/2)
}
```

**Answer:**

```go
// Analysis:
// - Two recursive calls
// - Each call reduces n by half
// - Tree has log(n) levels
// - At level k, there are 2^k nodes

// Time Complexity: O(n)
// - Level 0: 1 node
// - Level 1: 2 nodes
// - Level 2: 4 nodes
// - Level k: 2^k nodes
// - Total nodes = 1 + 2 + 4 + ... + 2^log(n) = 2^(log(n)+1) - 1 = 2n - 1 = O(n)

// Space Complexity: O(log n)
// - Maximum recursion depth is log(n)
// - Each stack frame uses O(1) space

// Common mistake: Thinking it's O(2^n) like naive Fibonacci
// The difference is n/2 vs n-1 reduction

// Optimized version:
func mysteryOptimized(n int) int {
    if n <= 1 {
        return 1
    }
    half := mysteryOptimized(n / 2)
    return half + half // Calculate once, use twice
}
// Time: O(log n), Space: O(log n)
```

### Question 2: Compare approaches for finding intersection of two arrays

**Problem:** Find common elements in two arrays. Analyze different approaches.

**Answer:**

```go
// Approach 1: Brute Force - O(n*m) time, O(min(n,m)) space
func intersection1(nums1, nums2 []int) []int {
    result := make(map[int]bool)
    for _, n1 := range nums1 {        // O(n)
        for _, n2 := range nums2 {    // O(m)
            if n1 == n2 {
                result[n1] = true
            }
        }
    }
    return mapToSlice(result)
}
// Total: O(n*m) - Bad for large arrays

// Approach 2: Hash Set - O(n+m) time, O(n) space
func intersection2(nums1, nums2 []int) []int {
    set := make(map[int]bool)
    for _, n := range nums1 {         // O(n)
        set[n] = true
    }

    result := make(map[int]bool)
    for _, n := range nums2 {         // O(m)
        if set[n] {                   // O(1)
            result[n] = true
        }
    }
    return mapToSlice(result)
}
// Total: O(n+m) - Optimal for unsorted arrays

// Approach 3: Sorting + Two Pointers - O(n log n + m log m) time, O(1) extra space
func intersection3(nums1, nums2 []int) []int {
    slices.Sort(nums1)  // O(n log n)
    slices.Sort(nums2)  // O(m log m)

    var result []int
    i, j := 0, 0
    for i < len(nums1) && j < len(nums2) {  // O(n+m)
        if nums1[i] == nums2[j] {
            if len(result) == 0 || result[len(result)-1] != nums1[i] {
                result = append(result, nums1[i])
            }
            i++
            j++
        } else if nums1[i] < nums2[j] {
            i++
        } else {
            j++
        }
    }
    return result
}
// Best when arrays are already sorted or memory is constrained

// Approach 4: Binary Search - O((n+m) log m) time, O(min(n,m)) space
func intersection4(nums1, nums2 []int) []int {
    // Ensure nums1 is the smaller array, then sort and search the larger one
    if len(nums1) > len(nums2) {
        nums1, nums2 = nums2, nums1
    }
    slices.Sort(nums2)  // O(m log m)

    result := make(map[int]bool)
    for _, n := range nums1 {  // O(n)
        if binarySearch(nums2, n) {  // O(log m)
            result[n] = true
        }
    }
    return mapToSlice(result)
}
// Wins when the larger array is already sorted: the sort cost disappears
// and O(n log m) beats O(n+m) when n << m

func mapToSlice(m map[int]bool) []int {
    res := make([]int, 0, len(m))
    for k := range m {
        res = append(res, k)
    }
    return res
}

func binarySearch(arr []int, target int) bool {
    _, found := slices.BinarySearch(arr, target)
    return found
}
```

### Question 3: Design a data structure with O(1) operations

**Problem:** Design a data structure supporting insert, delete, and getRandom in O(1).

**Answer:**

```go
// RandomizedSet with O(1) insert, delete, getRandom
type RandomizedSet struct {
    nums    []int          // For O(1) random access
    indices map[int]int    // val -> index for O(1) lookup
}

func Constructor() RandomizedSet {
    return RandomizedSet{
        nums:    make([]int, 0),
        indices: make(map[int]int),
    }
}

// O(1) average
func (rs *RandomizedSet) Insert(val int) bool {
    if _, exists := rs.indices[val]; exists {
        return false
    }
    rs.indices[val] = len(rs.nums)
    rs.nums = append(rs.nums, val)
    return true
}

// O(1)
func (rs *RandomizedSet) Remove(val int) bool {
    idx, exists := rs.indices[val]
    if !exists {
        return false
    }

    // Swap with last element for O(1) removal
    last := rs.nums[len(rs.nums)-1]
    rs.nums[idx] = last
    rs.indices[last] = idx

    // Remove last element
    rs.nums = rs.nums[:len(rs.nums)-1]
    delete(rs.indices, val)

    return true
}

// O(1)
func (rs *RandomizedSet) GetRandom() int {
    return rs.nums[rand.IntN(len(rs.nums))]
}

// Complexity Analysis:
// - Insert: O(1) amortized (slice append + map insert)
// - Remove: O(1) (swap + map operations)
// - GetRandom: O(1) (array access)
// - Space: O(n)
```

### Junior → FAANG: Answering Complexity Interview Questions Confidently

These three questions represent the three levels of complexity interview difficulty. Question 1 (analyze a mystery function) is a pure derivation problem: apply the recursion analysis rules. Question 2 (compare approaches) is a trade-off problem: know at least three approaches and their complexities by heart. Question 3 (design a data structure with O(1) operations) is a design problem: recognize that O(1) random access requires a contiguous array and O(1) lookup requires a hash map, and combine both.

For Question 1, the single most common wrong answer is "O(2 to the n)" for the mystery function. The key insight that prevents this mistake is that `mystery(n/2)` reduces n geometrically, not arithmetically. Geometric reduction gives O(n) total nodes in the recursion tree, not O(2 to the n). Practice this distinction explicitly by drawing the recursion tree for a few values of n.

For Question 3, the swap-with-last trick for O(1) removal is the insight that makes the design work. Without it, removing an element from the middle of the array requires shifting all subsequent elements, which is O(n). Swapping the target element with the last element and then truncating the slice achieves O(1) removal at the cost of disrupting the original order, which is acceptable when only random access is needed.

### Senior @ FAANG: Teaching Complexity Analysis in Interviews

As a bar-raiser or senior interviewer, these questions serve a different purpose. You are not just checking whether the candidate gets the right answer. You are observing how they think through uncertainty, how they communicate partial understanding, and whether they can connect theoretical analysis to practical implications.

For Question 1, a strong senior signal is a candidate who not only derives O(n) but also notices the optimization: computing `mysteryOptimized` by storing `half = mystery(n/2)` eliminates the redundant recursive call and drops the complexity to O(log n). A junior candidate solves the problem as stated. A senior candidate improves it unprompted.

For Question 2, the bar-raiser question is: "Which approach would you use in a production system where both arrays are already sorted and memory is at a premium?" The sorting approach with two pointers becomes dominant in that context because it requires no auxiliary allocation and leverages the pre-sorted property. A candidate who defaults to the hash set without considering the constraints has not thought about the full problem space.

For Question 3, the bar-raiser follow-up is thread safety. The RandomizedSet as implemented is not safe for concurrent access. How would you make it thread-safe without degrading the O(1) complexity? A strong answer involves a single `sync.RWMutex` protecting all three operations, with the observation that `GetRandom` only needs a read lock while `Insert` and `Remove` need a write lock. A very strong answer also notes that if `GetRandom` frequency is much higher than mutation frequency, a read-write lock provides better throughput than a simple mutex.

---
