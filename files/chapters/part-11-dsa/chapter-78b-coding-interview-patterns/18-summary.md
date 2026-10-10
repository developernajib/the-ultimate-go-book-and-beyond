## Summary

This chapter presented thirteen coding interview patterns that between them cover most of what interviews ask. Here is a recap:

| # | Pattern | Core Idea | Key Complexity |
|---|---------|-----------|----------------|
| 1 | Two Pointers | Coordinate two indices to avoid nested loops | O(n) |
| 2 | Sliding Window | Maintain a contiguous window with constraints | O(n) |
| 3 | Binary Search | Halve the search space using a monotonic predicate | O(log n) |
| 4 | BFS/DFS | Systematic graph/tree exploration | O(V + E) |
| 5 | Backtracking | Generate all candidates with pruning | O(2^n) or O(n!) |
| 6 | Dynamic Programming | Memoize overlapping subproblems | Varies |
| 7 | Monotonic Stack/Queue | Maintain order invariant for next greater/smaller | O(n) |
| 8 | Union-Find | Dynamic connectivity with near-O(1) operations | O(α(n)) |
| 9 | Trie | Efficient prefix operations on strings | O(L) per operation |
| 10 | Heap | Maintain top-K or sorted order in a stream | O(n log k) |
| 11 | Prefix Sum | O(1) range sum queries after O(n) preprocessing | O(n) / O(1) |
| 12 | Bit Manipulation | Use XOR, AND, OR for O(1) space tricks | O(n) |
| 13 | Advanced Graph | Dijkstra, Bellman-Ford, MST for weighted graphs | O((V+E) log V) |

**The pattern recognition workflow:**

1. Read the problem and identify constraints (sorted? contiguous? graph? optimization?)
2. Match constraints to a pattern using the decision tree
3. Apply the pattern's template
4. Handle edge cases
5. Verify complexity meets the problem's requirements

Mastering these patterns does not happen by reading, it happens by solving. Work through the worked problems in this chapter, then the 20 exercises. When you can name the right pattern within a minute or two of reading a new problem, and say *why* the problem's properties license it, the recognition half of the work is done.

Chapter 78C follows with a curated set of 150 problems organized by these same patterns, which is where the recognition instinct gets built through volume.

### Junior → FAANG: Consolidating the Patterns

The summary table is your pre-interview reference card. In the final 24 hours before your interview, review each row and mentally simulate the template for each pattern. The goal is not to memorize code but to recall the core invariant: what property does this pattern require of the input, what does the template guarantee, and what is the complexity? If any row takes longer than five seconds to recall, that pattern needs more practice time before the interview.

Prioritize the patterns where you have made the most mistakes during practice. If your prefix sum solutions had off-by-one errors in the base case, write the base case explicitly on paper before the interview day. If your backtracking solutions had undo bugs, write the three-step template (choose, recurse, unchoose) on paper and keep it visible. These physical reminders are allowed in take-home assessments and useful as mental anchors even in live interviews.

A concrete readiness test: for each of the thirteen patterns, solve one problem from this chapter from scratch, timed, without looking at the chapter. If you can do all thirteen with correct solutions and stated complexities, the recognition and the templates are in place. If several need hints or run long, those specific patterns are where the next week goes.

### Senior @ FAANG: Patterns as a Shared Engineering Vocabulary

Beyond interviews, these patterns are a shared vocabulary. A review comment saying "this nested loop has a two-pointer form available" conveys the whole suggestion, because both people already know the invariant it depends on. A design document saying "routing is Dijkstra over non-negative weights" conveys the complexity, the precondition, and the data structure in one clause. The names are compression, and they work only because both parties can decompress them.

That is also the limit worth naming. A vocabulary shared imprecisely is worse than no vocabulary, because "just use a sliding window here" sounds authoritative whether or not the constraint is monotone. The value is not in the label. It is in both people being able to state the property the label assumes, which is the same skill the interview is trying to measure.

The honest case for this material: these patterns are the algorithmic building blocks of real systems, and fluency with them makes you faster at recognizing when a piece of code is doing quadratic work on data that has since grown. That is a real benefit and it does not need to be oversold into claims about team-wide metrics.
