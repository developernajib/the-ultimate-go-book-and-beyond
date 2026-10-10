## 75.1 Interval Scheduling

Interval scheduling is the most common family of greedy problems you will encounter in coding interviews. The central idea is to sort intervals by some criterion (usually end time) and then make a single pass through the sorted list, greedily keeping or discarding each interval. Because the sort establishes a useful ordering, you only need to compare each interval against the last one you accepted, which keeps the logic simple and the runtime at O(n log n).

### Activity Selection / Meeting Rooms

The activity selection problem asks you to pick the maximum number of non-overlapping activities from a list of start/end time pairs. The greedy insight is to always choose the activity that finishes earliest, because finishing early leaves the most room for future activities. The same sorting-by-end-time idea extends to related problems like checking whether one person can attend all meetings, or computing how many meeting rooms are needed when meetings overlap.

```go
package greedy

import (
    "cmp"
    "container/heap"
    "slices"
)

// MaxActivities selects the maximum number of non-overlapping activities.
// Classic activity selection problem. Sorts the input in place.
// Time: O(n log n), Space: O(log n) for the sort's stack.
func MaxActivities(activities [][]int) int {
    if len(activities) == 0 {
        return 0
    }

    // Sort by end time (greedy choice: finish earliest).
    slices.SortFunc(activities, func(a, b []int) int {
        return cmp.Compare(a[1], b[1])
    })

    count := 1
    lastEnd := activities[0][1]

    for i := 1; i < len(activities); i++ {
        if activities[i][0] >= lastEnd {
            count++
            lastEnd = activities[i][1]
        }
    }

    return count
}

// CanAttendMeetings reports whether one person can attend every meeting.
// LeetCode 252: Meeting Rooms
// Time: O(n log n), Space: O(log n) for the sort's stack.
func CanAttendMeetings(intervals [][]int) bool {
    if len(intervals) <= 1 {
        return true
    }

    slices.SortFunc(intervals, func(a, b []int) int {
        return cmp.Compare(a[0], b[0])
    })

    for i := 1; i < len(intervals); i++ {
        if intervals[i][0] < intervals[i-1][1] {
            return false
        }
    }

    return true
}

// MinMeetingRooms returns the minimum number of rooms needed, which is the
// maximum number of meetings concurrent at any instant.
// LeetCode 253: Meeting Rooms II
// Time: O(n log n), Space: O(n)
func MinMeetingRooms(intervals [][]int) int {
    if len(intervals) == 0 {
        return 0
    }

    // Separate start and end times
    starts := make([]int, len(intervals))
    ends := make([]int, len(intervals))

    for i, interval := range intervals {
        starts[i] = interval[0]
        ends[i] = interval[1]
    }

    slices.Sort(starts)
    slices.Sort(ends)

    rooms := 0
    endPtr := 0

    for i := 0; i < len(starts); i++ {
        if starts[i] < ends[endPtr] {
            rooms++
        } else {
            endPtr++
        }
    }

    return rooms
}

// MinMeetingRoomsHeap solves the same problem with a min-heap of end times.
// The heap holds the end time of every room currently in use, so its size is
// the number of rooms. (heap is imported in the block at the top of the file.)

type IntHeap []int
func (h IntHeap) Len() int           { return len(h) }
func (h IntHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h IntHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *IntHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *IntHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

// Time: O(n log n), Space: O(n)
func MinMeetingRoomsHeap(intervals [][]int) int {
    if len(intervals) == 0 {
        return 0
    }

    slices.SortFunc(intervals, func(a, b []int) int {
        return cmp.Compare(a[0], b[0])
    })

    h := &IntHeap{}
    heap.Init(h)
    heap.Push(h, intervals[0][1])

    for i := 1; i < len(intervals); i++ {
        if intervals[i][0] >= (*h)[0] {
            heap.Pop(h)
        }
        heap.Push(h, intervals[i][1])
    }

    return h.Len()
}
```

### Merge and Insert Intervals

Merging intervals is a slightly different flavor of interval problem. Instead of selecting non-overlapping intervals, you combine overlapping ones into larger intervals. The approach is the same: sort by start time, then walk through the list and extend the current interval whenever the next one overlaps. Inserting a new interval into an already-sorted list follows a similar pattern but can be done in O(n) without re-sorting, because you only need to find where the new interval overlaps and merge in place.

```go
// MergeIntervals merges overlapping intervals.
// LeetCode 56: Merge Intervals
//
// Each interval placed into result is copied first. Without the copy, result[0]
// would alias intervals[0], and extending the merged interval would silently
// rewrite the caller's data.
// Time: O(n log n), Space: O(n)
func MergeIntervals(intervals [][]int) [][]int {
    if len(intervals) <= 1 {
        return slices.Clone(intervals)
    }

    slices.SortFunc(intervals, func(a, b []int) int {
        return cmp.Compare(a[0], b[0])
    })

    result := [][]int{{intervals[0][0], intervals[0][1]}}

    for i := 1; i < len(intervals); i++ {
        last := result[len(result)-1]
        if intervals[i][0] <= last[1] {
            // Overlapping: extend the current interval.
            last[1] = max(last[1], intervals[i][1])
        } else {
            result = append(result, []int{intervals[i][0], intervals[i][1]})
        }
    }

    return result
}

// InsertInterval inserts newInterval into an already sorted, non-overlapping
// list and merges anything it touches.
// LeetCode 57: Insert Interval
//
// The input requires no re-sort, so this is O(n). Note that newInterval is
// copied before being widened: mutating a caller's argument in place is a
// surprising side effect, and the caller may well reuse that slice.
// Time: O(n), Space: O(n)
func InsertInterval(intervals [][]int, newInterval []int) [][]int {
    result := [][]int{}
    merged := []int{newInterval[0], newInterval[1]}
    i := 0
    n := len(intervals)

    // Add intervals that end before merged starts.
    for i < n && intervals[i][1] < merged[0] {
        result = append(result, intervals[i])
        i++
    }

    // Absorb every interval that overlaps merged.
    for i < n && intervals[i][0] <= merged[1] {
        merged[0] = min(merged[0], intervals[i][0])
        merged[1] = max(merged[1], intervals[i][1])
        i++
    }
    result = append(result, merged)

    // Add remaining intervals
    for i < n {
        result = append(result, intervals[i])
        i++
    }

    return result
}

```

### Non-overlapping Intervals

These problems flip the question: instead of selecting the maximum set of compatible intervals, you ask how many intervals you must remove so that the remaining ones do not overlap. The greedy strategy is identical to activity selection, sort by end time and keep intervals that do not conflict. The number of removals is simply the total count minus the number you kept. A closely related variant asks for the minimum number of arrows (or points) that intersect every interval, which uses the same sort-by-end-time approach.

```go
// EraseOverlapIntervals returns the minimum number of intervals to remove so
// that the rest do not overlap. This is activity selection in disguise:
// removals = n - (maximum compatible subset).
// LeetCode 435: Non-overlapping Intervals
// Time: O(n log n), Space: O(log n) for the sort's stack.
func EraseOverlapIntervals(intervals [][]int) int {
    if len(intervals) <= 1 {
        return 0
    }

    // Sort by end time.
    slices.SortFunc(intervals, func(a, b []int) int {
        return cmp.Compare(a[1], b[1])
    })

    // Greedy: Keep intervals that end earliest
    kept := 1
    lastEnd := intervals[0][1]

    for i := 1; i < len(intervals); i++ {
        if intervals[i][0] >= lastEnd {
            kept++
            lastEnd = intervals[i][1]
        }
    }

    return len(intervals) - kept
}

// FindMinArrowShots returns the minimum number of arrows that burst every
// balloon. Balloons are closed intervals, so an arrow at x bursts any balloon
// with start <= x <= end. That is why the test below is > and not >=.
// LeetCode 452: Minimum Number of Arrows to Burst Balloons
// Time: O(n log n), Space: O(log n) for the sort's stack.
func FindMinArrowShots(points [][]int) int {
    if len(points) == 0 {
        return 0
    }

    // Sorting by end with cmp.Compare rather than a - b: LeetCode allows
    // coordinates across the full int32 range, and a - b would overflow.
    slices.SortFunc(points, func(a, b []int) int {
        return cmp.Compare(a[1], b[1])
    })

    arrows := 1
    arrowPos := points[0][1]

    for i := 1; i < len(points); i++ {
        if points[i][0] > arrowPos {
            arrows++
            arrowPos = points[i][1]
        }
    }

    return arrows
}
```

### Junior → FAANG: Mastering the Interval Family Before Your First Onsite

Interval scheduling problems are one of the most frequently asked families in FAANG phone screens. The most common mistake is sorting by start time when end time is correct, or vice versa. A simple rule: if you want to select the maximum number of compatible intervals, sort by end time. If you want to merge overlapping intervals, sort by start time. If you want to count concurrent intervals (meeting rooms), sort starts and ends independently.

It is worth knowing why end time is the right key for selection, because interviewers ask. Sort by shortest duration and you fail on intervals like [0,10], [9,11], [10,20]: the shortest is [9,11], taking it blocks both others for a total of 1, while [0,10] and [10,20] give 2. Sort by earliest start and a single long interval starting at 0 blocks everything after it. Earliest finish time is the only one of the three that survives an exchange argument: if some optimal solution does not start with the earliest-finishing interval, swap its first interval for the earliest-finishing one. The swap is always legal, because the replacement finishes no later, and it keeps the count identical. Repeat and you transform any optimal solution into the greedy one without ever losing an interval.

Work through `MaxActivities`, `MinMeetingRooms`, `MergeIntervals`, and `EraseOverlapIntervals` until you can write each from memory in under 10 minutes. Pay special attention to the boundary conditions: when is `>=` correct versus `>`? In activity selection, `activities[i][0] >= lastEnd` allows back-to-back activities. In balloon bursting, `points[i][0] > arrowPos` allows the arrow to touch the boundary. Getting these off-by-one details right is a primary differentiator at the entry-level bar.

Go tip: reach for `slices.SortFunc` with a `cmp.Compare` body. The comparator receives elements rather than indices, so it is harder to get wrong, and `cmp.Compare` cannot overflow the way a hand-written `a[1] - b[1]` can. `sort.Slice` still works and you will see it in older code, but it sorts through reflection and takes indices, which is strictly more error-prone.

One more habit these functions illustrate: do not let a returned slice alias the caller's input. `MergeIntervals` copies each interval before putting it in the result, because writing `result := [][]int{intervals[0]}` would make later widening of the merged interval reach back and rewrite the caller's data. That class of bug survives every unit test that only inspects the return value.

### Senior @ FAANG: Interval Scheduling as Infrastructure Primitives

Interval scheduling algorithms appear in production infrastructure more often than most engineers realize. Meeting room schedulers, CI/CD pipeline slot allocators, database connection pool managers, and streaming segment allocators all reduce to interval problems. The senior engineer's value is not in coding the O(n log n) sort: it is in identifying which variant of the interval problem the system actually has and ensuring the implementation handles the corner cases that production data will inevitably exercise.

**Correctness at scale.** The two-array approach to `MinMeetingRooms` is elegant in interviews, but in production with millions of intervals the memory allocation pattern matters. A staff engineer would benchmark heap allocation versus stack allocation for the `starts` and `ends` slices, consider whether the intervals can be pre-sorted at ingestion time to amortize the sort cost, and evaluate whether an online (streaming) variant is needed instead of batch processing.

**ADR example for interval scheduling.** An ADR for a CI/CD slot allocator using interval scheduling would state: "We use the earliest-finish-time greedy algorithm to maximize pipeline throughput. This is correct only if pipeline run durations are known at scheduling time. If durations become unknown (speculative execution), we must switch to a dynamic scheduling policy." Naming the precondition is the deliverable. The next engineer to make durations dynamic then has something concrete to contradict, instead of discovering the assumption by reading the scheduler's source.

**Generalization to higher dimensions.** A bar-raiser question at L6/L7 might ask: "Your interval scheduler works for one resource type. How would you extend it to schedule jobs that require two resource types simultaneously (CPU and GPU)?" The useful move is recognizing that the problem leaves the tractable 1D case and becomes a vector packing problem, which is NP-hard in general, so the practical answer is an approximation. Longest Processing Time first (LPT) and the decreasing-order bin packing heuristics (First Fit Decreasing, Best Fit Decreasing) are the standard starting points, and each comes with a proven approximation ratio rather than an optimality guarantee. This demonstrates platform thinking: knowing when the greedy algorithm breaks under generalization, and what to fall back to.
