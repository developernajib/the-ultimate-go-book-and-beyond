## 71.7 Advanced Heap Problems

### Reorganize String

Rearranging a string so no two adjacent characters are the same is a greedy frequency problem: always place the most frequent remaining character that differs from the previous character. A max-heap ordered by frequency efficiently identifies this character at each step, and if the most frequent character exceeds half the string length, no valid arrangement exists.

```go
import "container/heap"

// ReorganizeString rearranges string so no two adjacent chars are same
// LeetCode 767: Reorganize String
// Time: O(n log n), Space: O(n)
func ReorganizeString(s string) string {
    // Count frequencies
    freq := make(map[byte]int)
    for i := 0; i < len(s); i++ {
        freq[s[i]]++
    }

    // Max-heap by frequency
    h := &CharHeap{}
    heap.Init(h)

    for ch, count := range freq {
        // If any char appears more than (n+1)/2 times, impossible
        if count > (len(s)+1)/2 {
            return ""
        }
        heap.Push(h, CharItem{char: ch, freq: count})
    }

    result := make([]byte, 0, len(s))
    var prev CharItem

    for h.Len() > 0 {
        curr := heap.Pop(h).(CharItem)
        result = append(result, curr.char)
        curr.freq--

        // Re-add previous character
        if prev.freq > 0 {
            heap.Push(h, prev)
        }

        prev = curr
    }

    return string(result)
}

type CharItem struct {
    char byte
    freq int
}

type CharHeap []CharItem

func (h CharHeap) Len() int           { return len(h) }
func (h CharHeap) Less(i, j int) bool { return h[i].freq > h[j].freq } // max-heap
func (h CharHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *CharHeap) Push(x any) { *h = append(*h, x.(CharItem)) }
func (h *CharHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```

### Task Scheduler

The mathematical formula `(maxFreq - 1) * (n + 1) + maxCount` models the scheduler as a grid of cycles each of width `n+1`: the most-frequent task anchors each cycle, and the remaining slots fill with other tasks or idles. When enough distinct tasks exist to fill every cycle slot, no idle time is needed and the answer collapses to `len(tasks)`. The heap simulation in `LeastIntervalHeap` validates this by greedily executing the most-frequent available task each time unit.

```go
// LeastInterval finds minimum intervals to complete all tasks
// LeetCode 621: Task Scheduler
// Time: O(n), Space: O(1)
func LeastInterval(tasks []byte, n int) int {
    // Count frequencies
    freq := make([]int, 26)
    maxFreq := 0

    for _, task := range tasks {
        freq[task-'A']++
        if freq[task-'A'] > maxFreq {
            maxFreq = freq[task-'A']
        }
    }

    // Count tasks with max frequency
    maxCount := 0
    for _, f := range freq {
        if f == maxFreq {
            maxCount++
        }
    }

    // Calculate minimum intervals
    // Formula: (maxFreq - 1) * (n + 1) + maxCount
    // This accounts for the idle time between same tasks
    intervals := (maxFreq-1)*(n+1) + maxCount

    // But if we have enough tasks, no idle time needed
    if intervals < len(tasks) {
        return len(tasks)
    }

    return intervals
}

// LeastIntervalHeap using heap simulation
func LeastIntervalHeap(tasks []byte, n int) int {
    freq := make([]int, 26)
    for _, task := range tasks {
        freq[task-'A']++
    }

    h := &MaxIntHeap{}
    heap.Init(h)
    for _, f := range freq {
        if f > 0 {
            heap.Push(h, f)
        }
    }

    time := 0
    for h.Len() > 0 {
        // Process up to n+1 tasks in this cycle
        cycle := n + 1
        temp := []int{}

        for cycle > 0 && h.Len() > 0 {
            count := heap.Pop(h).(int)
            if count > 1 {
                temp = append(temp, count-1)
            }
            time++
            cycle--
        }

        // Add remaining tasks back
        for _, t := range temp {
            heap.Push(h, t)
        }

        // If there are more tasks, add idle time
        if h.Len() > 0 {
            time += cycle
        }
    }

    return time
}
```

### Smallest Range Covering Elements from K Lists

The key insight is that the range `[min, max]` across the k list pointers is minimized by advancing only the pointer holding the current minimum value. Advancing any other pointer cannot shrink the lower bound. A min-heap tracks the current minimum across all k cursors in O(log k), while a running `maxVal` variable tracks the upper bound, so each step evaluates a candidate range and advances the minimum list's pointer in O(log k) time.

```go
// SmallestRange finds smallest range covering at least one element from each list
// LeetCode 632: Smallest Range Covering Elements from K Lists
// Time: O(n log k), Space: O(k)
func SmallestRange(nums [][]int) []int {
    type Item struct {
        val      int
        listIdx  int
        elemIdx  int
    }

    h := make([]Item, 0)
    maxVal := nums[0][0]

    // Initialize with first element of each list
    for i, list := range nums {
        h = append(h, Item{val: list[0], listIdx: i, elemIdx: 0})
        if list[0] > maxVal {
            maxVal = list[0]
        }
    }

    // Heapify (min-heap by val)
    for i := len(h)/2 - 1; i >= 0; i-- {
        siftDownItem(h, i)
    }

    result := []int{h[0].val, maxVal}

    for {
        // Pop minimum
        min := h[0]

        // Update result if smaller range found
        if maxVal-min.val < result[1]-result[0] {
            result = []int{min.val, maxVal}
        }

        // Get next element from same list
        nextIdx := min.elemIdx + 1
        if nextIdx >= len(nums[min.listIdx]) {
            break // One list exhausted
        }

        nextVal := nums[min.listIdx][nextIdx]
        h[0] = Item{val: nextVal, listIdx: min.listIdx, elemIdx: nextIdx}
        siftDownItem(h, 0)

        // Update max
        if nextVal > maxVal {
            maxVal = nextVal
        }
    }

    return result
}

func siftDownItem(h []Item, idx int) {
    n := len(h)
    for {
        smallest := idx
        left, right := 2*idx+1, 2*idx+2
        if left < n && h[left].val < h[smallest].val {
            smallest = left
        }
        if right < n && h[right].val < h[smallest].val {
            smallest = right
        }
        if smallest == idx {
            break
        }
        h[idx], h[smallest] = h[smallest], h[idx]
        idx = smallest
    }
}
```

`SmallestRange` assumes every list is non-empty and that `nums` itself is non-empty, since it reads `nums[0][0]` before validating anything. The LeetCode constraints guarantee both. It also never removes an exhausted list from the heap, it stops the moment any list runs out, which is correct: once one list has no elements left, no later window can still cover all k lists.

### Junior → FAANG: Recognizing the Greedy-Heap Combination

The three problems in this section (Reorganize String, Task Scheduler, Smallest Range) share a pattern: a greedy choice at each step depends on a dynamically changing maximum or minimum, which is exactly what a heap provides.

For Reorganize String, the greedy rule is: always place the most frequent remaining character that is not the previous character. Be honest about what the heap buys you here. With a 26-letter alphabet, scanning the frequency array costs 26 steps and the heap costs log 26, and both are constants, so the heap is not an asymptotic win at all. A linear scan over 26 counters is a perfectly good answer and may well be faster in wall-clock terms. The heap earns its place by making the greedy choice explicit in the code, and by scaling if the alphabet is not 26 but Unicode. Say that out loud in an interview rather than claiming a speedup you do not have, since claiming O(log 26) beats O(26) invites the follow-up "both of those are O(1), so what did you actually gain?"

For Task Scheduler, the formula `(maxFreq - 1) * (n + 1) + maxCount` is the faster path to the answer, but the heap simulation validates it and is more natural to derive from scratch under interview pressure. If you blank on the formula, derive the simulation and mention the formula as an optimization.

The Smallest Range problem is rated Hard and combines k-way merge with a sliding window. Recognize it as "always advance the minimum pointer" (same insight as k-way merge) and use the heap to identify the minimum efficiently.

### Senior @ FAANG: Greedy Correctness, Exchange Arguments, and Code Review

At staff level, you are expected not only to implement greedy-heap algorithms but to verify their correctness rigorously. The standard tool is an exchange argument: assume the greedy choice is not optimal, then show that any optimal solution can be transformed into the greedy solution without reducing the objective value. This constitutes a proof that greedy is correct.

Be careful not to wave your hands here, because Reorganize String is a feasibility problem, not an optimization problem. There is no objective value to exchange for, so "swap it and the solution does not get worse" is not a proof of anything. The honest argument is an invariant argument:

A valid arrangement of a multiset of length `m` exists exactly when no character's count exceeds `ceil(m/2)`. That is the condition the code checks up front. The greedy then maintains it as an invariant. At each step it emits the most frequent available character (excluding the one just placed, which is held back in `prev` and reinserted only after the next pick). Emitting the current maximum is what keeps the remaining multiset feasible: it decrements the only count that could have been in danger of exceeding half of the shrinking remainder. Had you emitted anything else, the maximum count would stay put while the remaining length dropped by one, which is exactly how a count crosses the `ceil(m/2)` line and strands you. So the greedy step preserves feasibility, feasibility holds initially by the check, and the loop terminates because each iteration emits one character. That is a real proof, and it is the shape you want: identify the invariant, show the greedy preserves it.

In code review, greedy algorithms deserve scrutiny on three failure modes: an incorrect greedy criterion (optimizing or preserving the wrong quantity), missing edge cases (what if two characters tie for maximum frequency?), and non-termination (does each step strictly shrink the problem?). For Task Scheduler, the edge case is having enough distinct tasks that no idling is ever needed. The `if intervals < len(tasks) { return len(tasks) }` guard is what handles it, and that guard is exactly the line a reviewer should ask about, because the formula alone silently under-counts without it.

The Smallest Range problem is worth mentioning in system design discussions as a primitive for multi-source data alignment: aligning sensor readings from k sensors with imperfect clocks, finding the smallest time window that contains one reading from each sensor. This real-world framing is the kind of context a senior engineer adds when presenting an algorithmic solution to make it relevant to the business problem.
