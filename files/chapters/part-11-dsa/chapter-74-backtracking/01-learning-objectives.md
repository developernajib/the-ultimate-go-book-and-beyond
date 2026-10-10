## Learning Objectives

By the end of this chapter, you will:
- Understand the backtracking paradigm and when to apply it
- Master the template for backtracking problems
- Solve permutations, combinations, and subset problems
- Apply backtracking to constraint satisfaction problems
- Optimize backtracking with pruning techniques

### Junior → FAANG: Objectives as Interview Readiness Indicators

"Understand the backtracking paradigm and when to apply it" means: you can recognize a backtracking problem from its problem statement within 60 seconds and state why backtracking applies (exhaustive enumeration of a constrained search space). The keyword triggers are: generate all, find all valid, permutations, combinations, subsets, constraint satisfaction.

"Master the template" means: you can write the `choose, recurse, unchoose` loop from memory, correctly handling the copy-when-storing and unmake-the-choice requirements, for any of the six problem types in this chapter.

"Apply backtracking to constraint satisfaction problems" is the hardest objective because constraint satisfaction problems (N-Queens, Sudoku, map coloring) require translating the constraints into an efficient validity check. The skill is not in the backtracking template itself but in the constraint representation: using bitsets, hash maps, or precomputed tables to make validity checks O(1) rather than O(n).

"Optimize with pruning" means: you can identify and implement at least two pruning strategies (sort-and-break for combination sum, skip-duplicate-siblings for problems with repeated elements, bound-based pruning for numeric constraints) for each problem type.

### Senior @ FAANG: Objectives as a Hiring Rubric

When evaluating a candidate on a backtracking problem, senior interviewers score five dimensions. Problem recognition (did they identify backtracking quickly?). Template correctness (did they write the unmake step?). State management (did they copy before storing?). Pruning (did they add early termination?). Complexity analysis (did they correctly state the search tree size: 2^n subsets, n! permutations, C(n, k) combinations, and did they account for the O(n) copy at each leaf, which makes the time O(n * 2^n) and O(n * n!) rather than the bare counts?).

A candidate who scores 5/5 on these dimensions in a 40-minute interview is comfortably above the bar for L4 at FAANG. For L5, the bar adds: choosing the most efficient validity check representation for constraint satisfaction problems, reasoning about the branching factor and estimating the actual search tree size for a given input, and connecting the backtracking algorithm to a production use case without prompting.

For L6, the additional bar is: identifying when backtracking is the wrong approach (overlapping subproblems indicate DP, single optimal answer indicates greedy), proposing the correct alternative, and reasoning about the input constraint boundaries that make the algorithm tractable in production.

### Junior → FAANG: Objectives as a Week-by-Week Skill Ladder

The five learning objectives map to a five-week practice ladder. Week 1: master the template. Implement subsets and permutations from memory until you can write the choose/recurse/unchoose loop without thinking. Week 2: master the state variants. Implement combination sum (start index) and permutations (used array) and know which pattern to reach for based on whether order matters. Week 3: master constraint satisfaction. Implement N-Queens and Sudoku, focusing on building efficient constraint data structures (hash maps for O(1) validity checking). Week 4: master pruning. Take all previous implementations and add at least one pruning strategy to each (sort-and-break, bounds check, constraint propagation). Week 5: master complexity analysis. For each of the six problem types, state the exact time and space complexity formula without looking it up.

After five weeks, test yourself with a full mock interview on a new backtracking problem you have not seen before. If you can write a correct, pruned solution with the right complexity analysis in 30 minutes, you are ready for FAANG backtracking interviews.

### Senior @ FAANG: Objectives as a Mentoring Checklist

The five objectives define the mentoring checklist for backtracking. When a junior engineer on your team says "I understand backtracking," the checklist tells you exactly what to verify. Ask them to implement N-Queens without reference material. Watch whether they reach for hash maps for constraint tracking or linear scans. Ask them to state the time complexity and watch whether they say "O(n!)" with or without mentioning the actual pruning factor. Ask them to add the MRV heuristic and watch whether they understand why it reduces the effective branching factor.

The objective "optimize backtracking with pruning techniques" is the one that most junior engineers check off prematurely. Knowing that pruning exists and knowing which pruning strategy to apply to a specific problem structure are different skills. A mentoring session that focuses on "design a pruning strategy for this novel problem" (not "apply the pruning strategy you memorized") tests the deeper skill and reveals whether the engineer can reason about search tree structure or is only pattern-matching to known solutions.
