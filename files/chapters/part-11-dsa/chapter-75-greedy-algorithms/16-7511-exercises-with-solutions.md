## 75.14 Exercises with Solutions

### Exercise 1: Non-overlapping Intervals

Given a collection of intervals, find the minimum number of intervals you need to remove so that the remaining intervals do not overlap. This is the complement of the activity selection problem: instead of counting the maximum non-overlapping set, you subtract that count from the total. Sort by end time and greedily keep each interval that does not conflict with the previous one. Every interval you skip is one removal.

```go
func eraseOverlapIntervals(intervals [][]int) int {
    if len(intervals) == 0 {
        return 0
    }

    // Sort by end time.
    slices.SortFunc(intervals, func(a, b []int) int {
        return cmp.Compare(a[1], b[1])
    })

    count := 0
    prevEnd := intervals[0][1]

    for i := 1; i < len(intervals); i++ {
        if intervals[i][0] < prevEnd {
            count++  // Remove this interval
        } else {
            prevEnd = intervals[i][1]
        }
    }

    return count
}
```

---

### Junior → FAANG: What to Internalize From This Exercise

Non-overlapping intervals is the complement of activity selection, and the complementary framing is a useful mental model. Activity selection: maximize what you keep (sort by end time, keep non-conflicting). Non-overlapping intervals: minimize what you remove (sort by end time, count what conflicts). The code structure is nearly identical. Only the counter variable changes.

Practice articulating this connection in an interview. "This is the complement of activity selection. Instead of counting intervals I keep, I count intervals I remove, which is total minus kept." That sentence takes five seconds and immediately shows the interviewer you understand the underlying structure, not just the solution.

Also note the boundary condition. `intervals[i][0] < prevEnd` treats intervals that merely touch, where one ends exactly as the next begins, as compatible: `[1,2]` and `[2,3]` both survive. That is what LeetCode 435 asks for. If instead the problem counted a shared endpoint as a conflict, the test becomes `intervals[i][0] <= prevEnd`. The direction is easy to invert under pressure, so anchor it on a concrete pair rather than on the word "overlapping": ask yourself whether `[1,2]` and `[2,3]` may coexist, and let the answer pick the operator. Being precise about boundary conditions is a differentiator at all levels.

### Senior @ FAANG: Interval Removal as a Conflict Resolution Primitive

The non-overlapping intervals problem is a model for conflict resolution in scheduling systems. In production, "removing an interval" corresponds to canceling a booking, deferring a deployment, or dropping a low-priority task. The greedy minimum-removal strategy maximizes the number of tasks completed, which is the right objective for throughput-maximizing systems.

**Deployment scheduling conflict resolution.** In a continuous deployment system, scheduled deployments for different services can conflict if they share a critical dependency (a database schema migration, a network configuration change). The system must determine the minimum number of deployments to defer to eliminate all conflicts. If deployments are modeled as intervals (start time, end time of the critical section) and a conflict is defined as two deployments overlapping in the critical section, the non-overlapping intervals algorithm gives the minimum deferral count.

**Extending to weighted intervals.** The unweighted non-overlapping intervals problem (covered here) has an O(n log n) greedy solution. The weighted version (each interval has a weight, maximize total weight of non-overlapping intervals) requires DP (O(n log n) with binary search). When the deployment system assigns priorities to deployments (customer-facing vs. internal), it must use the weighted variant. A staff engineer recognizes this transition and implements the DP solution rather than incorrectly applying the greedy to the weighted case.

**Monitoring and feedback.** A production deployment scheduler using this algorithm should monitor: the fraction of deployments deferred per day (if high, the scheduling policy needs revision), the average deferral duration (if long, the priority model is incorrectly penalizing high-value work), and the accuracy of the critical section duration estimates (if deployments routinely overrun their estimated intervals, the conflict detection is based on stale data). Building these monitors is the production-grade complement to the algorithmic solution.
