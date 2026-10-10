## 73.9 Interview Tips

### DP Pattern Recognition

Recognizing the DP pattern early in an interview is critical because it determines the shape of the state, the recurrence, and the traversal order before you write a single line of code. Each pattern has a signature set of keywords and a characteristic dependency structure: Fibonacci variants depend only on a fixed number of prior states, grid problems depend on adjacent cells, string matching problems build a 2D table over two sequences, and interval problems require iterating by increasing range length so that sub-intervals are always solved first. Use this reference to map problem keywords to the correct state definition within the first minute of reading the prompt.

```
┌─────────────────────────────────────────────────────────────────┐
│                 DP PROBLEM PATTERNS                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. FIBONACCI VARIANT                                           │
│     Keywords: ways, count, steps                                │
│     Examples: Climbing Stairs, House Robber                     │
│     dp[i] depends on dp[i-1], dp[i-2], ...                      │
│                                                                 │
│  2. GRID/PATH                                                   │
│     Keywords: paths, minimum cost, grid                         │
│     Examples: Unique Paths, Minimum Path Sum                    │
│     dp[i][j] depends on dp[i-1][j], dp[i][j-1]                  │
│                                                                 │
│  3. STRING MATCHING                                             │
│     Keywords: subsequence, edit, pattern                        │
│     Examples: LCS, Edit Distance, Regex Matching                │
│     dp[i][j] = result for str1[0:i] and str2[0:j]               │
│                                                                 │
│  4. KNAPSACK                                                    │
│     Keywords: capacity, selection, subset sum                   │
│     Examples: 0/1 Knapsack, Coin Change, Target Sum             │
│     Choose or don't choose item i                               │
│                                                                 │
│  5. INTERVAL/RANGE                                              │
│     Keywords: merge, burst, optimal order                       │
│     Examples: Burst Balloons, Matrix Chain Multiplication       │
│     dp[i][j] = result for range [i, j]                          │
│                                                                 │
│  6. STATE MACHINE                                               │
│     Keywords: states, transitions, cooldown                     │
│     Examples: Stock problems, State-based DP                    │
│     Track multiple states per position                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Common Optimizations

1. **Space optimization**: If dp[i] only depends on dp[i-1], use O(1) space
2. **Prefix sums**: Precompute sums for range queries
3. **Binary search**: Combine with DP for O(n log n) LIS
4. **Bitmask DP**: For subset-based problems

### Junior → FAANG: Pattern Matching as a Time-Boxed Skill

The pattern recognition table above is your 60-second interview checklist. Read the problem statement, extract keywords ("minimum", "count ways", "subsequence", "grid", "partition"), map them to a pattern, and state the pattern name out loud. This signals to the interviewer that your approach is systematic rather than trial-and-error.

The six patterns cover the vast majority of DP interview problems. Fibonacci/stairs variants appear most often at the phone screen level. Grid path and knapsack variants appear at the onsite level. Interval DP and state machine problems appear in bar-raiser loops and higher-difficulty onsites. Bitmask DP (not covered in this section but worth knowing) shows up mostly in competitive programming and in the harder end of the onsite range. It applies when the number of items is small (typically <= 20) and the subset state must be tracked exactly.

Common optimizations are also a source of follow-up questions. "Can you reduce the space?" (almost always yes, via rolling arrays). "Can you do better than O(n^2)?" (sometimes yes, via binary search for LIS or monotonic queue for sliding window DP). Having a prepared answer for each of these follow-ups before the interviewer asks transforms a good interview into a great one.

### Senior @ FAANG: Optimization Discipline and Complexity Trade-offs

The optimization techniques listed above are not just performance improvements. They are correctness risks and maintenance costs. Each optimization warrants an explicit comment explaining why it is correct and what invariant it preserves.

Space optimization via rolling arrays: the comment must state which rows are read and in which order, so that a future developer who wants to modify the recurrence can quickly determine whether the space optimization still holds. Without this comment, any recurrence change requires re-deriving the space optimization from scratch.

Binary search combined with DP (LIS in O(n log n)): the `tails` array does not hold a valid LIS. It holds the smallest possible tail for each length. This is a subtle invariant that is easily misunderstood. If the problem requires reconstructing the actual LIS (not just its length), the binary search approach requires a separate parent array tracked alongside `tails`, adding code complexity. Document this trade-off: the O(n log n) solution is preferable for length-only queries. The O(n^2) approach may be preferable when reconstruction is required and code clarity matters more than the constant factor on n.

Bitmask DP: the scaling limit is strict, and it is worth doing the arithmetic rather than eyeballing it. At `int32` per state, 2^20 states (20 items) is 4 MiB, which is nothing. 2^25 (25 items) is 128 MiB, which is a real allocation. 2^30 is 4 GiB and the process is gone. Note that Go's `int` is 8 bytes on 64-bit, so a table of plain `int` doubles every number above: 25 items is 256 MiB, not 128. Each additional item doubles both the memory and the time, so the safe range ends abruptly, and "it worked in testing with 20 items" tells you nothing about 26. Where the item count is user-controlled, input validation must cap it before the DP table is allocated. A missing cap allows a malicious user to trigger an OOM condition, a denial-of-service vulnerability in any bitmask DP that is exposed via an API.

### Junior → FAANG: The Pattern Table as an Active Tool

The six-pattern reference table in this section is most useful when you practice applying it to unfamiliar problems under time pressure. Take any LeetCode DP problem you have not seen before and give yourself 60 seconds to identify the pattern, the state, and the recurrence direction before reading any discussion or hints. Track your success rate over time. The number itself matters less than its trend and where it breaks: if you reliably identify the pattern on mediums but stall on hards, the gap is in state design rather than in recognition, and that tells you what to drill next.

The common optimizations are also interview triggers. When you present a 2D DP solution, the interviewer will ask "can you reduce the space?" Have the answer ready: "yes, because row `i` only reads from row `i-1`, I can reduce to two alternating arrays and then to one array by iterating in the right direction." When you present an O(n^2) LIS solution, the interviewer will ask "can you do better?" Have the O(n log n) patience sort answer ready with a one-sentence explanation of the `tails` array invariant.

### Senior @ FAANG: Interview Tips as a Coaching Playbook

The pattern table and common optimizations in this section define the content of a structured DP coaching session for junior engineers. A 90-minute coaching session should cover: pattern recognition drill (give 6 problems, one per pattern, and time how long it takes to identify each), recurrence writing drill (for each identified pattern, write the recurrence and base cases without code), space optimization drill (convert a 2D solution to 1D for at least two different patterns), and complexity drill (state the exact time and space complexity, not just "polynomial").

The goal of coaching is not to teach specific problem solutions but to teach the pattern recognition and derivation skills that generalize. A junior engineer who can solve 20 specific DP problems from memory will fail novel variants. A junior engineer who can apply the five-step framework and pattern table to an unfamiliar problem will pass. Senior engineers who mentor with this distinction in mind produce faster, more durable skill development in their reports.
