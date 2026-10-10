## 75.13 Interview Questions

### Question 1: Jump Game

This is one of the most frequently asked greedy problems in phone screens. The key insight is to maintain a single variable tracking the farthest index you can reach. As you iterate through the array, if your current index exceeds that farthest reach, you are stuck and cannot reach the end. Otherwise, you update the farthest reach at each step. This single-pass O(n) solution is much simpler than the DP alternative and demonstrates clear greedy thinking.

```go
func canJump(nums []int) bool {
    maxReach := 0
    for i := 0; i < len(nums); i++ {
        if i > maxReach {
            return false
        }
        if i+nums[i] > maxReach {
            maxReach = i + nums[i]
        }
    }
    return true
}
```

### Question 2: Meeting Rooms II

This problem asks for the minimum number of conference rooms needed to hold all meetings without conflicts. The elegant two-array approach separates start and end times, sorts them independently, and uses two pointers to count how many meetings are active at any moment. When a new meeting starts before the earliest ending meeting finishes, you need an additional room. Otherwise, you reuse a room. This runs in O(n log n) time and is a perennial favorite across FAANG interview loops.

```go
func minMeetingRooms(intervals [][]int) int {
    if len(intervals) == 0 {
        return 0
    }

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
```

---

### Junior → FAANG: Structuring Your Interview Response Around These Questions

Both questions in this section follow the same answer structure: state the insight, prove it (briefly), implement it, analyze complexity, and handle edge cases. Practice delivering each part in the time budget shown: insight in 30 seconds, proof in 30 seconds, code in 3-4 minutes, complexity in 15 seconds, edge cases in 15 seconds. Total: under 6 minutes per medium problem, leaving time for follow-up questions.

For Jump Game, the insight is `maxReach`. The proof is: if `i > maxReach`, every index from 0 to `i-1` has jump values that cannot reach `i`, so the end is unreachable. The code is 8 lines. Complexity is O(n) time, O(1) space.

Edge cases worth naming: empty array (returns true vacuously), single element (true, you are already at the end), and an array of all zeros (true only when `len(nums) == 1`). Be precise about that last one. The rule is "all zeros", not "all zeros after the first". A leading value large enough to clear the zeros still succeeds, so `[3,0,0,0]` returns true, while `[1,0,0]` returns false because the reach dies at index 1. What decides the answer is whether `maxReach` ever stalls before the last index, not the presence of zeros.

For Meeting Rooms II, practice both the two-array approach and the heap approach. In an interview, start with the two-array approach (cleaner, easier to explain) and offer the heap approach as an alternative that is "more intuitive if you think of explicitly tracking which room is freed." Presenting two approaches signals depth.

### Senior @ FAANG: Using These Problems as Bar-Raiser Extensions

These two interview questions are L4-L5 problems in their base form. A bar-raiser extends them to probe L6 thinking. For Jump Game: "How would you solve this if you could also jump backward, and you want to determine if all positions are reachable from position 0?" This is now a graph reachability problem (BFS/DFS), and recognizing the transition from greedy to graph search is the L6 signal.

For Meeting Rooms II: "You have two types of meetings: internal (can be moved if needed) and external (fixed times). Minimize the number of rooms while never moving external meetings." The L6 signal here is *not* producing a greedy answer. It is noticing that the problem has quietly changed category. Once internal meetings can be moved, you are choosing their start times, not just counting overlaps, and that is scheduling with release times rather than interval counting. Fixing the external meetings first is a sound decomposition, but "then greedily place the internal ones" is a claim that needs a proof, and in general it does not have one: where you put one movable meeting changes what is feasible for the rest. A strong candidate says exactly that, notes that the sub-problem resembles bin packing or flow depending on how the constraints are pinned down, and asks what may be assumed about durations and windows before committing to an algorithm. Candidates who confidently assert greedy still works have missed the point of the extension.

A bar-raiser at L7 might ask: "Design the API for a calendar system that efficiently answers Meeting Rooms II queries for arbitrary time windows as new meetings are added and removed." This is an online interval scheduling problem requiring a segment tree or interval tree for O(log n) per operation. The ability to recognize when the greedy algorithm's batch assumption (all intervals known upfront) breaks, and what data structure to use for the online variant, is the staff-level signal.
