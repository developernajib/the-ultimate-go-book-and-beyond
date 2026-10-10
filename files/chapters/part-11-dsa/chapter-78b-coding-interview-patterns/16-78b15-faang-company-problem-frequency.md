## 78B.15 FAANG Company Problem Frequency

**Read this section with appropriate skepticism.** What follows is community folklore, aggregated from candidate self-reports on interview forums and question banks. It is not published data, no company releases such data, and none of it can be verified. It is also self-selecting, since candidates report the problems they found memorable or hard, and it decays quickly, because companies actively retire questions that circulate publicly. The tendencies below are real enough to be worth a nudge in how you allocate the last few weeks of practice. They are not real enough to skip a pattern over.

The honest summary is shorter than the lists: every company on this list draws from the same pattern set, the overlap between them is far larger than the differences, and the "signature problems" are better read as *representative of a style* than as questions you might be asked. If you find yourself preparing for company A instead of preparing for interviews, the folklore has cost you more than it gave.

### Google

**Most common patterns:**
1. Dynamic Programming (especially 2D DP, interval DP)
2. BFS/DFS (graph problems, grid problems)
3. Binary Search (on answer spaces)
4. Trie (prefix matching, autocomplete)
5. Sliding Window

**Signature problems:** Word Ladder, Median of Two Sorted Arrays, Burst Balloons, Word Search II, Alien Dictionary

### Meta (Facebook)

**Most common patterns:**
1. Binary Search
2. Two Pointers
3. BFS/DFS (especially trees)
4. Sliding Window
5. Prefix Sum + Hash Map

**Signature problems:** Valid Palindrome variations, Subarray Sum Equals K, Binary Tree problems, Add Binary, Merge Intervals

### Amazon

**Most common patterns:**
1. BFS/DFS (grid and graph problems)
2. Heap/Priority Queue
3. Sliding Window
4. Two Pointers
5. Union-Find

**Signature problems:** Number of Islands, Rotting Oranges, K Closest Points to Origin, Merge K Sorted Lists, LRU Cache

### Apple

**Most common patterns:**
1. Two Pointers
2. Trie (autocomplete systems)
3. BFS/DFS
4. Dynamic Programming
5. Sliding Window

**Signature problems:** 3Sum, Implement Trie, Binary Tree Level Order Traversal, Longest Substring Without Repeating Characters

### Netflix

**Most common patterns:**
1. Dynamic Programming
2. Graph algorithms (recommendation systems)
3. Heap/Priority Queue
4. Sliding Window
5. Binary Search

**Signature problems:** Longest Common Subsequence, Network Delay Time, Top K Frequent Elements

### Microsoft

**Most common patterns:**
1. Two Pointers
2. Binary Search
3. BFS/DFS
4. Dynamic Programming
5. Monotonic Stack

**Signature problems:** Container With Most Water, Search in Rotated Sorted Array, Course Schedule, Min Stack, Daily Temperatures

### Time Allocation Strategy for 45-Minute Interviews

The single biggest mistake candidates make is spending the first 25 minutes coding a solution they haven't fully reasoned about, then running out of time to test or handle edge cases. Treating a 45-minute slot as five distinct phases (understand, identify pattern, implement, test, optimize) forces you to surface ambiguities early and gives the interviewer visibility into your thinking process before a single line of code is written.

```
┌───────────────────────────────────────────────────────────────────┐
│            45-MINUTE INTERVIEW TIME BREAKDOWN                     │
├──────────────┬────────────────────────────────────────────────────┤
│ Minutes 0-5  │ UNDERSTAND the problem                             │
│              │ • Read carefully, identify constraints             │
│              │ • Ask clarifying questions                         │
│              │ • Work through 1-2 examples by hand                │
│              │ • Identify edge cases                              │
├──────────────┼────────────────────────────────────────────────────┤
│ Minutes 5-10 │ IDENTIFY the pattern                               │
│              │ • Use the decision tree above                      │
│              │ • State the pattern: "This is a sliding window"    │
│              │ • Explain your approach at a high level            │
│              │ • Discuss time/space complexity upfront            │
├──────────────┼────────────────────────────────────────────────────┤
│ Minutes 10-35│ IMPLEMENT the solution                             │
│              │ • Write clean, well-structured code                │
│              │ • Name variables descriptively                     │
│              │ • Talk through your thought process                │
│              │ • Handle edge cases as you code                    │
├──────────────┼────────────────────────────────────────────────────┤
│ Minutes 35-40│ TEST your solution                                 │
│              │ • Trace through with an example                    │
│              │ • Check edge cases                                 │
│              │ • Fix bugs                                         │
├──────────────┼────────────────────────────────────────────────────┤
│ Minutes 40-45│ OPTIMIZE and discuss                               │
│              │ • Confirm final complexity                         │
│              │ • Discuss alternative approaches                   │
│              │ • Mention potential optimizations                  │
│              │ • Ask interviewer if they have questions           │
└──────────────┴────────────────────────────────────────────────────┘
```

### Key Interview Tips

1. **Always start with brute force.** State the naive O(n²) or O(2^n) solution first, then optimize. This proves you can solve the problem at all and shows the optimization is deliberate rather than lucky. Say the brute force out loud, do not code it.

2. **Communicate pattern recognition.** Say "this is a two-pointer problem because the array is sorted and we want pairs." Naming the *property* that licenses the pattern, and not just the pattern, is the part that carries signal.

3. **Handle edge cases explicitly.** Empty input, single element, all-duplicates, and the boundary values of the stated constraints. Enumerate them out loud before coding, not after a failing trace.

4. **Write helper functions.** Splitting code into `isValid`, `dfs`, `canFinish` helpers makes it readable and lets you defer a detail while keeping momentum on the main structure.

5. **Know your Go standard library.** `slices.Sort`, `slices.SortFunc`, `slices.BinarySearch`, `sort.Slice`, `container/heap`, `strings.Builder`, `maps.Keys`, the builtin `min`/`max`, and `math.MaxInt`/`math.MinInt` (the int-sized ones, not the Int64 constants, when your variable is an `int`). These save real minutes.

---

### Junior → FAANG: Adapting Preparation to Target Company

Use the folklore above only to allocate *marginal* time, and only at the end. It should shift the last two weeks, never the first six. Skipping a pattern because a forum said your target company rarely asks it is how candidates get eliminated by the one question the forum was wrong about.

A practical preparation calendar: spend the first four weeks on pattern mastery (two pointers, sliding window, binary search, BFS/DFS, backtracking, DP), covering all of them regardless of target. Spend weeks five and six deepening whichever patterns you are weakest at, which you should determine from your own error log rather than from a frequency list. Spend week seven on timed 45-minute mock interviews, because the constraint you have not practiced is the clock and the audience, not the algorithms. The final week is review and rest, not new patterns.

First-job habit: read the constraints before anything else. They usually name the intended complexity. `n ≤ 20` invites exponential work and hints at bitmask or backtracking. `n ≤ 10^3` permits O(n²). `n ≤ 10^5` wants O(n log n) and rules out O(n²), since 10^10 operations will not finish. `n ≤ 10^9` rules out even allocating an array of that size, so the answer is arithmetic, binary search on the answer, or a per-digit construction, not iteration over n. Constraint reading takes ten seconds and eliminates whole branches of the decision tree before you have analyzed the problem at all.

### Senior @ FAANG: Frequency Data as Interview Design Feedback

It is tempting to read a company's apparent question mix as a window into its engineering, and to conclude that a search company asks graph problems because it does routing. Resist that story. Question selection is driven far more by what makes a clean 45-minute problem with a discoverable insight, by which questions have not yet leaked, and by individual interviewer preference, than by any mapping to the codebase. The reasoning also runs backwards: whatever pattern mix you observe, a plausible just-so explanation is available for it, which is a sign the explanation is doing no work.

The defensible use of this information is narrow: it is a weak prior for allocating your last two weeks, and nothing more.

As a senior engineer who designs interviews, the more valuable exercise is to audit whether your own team's process tests for the skills the job needs. If your team builds graph-heavy infrastructure and your interviews never ask graph problems, you may be filtering on the wrong signal and missing strong candidates. Conversely, if your interviews heavily test DP but your team's work is primarily API design and database optimization, you are creating false negatives for pragmatic engineers who are strong on the skills that matter for your team.

Governance consideration: standardize interview problem sets across interviewers on your team and refresh them annually. Stale problem sets create fairness issues (candidates who have seen the exact problem before have an unfair advantage) and reduce signal quality (interviewers start pattern-matching on memorized solution shapes rather than observing problem-solving process). Treat the interview problem set as a living artifact with version control and a documented refresh process.
