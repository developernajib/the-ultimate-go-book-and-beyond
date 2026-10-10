## Practice Problems

### Segment Tree / Fenwick Tree
| Problem | Difficulty | Key Technique |
|---|---|---|
| LC 307: Range Sum Query - Mutable | Medium | Fenwick or Segment Tree |
| LC 315: Count of Smaller Numbers After Self | Hard | Fenwick + coordinate compression |
| LC 327: Count of Range Sum | Hard | Segment tree or merge sort |
| LC 493: Reverse Pairs | Hard | Fenwick + coordinate compression |
| LC 308: Range Sum Query 2D - Mutable | Hard | 2D Fenwick Tree |

### Interval Problems
| Problem | Difficulty | Key Technique |
|---|---|---|
| LC 56: Merge Intervals | Medium | Sort + linear merge |
| LC 57: Insert Interval | Medium | Three-phase scan |
| LC 252: Meeting Rooms | Easy | Sort + overlap check |
| LC 253: Meeting Rooms II | Medium | Sweep line or min-heap |
| LC 435: Non-overlapping Intervals | Medium | Greedy (sort by end) |
| LC 986: Interval List Intersections | Medium | Two pointers |
| LC 1288: Remove Covered Intervals | Medium | Sort + greedy |

### Monotonic Stack / Deque
| Problem | Difficulty | Key Technique |
|---|---|---|
| LC 42: Trapping Rain Water | Hard | Monotonic stack or two pointers |
| LC 84: Largest Rectangle in Histogram | Hard | Monotonic increasing stack |
| LC 239: Sliding Window Maximum | Hard | Monotonic deque |
| LC 496: Next Greater Element I | Easy | Monotonic stack + hash map |
| LC 503: Next Greater Element II | Medium | Monotonic stack + circular |
| LC 739: Daily Temperatures | Medium | Monotonic stack |
| LC 862: Shortest Subarray with Sum >= K | Hard | Prefix sums + monotonic deque |

---

### Junior → FAANG: Practice Prioritization for This Problem Set

If you have limited time, prioritize in this order: LC 307 (Fenwick, foundational), LC 239 (monotonic deque, very common), LC 84 (monotonic stack, classic hard), LC 56 (merge intervals, appears in nearly every loop), LC 253 (meeting rooms with heap, common). Problems like LC 315, LC 493, and LC 862 are "hard" tier and worth attempting only after the medium problems feel automatic. For each problem, practice without looking at solutions first, even if you get it wrong. The wrong attempt followed by understanding the correct approach is more effective than reading solutions passively.

### Senior @ FAANG: Hard-Tier Problems as Technical Leadership Benchmarks

The hard-tier problems here (LC 315, 327, 493, 84, 239, 862) are useful for probing depth, though be honest about what they measure: a candidate who has seen LC 862 before will look brilliant and a candidate who has not may not derive the domination argument in 40 minutes regardless of ability. Solving them is weaker evidence than *explaining* them. Ask why the deque's back-eviction is sound, and the answer separates understanding from recall.

Some of these shapes do recur outside interviews. Inversion counting (LC 315, 493) is how Kendall tau compares a predicted ranking against an actual one, since the statistic is literally built from discordant pairs. The histogram problem (LC 84) is the same question as the largest contiguous free block in a fragmented allocator. Recognizing the shape is worth something. Just resist the temptation to claim more: most production work does not need a Fenwick tree, and reaching for one because you recognized an inversion count is how a maintainable system acquires a structure nobody else on the team can debug.
