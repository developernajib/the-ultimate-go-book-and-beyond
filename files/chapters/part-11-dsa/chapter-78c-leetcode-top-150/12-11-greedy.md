## 78C.11 Greedy

Greedy algorithms make the locally optimal choice at each step. The key is proving that local optimality leads to global optimality.

---
### LC 121 - Best Time to Buy and Sell Stock 🟢

**Key Insight**: You can only sell after you buy, so at each day the only buy price worth considering is the cheapest price seen **so far**. Track that running minimum and the best profit against it in one pass.

```go
func maxProfit(prices []int) int {
    best, cheapest := 0, 1<<62

    for _, p := range prices {
        cheapest = min(cheapest, p)   // best day to have bought before today
        best = max(best, p-cheapest)  // best profit if we sell today
    }
    return best
}
```

The order of those two lines is what makes the single pass legal. Updating `cheapest` first means a buy and sell on the same day is considered, which yields a profit of zero and is harmless, while never allowing a sell that precedes its buy.

`best` starting at 0 encodes the "do nothing" option, so a strictly decreasing price series correctly returns 0 rather than a negative loss.

This is the cleanest example in the chapter of a greedy that beats the obvious O(n²) pair scan. Note what is **not** the answer: the global maximum minus the global minimum. On `[2,4,1]` that pairing gives 4 - 1 = 3, but the 1 comes after the 4, so the real answer is 2. Any solution that does not respect the buy-before-sell ordering fails this case, and interviewers reach for it.

**Time**: O(n) - single pass.
**Space**: O(1).

---
### LC 55 - Jump Game 🟡

**Key Insight**: Track the farthest reachable index. If you can reach or pass the end, return true.

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
**Time**: O(n).
**Space**: O(1).

---
### LC 45 - Jump Game II 🟡

**Key Insight**: BFS-style. At each "level" (the range of reachable indices), find the farthest you can reach next and increment the jump count.

```go
func jump(nums []int) int {
    jumps := 0
    currentEnd := 0
    farthest := 0

    for i := 0; i < len(nums)-1; i++ {
        if i+nums[i] > farthest {
            farthest = i + nums[i]
        }
        if i == currentEnd {
            jumps++
            currentEnd = farthest
        }
    }
    return jumps
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 134 - Gas Station 🟡

**Key Insight**: If total gas >= total cost, a solution exists. The starting station is the one immediately after the last point where the running surplus dips below zero.

```go
func canCompleteCircuit(gas []int, cost []int) int {
    totalSurplus := 0
    currentSurplus := 0
    start := 0

    for i := 0; i < len(gas); i++ {
        totalSurplus += gas[i] - cost[i]
        currentSurplus += gas[i] - cost[i]
        if currentSurplus < 0 {
            start = i + 1
            currentSurplus = 0
        }
    }

    if totalSurplus < 0 {
        return -1
    }
    return start
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 435 - Non-overlapping Intervals 🟡

**Key Insight**: Sort by end time, then greedily keep the intervals that end earliest and count the removals.

```go
func eraseOverlapIntervals(intervals [][]int) int {
    sort.Slice(intervals, func(i, j int) bool {
        return intervals[i][1] < intervals[j][1]
    })

    removals := 0
    prevEnd := intervals[0][1]

    for i := 1; i < len(intervals); i++ {
        if intervals[i][0] < prevEnd {
            removals++
        } else {
            prevEnd = intervals[i][1]
        }
    }
    return removals
}
```
**Time**: O(n log n).
**Space**: O(1).

---
### LC 452 - Minimum Number of Arrows to Burst Balloons 🟡

**Key Insight**: Sort by end point, then shoot at each balloon's end and skip every balloon that arrow also bursts.

```go
func findMinArrowShots(points [][]int) int {
    sort.Slice(points, func(i, j int) bool {
        return points[i][1] < points[j][1]
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
**Time**: O(n log n).
**Space**: O(1).

---
### LC 763 - Partition Labels 🟡

**Key Insight**: Track the last occurrence of each character. Extend the current partition until the index reaches the farthest last occurrence seen.

```go
func partitionLabels(s string) []int {
    var lastIdx [26]int
    for i := 0; i < len(s); i++ {
        lastIdx[s[i]-'a'] = i
    }

    var result []int
    start, end := 0, 0

    for i := 0; i < len(s); i++ {
        if lastIdx[s[i]-'a'] > end {
            end = lastIdx[s[i]-'a']
        }
        if i == end {
            result = append(result, end-start+1)
            start = i + 1
        }
    }
    return result
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 846 - Hand of Straights 🟡

**Key Insight**: Sort the cards, then greedily form groups starting from the smallest available card using a frequency map.

```go
func isNStraightHand(hand []int, groupSize int) bool {
    if len(hand)%groupSize != 0 {
        return false
    }

    sort.Ints(hand)
    count := make(map[int]int)
    for _, card := range hand {
        count[card]++
    }

    for _, card := range hand {
        if count[card] == 0 {
            continue
        }
        for i := 0; i < groupSize; i++ {
            if count[card+i] == 0 {
                return false
            }
            count[card+i]--
        }
    }
    return true
}
```
**Time**: O(n log n).
**Space**: O(n).

---
### LC 621 - Task Scheduler (Greedy approach) 🟡

**Key Insight**: (Covered in the Heap section.) The idle slots are determined by the most frequent task, and other tasks fill them.

*(See Heap section for the full solution.)*

---

### Junior → FAANG: Proving Greedy Correctness Before Coding

Junior engineers often apply greedy algorithms by intuition and get wrong answers because the greedy choice does not actually lead to a globally optimal solution. The discipline: for every greedy problem, state the greedy choice and then verify the exchange argument (swapping the greedy choice for any other choice cannot improve the result). For Jump Game, the greedy choice is always extending the maximum reachable index as far as possible. The exchange argument: if you can reach index i, you can reach every index up to i, so the greedy maximum-reach update is never worse than any alternative choice.

Gas Station is the hardest greedy problem in this section. The key insight is that total gas minus total cost determines whether a valid starting position exists at all. If one does, the answer is the station **immediately after** the last index at which the running surplus goes negative, which is why the code assigns `start = i + 1` rather than `start = i`, and why it keeps overwriting `start` instead of returning at the first negative. Read the loop carefully: each reset moves the candidate past the segment that just failed, so the surviving `start` is the one after the final deficit. The proof is that any station inside a failed segment cannot be the answer, since starting there means reaching the same deficit with even less gas in the tank. If the total is non-negative, the profit segments outweigh the deficit segments, so starting after the last deficit always completes the circuit.

### Senior @ FAANG: Greedy Algorithms in Resource Allocation and Scheduling

Earliest Deadline First (EDF) scheduling, the optimal algorithm for preemptive uniprocessor scheduling with soft deadlines, is a greedy algorithm: at each scheduling decision, run the task with the earliest deadline. The exchange argument proof is a classic result in scheduling theory. When designing a priority queue of pending requests in a production API server with SLA tiers, EDF provides a useful baseline: if your scheduling policy deviates from EDF, document explicitly why the deviation is correct for your workload characteristics.

In distributed systems, greedy approaches appear in leader election (elect the node with the highest ID, which is greedy by node identity), replica placement (place each replica on the least-loaded rack, greedy by current load), and task distribution (assign the next task to the worker with the shortest queue, greedy by current queue depth). Each of these requires an exchange argument proof to establish optimality. In practice, the proof is often implicit, but explicitly documenting it in ADRs prevents future engineers from "optimizing" the scheduling policy in ways that break the optimality guarantee.
