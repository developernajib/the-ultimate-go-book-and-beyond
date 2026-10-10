## 78B.14 Pattern Recognition Guide

The most useful skill in coding interviews is quickly identifying which pattern to apply. Here is a systematic decision framework.

Read what follows as a set of priors, not a lookup table. Each row says "this cue makes this pattern worth trying first," not "this cue implies this pattern." Several cues are genuinely ambiguous. "Contiguous subarray" points at sliding window, but maximum subarray sum is Kadane's, subarray sum equals K is prefix sum with a hash map, and subarray minimum is a monotonic deque. "Count the ways" points at DP, but plenty of counting problems are closed-form combinatorics and plenty of optimization problems that look like DP fall to a greedy with a proof. The table gets you to a first hypothesis in seconds. Verifying the hypothesis against the actual constraints is the work, and the verification step is what interviewers are grading. A candidate who pattern-matches on a keyword and codes for ten minutes before discovering the negative numbers ruin the approach has demonstrated the failure mode this table can cause, not the skill it is meant to build.

### Pattern Selection Table

```
┌──────────────────────────────────┬────────────────────────────────────────┐
│ Problem Cues                     │ Pattern to Apply                       │
├──────────────────────────────────┼────────────────────────────────────────┤
│ Sorted array, find pair          │ Two Pointers (opposite)                │
│ Remove/move in-place, O(1) space │ Two Pointers (same direction)          │
│ Linked list cycle                │ Two Pointers (fast/slow)               │
│ Contiguous subarray/substring    │ Sliding Window                         │
│ Max/min subarray of size k       │ Sliding Window (fixed)                 │
│ Longest substring with condition │ Sliding Window (variable)              │
│ Sorted array, find element       │ Binary Search                          │
│ Minimize max / maximize min      │ Binary Search on Answer                │
│ Shortest path, unweighted        │ BFS                                    │
│ Level-order traversal            │ BFS                                    │
│ All paths, connected components  │ DFS                                    │
│ Course prerequisites, ordering   │ Topological Sort (BFS/DFS)             │
│ Multi-source shortest distance   │ Multi-source BFS                       │
│ Generate all permutations/combos │ Backtracking                           │
│ Constraint satisfaction          │ Backtracking with pruning              │
│ Min/max/count ways               │ Dynamic Programming                    │
│ Overlapping subproblems          │ Dynamic Programming                    │
│ Buy/sell stock with states       │ State Machine DP                       │
│ Range queries                    │ Prefix Sum or Segment Tree             │
│ Next greater/smaller element     │ Monotonic Stack                        │
│ Sliding window maximum           │ Monotonic Deque                        │
│ Dynamic connectivity             │ Union-Find                             │
│ Prefix matching, autocomplete    │ Trie                                   │
│ Top-K, merge K sorted            │ Heap / Priority Queue                  │
│ Find median in stream            │ Two Heaps                              │
│ Subarray sum equals K            │ Prefix Sum + Hash Map                  │
│ Single number (pairs cancel)     │ Bit Manipulation (XOR)                 │
│ Shortest path, weighted graph    │ Dijkstra / Bellman-Ford                │
│ Minimum spanning tree            │ Kruskal's / Prim's                     │
└──────────────────────────────────┴────────────────────────────────────────┘
```

### Decision Tree: "Which Pattern Should I Use?"

```
Start
  │
  ├─ Is the input sorted (or can sorting help)?
  │   ├─ Yes, find a pair/triplet → Two Pointers
  │   ├─ Yes, find an element → Binary Search
  │   └─ Yes, merge sorted things → Heap (merge K)
  │
  ├─ Is it about contiguous subarrays/substrings?
  │   ├─ Fixed size? → Sliding Window (fixed)
  │   ├─ Variable size with condition? → Sliding Window (variable)
  │   └─ Sum-related? → Prefix Sum + Hash Map
  │
  ├─ Is it a graph/tree problem?
  │   ├─ Shortest path (unweighted)? → BFS
  │   ├─ Shortest path (weighted, non-negative)? → Dijkstra
  │   ├─ Shortest path (negative weights)? → Bellman-Ford
  │   ├─ Connected components? → DFS or Union-Find
  │   ├─ Ordering/dependencies? → Topological Sort
  │   ├─ Minimum spanning tree? → Kruskal's or Prim's
  │   └─ Tree traversal? → BFS (level) or DFS (path)
  │
  ├─ Is it about generating all possibilities?
  │   ├─ Permutations/combinations/subsets? → Backtracking
  │   └─ With constraints? → Backtracking + Pruning
  │
  ├─ Does it ask for min/max/count with optimal substructure?
  │   ├─ Can I define states and transitions? → DP
  │   ├─ Stock buy/sell? → State Machine DP
  │   └─ Knapsack variant? → 0/1 or Unbounded Knapsack DP
  │
  ├─ String prefix operations?
  │   └─ Yes → Trie
  │
  ├─ Next greater/smaller element?
  │   └─ Yes → Monotonic Stack
  │
  ├─ Top-K or streaming median?
  │   └─ Yes → Heap
  │
  └─ Pairs that cancel / bit-level operations?
      └─ Yes → Bit Manipulation
```

### Common Mistakes in Pattern Selection

1. **Using DP when greedy works.** If a greedy exchange argument holds, DP is overkill. The reverse error is worse: using greedy where it is merely usually right. Greedy needs a proof, not a passing test suite.
2. **Using BFS for weighted graphs.** BFS gives shortest paths only when every edge costs the same. Use Dijkstra for non-negative weights. The exception worth knowing: with weights restricted to 0 and 1, a deque-based 0-1 BFS beats Dijkstra and is simpler.
3. **Using DFS for shortest path.** DFS finds *a* path, not *the* shortest one, unless you exhaustively explore every path and keep the best, which forfeits the reason you chose DFS.
4. **Missing the prefix sum pattern.** "Count subarrays with sum K" is often mistaken for sliding window, but negative numbers break the shrink property that sliding window depends on. Check the sign constraint before committing.
5. **Not recognizing binary search on the answer.** "Minimize the maximum" or "maximize the minimum" is the tell. Confirm feasibility is monotone before you commit, since that, and not the phrasing, is what licenses the search.
6. **Trusting the cue over the constraints.** Every row above assumes the constraints cooperate. The constraint line in a problem statement usually names the intended complexity: n ≤ 20 means exponential is expected and hints at bitmask, n ≤ 10^5 rules out O(n²), and n ≤ 10^9 with a small answer range means you are searching the answer, not the input.

---

### Junior → FAANG: Using the Decision Tree Under Time Pressure

A pattern recognition guide is only useful if you can apply it in the first minute or two while an interviewer is watching. The way to internalize the decision tree is to practice it as a separate skill from solving problems. Take a problem, read only the problem statement (no solution), and force yourself to name the pattern before writing any code. Record how long it takes and which patterns you misidentify. Review the misidentifications after each session.

The most common misclassification pairs: "count subarrays with sum K" is prefix sum, not sliding window (negative elements break sliding window). "Find all unique permutations" is backtracking, not two pointers. "Shortest path in unweighted graph" is BFS, not DFS. "Minimum cost to connect all nodes" is MST (Kruskal/Prim), not shortest path (Dijkstra). Drilling these boundaries prevents the false-start failure mode where you code half a solution before realizing the approach is wrong.

Entry-level signal: after stating the pattern, also stating the signal word or phrase from the problem that triggered it. "I see 'subarray with sum,' and the input has negative numbers, so sliding window won't work but prefix sum with a hash map will" is more convincing to an interviewer than "I'll use prefix sum" without explanation.

### Senior @ FAANG: Pattern Recognition as Engineering Judgment

At L5 and above, pattern recognition extends beyond algorithm selection to system design. When a product manager describes a new feature, the senior engineer's job is to recognize the underlying computational structure and propose an implementation that is correct, scalable, and maintainable. "Users want to see the top 10 trending posts in the last hour" is a top-K + sliding window problem. "We need to find all groups of users who have chatted with the same person" is a Union-Find or graph connected components problem. Framing these as known patterns immediately grounds the system design conversation in concrete algorithmic tradeoffs.

From a bar-raiser perspective, watch for candidates who can transfer pattern recognition across domains. A candidate who recognizes that a Kafka consumer lag monitoring system is a "sliding window maximum" problem applied to a time series has demonstrated the kind of generative pattern thinking that distinguishes L5 candidates from L4 candidates who solve the presented problem but cannot see its structure in a novel context.

Maturity model for pattern recognition: L3 candidates recognize patterns they have seen before. L4 candidates recognize patterns in mild variations of familiar problems. L5 candidates recognize patterns in novel domains with different surface structure. L6 candidates can decompose a problem that does not cleanly fit one pattern into sub-problems each matching a known pattern, and design the interface between sub-solutions. This progression is observable in interviews and should inform calibration discussions.
