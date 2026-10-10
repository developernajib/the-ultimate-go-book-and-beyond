## Additional Interview Questions with Frameworks

### Question 3: Sliding Window Median

**Problem**: Find the median of each sliding window of size k.

```
┌─────────────────────────────────────────────────────────────────┐
│           SLIDING WINDOW MEDIAN FRAMEWORK                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Challenge: Support efficient ADD, REMOVE, and FIND_MEDIAN      │
│                                                                 │
│  Two-Heap Approach (same as running median):                    │
│  • maxHeap: smaller half (max at top)                           │
│  • minHeap: larger half (min at top)                            │
│                                                                 │
│  But removal is O(n) in standard heap!                          │
│                                                                 │
│  Solution: Lazy Removal                                         │
│  1. Track "balance" between heaps                               │
│  2. Mark items as "removed" in a hashmap                        │
│  3. Only actually remove when item is at heap top               │
│  4. Maintain logical sizes for balance                          │
│                                                                 │
│  Time: O((n-k+1) * log k) | Space: O(k)                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

A warning before the code: the tempting shortcut here is to fake a max-heap by negating values on the way in and out. Combine that with a `Less` that is *also* inverted and you get a double negation that type-checks, runs, and returns plausible-looking garbage. Use two honest heap types instead, `MaxIntHeap` (`Less` returns `h[i] > h[j]`) and `IntHeap` (`Less` returns `h[i] < h[j]`), both storing values as-is. Fewer sign flips, fewer bugs.

```go
// LeetCode 480: Sliding Window Median
// Time: O(n log k), Space: O(k)
//
// small (max-heap) holds the lower half, large (min-heap) the upper half.
// Invariant: smallSz == largeSz or smallSz == largeSz+1, and every live
// value in small is <= every live value in large.
//
// The heaps physically contain elements that have already left the window.
// smallSz/largeSz are the LOGICAL sizes, counting only live elements, and
// they are what the balance invariant is maintained over. prune only ever
// discards dead elements from a root, which is the only place they can be
// found in O(1).
type SlidingMedian struct {
    small   MaxIntHeap  // lower half, max at root
    large   IntHeap     // upper half, min at root
    delayed map[int]int // value -> pending deletions
    smallSz int         // logical size of small
    largeSz int         // logical size of large
}

func NewSlidingMedian() *SlidingMedian {
    return &SlidingMedian{delayed: make(map[int]int)}
}

func medianSlidingWindow(nums []int, k int) []float64 {
    sm := NewSlidingMedian()

    for i := 0; i < k; i++ {
        sm.addNum(nums[i])
    }

    result := make([]float64, 0, len(nums)-k+1)
    result = append(result, sm.findMedian(k))

    for i := k; i < len(nums); i++ {
        sm.addNum(nums[i])
        sm.removeNum(nums[i-k])
        result = append(result, sm.findMedian(k))
    }

    return result
}

func (sm *SlidingMedian) addNum(num int) {
    if len(sm.small) == 0 || num <= sm.small[0] {
        heap.Push(&sm.small, num)
        sm.smallSz++
    } else {
        heap.Push(&sm.large, num)
        sm.largeSz++
    }
    sm.rebalance()
}

func (sm *SlidingMedian) removeNum(num int) {
    sm.delayed[num]++

    // Decide which half owned it by the same test addNum used.
    if num <= sm.small[0] {
        sm.smallSz--
        if num == sm.small[0] {
            sm.pruneSmall() // it is at the root, so evict it now
        }
    } else {
        sm.largeSz--
        if num == sm.large[0] {
            sm.pruneLarge()
        }
    }
    sm.rebalance()
}

func (sm *SlidingMedian) rebalance() {
    if sm.smallSz > sm.largeSz+1 {
        heap.Push(&sm.large, heap.Pop(&sm.small).(int))
        sm.smallSz--
        sm.largeSz++
        sm.pruneSmall() // small's new root may be dead
    } else if sm.smallSz < sm.largeSz {
        heap.Push(&sm.small, heap.Pop(&sm.large).(int))
        sm.smallSz++
        sm.largeSz--
        sm.pruneLarge()
    }
}

func (sm *SlidingMedian) pruneSmall() {
    for len(sm.small) > 0 && sm.delayed[sm.small[0]] > 0 {
        v := sm.small[0]
        sm.delayed[v]--
        if sm.delayed[v] == 0 {
            delete(sm.delayed, v)
        }
        heap.Pop(&sm.small)
    }
}

func (sm *SlidingMedian) pruneLarge() {
    for len(sm.large) > 0 && sm.delayed[sm.large[0]] > 0 {
        v := sm.large[0]
        sm.delayed[v]--
        if sm.delayed[v] == 0 {
            delete(sm.delayed, v)
        }
        heap.Pop(&sm.large)
    }
}

func (sm *SlidingMedian) findMedian(k int) float64 {
    if k%2 == 1 {
        return float64(sm.small[0])
    }
    return (float64(sm.small[0]) + float64(sm.large[0])) / 2.0
}
```

`MaxIntHeap` and `IntHeap` are the plain slice heaps from Section 71.2, with no negation anywhere.

Two things to notice. The prune calls are placed where a root can newly become dead, not sprayed everywhere, and each prune is amortized O(1) across the run because every element is pushed once and popped at most once. And `findMedian` reads `sm.small[0]` directly, which is safe precisely because prune guarantees the root is always live. If you ever relax that guarantee, the median silently starts reporting values that already left the window.

The complexity claim deserves care as well: the heaps can grow to O(n) physically if dead elements never reach a root, so O(k) space is the amortized steady state rather than a hard bound. On adversarial input, memory is bounded by the number of insertions.

---

### Question 4: IPO (Maximum Capital Selection)

**Problem**: Given projects with profits and capital requirements, find maximum capital after completing at most k projects.

```
┌──────────────────────────────────────────────────────────────────┐
│           TWO-HEAP GREEDY FRAMEWORK                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Problem Structure:                                              │
│  • Start with capital W                                          │
│  • Each project i has profit[i] and capital[i] requirement       │
│  • Can do at most k projects sequentially                        │
│  • Maximize final capital                                        │
│                                                                  │
│  Greedy Insight:                                                 │
│  • Given available capital, always pick highest profit project   │
│  • Completed project adds profit to capital                      │
│                                                                  │
│  Two-Structure Strategy:                                         │
│  1. sorted slice: all projects, ascending capital requirement    │
│  2. maxHeap: affordable projects, ordered by profit              │
│                                                                  │
│  Algorithm:                                                      │
│  for k iterations:                                               │
│    • Sweep newly affordable projects into maxHeap                │
│    • Pick max profit project from maxHeap                        │
│    • Add profit to capital (capital only grows)                  │
│                                                                  │
│  Why it terminates well: profits are non-negative, so capital    │
│  never shrinks and the affordable set only ever grows.           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

```go
// LeetCode 502: IPO
// Time: O(n log n), Space: O(n)
import (
    "container/heap"
    "sort"
)

func findMaximizedCapital(k int, w int, profits []int, capital []int) int {
    n := len(profits)

    type Project struct {
        profit  int
        capital int
    }

    // Sorted slice by capital requirement, NOT a heap. The framework
    // diagram calls this a min-heap, and a min-heap would work, but since
    // we sweep it strictly left to right and never insert, sorting once is
    // simpler and the same O(n log n). Only the profit side needs a heap,
    // because that is where elements arrive dynamically.
    byCapital := make([]Project, n)
    for i := 0; i < n; i++ {
        byCapital[i] = Project{profits[i], capital[i]}
    }
    sort.Slice(byCapital, func(i, j int) bool {
        return byCapital[i].capital < byCapital[j].capital
    })

    // Max-heap by profit, holding exactly the currently affordable projects.
    profitHeap := &ProfitHeap{}

    idx := 0
    for i := 0; i < k; i++ {
        // Unlock everything now affordable. idx never rewinds, so across
        // all k iterations this inner loop runs at most n times total.
        for idx < n && byCapital[idx].capital <= w {
            heap.Push(profitHeap, byCapital[idx].profit)
            idx++
        }

        if profitHeap.Len() == 0 {
            break // nothing affordable, and capital can only stay put
        }

        // Take the most profitable available project.
        w += heap.Pop(profitHeap).(int)
    }

    return w
}

type ProfitHeap []int

func (h ProfitHeap) Len() int           { return len(h) }
func (h ProfitHeap) Less(i, j int) bool { return h[i] > h[j] } // max-heap
func (h ProfitHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *ProfitHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *ProfitHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```

---

### Question 5: K-th Smallest in Sorted Matrix

**Problem**: Find k-th smallest element in matrix sorted row-wise and column-wise.

```
┌─────────────────────────────────────────────────────────────────┐
│           MATRIX SEARCH WITH HEAP FRAMEWORK                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Matrix Property:                                               │
│  ┌─────┬─────┬─────┐                                            │
│  │  1  │  5  │  9  │  Each row sorted                           │
│  ├─────┼─────┼─────┤  Each column sorted                        │
│  │  10 │  11 │  13 │                                            │
│  ├─────┼─────┼─────┤                                            │
│  │  12 │  13 │  15 │                                            │
│  └─────┴─────┴─────┘                                            │
│                                                                 │
│  Approach 1: Heap (k elements)                                  │
│  • Start with first element of each row                         │
│  • Pop minimum, push next element from same row                 │
│  • Repeat k times                                               │
│  Time: O(k log n)                                               │
│                                                                 │
│  Approach 2: Binary Search                                      │
│  • Binary search on value range                                 │
│  • Count elements <= mid in O(n)                                │
│  • Time: O(n log(max-min))                                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// LeetCode 378: Kth Smallest Element in a Sorted Matrix
// Approach 1: Heap - O(k log n)

// Cell must be a package-level named type, and CellHeap must be []Cell.
// Declaring Cell inside the function while the heap holds an anonymous
// struct{val, row, col int} compiles but panics at run time: a type
// assertion needs the EXACT dynamic type, and a named type is never
// identical to its underlying anonymous struct for that purpose.
type Cell struct {
    val, row, col int
}

type CellHeap []Cell

func (h CellHeap) Len() int           { return len(h) }
func (h CellHeap) Less(i, j int) bool { return h[i].val < h[j].val }
func (h CellHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *CellHeap) Push(x any)        { *h = append(*h, x.(Cell)) }
func (h *CellHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

func kthSmallestHeap(matrix [][]int, k int) int {
    n := len(matrix)

    h := &CellHeap{}

    // Seed with the first element of each row. Only min(n, k) rows can
    // possibly contribute to the k-th smallest.
    for i := 0; i < n && i < k; i++ {
        heap.Push(h, Cell{matrix[i][0], i, 0})
    }

    var result int
    for i := 0; i < k; i++ {
        cell := heap.Pop(h).(Cell)
        result = cell.val

        // Advance within the same row.
        if cell.col+1 < len(matrix[cell.row]) {
            heap.Push(h, Cell{matrix[cell.row][cell.col+1], cell.row, cell.col + 1})
        }
    }

    return result
}

// Approach 2: Binary Search - O(n log(max-min))
func kthSmallestBinarySearch(matrix [][]int, k int) int {
    n := len(matrix)
    lo, hi := matrix[0][0], matrix[n-1][n-1]

    for lo < hi {
        mid := lo + (hi-lo)/2

        // Count elements <= mid
        count := 0
        col := n - 1
        for row := 0; row < n; row++ {
            for col >= 0 && matrix[row][col] > mid {
                col--
            }
            count += col + 1
        }

        if count < k {
            lo = mid + 1
        } else {
            hi = mid
        }
    }

    return lo
}
```

---

### Question 6: Trapping Rain Water II (3D)

**Problem**: Given 2D elevation map, calculate volume of water trapped after raining.

```
┌─────────────────────────────────────────────────────────────────┐
│           3D WATER TRAPPING WITH MIN-HEAP                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Key Insight: Water level at any cell is determined by          │
│  the lowest boundary that can contain it.                       │
│                                                                 │
│  BFS from boundaries using min-heap:                            │
│  1. Add all boundary cells to min-heap                          │
│  2. Process cells in order of height (lowest first)             │
│  3. For each cell, check neighbors:                             │
│     • If neighbor is lower, it can trap water                   │
│     • Add neighbor to heap with max(current_height, neighbor)   │
│                                                                 │
│  Why min-heap? We need to process the lowest boundary first     │
│  because that determines the water level for interior cells.    │
│                                                                 │
│  Time: O(m*n*log(m*n)), Space: O(m*n)                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// LeetCode 407: Trapping Rain Water II
// Time: O(m*n*log(m*n)), Space: O(m*n)

// Named package-level type again, for the same reason as Cell above.
type WaterCell struct {
    height, row, col int
}

type CellMinHeap []WaterCell

func (h CellMinHeap) Len() int           { return len(h) }
func (h CellMinHeap) Less(i, j int) bool { return h[i].height < h[j].height }
func (h CellMinHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *CellMinHeap) Push(x any)        { *h = append(*h, x.(WaterCell)) }
func (h *CellMinHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

func trapRainWater(heightMap [][]int) int {
    if len(heightMap) == 0 || len(heightMap[0]) == 0 {
        return 0
    }

    m, n := len(heightMap), len(heightMap[0])
    if m < 3 || n < 3 {
        return 0 // no interior cell can hold water
    }

    h := &CellMinHeap{}

    visited := make([][]bool, m)
    for i := range visited {
        visited[i] = make([]bool, n)
    }

    // Seed with every boundary cell. Water can never be trapped on the
    // border, so the border is the initial "wall" we work inward from.
    for i := 0; i < m; i++ {
        heap.Push(h, WaterCell{heightMap[i][0], i, 0})
        heap.Push(h, WaterCell{heightMap[i][n-1], i, n - 1})
        visited[i][0] = true
        visited[i][n-1] = true
    }
    for j := 1; j < n-1; j++ {
        heap.Push(h, WaterCell{heightMap[0][j], 0, j})
        heap.Push(h, WaterCell{heightMap[m-1][j], m - 1, j})
        visited[0][j] = true
        visited[m-1][j] = true
    }

    dirs := [][]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}}
    water := 0

    for h.Len() > 0 {
        cell := heap.Pop(h).(WaterCell)

        for _, d := range dirs {
            nr, nc := cell.row+d[0], cell.col+d[1]

            if nr < 0 || nr >= m || nc < 0 || nc >= n || visited[nr][nc] {
                continue
            }

            // Mark on ENQUEUE, not on dequeue. Marking when the cell is
            // popped would let it be pushed several times from different
            // neighbours and counted more than once.
            visited[nr][nc] = true

            // The popped cell is the lowest unprocessed wall, so any lower
            // neighbour is flooded exactly up to that wall's height.
            if heightMap[nr][nc] < cell.height {
                water += cell.height - heightMap[nr][nc]
            }

            // The neighbour now acts as a wall at its effective water level.
            newHeight := max(cell.height, heightMap[nr][nc])
            heap.Push(h, WaterCell{newHeight, nr, nc})
        }
    }

    return water
}
```

Why the min-heap is the load-bearing choice: popping the globally lowest wall guarantees that when a cell is first reached, it is reached across the lowest possible barrier. Water escapes over the lowest rim, so that first arrival already fixes the final water level and the cell never needs revisiting. Pop the highest wall instead and the invariant collapses, because a lower path might still be found later.

### Junior → FAANG: Framework Diagrams as Interview Scaffolding

The framework diagrams (the ASCII boxes above each problem) are the most valuable part of this section for interview preparation. They capture the key insight for each problem in a format you can reconstruct from memory before writing a single line of code.

For the Sliding Window Median, the key insight is "lazy removal": you cannot cheaply remove an arbitrary element from a heap, so you mark it dead in a map and discard it only once it reaches a root. Direct removal is O(n) because finding the element requires a scan, unless you maintain an index map alongside.

The subtlety worth reconstructing is why lazy removal stays *correct* rather than merely cheap. Dead elements sit in the heaps indefinitely, so the physical size means nothing. The fix is to track logical sizes (`smallSz`, `largeSz`) separately and maintain the balance invariant over those, never over `len()`. A dead element buried in the middle of a heap is harmless precisely because it can never affect a root comparison, and by the time it *can* (it has surfaced), prune removes it. That is the whole argument, and getting it wrong by balancing on physical size is the classic way this solution fails.

For the IPO problem, the insight is "greedy with two heaps": sort projects by capital requirement, then use a min-heap to unlock affordable projects and a max-heap to always select the highest-profit available project. Practice sketching this two-heap architecture on paper before coding.

For Trapping Rain Water II, the insight is BFS from the boundary inward using the minimum boundary height as the water level. The min-heap always gives you the lowest boundary cell to process next, ensuring water level is never overestimated. This is the 3D generalization of the two-pointer approach for the 1D problem.

### Senior @ FAANG: Advanced Framework Design and Problem Decomposition

At staff level, you should be able to generate framework diagrams for novel problems, not just recall them for known problems. The process: (1) identify the invariant that the data structure must maintain, (2) identify the operation that is repeated in the main loop and its required complexity, (3) choose the data structure that provides that operation at the required complexity, (4) verify that the invariant is maintained by the chosen data structure's operations.

For the Sliding Window Median: the invariant is the two-heap balance (section 71.5), extended with lazy deletion. The repeated operation is "remove the oldest element and add the newest element, then find the median", requiring O(log k) per step. The lazy deletion map is the extension that makes removal O(log k) amortized instead of O(k).

For the IPO problem: the invariant is that the max-profit heap only contains projects whose capital requirement is satisfied by the current capital. The repeated operation is "select the max-profit affordable project", requiring O(log n). The two-heap architecture maintains the invariant by transferring projects from the capital-sorted min-heap to the profit max-heap each time capital increases.

Framework generation is the skill that separates engineers who can solve problems they have seen from engineers who can solve problems they have never seen. At L6 and above, novel problem solving is the primary signal in bar-raiser interviews, and framework generation is the underlying cognitive skill being assessed.

---
