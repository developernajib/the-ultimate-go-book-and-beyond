## 74.17 Backtracking Pattern Reference Card

This reference card distills every backtracking variant covered in this chapter into a single lookup resource. The template captures the invariant structure (make a choice, recurse, undo the choice), while the problem-type mappings highlight the one detail that changes per variant: how you select candidates and how you avoid revisiting the same state. Use this during interviews to quickly classify an unfamiliar problem before writing a single line of code.

```
┌─────────────────────────────────────────────────────────────────┐
│             BACKTRACKING QUICK REFERENCE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  TEMPLATE:                                                      │
│  func backtrack(state, choices) {                               │
│      if isComplete(state) {                                     │
│          addToResult(copy(state))                               │
│          return                                                 │
│      }                                                          │
│      for choice in choices {                                    │
│          if isValid(choice) {                                   │
│              makeChoice(state, choice)                          │
│              backtrack(state, newChoices)                       │
│              undoChoice(state, choice) // BACKTRACK             │
│          }                                                      │
│      }                                                          │
│  }                                                              │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  PROBLEM TYPE → KEY PATTERN                                     │
├─────────────────────────────────────────────────────────────────┤
│  Subsets      → start from index, include/exclude               │
│  Permutations → used[] array, try all unused                    │
│  Combinations → start index, remaining count                    │
│  Grid Search  → mark visited in-place, restore after            │
│  Constraint   → precompute validity sets for O(1) lookup        │
│                                                                 │
│  DUPLICATES: sort first, then the guard DIFFERS by family.      │
│  Two guards, not one. Using the wrong one is a wrong answer:    │
│   start-index family (subsets, combinations):                   │
│      skip if i > start && nums[i] == nums[i-1]                  │
│      (i > start, NOT i > 0: i > 0 over-prunes and DROPS         │
│       valid results, e.g. loses [1,2,2] from [1,2,2])           │
│   used[] family (permutations):                                 │
│      skip if i > 0 && nums[i] == nums[i-1] && !used[i-1]        │
│      (the !used[i-1] form and the used[i-1] form are BOTH       │
│       correct and give the same set, in mirrored order)         │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  COMPLEXITY PATTERNS  (count, then the O(n) copy per result)    │
├─────────────────────────────────────────────────────────────────┤
│  Subsets:      2^n results     -> O(n * 2^n) time               │
│  Permutations: n! results      -> O(n * n!) time                │
│  k-Combos:     C(n,k) results  -> O(k * C(n,k)) time            │
│  N-Queens:     O(n!) upper bound, but VERY loose: n=8 walks     │
│                2057 nodes vs 8!=40320, and returns 92 boards    │
│  Sudoku:       O(9^empty) worst case, tiny in practice          │
│  Space:        O(depth) for the stack, excluding the output     │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  COMMON OPTIMIZATIONS                                           │
├─────────────────────────────────────────────────────────────────┤
│  1. Sort first: enables duplicate skip + break early            │
│     ONLY for candidate-list problems. Nothing to sort in        │
│     N-Queens, Sudoku, grids, or Generate Parentheses.           │
│  2. Pruning: skip invalid branches BEFORE recursing             │
│  3. Precomputation: build lookup tables (palindromes, sums)     │
│  4. Constraint sets: O(1) validity checks vs a rescan           │
│  5. MRV heuristic: choose most constrained variable first.      │
│     Cuts NODES hugely, but its own O(e*9) rescan eats most      │
│     of the win. Track candidate counts incrementally to         │
│     actually collect it. Measure work, not node count.          │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  CRITICAL MISTAKES TO AVOID                                     │
├─────────────────────────────────────────────────────────────────┤
│  ✗ Storing slice reference instead of copy                      │
│    (symptom: right count, TAIL entries corrupted. The first     │
│     few can be correct by luck, so never spot-check [0])        │
│  ✗ Forgetting to undo choice (symptom: often ZERO results)      │
│  ✗ Not handling duplicates in input                             │
│  ✗ Wrong guard for the family (over-prunes, drops answers)      │
│  ✗ break instead of continue on UNSORTED candidates             │
│  ✗ Wrong start index (answer count off by a factor of n!)       │
│  ✗ Rescanning validity when O(1) sets are possible              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Using the Reference Card as an Active Decision Tool

The reference card above is not a passive cheat sheet. It is a decision tree you run in your head in the first 90 seconds of any backtracking interview problem. The sequence is fixed: read the problem, classify the problem type (subsets, permutations, combinations, grid, constraint satisfaction), identify the key pattern for that type, then identify which optimizations apply. Only after completing those three steps do you write the function signature.

The problem-type classification is the single most useful step. The question to ask is: does order matter in the output? If yes, you are in permutation territory and need a `used[]` array. If no, you are in subset or combination territory and need a `start` index. If the input space is a 2D grid, you are in grid search territory and need in-place marking. If the problem has hard placement constraints (N-Queens, Sudoku), you are in constraint satisfaction territory and need precomputed validity sets.

The five critical mistakes at the bottom of the reference card form a post-implementation checklist. After writing your solution, scan your code top to bottom against each mistake in order. The copy mistake takes 5 seconds to check (look for every `append(result, ...)`). The undo mistake takes 5 seconds to check (look for every state modification and verify a reversal exists after the recursive call). Running this checklist before claiming your solution is complete eliminates the most common sources of backtracking failure in interviews.

To internalize the reference card, reproduce it from memory on a blank sheet of paper once per day for five days. On day one, use the card as a reference and fill in what you cannot remember. On days two through five, attempt the reproduction before looking. By day five the template, the problem-type mappings, the complexity patterns, the optimizations, and the mistake list should be instant recall. Pay particular attention to the two duplicate guards: they look almost identical, they belong to different families, and swapping them silently drops valid answers rather than producing an error.

### Senior @ FAANG: Reference Card as a Team Vocabulary and Maturity Artifact

The reference card defines the team vocabulary for backtracking implementations. When a pull request description says "uses constraint satisfaction with O(1) validity checks and MRV heuristic," every engineer on the team should understand exactly what that means without reading the code. Without a shared reference, teams use inconsistent terminology: one engineer calls it "pruning," another calls it "early termination," another calls it "branch cutting." The reference card establishes the canonical terms that make code review, incident postmortems, and architecture discussions precise and efficient.

The five complexity patterns in the card map directly to capacity planning decisions. A function with O(2^n) output size must never be called with unbounded n on a production code path. The reference card makes this constraint explicit and documentable. When an ADR proposes using backtracking for a new feature, the ADR should cite the relevant complexity pattern from the reference card and document the maximum n value that keeps the output size within the system's memory and latency budget. This is the difference between a backtracking implementation that works in staging and one that survives production traffic.

The five common optimizations define a maturity model for backtracking implementations. Level 1 (no optimizations): correct but potentially slow, acceptable only for inputs bounded at single digits. Level 2 (sort-first): handles duplicate inputs correctly and enables early termination for combination problems. Level 3 (pruning): eliminates branches before recursing, reducing tree size by orders of magnitude for well-structured inputs. Level 4 (precomputation): builds lookup tables before the search begins, trading one-time upfront cost for per-call speedup. Level 5 (constraint sets plus MRV): O(1) validity checks and minimum-remaining-values heuristic for constraint satisfaction problems, approaching the performance of dedicated CSP solvers.

Production backtracking implementations should document their maturity level in a doc comment on the function. A comment that says "Level 3: sorted candidates with early break pruning, O(C(n, k)) output size, n bounded at 20 by input validation" communicates more useful information than a comment that says "finds all combinations." Teams that adopt this convention produce backtracking code that is self-documenting, capacity-plan-aware, and straightforward to audit during incident response.

The five critical mistakes at the bottom of the reference card define the rejection criteria for code review. A pull request that exhibits any of the five mistakes should not be approved regardless of test coverage, because the mistakes can produce correct output for test cases while failing on production inputs (aliasing bugs produce wrong output only when the backtracking path is long enough to trigger slice reuse, which test cases rarely exercise). The code review checklist for any backtracking implementation should include all five mistake checks as explicit line items, not as general "correctness" items.
