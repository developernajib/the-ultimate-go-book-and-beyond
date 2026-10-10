## 78C.12 Intervals

Interval problems typically require sorting by start or end time, then scanning for overlaps, merges, or gaps.

---
### LC 228 - Summary Ranges 🟢

**Key Insight**: The input is already sorted and distinct, so a range is simply a maximal run where each element is exactly one more than the last. Anchor the start, run the inner loop to the end of the run, then emit.

```go
import "strconv"

func summaryRanges(nums []int) []string {
    var result []string

    for i := 0; i < len(nums); {
        start := i
        for i+1 < len(nums) && nums[i+1] == nums[i]+1 {
            i++ // extend while the run stays consecutive
        }
        if start == i {
            result = append(result, strconv.Itoa(nums[start]))
        } else {
            result = append(result, strconv.Itoa(nums[start])+"->"+strconv.Itoa(nums[i]))
        }
        i++ // step past the run we just closed
    }
    return result
}
```

The outer `for` deliberately has no post statement. The inner loop already advances `i` to the last element of the run, and the trailing `i++` moves past it, so an automatic increment would skip an element.

Comparing `nums[i+1] == nums[i]+1` rather than `nums[i+1] - nums[i] == 1` is the safer habit. On this problem values reach the int32 bounds, and while Go's 64-bit `int` absorbs both forms, the addition style is the one that survives translation to a language with 32-bit ints. A range of one element is emitted as a bare number, not as `"7->7"`, which is why the `start == i` branch exists.

**Time**: O(n) - each element is examined once, since the inner loop never rewinds.
**Space**: O(1), ignoring the output.

---
### LC 56 - Merge Intervals 🟡

**Key Insight**: Sort by start time. Merge overlapping intervals by extending the end when overlap is detected.

```go
func merge(intervals [][]int) [][]int {
    sort.Slice(intervals, func(i, j int) bool {
        return intervals[i][0] < intervals[j][0]
    })

    result := [][]int{intervals[0]}

    for i := 1; i < len(intervals); i++ {
        last := result[len(result)-1]
        if intervals[i][0] <= last[1] {
            if intervals[i][1] > last[1] {
                last[1] = intervals[i][1]
            }
        } else {
            result = append(result, intervals[i])
        }
    }
    return result
}
```

Note that `result` holds the input's own slices, so extending `last[1]` writes through to the caller's data. LeetCode accepts this, but in production code copy each interval before mutating it.

**Time**: O(n log n).
**Space**: O(n).

---
### LC 57 - Insert Interval 🟡

**Key Insight**: Add all intervals that end before the new one, merge all overlapping ones, then add the rest.

```go
func insert(intervals [][]int, newInterval []int) [][]int {
    var result [][]int
    i := 0
    n := len(intervals)

    // Add all intervals that come before
    for i < n && intervals[i][1] < newInterval[0] {
        result = append(result, intervals[i])
        i++
    }

    // Merge overlapping intervals
    for i < n && intervals[i][0] <= newInterval[1] {
        if intervals[i][0] < newInterval[0] {
            newInterval[0] = intervals[i][0]
        }
        if intervals[i][1] > newInterval[1] {
            newInterval[1] = intervals[i][1]
        }
        i++
    }
    result = append(result, newInterval)

    // Add remaining
    for i < n {
        result = append(result, intervals[i])
        i++
    }
    return result
}
```
**Time**: O(n).
**Space**: O(n).

---
### LC 252 - Meeting Rooms 🟢

**Key Insight**: Sort by start time. If any meeting starts before the previous one ends, there is a conflict.

```go
func canAttendMeetings(intervals [][]int) bool {
    sort.Slice(intervals, func(i, j int) bool {
        return intervals[i][0] < intervals[j][0]
    })

    for i := 1; i < len(intervals); i++ {
        if intervals[i][0] < intervals[i-1][1] {
            return false
        }
    }
    return true
}
```
**Time**: O(n log n).
**Space**: O(1).

---
### LC 253 - Meeting Rooms II 🟡

**Key Insight**: Use a min-heap of end times. If the earliest ending meeting ends before the next one starts, reuse that room.

```go
import "container/heap"

func minMeetingRooms(intervals [][]int) int {
    sort.Slice(intervals, func(i, j int) bool {
        return intervals[i][0] < intervals[j][0]
    })

    h := &IntHeap{}
    heap.Init(h)

    for _, iv := range intervals {
        if h.Len() > 0 && (*h)[0] <= iv[0] {
            heap.Pop(h)
        }
        heap.Push(h, iv[1])
    }
    return h.Len()
}

type IntHeap []int

func (h IntHeap) Len() int            { return len(h) }
func (h IntHeap) Less(i, j int) bool  { return h[i] < h[j] }
func (h IntHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *IntHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *IntHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```
**Time**: O(n log n).
**Space**: O(n).

---
### LC 435 - Non-overlapping Intervals 🟡

*(Covered in Greedy section.)*

---
### LC 452 - Minimum Number of Arrows to Burst Balloons 🟡

*(Covered in Greedy section.)*

---
### LC 986 - Interval List Intersections 🟡

**Key Insight**: Two pointers on two sorted interval lists. The intersection is [max(starts), min(ends)] when that range is valid. Advance the pointer with the earlier end.

```go
func intervalIntersection(firstList [][]int, secondList [][]int) [][]int {
    var result [][]int
    i, j := 0, 0

    for i < len(firstList) && j < len(secondList) {
        lo := firstList[i][0]
        if secondList[j][0] > lo {
            lo = secondList[j][0]
        }
        hi := firstList[i][1]
        if secondList[j][1] < hi {
            hi = secondList[j][1]
        }

        if lo <= hi {
            result = append(result, []int{lo, hi})
        }

        if firstList[i][1] < secondList[j][1] {
            i++
        } else {
            j++
        }
    }
    return result
}
```
**Time**: O(m + n).
**Space**: O(1), ignoring the output.

---
### LC 1288 - Remove Covered Intervals 🟡

**Key Insight**: Sort by start ascending, then by end descending. An interval is covered if its end <= the running max end.

```go
func removeCoveredIntervals(intervals [][]int) int {
    sort.Slice(intervals, func(i, j int) bool {
        if intervals[i][0] == intervals[j][0] {
            return intervals[i][1] > intervals[j][1]
        }
        return intervals[i][0] < intervals[j][0]
    })

    count := 0
    maxEnd := 0

    for _, iv := range intervals {
        if iv[1] > maxEnd {
            count++
            maxEnd = iv[1]
        }
    }
    return count
}
```
**Time**: O(n log n).
**Space**: O(1).

---

### Junior → FAANG: Interval Problems as a Pattern Family

Interval problems share one entry point: sort first. Whether you are merging, inserting, counting rooms, or finding intersections, a sort by start or end time makes the problem tractable. The most common mistake is choosing the wrong sort key. Merging overlapping intervals uses start time. Non-overlapping interval removal (greedy activity selection) uses end time. Meeting Rooms II uses start time for iteration and a min-heap of end times for room tracking. Memorize which sort key applies to which problem variant and you will handle the entire family with confidence in interviews.

### Senior @ FAANG: Interval Problems in Production Scheduling and Calendar Systems

At the senior level, interval problems directly map to production systems. Calendar conflict detection (LC 252, 253) is the core of Google Calendar's meeting scheduler and any resource reservation system. Sweep line with a sorted event list is the standard production approach for counting concurrent sessions in analytics pipelines, tracking peak concurrent connections in monitoring systems, and computing time-based billing windows. The staff-level concern is correctness under concurrent updates: when intervals are being inserted and queried simultaneously, a naive sorted array requires a read-write lock, whereas an interval tree (augmented BST) supports O(log n) insert, delete, and overlap query without global locking. Production calendar systems at FAANG scale use segment trees or interval trees backed by a distributed lock-free data structure for their hot path, falling back to batch re-sort for cold-path analytics. When owning such a system, the ADR must document the concurrency model, the expected query-to-insert ratio, and the threshold at which a switch from sorted array to interval tree becomes justified.
