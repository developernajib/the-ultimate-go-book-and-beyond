## Exercises

### Exercise 1: Kth Smallest Element in Sorted Matrix
Find the k-th smallest element in a row-wise and column-wise sorted matrix.

### Exercise 2: Find K Pairs with Smallest Sums
Given two sorted arrays, find k pairs with smallest sums.

### Exercise 3: Minimum Cost to Connect Sticks
Given sticks of various lengths, find minimum cost to connect all into one (cost = sum of lengths being connected).

### Exercise 4: Trapping Rain Water II
Given a 2D elevation map, find how much water can be trapped (3D version).

### Junior → FAANG: Exercise Strategy for Heap Problems

Each exercise above maps to a specific heap pattern. Kth Smallest in Sorted Matrix combines the k-way merge pattern (seed the heap with each row's first element) with the insight that row and column sort order gives you a structured search space. Find K Pairs with Smallest Sums is the same pattern applied to pairs. Minimum Cost to Connect Sticks is the Huffman coding pattern: always merge the two smallest. Trapping Rain Water II uses a min-heap as a boundary-value tracker (same structure as Prim's MST).

Practice order: do exercises 1 and 3 first (straightforward heap applications), then 2 (slightly more complex seed logic), then 4 (the hardest, requiring a BFS-min-heap combination). Do each one timed: if you cannot produce a working solution within 30 minutes, read the solution, understand it fully, then implement it again from scratch two days later without looking.

### Senior @ FAANG: Exercise Design and Technical Leadership

At staff level, you may be asked to design exercises for junior engineers on your team, calibrate interview difficulty, or review take-home assessments. Understanding why these four exercises were chosen teaches you to reason about problem quality.

A good heap exercise has exactly one key insight that requires the heap (not a workaround), a clear correctness check (the answer is a single number or a sortable list), and a complexity trap that an O(n^2) brute force exposes but the heap avoids. Exercise 3 (Minimum Cost to Connect Sticks) is particularly well designed: the greedy correctness argument (always merge the two cheapest) is non-obvious but verifiable by an exchange argument, and the O(n^2) greedy without a heap fails on large inputs.

When calibrating interview difficulty, consider that Trapping Rain Water II (Exercise 4) is a full hard problem that combines BFS, a min-heap, and boundary-value reasoning. Assigning it as a 45-minute interview problem is appropriate only at L6. For L4 or L5, limit to exercises 1-3 with a follow-up discussion of the algorithmic trade-offs rather than a full implementation.

---
