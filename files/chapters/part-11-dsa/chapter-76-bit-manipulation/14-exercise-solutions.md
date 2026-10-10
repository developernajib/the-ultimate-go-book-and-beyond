## Exercise Solutions

### Exercise 5: Find Kth Largest XOR Coordinate Value (Complete Solution)

**Problem**: Given a 2D matrix, compute XOR of all elements in the rectangle from (0,0) to (i,j) for each cell. Find the kth largest value.

```go
package main

import (
    "container/heap"
    "fmt"
)

// Solution using prefix XOR and min-heap
// Time: O(m*n*log(k)), Space: O(m*n)
func kthLargestValue(matrix [][]int, k int) int {
    if len(matrix) == 0 || len(matrix[0]) == 0 {
        return 0
    }

    m, n := len(matrix), len(matrix[0])

    // Compute prefix XOR matrix
    // prefixXOR[i][j] = XOR of all elements in rectangle (0,0) to (i,j)
    prefixXOR := make([][]int, m+1)
    for i := range prefixXOR {
        prefixXOR[i] = make([]int, n+1)
    }

    // Min-heap to track k largest values
    minHeap := &IntMinHeap{}
    heap.Init(minHeap)

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            // 2D prefix XOR formula (similar to prefix sum)
            // XOR is its own inverse, so: A ^ A = 0
            // prefixXOR[i][j] = matrix[i-1][j-1] ^ prefixXOR[i-1][j] ^
            //                   prefixXOR[i][j-1] ^ prefixXOR[i-1][j-1]
            prefixXOR[i][j] = matrix[i-1][j-1] ^
                              prefixXOR[i-1][j] ^
                              prefixXOR[i][j-1] ^
                              prefixXOR[i-1][j-1]

            // Maintain heap of k largest
            heap.Push(minHeap, prefixXOR[i][j])
            if minHeap.Len() > k {
                heap.Pop(minHeap)
            }
        }
    }

    return (*minHeap)[0]
}

// IntMinHeap implements heap.Interface for min-heap of integers
type IntMinHeap []int

func (h IntMinHeap) Len() int           { return len(h) }
func (h IntMinHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h IntMinHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }

func (h *IntMinHeap) Push(x any) {
    *h = append(*h, x.(int))
}

func (h *IntMinHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[0 : n-1]
    return x
}

// Alternative: Quick Select for O(m*n) average time
func kthLargestValueQuickSelect(matrix [][]int, k int) int {
    m, n := len(matrix), len(matrix[0])

    // Compute all prefix XOR values
    prefixXOR := make([][]int, m+1)
    for i := range prefixXOR {
        prefixXOR[i] = make([]int, n+1)
    }

    values := make([]int, 0, m*n)

    for i := 1; i <= m; i++ {
        for j := 1; j <= n; j++ {
            prefixXOR[i][j] = matrix[i-1][j-1] ^
                              prefixXOR[i-1][j] ^
                              prefixXOR[i][j-1] ^
                              prefixXOR[i-1][j-1]
            values = append(values, prefixXOR[i][j])
        }
    }

    // Quick select to find kth largest
    return quickSelect(values, len(values)-k)
}

func quickSelect(arr []int, k int) int {
    left, right := 0, len(arr)-1

    for left < right {
        pivotIdx := partition(arr, left, right)
        if pivotIdx == k {
            return arr[k]
        } else if pivotIdx < k {
            left = pivotIdx + 1
        } else {
            right = pivotIdx - 1
        }
    }

    return arr[k]
}

func partition(arr []int, left, right int) int {
    pivot := arr[right]
    i := left

    for j := left; j < right; j++ {
        if arr[j] <= pivot {
            arr[i], arr[j] = arr[j], arr[i]
            i++
        }
    }

    arr[i], arr[right] = arr[right], arr[i]
    return i
}

func main() {
    matrix := [][]int{
        {5, 2},
        {1, 6},
    }

    fmt.Println("Matrix:")
    for _, row := range matrix {
        fmt.Println(row)
    }

    fmt.Println("\nPrefix XOR values:")
    fmt.Println("(0,0): 5")
    fmt.Println("(0,1): 5^2 = 7")
    fmt.Println("(1,0): 5^1 = 4")
    fmt.Println("(1,1): 5^2^1^6 = 0")

    for k := 1; k <= 4; k++ {
        result := kthLargestValue(matrix, k)
        fmt.Printf("k=%d largest: %d\n", k, result)
    }
}
```

**Key Insights**:
1. 2D prefix XOR is similar to 2D prefix sum, but uses XOR
2. XOR is self-inverse: A ^ A = 0, so the formula works
3. Use min-heap of size k to efficiently track k largest values
4. Quick select provides O(n) average time alternative

---

### Exercise 6: Decode XORed Permutation (Complete Solution)

**Problem**: Given an encoded array where encoded[i] = perm[i] XOR perm[i+1], and perm is a permutation of [1,2,...,n] where n is odd, find perm.

```go
package main

import "fmt"

// Solution exploiting the property that n is always odd
// Time: O(n), Space: O(n)
func decode(encoded []int) []int {
    n := len(encoded) + 1

    // Step 1: Calculate XOR of all elements 1 to n
    // Since perm is a permutation, it contains all elements 1 to n
    totalXOR := 0
    for i := 1; i <= n; i++ {
        totalXOR ^= i
    }

    // Step 2: Calculate XOR of elements at odd indices (1, 3, 5, ...)
    // encoded[1] = perm[1] ^ perm[2]
    // encoded[3] = perm[3] ^ perm[4]
    // ...
    // XOR of all these = perm[1] ^ perm[2] ^ perm[3] ^ perm[4] ^ ...
    // This equals XOR of all elements except perm[0]!
    oddXOR := 0
    for i := 1; i < n-1; i += 2 {
        oddXOR ^= encoded[i]
    }

    // Step 3: perm[0] = totalXOR ^ oddXOR
    // Because totalXOR = perm[0] ^ perm[1] ^ ... ^ perm[n-1]
    // And oddXOR = perm[1] ^ perm[2] ^ ... ^ perm[n-1]
    // So totalXOR ^ oddXOR = perm[0]

    perm := make([]int, n)
    perm[0] = totalXOR ^ oddXOR

    // Step 4: Decode remaining elements
    // perm[i+1] = encoded[i] ^ perm[i]
    for i := 0; i < n-1; i++ {
        perm[i+1] = encoded[i] ^ perm[i]
    }

    return perm
}

// Verification function
func verify(perm, encoded []int) bool {
    for i := 0; i < len(encoded); i++ {
        if perm[i]^perm[i+1] != encoded[i] {
            return false
        }
    }
    return true
}

func main() {
    // Test case 1: encoded = [3,1]
    // This comes from perm = [1,2,3] where:
    // encoded[0] = 1^2 = 3
    // encoded[1] = 2^3 = 1
    encoded1 := []int{3, 1}
    result1 := decode(encoded1)
    fmt.Printf("Encoded: %v\n", encoded1)
    fmt.Printf("Decoded: %v\n", result1)
    fmt.Printf("Valid: %v\n\n", verify(result1, encoded1))

    // Test case 2: encoded = [6,5,4,6]
    // This comes from perm = [2,4,1,5,3] where:
    // encoded[0] = 2^4 = 6
    // encoded[1] = 4^1 = 5
    // encoded[2] = 1^5 = 4
    // encoded[3] = 5^3 = 6
    encoded2 := []int{6, 5, 4, 6}
    result2 := decode(encoded2)
    fmt.Printf("Encoded: %v\n", encoded2)
    fmt.Printf("Decoded: %v\n", result2)
    fmt.Printf("Valid: %v\n\n", verify(result2, encoded2))

    // Explanation of the algorithm
    fmt.Println("=== Algorithm Explanation ===")
    fmt.Println("Why n must be odd:")
    fmt.Println("- We use XOR of odd-indexed encoded values")
    fmt.Println("- This gives us XOR of all perm elements except perm[0]")
    fmt.Println("- Only works when n is odd (even number of remaining elements)")
}
```

**Why This Works**:
```
For n=5, encoded has 4 elements:
encoded[0] = perm[0] ^ perm[1]
encoded[1] = perm[1] ^ perm[2]
encoded[2] = perm[2] ^ perm[3]
encoded[3] = perm[3] ^ perm[4]

XOR of odd indices: encoded[1] ^ encoded[3]
= (perm[1] ^ perm[2]) ^ (perm[3] ^ perm[4])
= perm[1] ^ perm[2] ^ perm[3] ^ perm[4]

totalXOR = 1 ^ 2 ^ 3 ^ 4 ^ 5 = perm[0] ^ perm[1] ^ perm[2] ^ perm[3] ^ perm[4]

Therefore:
perm[0] = totalXOR ^ (perm[1] ^ perm[2] ^ perm[3] ^ perm[4])
        = totalXOR ^ oddXOR
```

---

### Exercise 7: Maximum AND Sum of Array (Bitmask DP)

**Problem**: Given an array of integers and numSlots slots (each can hold at most 2 numbers), maximize the AND sum where placing number at slot i contributes `number AND i` to the sum.

```go
package main

import "fmt"

// Solution using bitmask DP with ternary representation
// Each slot can have 0, 1, or 2 numbers
// Time: O(n * 3^numSlots), Space: O(3^numSlots)
func maximumANDSum(nums []int, numSlots int) int {
    n := len(nums)

    // Total states: 3^numSlots (each slot: 0, 1, or 2 items)
    totalStates := 1
    for i := 0; i < numSlots; i++ {
        totalStates *= 3
    }

    // dp[mask] = maximum AND sum when slot configuration is 'mask'
    // mask is a base-3 number where digit i represents items in slot i+1
    dp := make([]int, totalStates)

    // Process each number
    for i := 0; i < n; i++ {
        num := nums[i]

        // Iterate in reverse to avoid using same number twice
        for mask := totalStates - 1; mask >= 0; mask-- {
            // Count total items in this configuration
            items := countItems(mask, numSlots)
            if items != i {
                continue // This state can only be reached with 'items' numbers placed
            }

            // Try placing num in each slot
            for slot := 1; slot <= numSlots; slot++ {
                slotCount := getDigit(mask, slot-1)
                if slotCount < 2 { // Slot has room
                    newMask := setDigit(mask, slot-1, slotCount+1)
                    contribution := num & slot
                    if dp[mask]+contribution > dp[newMask] {
                        dp[newMask] = dp[mask] + contribution
                    }
                }
            }
        }
    }

    // Find maximum among all final states
    maxSum := 0
    for _, v := range dp {
        if v > maxSum {
            maxSum = v
        }
    }
    return maxSum
}

// Helper functions for base-3 digit manipulation
func getDigit(mask, pos int) int {
    for i := 0; i < pos; i++ {
        mask /= 3
    }
    return mask % 3
}

func setDigit(mask, pos, val int) int {
    oldVal := getDigit(mask, pos)
    diff := val - oldVal
    power := 1
    for i := 0; i < pos; i++ {
        power *= 3
    }
    return mask + diff*power
}

func countItems(mask, numSlots int) int {
    count := 0
    for i := 0; i < numSlots; i++ {
        count += getDigit(mask, i)
    }
    return count
}

// Alternative: Using binary bitmask (2*numSlots bits)
// Each slot represented by 2 bits
func maximumANDSumBinary(nums []int, numSlots int) int {
    n := len(nums)

    // 2 bits per slot: 00=empty, 01=one item, 11=two items
    totalStates := 1 << (2 * numSlots)

    dp := make([]int, totalStates)
    for i := range dp {
        dp[i] = -1 // Unvisited
    }
    dp[0] = 0

    for i := 0; i < n; i++ {
        num := nums[i]
        newDP := make([]int, totalStates)
        copy(newDP, dp)

        for mask := 0; mask < totalStates; mask++ {
            if dp[mask] == -1 || countBinaryItems(mask, numSlots) != i {
                continue
            }

            for slot := 1; slot <= numSlots; slot++ {
                slotBits := (mask >> (2 * (slot - 1))) & 3
                if slotBits < 3 { // Slot has room (not 11)
                    newSlotBits := slotBits + 1
                    if slotBits == 0 {
                        newSlotBits = 1 // 00 -> 01
                    } else if slotBits == 1 {
                        newSlotBits = 3 // 01 -> 11
                    } else {
                        continue // Already full
                    }

                    clearMask := ^(3 << (2 * (slot - 1)))
                    newMask := (mask & clearMask) | (newSlotBits << (2 * (slot - 1)))

                    contribution := num & slot
                    if dp[mask]+contribution > newDP[newMask] {
                        newDP[newMask] = dp[mask] + contribution
                    }
                }
            }
        }
        dp = newDP
    }

    maxSum := 0
    for _, v := range dp {
        if v > maxSum {
            maxSum = v
        }
    }
    return maxSum
}

func countBinaryItems(mask, numSlots int) int {
    count := 0
    for slot := 1; slot <= numSlots; slot++ {
        slotBits := (mask >> (2 * (slot - 1))) & 3
        if slotBits == 1 {
            count += 1
        } else if slotBits == 3 {
            count += 2
        }
    }
    return count
}

func main() {
    // Test case 1
    nums1 := []int{1, 2, 3, 4, 5, 6}
    numSlots1 := 3
    result1 := maximumANDSum(nums1, numSlots1)
    fmt.Printf("nums=%v, numSlots=%d\n", nums1, numSlots1)
    fmt.Printf("Maximum AND Sum: %d\n\n", result1)

    // Test case 2
    nums2 := []int{1, 3, 10, 4, 7, 1}
    numSlots2 := 9
    result2 := maximumANDSum(nums2, numSlots2)
    fmt.Printf("nums=%v, numSlots=%d\n", nums2, numSlots2)
    fmt.Printf("Maximum AND Sum: %d\n\n", result2)

    // Explanation
    fmt.Println("=== Understanding AND Sum ===")
    fmt.Println("If we place 6 in slot 3:")
    fmt.Printf("Contribution = 6 AND 3 = %d (binary: %03b AND %03b = %03b)\n",
               6&3, 6, 3, 6&3)
    fmt.Println("\nIf we place 5 in slot 1:")
    fmt.Printf("Contribution = 5 AND 1 = %d (binary: %03b AND %03b = %03b)\n",
               5&1, 5, 1, 5&1)
}
```

**Key Concepts**:
1. State representation: ternary (base-3) or binary with 2 bits per slot
2. Each slot can hold 0, 1, or 2 numbers
3. We want to maximize sum of (number AND slot_index) for all placements
4. DP transition: try placing each number in each available slot

---

### Exercise 8: Count Number of Maximum Bitwise-OR Subsets (Complete Solution)

**Problem**: Given an array, find the count of non-empty subsets that achieve the maximum possible bitwise OR.

```go
package main

import "fmt"

// Solution: First find max OR, then count subsets achieving it
// Time: O(2^n), Space: O(1)
func countMaxOrSubsets(nums []int) int {
    n := len(nums)

    // Step 1: Find maximum possible OR (OR of all elements)
    maxOR := 0
    for _, num := range nums {
        maxOR |= num
    }

    // Step 2: Count subsets with this OR using bitmask enumeration
    count := 0
    total := 1 << n // 2^n subsets

    for mask := 1; mask < total; mask++ { // Skip empty subset
        currentOR := 0
        for i := 0; i < n; i++ {
            if mask&(1<<i) != 0 {
                currentOR |= nums[i]
            }
        }
        if currentOR == maxOR {
            count++
        }
    }

    return count
}

// Optimized: DP counting approach
// Time: O(n * maxOR), Space: O(maxOR)
func countMaxOrSubsetsDP(nums []int) int {
    // dp[or_value] = number of subsets with this OR value
    dp := make(map[int]int)
    dp[0] = 1 // Empty subset has OR = 0

    maxOR := 0
    for _, num := range nums {
        maxOR |= num

        // For each existing OR value, add num to create new OR
        newCounts := make(map[int]int)
        for orVal, cnt := range dp {
            newOR := orVal | num
            newCounts[newOR] += cnt
        }

        // Merge new counts into dp
        for orVal, cnt := range newCounts {
            dp[orVal] += cnt
        }
    }

    // dp[0] was seeded with the empty subset, so it is included in the count
    // whenever maxOR == 0 (which happens only when every element is 0).
    // The problem asks for non-empty subsets, so remove it. LeetCode 2044
    // guarantees nums[i] >= 1, which makes maxOR > 0 and hides this entirely,
    // but the other implementations in this file disagree with it on [0], so
    // one of them was wrong and it was this one.
    if maxOR == 0 {
        return dp[maxOR] - 1
    }
    return dp[maxOR]
}

// Backtracking solution (cleaner for interviews)
func countMaxOrSubsetsBacktrack(nums []int) int {
    maxOR := 0
    for _, num := range nums {
        maxOR |= num
    }

    count := 0
    var backtrack func(idx, currentOR int)

    backtrack = func(idx, currentOR int) {
        if idx == len(nums) {
            if currentOR == maxOR {
                count++
            }
            return
        }

        // Include nums[idx]
        backtrack(idx+1, currentOR|nums[idx])

        // Exclude nums[idx]
        backtrack(idx+1, currentOR)
    }

    backtrack(0, 0)

    // Subtract 1 for empty subset if needed
    if maxOR == 0 {
        return count - 1
    }
    return count
}

// Optimized backtracking with early termination
func countMaxOrSubsetsOptimized(nums []int) int {
    maxOR := 0
    for _, num := range nums {
        maxOR |= num
    }

    count := 0
    var backtrack func(idx, currentOR int)

    backtrack = func(idx, currentOR int) {
        // Early termination: once currentOR reaches maxOR, OR is monotone, so
        // every way of choosing from the remaining elements also yields maxOR.
        if currentOR == maxOR {
            // All 2^(n-idx) subsets of the remainder have OR == maxOR.
            count += 1 << (len(nums) - idx)
            return
        }

        if idx == len(nums) {
            return
        }

        // Include nums[idx]
        backtrack(idx+1, currentOR|nums[idx])

        // Exclude nums[idx]
        backtrack(idx+1, currentOR)
    }

    backtrack(0, 0)

    // Same empty-subset correction as the other variants. When maxOR == 0 the
    // early-termination branch fires immediately at idx 0 and counts all 2^n
    // subsets, the empty one included.
    if maxOR == 0 {
        return count - 1
    }
    return count
}

func main() {
    // Test case 1
    nums1 := []int{3, 1}
    result1 := countMaxOrSubsets(nums1)
    fmt.Printf("nums=%v\n", nums1)
    fmt.Printf("Max OR = %d (binary: %04b)\n", 3|1, 3|1)
    fmt.Printf("Count of max OR subsets: %d\n\n", result1)

    // Test case 2
    nums2 := []int{2, 2, 2}
    result2 := countMaxOrSubsets(nums2)
    fmt.Printf("nums=%v\n", nums2)
    fmt.Printf("Max OR = %d (binary: %04b)\n", 2, 2)
    fmt.Printf("Count of max OR subsets: %d\n\n", result2)

    // Test case 3
    nums3 := []int{3, 2, 1, 5}
    result3 := countMaxOrSubsets(nums3)
    fmt.Printf("nums=%v\n", nums3)
    fmt.Printf("Max OR = %d (binary: %04b)\n", 3|2|1|5, 3|2|1|5)
    fmt.Printf("Count of max OR subsets: %d\n\n", result3)

    // Enumerate all subsets for nums1
    fmt.Println("=== All subsets for [3,1] ===")
    fmt.Println("{3}: OR = 3")
    fmt.Println("{1}: OR = 1")
    fmt.Println("{3,1}: OR = 3")
    fmt.Println("Subsets with max OR (3): {3}, {3,1} = 2 subsets")

    // Performance comparison
    fmt.Println("\n=== Performance Notes ===")
    fmt.Println("Brute force: O(n * 2^n)")
    fmt.Println("DP: O(n * maxOR)")
    fmt.Println("Optimized backtrack: O(2^n) worst, but often faster with early termination")
}
```

**Optimization Insight**:
- Once we reach maxOR, every subset including current elements will also have maxOR
- This allows exponential speedup in many cases
- Formula: if currentOR == maxOR at index i, add 2^(n-i) to count

### Junior -> FAANG: Learning to Read Your Own Solutions Critically

After implementing each solution above, ask three questions: (1) "Does my solution handle the empty input?" (2) "Does my solution handle a single-element input?" (3) "Does my solution handle the maximum allowed input size within the time limit?" For the bitmask solutions here, the time limit question translates to: "what is the maximum n for which `1 << n` stays within 30 bits (about 10^9)?" The answer is n=29 at most.

For Exercise 5 (Kth Largest XOR Coordinate Value), notice that the 2D prefix XOR formula mirrors 2D prefix sum: `prefixXOR[i][j] = matrix[i-1][j-1] ^ prefixXOR[i-1][j] ^ prefixXOR[i][j-1] ^ prefixXOR[i-1][j-1]`. The XOR inclusion-exclusion works because XOR is its own inverse, which is exactly the condition needed for inclusion-exclusion to cancel correctly. Prove this to yourself by expanding the formula for a 2x2 matrix.

For Exercise 8 (Count Max OR Subsets), the early termination optimization in `countMaxOrSubsetsOptimized` is a good habit: once the running OR reaches the maximum, any subset of the remaining elements is counted without branching further. This exponential speedup is real in practice when many elements share the maximum OR bits.

### Senior @ FAANG: Code Quality and Ownership Standards for Exercise Solutions

The exercise solutions above are pedagogically sound but would require several changes before being merged into production Go code. Document these changes as a code review:

The `IntMinHeap` type implements `heap.Interface` correctly, but the `Push` and `Pop` method receivers use pointer semantics (`*IntMinHeap`) while `Len`, `Less`, and `Swap` use value semantics. In Go, all heap interface methods must be implemented on the same type (pointer or value), and mixing them is a correctness issue with interface dispatch. The correct pattern is to put all five methods on `*IntMinHeap`.

The `maximumANDSum` function has O(n * 3^numSlots) complexity. For the problem constraints (n up to 9, numSlots up to 9), `3^9 = 19683`, which is fine. But the comment in the code says `O(n * 3^numSlots)` without noting that `n <= 2 * numSlots` due to the capacity constraint (each slot holds at most 2 items). Tighten the complexity analysis in the comment.

For the `countMaxOrSubsetsOptimized` early termination: the formula `count += 1 << (len(nums) - idx)` is correct but assumes that all remaining elements OR to at least the current OR value. This is always true because OR is monotone (adding elements can only set more bits, never clear them). Add this justification as a comment so the next reader does not need to reason through it.
