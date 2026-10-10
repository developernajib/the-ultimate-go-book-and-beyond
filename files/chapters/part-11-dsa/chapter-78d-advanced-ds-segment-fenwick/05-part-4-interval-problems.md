## 78D.4 Interval Problems

### LeetCode 56: Merge Intervals

**Problem:** Given an array of intervals, merge all overlapping intervals.

Sorting intervals by start time ensures that any interval that can merge with a previous one is adjacent in the sorted order. After sorting, a single pass extends the current interval's end as long as the next interval overlaps, adding the finalized interval to the result when a gap is encountered.

```go
import "sort"

func merge(intervals [][]int) [][]int {
	sort.Slice(intervals, func(i, j int) bool {
		return intervals[i][0] < intervals[j][0]
	})

	result := [][]int{intervals[0]}
	for i := 1; i < len(intervals); i++ {
		last := result[len(result)-1]
		if intervals[i][0] <= last[1] {
			// Overlapping: extend the end
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

**Complexity:** O(n log n) time, O(n) space.
**Key insight:** Sort by start. If the current interval overlaps the last merged one, extend its end. Otherwise start a new merged interval. Sorting is what makes the single pass sufficient: once sorted by start, anything that can merge with an earlier interval must be adjacent to it in the order, so there is never a reason to look further back than `result`'s last element.

Two caveats the problem constraints hide. This **mutates the caller's slices**. `result` is seeded with `intervals[0]` itself, not a copy, so `last[1] = ...` writes through to the caller's data: after `merge([][]int{{1,3},{2,6},{8,10}})` the caller's first interval has silently become `[1,6]`. The `sort.Slice` reorders the caller's outer slice too. Both are fine on LeetCode and neither is fine in a library. Copy each interval into `result` if the input must survive.

It also panics on empty input at `intervals[0]`. LC 56 guarantees at least one interval. Real code should not.

Note the `<=` in the overlap test: intervals that merely touch, like `[1,4]` and `[4,5]`, are merged into `[1,5]`. That is what LC 56 wants. It is the opposite convention from the half-open one in the Meeting Rooms sweep, where a meeting ending at 5 does not conflict with one starting at 5. The same-looking comparison encodes opposite semantics in the two problems, so decide which the problem wants rather than reusing a remembered operator.

### LeetCode 57: Insert Interval

**Problem:** Given a set of non-overlapping intervals sorted by start, insert a new interval and merge if necessary.

```go
func insert(intervals [][]int, newInterval []int) [][]int {
	result := make([][]int, 0, len(intervals)+1)
	i := 0
	n := len(intervals)

	// Add all intervals that end before newInterval starts
	for i < n && intervals[i][1] < newInterval[0] {
		result = append(result, intervals[i])
		i++
	}

	// Merge overlapping intervals with newInterval
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

	// Add remaining intervals
	for i < n {
		result = append(result, intervals[i])
		i++
	}

	return result
}
```

**Complexity:** O(n) time, O(n) space. No sort, because the input is already sorted, which is the entire reason this is O(n) rather than O(n log n).
**Key insight:** Three phases: before the overlap, during it (absorbing each overlapping interval into `newInterval`), and after. The middle loop mutates `newInterval` rather than emitting anything, so overlapping intervals collapse into a single output interval that is appended once, after the loop ends.

Note the asymmetry in the two loop conditions, which is where this goes wrong under pressure. Phase one advances while `intervals[i][1] < newInterval[0]`, a strict `<`, so an interval that ends exactly where the new one starts is *not* skipped, it falls through to be merged. Phase two continues while `intervals[i][0] <= newInterval[1]`, a `<=`, so an interval starting exactly at the new one's end is merged. Both choices encode LC 57's closed-interval semantics, where touching counts as overlapping, consistent with LC 56 above. Swap either operator and touching intervals stop merging.

### LeetCode 435: Non-overlapping Intervals

**Problem:** Given an array of intervals, return the minimum number of intervals you need to remove to make the rest non-overlapping.

```go
func eraseOverlapIntervals(intervals [][]int) int {
	// Sort by end time (greedy: keep the interval that ends earliest)
	sort.Slice(intervals, func(i, j int) bool {
		return intervals[i][1] < intervals[j][1]
	})

	count := 0
	end := intervals[0][1]
	for i := 1; i < len(intervals); i++ {
		if intervals[i][0] < end {
			// Overlap: drop this one, since it ends no earlier than what we kept
			count++
		} else {
			end = intervals[i][1]
		}
	}
	return count
}
```

**Complexity:** O(n log n) time, O(1) space.
**Key insight:** This is activity selection. Sorting by *end* rather than start is the entire trick, and it is worth being able to justify rather than recall.

The exchange argument: to keep as many intervals as possible, the first one you keep should be the one that ends earliest, because among all candidates it leaves the most room for everything after it. Formally, if some optimal solution keeps interval X first, swapping X for the earliest-ending interval E cannot conflict with anything else in that solution, since E ends no later than X. So an optimal solution exists that starts with E, and the argument repeats on the remainder. Sorting by start gives no such guarantee: the earliest-starting interval might run the entire length of the input and block everything.

Notice that this returns a *count of removals* while the greedy actually computes the maximum *kept* set. The two are the same question asked backwards, which is why the code can answer it without ever building the kept set.

The `<` here is half-open again: `[1,2]` and `[2,3]` do not conflict, so neither is removed. This is LC 435's convention, and it differs from LC 56's in the same file. Read each problem's definition of overlap before writing the comparison.

### LeetCode 986: Interval List Intersections

**Problem:** Given two lists of closed intervals (each sorted and non-overlapping), return their intersection.

```go
func intervalIntersection(firstList [][]int, secondList [][]int) [][]int {
	result := [][]int{}
	i, j := 0, 0

	for i < len(firstList) && j < len(secondList) {
		// Find overlap
		lo := max(firstList[i][0], secondList[j][0])
		hi := min(firstList[i][1], secondList[j][1])

		if lo <= hi {
			result = append(result, []int{lo, hi})
		}

		// Advance the pointer with the smaller end
		if firstList[i][1] < secondList[j][1] {
			i++
		} else {
			j++
		}
	}
	return result
}

// min and max are builtins as of Go 1.21. No helpers needed.
```

**Complexity:** O(m + n) time, O(1) space excluding the output.
**Key insight:** Two pointers. The intersection of `[a, b]` and `[c, d]` is `[max(a,c), min(b,d)]`, which is empty exactly when `max(a,c) > min(b,d)`. That single formula handles every relative arrangement of the two intervals, which is why this needs no case analysis.

The advance rule is the part to justify: always advance the pointer whose interval ends *first*. That interval cannot intersect anything later in the other list, since both lists are sorted and everything remaining there starts at or after the current element's start. So it is finished and can be discarded. Advancing the other pointer instead would discard an interval that may still have intersections left.

Because each step retires exactly one interval, the loop runs at most m + n times.

### LeetCode 1288: Remove Covered Intervals

**Problem:** Given a list of intervals, return the number of remaining intervals after removing all intervals covered by another.

An interval `[a, b)` is covered by `[c, d)` if `c <= a` and `b <= d`.

```go
func removeCoveredIntervals(intervals [][]int) int {
	// Sort by start ascending, then by end descending
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
		// else: this interval is covered by a previous one
	}
	return count
}
```

**Complexity:** O(n log n) time, O(1) space.
**Key insight:** Sort by start ascending, end descending. Then an interval is covered exactly when its end is not greater than the maximum end seen so far.

The tie-break carries the correctness. Sorting by start ascending means every earlier interval has a start at most this one's, so the `c <= a` half of the covering condition is automatic and only the ends need checking. But when two intervals share a start, the longer one must come first, or the shorter would be examined first, set `maxEnd`, and the longer one would then look uncovered *and* the shorter would be counted, giving 2 where the answer is 1. Sorting ends descending on a start tie is what prevents that. Drop the tie-break and the code is right on every input without duplicate starts, which is most random tests.

`maxEnd := 0` works only because LC 1288 constrains `0 <= li < ri`, making every end at least 1. On inputs allowing negative or zero endpoints this seeds the comparison wrong and drops legitimate intervals. `math.MinInt` is the honest initializer.

---

### Junior → FAANG: Building Interval Problem Intuition from First Principles

Every interval problem in this section can be approached with the same opening question: "What happens when I sort by start time, and what breaks?" If sorting by start is sufficient (merging, insertion, coverage detection), the solution is a linear scan after sorting. If start-time sorting leaves an ambiguity (which interval to greedily keep for non-overlap removal), sort by end time instead. For insertion problems (LC 57), the three-phase structure (before, overlap, after) handles the sorted structure without re-sorting. Practice constructing a small example by hand before coding to confirm which sort key resolves the ambiguity cleanly.

### Senior @ FAANG: Interval Data Structures for Dynamic Online Problems

Every algorithm in this section is *offline*: it sees all the intervals, sorts once, and scans once. That is the assumption to question first in a real system, because sorting requires having everything, and an online system does not. Once intervals arrive and are queried interleaved, a re-sort per insert is O(n log n) per operation and the whole approach collapses.

The tool for the online case is the interval tree: a balanced BST keyed on interval start, with each node augmented to store the maximum end anywhere in its subtree. That one extra field is what makes it work. Searching for intervals overlapping a query, you can prune an entire subtree the moment its `maxEnd` falls below the query's start, because nothing in it can reach far enough right to overlap. That gives O(log n) insertion and O(log n + k) overlap query for k results. Go's standard library has no interval tree, but the augmentation is simple enough to write on top of any balanced tree.

The shape recurs anywhere a lookup is "which ranges contain this point": free/busy calendar queries, time-bounded permission grants, and IP range matching in packet filters are all the same query with different units. IP prefix matching is the interesting exception, since prefixes nest rather than overlap arbitrarily, which is why routing tables use tries rather than interval trees. The structure of your intervals, not the word "interval," decides the tool.

Before building one, ask whether you need it. If intervals are effectively static and queries dominate, a sorted array with binary search beats an interval tree on both simplicity and cache behavior. The tree earns its complexity only when insertions and deletions are frequent enough to make re-sorting untenable.

Whatever you build, test it against a brute-force O(n) scan on randomly generated intervals, with the degenerate cases forced in: shared endpoints, zero-length intervals, fully nested intervals, and empty input. Those are precisely where an augmented-tree pruning condition is wrong, and precisely where random generation alone will not take you.
