## 75.17 Exercises with Complete Solutions

### Exercise 1: Queue Reconstruction by Height

**Problem**: People in queue with height and count of taller people in front. Reconstruct the queue.

**Example**: Input: [[7,0],[4,4],[7,1],[5,0],[6,1],[5,2]]
Output: [[5,0],[7,0],[5,2],[6,1],[4,4],[7,1]]

**Solution**:

```go
package greedy

import (
    "cmp"
    "slices"
)

// ReconstructQueue reconstructs the queue from (height, k) pairs, where k is
// the number of people at least as tall standing in front.
// LeetCode 406: Queue Reconstruction by Height
//
// Time: O(n^2). The sort is O(n log n), but each insertion shifts up to n
// elements, and that dominates. Space: O(n) for the result.
func ReconstructQueue(people [][]int) [][]int {
    // Sort by:
    // 1. Height descending (tallest first).
    // 2. K-value ascending (for equal heights, fewer people in front first).
    // Both keys are required. Equal-height people count toward each other's k,
    // so inserting the smaller k first is what keeps the index meaningful.
    slices.SortFunc(people, func(a, b []int) int {
        if a[0] != b[0] {
            return cmp.Compare(b[0], a[0]) // Taller first.
        }
        return cmp.Compare(a[1], b[1]) // Lower k first.
    })

    // Insert each person at index k
    // Key insight: When we insert a person, all previously inserted
    // people are taller, so k is exactly the insertion position
    result := make([][]int, 0, len(people))

    for _, person := range people {
        k := person[1]
        // Insert at position k
        result = append(result, nil)
        copy(result[k+1:], result[k:])
        result[k] = person
    }

    return result
}

/*
WALKTHROUGH:

Sorted input: [[7,0],[7,1],[6,1],[5,0],[5,2],[4,4]]

Step 1: Insert [7,0] at index 0
        [[7,0]]

Step 2: Insert [7,1] at index 1
        [[7,0],[7,1]]

Step 3: Insert [6,1] at index 1
        [[7,0],[6,1],[7,1]]

Step 4: Insert [5,0] at index 0
        [[5,0],[7,0],[6,1],[7,1]]

Step 5: Insert [5,2] at index 2
        [[5,0],[7,0],[5,2],[6,1],[7,1]]

Step 6: Insert [4,4] at index 4
        [[5,0],[7,0],[5,2],[6,1],[4,4],[7,1]]

WHY THIS WORKS:
- Process tallest people first
- When inserting person with k people in front, exactly k
  positions before them have taller people (all inserted so far)
- Shorter people inserted later don't affect k-values of taller people
*/
```

---

### Exercise 2: Reorganize String

**Problem**: Rearrange string so no two adjacent characters are same. Return "" if impossible.

**Example**: Input: "aab" → Output: "aba"

**Solution**:

```go
package greedy

import "container/heap"

// ReorganizeString rearranges to avoid adjacent duplicates
// LeetCode 767: Reorganize String
// Time: O(n log k), Space: O(k) where k is alphabet size
func ReorganizeString(s string) string {
    // Count frequency of each character
    freq := make(map[byte]int)
    for i := 0; i < len(s); i++ {
        freq[s[i]]++
    }

    // Check if reorganization is possible
    // If any char appears more than (n+1)/2 times, impossible
    maxFreq := (len(s) + 1) / 2
    for _, count := range freq {
        if count > maxFreq {
            return ""
        }
    }

    // Use max-heap to always pick most frequent remaining char
    h := &CharHeap{}
    heap.Init(h)

    for char, count := range freq {
        heap.Push(h, CharCount{char: char, count: count})
    }

    result := make([]byte, 0, len(s))
    var prev CharCount

    for h.Len() > 0 || prev.count > 0 {
        // If only prev char left and still has count, impossible
        if h.Len() == 0 && prev.count > 0 {
            return ""
        }

        // Pop most frequent
        curr := heap.Pop(h).(CharCount)
        result = append(result, curr.char)
        curr.count--

        // Push back previous char if it still has count
        if prev.count > 0 {
            heap.Push(h, prev)
        }

        // Current becomes prev for next iteration
        prev = curr
    }

    return string(result)
}

type CharCount struct {
    char  byte
    count int
}

type CharHeap []CharCount

func (h CharHeap) Len() int           { return len(h) }
func (h CharHeap) Less(i, j int) bool { return h[i].count > h[j].count }  // Max heap
func (h CharHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *CharHeap) Push(x any) { *h = append(*h, x.(CharCount)) }
func (h *CharHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

/*
WALKTHROUGH for "aab":

freq: {'a': 2, 'b': 1}
Max allowed: (3+1)/2 = 2 ✓

Heap: [('a',2), ('b',1)]
prev: none

Step 1: Pop 'a' (2), result="a", prev='a'(1)
        Heap: [('b',1)]

Step 2: Pop 'b' (1), push back 'a'(1), result="ab", prev='b'(0)
        Heap: [('a',1)]

Step 3: Pop 'a' (1), prev='b' has count 0, result="aba", prev='a'(0)
        Heap: []

Done! Result: "aba"
*/
```

---

### Exercise 3: Boats to Save People

**Problem**: Each boat holds at most 2 people with weight limit. Find minimum boats.

**Example**: people = [3,2,2,1], limit = 3 → Output: 3

**Solution**:

```go
package greedy

import "slices"

// NumRescueBoats finds the minimum number of boats needed, where each boat
// carries at most 2 people and at most `limit` total weight.
// LeetCode 881: Boats to Save People
//
// Sorts people in place. Time: O(n log n),
// Space: O(log n) for the sort's stack.
func NumRescueBoats(people []int, limit int) int {
    slices.Sort(people)

    boats := 0
    left, right := 0, len(people)-1

    for left <= right {
        // Heaviest person always takes a boat
        // Try to pair with lightest person
        if people[left]+people[right] <= limit {
            left++  // Lightest person fits with heaviest
        }
        right--  // Heaviest person boards
        boats++
    }

    return boats
}

/*
WHY GREEDY WORKS:

1. Heaviest person must board at some point
2. If lightest person can fit with heaviest, this is optimal
   (we're using minimum space for the pairing)
3. If lightest can't fit with heaviest, heaviest must ride alone
4. We never skip better pairings because we try lightest first

PROOF:
Consider optimal solution OPT. If OPT pairs heaviest (H) with
someone other than lightest (L), we can swap without increasing
boats (L is lighter, so it fits). If OPT has H alone but we
pair H+L, we save a boat. So our greedy is always ≤ OPT.

WALKTHROUGH for [3,2,2,1], limit=3:

Sorted: [1,2,2,3]
left=0, right=3

Step 1: people[0]+people[3] = 1+3 = 4 > 3
        Heaviest (3) rides alone
        right=2, boats=1

Step 2: people[0]+people[2] = 1+2 = 3 ≤ 3
        Pair lightest (1) with heaviest (2)
        left=1, right=1, boats=2

Step 3: left=right=1
        Middle person (2) rides alone
        boats=3

Result: 3 boats
*/
```

---

### Exercise 4: Maximum Units on a Truck

**Problem**: Load truck with boxes to maximize units. Given box types (count, units per box) and truck size.

**Example**: boxTypes = [[1,3],[2,2],[3,1]], truckSize = 4 → Output: 8

**Solution**:

```go
package greedy

import (
    "cmp"
    "slices"
)

// MaximumUnits maximizes the units loaded on a truck, given box types of
// (count, unitsPerBox) and a truck capacity measured in boxes.
// LeetCode 1710: Maximum Units on a Truck
//
// Sorts boxTypes in place. Time: O(n log n),
// Space: O(log n) for the sort's stack.
func MaximumUnits(boxTypes [][]int, truckSize int) int {
    // Sort by units per box, descending.
    // Greedy: always take the boxes with the most units first.
    slices.SortFunc(boxTypes, func(a, b []int) int {
        return cmp.Compare(b[1], a[1])
    })

    totalUnits := 0
    remainingSpace := truckSize

    for _, box := range boxTypes {
        count := box[0]
        unitsPerBox := box[1]

        // Take as many of this box type as possible
        take := min(count, remainingSpace)
        totalUnits += take * unitsPerBox
        remainingSpace -= take

        if remainingSpace == 0 {
            break
        }
    }

    return totalUnits
}

/*
WHY GREEDY WORKS:

This is essentially fractional knapsack where "weight" = 1 for all boxes.
Since all boxes take same space (1 slot), we should always prefer
boxes with more units.

No counterexample exists because:
- Each box takes exactly 1 slot
- Value per slot is the only factor
- Taking highest value per slot first is always optimal

WALKTHROUGH for [[1,3],[2,2],[3,1]], truckSize=4:

Sorted by units: [[1,3],[2,2],[3,1]]

Step 1: Box type [1,3]: 3 units/box, 1 available
        Take min(1, 4) = 1 box
        totalUnits = 1*3 = 3
        remainingSpace = 4-1 = 3

Step 2: Box type [2,2]: 2 units/box, 2 available
        Take min(2, 3) = 2 boxes
        totalUnits = 3 + 2*2 = 7
        remainingSpace = 3-2 = 1

Step 3: Box type [3,1]: 1 unit/box, 3 available
        Take min(3, 1) = 1 box
        totalUnits = 7 + 1*1 = 8
        remainingSpace = 1-1 = 0

Result: 8 units
*/
```

---

### Junior → FAANG: Patterns Across Exercise Problems

These four exercises share a common pattern: a greedy sort criterion exists that transforms the problem from exponential to linear or near-linear. Queue Reconstruction sorts by height then k-value, Reorganize String uses a max-heap to always pick the most frequent character, Boats to Save People sorts and applies two pointers, and Maximum Units treats the problem as fractional knapsack with uniform weights. When you notice that a problem reduces to "always pick the locally best option from a sorted or priority-ordered set," that is a strong signal that greedy with a heap or sorted array will work. The entry-level interview skill is recognizing which sort key to use. Practice by asking: "If I sort by X, does making the greedy pick never prevent a better future pick?"

### Senior @ FAANG: Greedy Problem Recognition as a System-Design Signal

At the senior level, exercises like these are not just algorithm practice but templates for production systems. Reorganize String is structurally identical to task scheduling on a multi-core system: given a set of tasks with cooldown constraints, how do you interleave them to minimize idle time? The heap-based greedy is optimal and translates directly to a job scheduler. Boats to Save People maps to bin packing with cardinality-2 bins, which appears in vehicle routing and ride-share dispatch. Maximum Units on a Truck is a load optimizer for logistics pipelines. A bar-raiser interviewer will not just ask you to code the solution but will then ask: "How does this change if we have multiple trucks (bins)? If item counts have uncertainty? If we need to handle online arrivals?" The ability to extend a greedy solution to these variants, or recognize when the variant breaks the greedy choice property and requires DP or LP, is the L6 signal. Staff engineers are expected to own the mapping from business requirement to algorithm class, not just the implementation of a known algorithm.
