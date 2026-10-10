## Complete Exercise Solutions

### Exercise 2: Find K Pairs with Smallest Sums

**Problem**: Given two sorted arrays, find k pairs (u, v) with smallest sums u+v.

```go
// LeetCode 373: Find K Pairs with Smallest Sums
// Time: O(k log k), Space: O(k)
import "container/heap"

// Pair is a package-level named type and PairHeap is []Pair. Declaring
// Pair inside the function while the heap element type is an anonymous
// struct compiles but panics at run time, because a type assertion
// requires the exact dynamic type and a named type is never identical to
// its underlying anonymous struct.
type Pair struct {
    sum, i, j int
}

type PairHeap []Pair

func (h PairHeap) Len() int           { return len(h) }
func (h PairHeap) Less(i, j int) bool { return h[i].sum < h[j].sum }
func (h PairHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *PairHeap) Push(x any)        { *h = append(*h, x.(Pair)) }
func (h *PairHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

func kSmallestPairs(nums1 []int, nums2 []int, k int) [][]int {
    if len(nums1) == 0 || len(nums2) == 0 {
        return nil
    }

    h := &PairHeap{}

    // Seed with (nums1[i], nums2[0]) for each i, capped at k.
    // Seeding more than k rows is pointless: the k-th smallest sum can
    // never come from the (k+1)-th smallest element of nums1, since
    // nums1 is sorted and nums2[0] is its smallest partner.
    for i := 0; i < len(nums1) && i < k; i++ {
        heap.Push(h, Pair{nums1[i] + nums2[0], i, 0})
    }

    result := make([][]int, 0, k)

    for h.Len() > 0 && len(result) < k {
        pair := heap.Pop(h).(Pair)
        result = append(result, []int{nums1[pair.i], nums2[pair.j]})

        // Advance only within the same nums1 row. Every pair is reachable
        // this way exactly once, so no visited set is needed.
        if pair.j+1 < len(nums2) {
            heap.Push(h, Pair{
                nums1[pair.i] + nums2[pair.j+1],
                pair.i,
                pair.j + 1,
            })
        }
    }

    return result
}
```

---

### Exercise 3: Minimum Cost to Connect Sticks

**Problem**: Given array of stick lengths, find minimum cost to connect all into one.

```go
// LeetCode 1167: Minimum Cost to Connect Sticks
// Greedy: Always connect two smallest sticks
// Time: O(n log n), Space: O(n)
import (
    "container/heap"
    "slices"
)

func connectSticks(sticks []int) int {
    if len(sticks) <= 1 {
        return 0
    }

    // slices.Clone matters here. IntMinHeap(sticks) would be a conversion,
    // not a copy, so Init and the subsequent Pop/Push traffic would scribble
    // all over the caller's slice. Callers rarely expect an accounting
    // function to reorder their input.
    h := IntMinHeap(slices.Clone(sticks))
    heap.Init(&h)

    totalCost := 0

    for h.Len() > 1 {
        // Pop two smallest
        first := heap.Pop(&h).(int)
        second := heap.Pop(&h).(int)

        // Connect them
        combined := first + second
        totalCost += combined

        // Push combined stick back
        heap.Push(&h, combined)
    }

    return totalCost
}

type IntMinHeap []int

func (h IntMinHeap) Len() int           { return len(h) }
func (h IntMinHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h IntMinHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *IntMinHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *IntMinHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```

**Why Greedy Works**:

This is Huffman's algorithm with the alphabet renamed, and the argument is the same. Think of the merges as building a binary tree whose leaves are the original sticks. A stick's length is added to the running cost once for every merge it sits inside, which is exactly its depth in that tree. So the total cost is the sum over sticks of `length * depth`, and the task is to build the tree minimizing that weighted sum.

That framing makes the greedy obvious: long sticks must end up shallow, so short sticks have to be pushed deep, and the way to push a stick deep is to merge it early. Merging the two smallest first is precisely the move that gives the two smallest the greatest depth.

The exchange argument makes it rigorous. In any optimal tree, the two deepest leaves are siblings (otherwise you could promote one and cut the cost). If the two smallest sticks are not that sibling pair, swap them in. The swap moves smaller weights to deeper positions and larger weights shallower, which cannot increase the weighted sum. So an optimal solution exists in which the two smallest are merged first, and induction on the reduced problem finishes it.

Note the load-bearing detail: the merged stick goes **back into the heap** and competes on equal footing with the originals. It is not treated specially, and that is what makes the induction valid.

---

### Exercise 4: Course Schedule III

**Problem**: Take maximum number of courses, each with duration and deadline.

```go
// LeetCode 630: Course Schedule III
// Greedy with max-heap for replacements
// Time: O(n log n), Space: O(n)
func scheduleCourse(courses [][]int) int {
    // Sort by deadline
    sort.Slice(courses, func(i, j int) bool {
        return courses[i][1] < courses[j][1]
    })

    // Max-heap of durations (taken courses)
    h := &IntMaxHeap{}
    heap.Init(h)

    totalTime := 0

    for _, course := range courses {
        duration, deadline := course[0], course[1]

        if totalTime+duration <= deadline {
            // Can take this course
            totalTime += duration
            heap.Push(h, duration)
        } else if h.Len() > 0 && (*h)[0] > duration {
            // Replace longest course with this one (saves time)
            totalTime -= heap.Pop(h).(int)
            totalTime += duration
            heap.Push(h, duration)
        }
        // Otherwise skip this course
    }

    return h.Len()
}

type IntMaxHeap []int

func (h IntMaxHeap) Len() int           { return len(h) }
func (h IntMaxHeap) Less(i, j int) bool { return h[i] > h[j] }
func (h IntMaxHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *IntMaxHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *IntMaxHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```

**Key Insight**:
- Process courses by deadline order
- If course fits, take it
- If not, check if replacing the longest taken course helps
- Max-heap tracks durations for efficient replacement

---

### Exercise 5: Minimum Number of Refueling Stops

**Problem**: Reach target with initial fuel, using fewest gas stations.

```go
// LeetCode 871: Minimum Number of Refueling Stops
// Greedy: Use "time machine" - pretend we can refuel retroactively
// Time: O(n log n), Space: O(n)
func minRefuelStops(target int, startFuel int, stations [][]int) int {
    // Max-heap of fuel amounts we've passed
    h := &IntMaxHeap{}
    heap.Init(h)

    fuel := startFuel
    stops := 0
    prev := 0

    for i := 0; i <= len(stations); i++ {
        // Current position (target or next station)
        curr := target
        if i < len(stations) {
            curr = stations[i][0]
        }

        // Drive to current position
        fuel -= curr - prev

        // Refuel from passed stations if needed
        for fuel < 0 && h.Len() > 0 {
            fuel += heap.Pop(h).(int)
            stops++
        }

        // Can't reach this position
        if fuel < 0 {
            return -1
        }

        // Add this station's fuel to heap
        if i < len(stations) {
            heap.Push(h, stations[i][1])
        }

        prev = curr
    }

    return stops
}
```

**Algorithm Intuition**:
1. Drive as far as possible with current fuel
2. When stuck, "look back" and choose the station with most fuel
3. Max-heap lets us always pick the best option
4. This greedy approach is optimal because we minimize stops

### Junior → FAANG: Common Patterns Across the Exercise Solutions

Reading through these five exercise solutions, a pattern emerges: every problem reduces to "maintain a bounded set under a priority criterion with O(log n) updates."

For K Pairs with Smallest Sums, the key observation is that you only need to seed the heap with k entries (one per nums1 index), not all n*m possible pairs. This bounding of the initial heap size is the difference between an O(k log k) solution and an O(nm log nm) brute force.

For Minimum Cost to Connect Sticks (the Huffman pattern), the greedy correctness rests on total cost equalling the sum of `length * depth` over the implied merge tree. Merging early buries a stick deeper, so the smallest sticks are the ones you want merged first. The exchange argument above formalizes it.

For Course Schedule III, the insight of replacing the longest taken course with the current course (if it saves time) is non-obvious. The max-heap of durations makes this O(log n) per course instead of O(n).

For Minimum Refueling Stops, the "time machine" intuition (we pretend to refuel retroactively at the best station we passed) is a classic greedy trick. The max-heap stores all passed stations' fuel, making the retroactive best choice O(log n).

### Senior @ FAANG: Greedy Correctness and Exchange Arguments for Each Exercise

Staff engineers and interviewers must be able to verify that these greedy algorithms are correct, not just that they produce correct outputs on test cases. The tool is the exchange argument.

For K Pairs with Smallest Sums: the greedy is to always extract the minimum-sum pair and extend it by advancing the nums2 index. The exchange argument: if the optimal k-th pair (u, v) is not in our heap frontier, then some pair (u, v') with v' < v has not been extracted yet (since nums2 is sorted). But that pair has a smaller sum and would be extracted before (u, v), contradicting the assumption.

For Course Schedule III: the exchange argument for the replacement step: if we have taken a set S of courses and the current course fits, taking it is always at least as good as any other choice. If it does not fit but replaces the longest taken course, the resulting set has the same size but smaller total time, which is weakly better (allows more future courses).

For Minimum Refueling Stops: the exchange argument is that any optimal solution that does not use the best available station at the time of running out of fuel can be modified to use it instead, without increasing the number of stops.

Being able to state these arguments concisely (two to three sentences each) in a code review or design review is the L6 bar for algorithm correctness. At L7, you would require these arguments as written comments in production code for any non-obvious greedy algorithm.

---
