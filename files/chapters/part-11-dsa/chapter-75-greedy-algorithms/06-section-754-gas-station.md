## 75.4 Gas Station

The gas station problem places you on a circular route with gas stations, each providing some fuel and costing some fuel to reach the next station. You need to find a starting station from which you can complete the full circuit, or determine that no such station exists. The greedy insight is twofold: first, if the total gas available is less than the total cost, no solution exists. Second, as you scan the stations, whenever your running tank drops below zero, every station you have visited so far is a bad starting point, so you reset your candidate start to the next station. This single-pass approach runs in O(n) time.

```go
// CanCompleteCircuit finds starting gas station index
// LeetCode 134: Gas Station
// Time: O(n), Space: O(1)
func CanCompleteCircuit(gas []int, cost []int) int {
    totalGas, totalCost := 0, 0
    tank := 0
    start := 0

    for i := 0; i < len(gas); i++ {
        totalGas += gas[i]
        totalCost += cost[i]
        tank += gas[i] - cost[i]

        if tank < 0 {
            // Can't start from any station before i+1
            start = i + 1
            tank = 0
        }
    }

    if totalGas < totalCost {
        return -1
    }

    return start
}
```

### Junior → FAANG: Unpacking the Gas Station Greedy in an Interview

Gas station is a problem where the O(n^2) brute force is obvious and the O(n) greedy is elegant but requires justification. In an interview, first state the brute force, then explain why you can do better. The greedy insight has two parts, and both parts need to be stated: (1) if total gas is less than total cost, no solution exists, so checking the sum first is a necessary condition. (2) If you fail at station `i`, you cannot start from any station between `start` and `i`, because every prefix of that range also fails.

The second part is the one most candidates skip or hand-wave. Practice the argument: if you can reach station `j` from `start` but fail at station `i > j`, then any station between `start` and `i` as a starting point would also fail at or before `i` (you already know the cumulative net from `start` to `i` is negative, and starting later within that range cannot make it better). This argument is clean enough to say in two sentences and is the greedy choice property for this problem.

Edge cases: a single station where `gas[0] == cost[0]` (valid, returns 0), all stations with zero net (returns 0 if total >= 0), and the case where the answer is the last station.

### Senior @ FAANG: Circular Resource Feasibility in Distributed Systems

The gas station problem is a model for circular resource feasibility: can a process traverse a circular dependency graph and always have enough resources at each step? This pattern appears in distributed systems in several forms.

**Ring-topology health checks.** In a gossip protocol over a ring topology, each node forwards health data to its successor. If the forwarding cost (message size, processing time) exceeds the capacity (bandwidth, CPU budget) at any node, the ring breaks. The gas station algorithm can determine whether a full ring traversal is feasible and, if so, from which starting node. Applied to ring-topology monitoring systems, this gives a single-pass O(n) feasibility check before starting the gossip cycle.

**Pipeline backpressure analysis.** In a streaming data pipeline, each stage has a throughput capacity and an input rate. The circular version arises in feedback pipelines where output from the last stage feeds back as input to the first. The gas station invariant (total gas >= total cost for feasibility) maps to total pipeline capacity >= total data rate. The greedy starting point maps to the optimal stage to buffer data during a traffic spike.

**Staff-level concern: what happens when the greedy answer is wrong.** Be careful with the uniqueness claim. LeetCode 134 *states* that a solution, if it exists, is unique, but that is a constraint on their test data and not a property of the problem. With `gas = [1,2]` and `cost = [0,0]`, both stations are valid starting points. The algorithm returns one valid start, not the only one. A system built on the assumption that the answer is canonical will disagree with itself the moment someone reorders the input.

In practice the inputs to a gas station-like system are estimates, not exact values. A staff engineer asks: what is the sensitivity of the greedy answer to small perturbations in `gas` or `cost`? If a small change in one station's net flips the greedy answer from `start = 3` to `start = 7`, the system is operating near a feasibility boundary and needs a margin buffer. Building that margin into the capacity planning model is the production-grade extension of the interview problem.
