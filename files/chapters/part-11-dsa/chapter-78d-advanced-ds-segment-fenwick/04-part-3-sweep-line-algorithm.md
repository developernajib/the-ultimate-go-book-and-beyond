## 78D.3 Sweep Line Algorithm

### What Is the Sweep Line Technique?

The sweep line (or line sweep) technique processes events in sorted order, typically by time or x-coordinate. Instead of checking all pairs or ranges, we sweep through events and maintain a data structure tracking the current state.

**Common pattern:**
1. Convert the problem into events (start/end of intervals, enter/leave)
2. Sort events
3. Sweep through events, maintaining a state (counter, heap, balanced BST)
4. Extract the answer from the state at each event

### Meeting Rooms Pattern

#### LeetCode 252: Meeting Rooms

**Problem:** Given an array of meeting time intervals `[start, end]`, determine if a person could attend all meetings (no overlaps).

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

**Complexity:** O(n log n) time, O(1) space (ignoring sort).
**Key insight:** Sort by start time. If any meeting starts before the previous one ends, there is a conflict.

#### LeetCode 253: Meeting Rooms II

**Problem:** Given an array of meeting time intervals, find the minimum number of conference rooms required.

**Approach 1: Sweep line with events**

```go
func minMeetingRooms(intervals [][]int) int {
	events := make([][]int, 0, 2*len(intervals))
	for _, iv := range intervals {
		events = append(events, []int{iv[0], 1})  // meeting starts
		events = append(events, []int{iv[1], -1}) // meeting ends
	}
	sort.Slice(events, func(i, j int) bool {
		if events[i][0] == events[j][0] {
			return events[i][1] < events[j][1] // end before start at same time
		}
		return events[i][0] < events[j][0]
	})

	rooms, maxRooms := 0, 0
	for _, e := range events {
		rooms += e[1]
		if rooms > maxRooms {
			maxRooms = rooms
		}
	}
	return maxRooms
}
```

**The tie-break is the whole algorithm.** Look closely at the comparator: when two events share a coordinate, it orders by `e[1]`, and since an end carries -1 and a start carries +1, **ends sort before starts**. That is not a stylistic choice, and getting it backwards is the defining bug of this pattern.

Consider `[[1,5], [5,9]]`. One meeting ends exactly when the next begins, so one room suffices. Process ends first and the counter goes 1, 0, 1: the answer is 1. Flip the comparator so starts come first and the counter goes 1, 2, 1: the answer is 2, and you have invented a room that nobody needed.

Note what makes this dangerous. Both versions are correct on every input where no start coincides with an end, which is nearly every randomly generated test and nearly every example anyone writes by hand. The bug only fires on exact coincidence. Test the comparator with inputs built to collide, because random testing will not find this for you.

The underlying question the tie-break answers is whether intervals are half-open `[start, end)` or closed `[start, end]`. Ends-before-starts encodes half-open, which is what LC 253 wants and what "the room is free at the moment the meeting ends" means. If a problem instead says two intervals touching at a point *do* conflict, the correct comparator is the reverse. Decide which semantics the problem has before you write the comparator, and say so out loud.

**Approach 2: Min-heap**

(This is an alternative implementation of the same function. Pick one, since two functions of the same name will not compile in one package.)

```go
func minMeetingRooms(intervals [][]int) int {
	sort.Slice(intervals, func(i, j int) bool {
		return intervals[i][0] < intervals[j][0]
	})

	h := &IntHeap{}
	heap.Init(h)

	for _, iv := range intervals {
		// If earliest ending meeting ends before this one starts, reuse room
		if h.Len() > 0 && (*h)[0] <= iv[0] {
			heap.Pop(h)
		}
		heap.Push(h, iv[1])
	}
	return h.Len()
}

type IntHeap []int

func (h IntHeap) Len() int           { return len(h) }
func (h IntHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h IntHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *IntHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *IntHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}
```

The heap holds the end times of currently occupied rooms, so `h.Len()` is the room count and the heap's minimum is the soonest a room frees up. The same half-open decision reappears as the `<=` in `(*h)[0] <= iv[0]`: a room whose meeting ends exactly when the next starts is reusable. Change it to `<` and this version disagrees with the sweep version on precisely the coincident cases discussed above. The two implementations must encode the same interval semantics, and the only way to be sure they do is to test them against each other on inputs with shared endpoints.

**Complexity:** O(n log n) time, O(n) space.
**Key insight:** The number of rooms needed equals the maximum number of meetings overlapping at any instant. The sweep computes that maximum directly. The heap computes it as a side effect of never opening a room it could reuse.

### Rectangle Area with Sweep Line

This is the classic coordinate compression + sweep line pattern. Used in problems like "Rectangle Area II" (LC 850).

```go
func rectangleArea(rectangles [][]int) int {
	const MOD = 1_000_000_007

	// Collect all unique y-coordinates
	ys := make(map[int]bool)
	type event struct {
		x, y1, y2, typ int // typ: +1 open, -1 close
	}
	var events []event

	for _, r := range rectangles {
		x1, y1, x2, y2 := r[0], r[1], r[2], r[3]
		ys[y1] = true
		ys[y2] = true
		events = append(events, event{x1, y1, y2, 1})
		events = append(events, event{x2, y1, y2, -1})
	}

	// Sort y-coordinates
	sortedY := make([]int, 0, len(ys))
	for y := range ys {
		sortedY = append(sortedY, y)
	}
	sort.Ints(sortedY)

	// Map y -> index
	yIndex := make(map[int]int)
	for i, y := range sortedY {
		yIndex[y] = i
	}

	// Sort events by x
	sort.Slice(events, func(i, j int) bool {
		return events[i].x < events[j].x
	})

	// Sweep
	count := make([]int, len(sortedY)) // count of active rectangles covering each y-segment
	area := 0
	prevX := events[0].x

	i := 0
	for i < len(events) {
		curX := events[i].x

		// Calculate active y-length
		activeLen := 0
		for j := 0; j < len(sortedY)-1; j++ {
			if count[j] > 0 {
				activeLen += sortedY[j+1] - sortedY[j]
			}
		}

		// Add area
		area = (area + activeLen*(curX-prevX)) % MOD

		// Process all events at this x
		for i < len(events) && events[i].x == curX {
			e := events[i]
			y1Idx := yIndex[e.y1]
			y2Idx := yIndex[e.y2]
			for j := y1Idx; j < y2Idx; j++ {
				count[j] += e.typ
			}
			i++
		}
		prevX = curX
	}

	return area
}
```

**Complexity:** O(n²) where n is the number of rectangles. There are O(n) distinct x-coordinates and each one rescans the O(n) y-segments to total the active length. Replacing that rescan with a segment tree over the y-axis, one that tracks covered length under range add and subtract, brings it to O(n log n). That segment tree is a genuinely tricky one, since it must maintain "total covered length" rather than a simple sum, so its nodes store both a coverage count and a length. It is worth naming as the next step in an interview even if you implement the O(n²) version.

Two details in the sweep above. The area for the strip between `prevX` and `curX` is computed *before* the events at `curX` are applied, because that strip's coverage is whatever was active on the way in. And `count` is indexed by y-*segment*, not by y-coordinate: `count[j]` covers the gap between `sortedY[j]` and `sortedY[j+1]`, which is why the loops stop at `len(sortedY)-1` and why the update runs `for j := y1Idx; j < y2Idx`. Coordinate compression is what makes this legal: coverage can only change at a coordinate where some rectangle has an edge, so the segments between consecutive coordinates are uniform.

---

### Junior → FAANG: Sweep Line as a Problem Reduction Technique

The sweep line turns a 2D geometric problem into a sequence of 1D problems. The interview entry point is recognizing when a problem involves intervals or rectangles and asking: "Can I process events in sorted order and maintain a simple state?" For Meeting Rooms II, the events are interval starts and ends, and the state is the count of active meetings. For rectangle union area, the events are left and right edges, and the state is a coverage count array. The technique always has three steps: create events, sort events, and sweep while updating state. The sort comparator is often where bugs hide: ties between a start event and an end event at the same coordinate must be resolved consistently, typically by processing ends before starts (for counting rooms, processing ends first means a departing meeting frees its room before the next one claims it).

### Senior @ FAANG: Sweep Line in Computational Geometry and Geospatial Systems

At the senior level, sweep line is the foundation of computational geometry. Bentley-Ottmann finds all intersections among n line segments in O((n + k) log n) where k is the number of intersections, and it is the standard approach behind segment intersection in geometry libraries. Shamos-Hoey is the simpler relative that only answers whether *any* two segments intersect, in O(n log n), which is what polygon validity checking needs. Polygon overlay, computing the union or intersection of two regions, is the same sweep, and it is what geofencing and spatial joins reduce to.

The concern when shipping any of these is numerical precision, and it is a sharper version of the tie-break problem above. Under floating point, deciding whether a point lies exactly on a segment, or whether two events share an x-coordinate, is not reliably answerable. An epsilon comparison can even produce an *inconsistent* ordering, where a < b and b < c but c < a, which breaks the sort itself and corrupts the sweep's state structure. This is why serious implementations use exact predicates: integer coordinates on a fixed grid, or adaptive-precision arithmetic that falls back to exact evaluation only when a determinant is too close to zero to call.

Note the shared theme with the interview version. In both cases the algorithm is correct on generic inputs and fails only on degeneracy: coincident endpoints, collinear segments, shared vertices. Degenerate inputs are rare in random tests and common in real data, because real data comes from grids, snaps to shared boundaries, and repeats. Test the degenerate cases explicitly, because your users will supply them.
