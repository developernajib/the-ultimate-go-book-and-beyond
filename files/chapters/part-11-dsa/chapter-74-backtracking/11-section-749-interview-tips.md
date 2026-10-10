## 74.9 Interview Tips

### Backtracking vs Other Approaches

Choosing the right algorithm class before coding is the most important interview skill. Backtracking is appropriate when the solution space is a tree of discrete choices and you need every valid leaf, not just a single optimal one. Dynamic programming covers overlapping subproblems, greedy covers locally optimal selection, and BFS covers shortest-path problems. Recognizing the problem's structural signature (enumeration vs. optimization vs. reachability) lets you select the right tool before writing a single line of code.

```
┌─────────────────────────────────────────────────────────────────┐
│           WHEN TO USE BACKTRACKING                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Use Backtracking when:                                         │
│  • Need to find ALL solutions (not just one)                    │
│  • Need to enumerate combinations/permutations                  │
│  • Problem has constraint satisfaction nature                   │
│  • Decision tree exploration needed                             │
│                                                                 │
│  Problem Keywords:                                              │
│  • "Find all", "Return all", "Generate all"                     │
│  • "Permutations", "Combinations", "Subsets"                    │
│  • "Possible ways", "All paths"                                 │
│  • "Partition", "Split"                                         │
│                                                                 │
│  Complexity Patterns (leaves x O(n) copy at each leaf):         │
│  • Subsets:      2^n leaves    -> O(n * 2^n) time               │
│  • Permutations: n! leaves     -> O(n * n!) time                │
│  • Combinations: C(n,k) leaves -> O(k * C(n,k)) time            │
│  Space is O(depth) for the stack, excluding the result.         │
│  Do NOT drop the copy factor: it is the usual mistake.          │
│                                                                 │
│  Key Optimizations:                                             │
│  • Pruning: Skip invalid branches early                         │
│  • Sorting: Helps skip duplicates                               │
│  • Memoization: For overlapping subproblems                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Common Patterns

| Pattern | When to Use | Example |
|---------|-------------|---------|
| Start index | Combinations, subsets | `backtrack(i+1)` |
| Used array | Permutations | `used[i] = true` |
| Skip duplicates | With duplicate input | `if i > start && nums[i] == nums[i-1]` (sort first) |
| Path copying | Store results | `result = append(result, append([]int(nil), path...))` |

### Common Mistakes

1. **Forgetting to backtrack**: Always undo the choice after recursion
2. **Modifying shared state**: Make copies when storing results
3. **Off-by-one errors**: Check start/end indices carefully
4. **Missing pruning**: Add constraints to skip invalid branches
5. **Duplicate handling**: Sort and skip consecutive duplicates

### Junior → FAANG: Interview Tips as a Decision Protocol

The "when to use backtracking" diagram above is your decision protocol. Walk through it mentally every time you read a problem statement. "Need to find ALL solutions" is the primary trigger. "Decision tree exploration needed" is the secondary trigger when the problem has a natural step-by-step structure with choices at each step.

The most important common pattern is the path-copying discipline: `copy(result, path)` before appending to the result. Make this a reflex. The second most important is the start index versus used-array distinction: start index for combinations (order does not matter, no repeats), used array for permutations (order matters). The duplicate handling guard `i > start && nums[i] == nums[i-1]` is the third reflex to develop.

For complexity analysis: state the exact complexity formula, not just "exponential." Subsets: O(n * 2^n) time and O(n) space (excluding result storage). Permutations: O(n * n!) time and O(n) space. Combinations C(n, k): O(k * C(n, k)) time and O(k) space. N-Queens: O(n!) worst case with significant pruning. Sudoku: O(9^e) where e is the number of empty cells, with effective branching factor much lower in practice.

### Senior @ FAANG: Tips as a Coaching and Review Framework

The tips section above maps to a structured interview evaluation rubric that senior interviewers use to score backtracking candidates. The five common mistakes become five evaluation dimensions: copy discipline (did they copy before storing?), backtrack discipline (did they unmake choices?), index discipline (did they use the right start index?), pruning discipline (did they add effective pruning?), duplicate discipline (did they handle duplicate inputs correctly?).

A candidate who demonstrates all five disciplines without prompting is demonstrating L5 readiness. A candidate who demonstrates three and can fix the other two when pointed to is demonstrating L4 readiness. A candidate who cannot demonstrate copy discipline even after a hint is demonstrating L3 or below for backtracking.

When coaching junior engineers through backtracking, the most effective approach is to have them trace through a small example by hand before coding, updating the path and result lists at each step of the recursion. This exercise reveals immediately whether they understand when copies are made, when choices are undone, and what the state of the path is at each recursive call. Code review alone is insufficient to diagnose this understanding. Hands-on tracing is required.

### Junior → FAANG: The Decision Protocol as a 60-Second Habit

The "when to use backtracking" decision protocol should take less than 60 seconds. Scan the problem statement for three signals: "find all," "generate all," or "return all." If any of these appear, backtracking is the primary candidate. Confirm by asking: "is there a choice at each step that branches the search?" If yes, backtracking applies. If the problem instead asks for a single optimal answer (minimum, maximum), consider DP or greedy first.

The complexity formulas are worth knowing precisely because interviewers explicitly ask for them. State the formula, not just the order class. "Subsets: O(n times 2^n) time and O(n) space for the recursion stack, not counting the result storage." The `n` factor comes from the copy made when storing each result (O(n) per subset). Forgetting the `n` factor is the most common complexity analysis error for backtracking problems.

Sorting is the highest-value reflex for the *candidate-list* family of problems, and it is worth being clear about where the family ends. When the input is a list of values you choose from, sorting buys one or both of: the duplicate-sibling skip guard (which needs equal values adjacent to work at all), and early termination via `break` (once a candidate exceeds the constraint, every later one does too). That covers Subsets II, Permutations II, Combination Sum I and II.

It buys nothing for the rest of this chapter. There is no input list to sort in N-Queens or Generate Parentheses, sorting a Sudoku board or a word-search grid is meaningless, and Letter Combinations has a fixed keypad mapping. Reach for the sort when the problem hands you candidates and asks you to pick among them. Announcing "I'll sort first" on N-Queens signals pattern-matching rather than understanding.

### Senior @ FAANG: Tips as a Code Review and Hiring Rubric

The five common mistakes in the tips table translate directly to a production code review rubric for backtracking implementations. A PR containing a backtracking function should be reviewed against each of these five dimensions before approval.

Copy discipline: search the code for `result = append(result, path)` where `path` is a slice. Every such line must be accompanied by a copy: `result = append(result, append([]int{}, path...))` or `copy(dst, path)` with a pre-allocated destination. Any direct reference store is a bug.

Backtrack completeness: for every state modification in the make-choice step, verify there is a corresponding reversal in the unmake-choice step. These must be in exactly the same scope (same function body, same level of nesting) and must reverse each other exactly. Asymmetric make/unmake is always a bug.

Pruning effectiveness: instrument the number of recursive calls and compare it against the unpruned tree size on representative inputs. What matters is not hitting a particular ratio but how the ratio moves as the input grows: effective pruning makes the explored fraction shrink with n, while a fraction that holds steady means you are paying exponential cost for a constant-factor saving. N-Queens is the reference point for what good looks like, exploring 2057 nodes at n=8 against 8! = 40320, and pulling further ahead as n rises. If your search does not show that widening gap, the pruning is decorative, and the honest conclusion may be that the problem wants a different algorithm rather than a better prune.
