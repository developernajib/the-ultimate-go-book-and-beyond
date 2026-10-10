## Summary

| # | Pattern | Count | Key Technique |
|---|---------|-------|---------------|
| 1 | Two Pointers | 11 | Converging/diverging pointers on sorted data |
| 2 | Sliding Window | 10 | Expand/shrink window to meet constraints |
| 3 | Binary Search | 11 | Halving search space with monotonic predicates |
| 4 | Stack | 9 | LIFO matching, monotonic sequences |
| 5 | Linked List | 11 | Fast/slow pointers, dummy nodes, reversal |
| 6 | Trees | 14 | DFS recursion, BFS level-order |
| 7 | Heap/Priority Queue | 9 | Top-k, merge-k, median maintenance |
| 8 | Graphs | 12 | BFS, DFS, topological sort, shortest path |
| 9 | Dynamic Programming | 16 | State definition, recurrence, base cases |
| 10 | Backtracking | 8 | Choose-explore-unchoose with pruning |
| 11 | Greedy | 9 | Local optimality leads to global optimality |
| 12 | Intervals | 9 | Sort by start/end, scan for overlaps |
| 13 | Tries | 5 | Prefix trees for string operations |
| 14 | Bit Manipulation | 6 | XOR, AND masks, bit counting |
| 15 | Math/Geometry | 6 | Matrix operations, digit manipulation |
| 16 | Design | 8 | Combining data structures for O(1) ops |
| 17 | Union Find | 5 | Path compression, union by rank |
| 18 | Monotonic Stack | 5 | Next greater/smaller element |
| | **Total entries** | **164** | |
| | **Distinct problems** | **150** | |

The two totals differ because 14 problems earn a place in two pattern sections, and each is written up once with a pointer from the other. Trapping Rain Water (42) is filed under both Two Pointers and Monotonic Stack, Largest Rectangle (84) and Daily Temperatures (739) under both Stack and Monotonic Stack, LRU Cache (146), Min Stack (155), Trie (208) and Find Median (295) under both their home pattern and Design, Number of Islands (200), Graph Valid Tree (261), Connected Components (323) and Redundant Connection (684) under both Graphs and Union Find, Non-overlapping Intervals (435) and Burst Balloons (452) under both Greedy and Intervals, and Task Scheduler (621) under both Heap and Greedy.

That overlap is the point rather than an accounting slip. A problem that yields to two patterns is the most valuable kind to study, because interviewers use exactly those problems to tell pattern recognition apart from pattern memorization. When you reach a cross-referenced problem the second time, solve it with the second pattern instead of rereading the first solution.

---

### Junior → FAANG: Using the Checklist as a Study Plan

The 18-pattern checklist is a concrete study roadmap. Solve problems in the order listed because each pattern builds on the previous: two pointers before sliding window, binary search before BFS/DFS, stack before monotonic stack. Track your completion per pattern and identify which patterns have the highest error rate in your practice sessions. Patterns with multiple "wrong answer" or "time limit exceeded" attempts in practice will be your weak spots in the real interview. Address them with targeted repetition before moving to the next pattern. The goal is not to memorize solutions but to reach the point where you can derive the approach from the pattern name alone.

### Senior @ FAANG: The 150-Problem List as a Bar-Raising Calibration Tool

At the senior level, this checklist has a second use: calibrating the difficulty and coverage of your team's interview loop. A well-designed FAANG interview loop samples problems from 4-6 of these 18 patterns, choosing problems that have multiple valid approaches (greedy and DP, or BFS and Union-Find) to test conceptual depth rather than pattern memorization. Bar-raiser interviewers look for candidates who can state which pattern applies, why it applies (the structural property), what the time and space complexity is, and how the solution extends or breaks under modified constraints. Staff-level candidates are expected to solve the problem, propose an optimization, and then describe how the algorithm would change if the input were streaming, distributed, or adversarially ordered. When your team is calibrating its interview loop, map each problem to the patterns in this list and verify that the loop covers at least 4 distinct patterns, includes at least one "hard" problem per loop, and has a documented expected-behavior rubric for each problem that distinguishes L4, L5, and L6 responses.
