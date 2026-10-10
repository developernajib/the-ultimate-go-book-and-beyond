## Exercises

### Beginner (Warm-up)

1. **Two Sum (LC 1).** Given an unsorted array and target, return indices of two numbers that add up to target. (Hint: Hash Map, not Two Pointers since unsorted)

2. **Valid Anagram (LC 242).** Given two strings, determine if one is an anagram of the other. (Hint: Character frequency count)

3. **Maximum Subarray (LC 53).** Find the contiguous subarray with the largest sum. (Hint: Kadane's algorithm, which is 1D DP in disguise)

4. **Merge Two Sorted Lists (LC 21).** Merge two sorted linked lists. (Hint: Two Pointers on linked lists)

5. **Invert Binary Tree (LC 226).** Invert a binary tree. (Hint: DFS/BFS, swap children)

### Intermediate

6. **Group Anagrams (LC 49).** Group strings that are anagrams. (Hint: Sort each string as key, or use character count as key)

7. **Longest Palindromic Substring (LC 5).** Find the longest palindromic substring. (Hint: expand around center, a two-pointers variant. Note there are 2n-1 centers, not n, because even-length palindromes are centered between characters)

8. **Coin Change (LC 322).** Find minimum coins to make amount. (Hint: 1D DP, unbounded knapsack)

9. **Word Break (LC 139).** Determine if string can be segmented into dictionary words. (Hint: 1D DP with hash set)

10. **Clone Graph (LC 133).** Clone an undirected graph. (Hint: BFS/DFS with hash map for visited)

11. **Implement LRU Cache (LC 146).** Design an LRU cache. (Hint: Doubly linked list + hash map)

12. **Pacific Atlantic Water Flow (LC 417).** Find cells that can reach both oceans. (Hint: Multi-source DFS/BFS from each ocean)

13. **Task Scheduler (LC 621).** Find minimum intervals to complete all tasks with cooldown. (Hint: Greedy with priority queue)

### Advanced

14. **Trapping Rain Water (LC 42).** Calculate trapped water. (Hint: Two Pointers or Monotonic Stack)

15. **Alien Dictionary (LC 269).** Determine order of characters from sorted alien words. (Hint: Topological Sort)

16. **Longest Increasing Subsequence (LC 300).** Find length of LIS. (Hint: DP with binary search for O(n log n))

17. **Edit Distance (LC 72).** Find minimum operations to convert one string to another. (Hint: 2D DP)

18. **Serialize and Deserialize Binary Tree (LC 297).** Design serialization/deserialization. (Hint: BFS or preorder DFS)

19. **Swim in Rising Water (LC 778).** Find minimum time to swim from top-left to bottom-right. (Hint: Binary Search on Answer + BFS, or Dijkstra)

20. **Regular Expression Matching (LC 10).** Implement regex with `.` and `*`. (Hint: 2D DP)

For each exercise, follow this approach:
1. Identify the pattern using the decision tree in Section 78B.14
2. Write the solution using the appropriate template from this chapter
3. Analyze time and space complexity
4. Test with edge cases

---

### Junior → FAANG: Structured Exercise Practice

Random problem practice produces random results. For each exercise here, enforce a protocol: (1) read the problem and its constraints, (2) name the pattern and the signal phrase that triggered it within about two minutes, (3) state the complexity goal before coding, (4) write the solution in 20 minutes or fewer, (5) enumerate and test three edge cases. If you cannot name the pattern in two minutes, do not read the hint. Reread the problem looking for the property that licenses each pattern: sorted input for two pointers, contiguity for sliding window, "find the kth" for heap or quickselect, "count the ways" for DP, "all combinations" for backtracking. The hint is the answer, and reaching for it converts a recognition exercise into a typing exercise.

The beginner exercises build mechanical fluency with templates. The intermediate exercises test pattern transfer to unfamiliar problem framings. The advanced exercises require combining two patterns (e.g., binary search + greedy, BFS + Union-Find) or applying a pattern in an unusual domain. If an advanced exercise takes more than 45 minutes, spend 10 more minutes on the specific sub-skill that blocked you rather than moving on without understanding the gap.

Keep a mistake log: for each problem you got wrong or took too long, record the pattern, the mistake, and the correct insight. Reviewing this log before your interview loop is more valuable than solving additional new problems.

### Senior @ FAANG: Designing Exercises for Team Calibration

Exercise sets serve two purposes: skill building for individuals and calibration for teams. At L5+, these are useful for sanity-checking your interview rubric. Give a few to current engineers whose level you already know, watch their approach, and see whether your benchmarks actually separate the levels you expect them to separate.

Be honest about what that experiment shows. If your own engineers, who are demonstrably doing the job well, struggle with the advanced exercises, the first hypothesis should be that the bar is miscalibrated rather than that the team has a gap. An interview loop that your existing high performers would fail is not measuring the job.

For building a structured onboarding curriculum for new graduate hires, the progression from beginner to advanced exercises represents a four-to-eight week ramp. Track completion rate and time-to-completion per exercise as leading indicators of interview readiness rather than waiting until mock interviews to discover gaps.
