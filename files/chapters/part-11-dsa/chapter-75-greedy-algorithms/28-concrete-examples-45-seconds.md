## Concrete Examples (45 seconds)
"**Greedy works**:
- Activity selection: Earliest end time always safe
- Fractional knapsack: Best ratio first always optimal
- Dijkstra: Nearest unvisited always correct, but only with
  non-negative edge weights. State the condition, it is the
  whole reason the greedy choice is safe

**DP needed**:
- 0/1 Knapsack: Can't take fractions, greedy fails
- Coin change (arbitrary): Greedy [4,1,1] vs optimal [3,3]
- Edit distance: Must consider all operations"

### Junior → FAANG: Using Example Pairs as a Quick Calibration Test

The example pairs in this section are a calibration test you can run in under 30 seconds for any new problem. Map the new problem onto the closest example: does it look like activity selection (interval, minimize or maximize count)? Does it look like fractional knapsack (ratio-based, continuous)? Does it look like Dijkstra (single-source shortest path on non-negative weights)?

If the mapping is clear, apply the same algorithm family. If the mapping is unclear or the new problem has a twist that breaks the analogy (weights become negative, items become indivisible, multiple resources), stop and apply the three-question decision framework instead.

The coin change counterexample (coins [1,3,4], amount 6: greedy gives 4+1+1=3 coins, optimal is 3+3=2 coins) is the single most important counterexample to memorize. It disproves greedy for arbitrary coin systems in one line, and interviewers use variations of it frequently.

### Senior @ FAANG: Building a Counterexample Library for Your Team

The six concrete examples in this section (three greedy, three DP) are the kernel of an organizational counterexample library. A staff engineer building a team knowledge base would extend this list to 20-30 examples spanning all major greedy problem families, with a counterexample for each DP-required problem and an exchange argument for each greedy-solvable problem.

This library serves three purposes. First, it is a reference during design reviews: when a proposed algorithm is similar to a known counterexample, the review can immediately point to it and save 30 minutes of re-derivation. Second, it is a test source: the counterexamples become adversarial test cases that are added to the test suite of any algorithm in the relevant family. Third, it is a training resource: new engineers joining the team study the library as part of onboarding.

The Dijkstra example is particularly worth extending. Dijkstra's greedy choice (always expand the nearest unvisited node) fails when edges have negative weights because a shorter path via a negative edge might not be discoverable from the current frontier. The Bellman-Ford algorithm handles this with DP (relax all edges n-1 times). The staff-level extension: what about graphs with cycles of negative total weight? Neither Dijkstra nor Bellman-Ford handles this correctly (Bellman-Ford detects the cycle but cannot find the shortest path, since no finite shortest path exists). Knowing this boundary is essential when evaluating algorithms for routing protocols or financial arbitrage detection systems.
