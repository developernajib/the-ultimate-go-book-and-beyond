## 78B.11 The Prefix Sum Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                   PREFIX SUM PATTERN                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Array:      [1, 2, 3, 4, 5]                                    │
│  Prefix Sum: [0, 1, 3, 6, 10, 15]                               │
│                                                                 │
│  Sum(i..j) = prefix[j+1] - prefix[i]                            │
│  Sum(1..3) = prefix[4] - prefix[1] = 10 - 1 = 9                 │
│                                                                 │
│  Variant: prefix[i] stored in hash map for                      │
│  "count subarrays with sum = k" type problems                   │
│                                                                 │
│  Key insight: Convert range sum queries from O(n) to O(1)       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**When to use Prefix Sum:**
- Range sum queries
- Subarray sum equals K
- Count of subarrays meeting a sum condition
- 2D prefix sums for matrix region queries

---

### Problem 1: Range Sum Query, Immutable (LC 303)

**Problem:** Given an array, handle multiple queries for the sum of elements between indices `left` and `right` inclusive.

**Approach:** Precompute prefix sums. Answer each query in O(1).

```go
type NumArray struct {
    prefix []int
}

func NumArrayConstructor(nums []int) NumArray {
    prefix := make([]int, len(nums)+1)
    for i, n := range nums {
        prefix[i+1] = prefix[i] + n
    }
    return NumArray{prefix: prefix}
}

func (na *NumArray) SumRange(left, right int) int {
    return na.prefix[right+1] - na.prefix[left]
}
```

**Time Complexity:** O(n) preprocessing, O(1) per query.
**Space Complexity:** O(n).

The `len(nums)+1` sizing with `prefix[0] = 0` is what makes `SumRange` a single expression with no special case for `left == 0`. Size the array to n instead and you need a branch, which is the usual source of off-by-one bugs here. The extra slot is buying the absence of a conditional.

**Edge cases:**
- left == right → single element, `prefix[i+1] - prefix[i]`
- Entire array range → `prefix[n] - prefix[0]`
- Negative numbers in the array: prefix sums are not monotone, which does not matter here because subtraction does not care, but it does matter the moment you want to binary search the prefix array

---

### Problem 2: Subarray Sum Equals K (LC 560)

**Problem:** Given an array of integers and integer `k`, find the total number of subarrays whose sum equals `k`.

**Approach:** Use prefix sum + hash map. For each prefix sum, check how many previous prefix sums equal `current_prefix - k`.

```go
func subarraySum(nums []int, k int) int {
    count := 0
    prefixSum := 0
    prefixCount := map[int]int{0: 1} // prefix sum -> count of occurrences

    for _, num := range nums {
        prefixSum += num

        // If (prefixSum - k) was seen before, those are valid subarrays
        if c, exists := prefixCount[prefixSum-k]; exists {
            count += c
        }

        prefixCount[prefixSum]++
    }

    return count
}
```

**Time Complexity:** O(n).
**Space Complexity:** O(n) for the hash map.

**Edge cases:**
- k=0 → count subarrays summing to 0 (can exist with negative numbers)
- All zeros, k=0 → n*(n+1)/2 subarrays
- Negative numbers → prefix sum can decrease, making the hash map essential
- Single element equal to k → count it

---

### Problem 3: Product of Array Except Self (LC 238)

**Problem:** Given an array `nums`, return an array where `answer[i]` is the product of all elements except `nums[i]`. Cannot use division. Must be O(n).

**Approach:** Two-pass prefix/suffix product. First pass computes prefix products (left to right). Second pass multiplies in suffix products (right to left).

```go
func productExceptSelf(nums []int) []int {
    n := len(nums)
    answer := make([]int, n)

    // First pass: prefix product (product of all elements to the left)
    answer[0] = 1
    for i := 1; i < n; i++ {
        answer[i] = answer[i-1] * nums[i-1]
    }

    // Second pass: multiply by suffix product (product of all elements to the right)
    suffix := 1
    for i := n - 2; i >= 0; i-- {
        suffix *= nums[i+1]
        answer[i] *= suffix
    }

    return answer
}
```

**Time Complexity:** O(n).
**Space Complexity:** O(1) extra (the output array doesn't count per problem statement).

**Edge cases:**
- Contains a zero → all products except that position are 0
- Contains two zeros → all products are 0
- Negative numbers → signs handled naturally by multiplication
- Array of length 2

---

### Junior → FAANG: The Prefix Sum and Hash Map Combination

Prefix sum alone answers range sum queries. The real power emerges when you combine it with a hash map: for problems like "count subarrays with sum equal to K," store the count of each prefix sum value seen so far. When you reach prefix sum `P` at index `i`, the number of subarrays ending at `i` with sum K is the count of previous prefix sums equal to `P - K`. This is O(n) time and O(n) space and handles negative numbers, which rules out sliding window.

The pattern breaks for junior engineers when they forget the base case: initialize the hash map with `prefixCount[0] = 1` before processing any element. This represents the "empty prefix" whose sum is zero, required to count subarrays starting from index 0 that already equal K.

Common confusion: prefix sum vs. sliding window. Sliding window works when all elements are non-negative (shrinking the window always decreases the sum). Prefix sum with hash map works when elements can be negative but you lose the ability to shrink (you must process all elements). Recognizing when to switch between these two is a key interview differentiator.

Entry-level signal: correctly explaining the Product of Array Except Self problem without using division. The prefix-product approach uses a left-pass (product of all elements to the left of i) and a right-pass (product of all elements to the right of i) combined into a single output array, achieving O(n) time and O(1) extra space.

### Senior @ FAANG: Prefix Sums in Data Warehousing and Analytics Queries

Prefix sums, generalized as cumulative aggregation, are why a running-total window function is not quadratic. When a query engine evaluates `SUM(...) OVER (ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`, the natural implementation is a single accumulating pass, which is the prefix sum array computed lazily. The same identity underpins the min/max/sum zone maps that columnar formats keep per block: precomputed aggregates let a scan skip blocks entirely.

Monitoring systems make the same trade. Storing cumulative counters rather than per-interval deltas means any rolling window is one subtraction, which is exactly `prefix[j] - prefix[i]`. This is why counter-style metrics are so often exposed as monotonically increasing totals and differenced at query time rather than at write time: the cumulative form answers every window, while a pre-bucketed form only answers the buckets you chose in advance.

The tradeoff worth documenting is the one the pattern always carries: prefix sums make reads O(1) and make writes invalidate everything downstream. That is fine for append-only data, where a new element only extends the array, and it is bad for data with updates in the middle.

ADR consideration: prefix sum arrays are O(n) space and O(n) time to compute. They are appropriate when the array is static (or slowly changing) and range queries are frequent. For dynamic arrays with frequent updates, a Fenwick tree (binary indexed tree) is preferable: it supports O(log n) point updates and O(log n) prefix sum queries. Document the update frequency and query frequency when choosing between a static prefix sum array and a dynamic Fenwick tree. For read-mostly workloads the prefix array is simpler. For mixed read-write workloads the Fenwick tree amortizes better.

Bar-raiser signal: the candidate derives the 2D extension rather than reciting it. The formula `sum(r1,c1,r2,c2) = prefix[r2][c2] - prefix[r1-1][c2] - prefix[r2][c1-1] + prefix[r1-1][c1-1]` is inclusion-exclusion: subtracting the strip above and the strip to the left removes their overlapping corner twice, so it gets added back once. This structure is the summed-area table, long used in image processing to evaluate box filters and Haar-like features in constant time regardless of window size. The pattern generalizes to d dimensions with 2^d terms, which is also the reason it stops being attractive past a few dimensions.
