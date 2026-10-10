## 83F.5 The 4-Week Emergency Plan

You have an interview in 30 days. You cannot follow the full 12-week plan. This section distills the most critical preparation into 4 weeks, prioritizing the highest-impact activities and accepting that some areas will remain rough.

**The philosophy:** Maximize pass probability, not perfection. A candidate who is solid across all four pillars passes more often than a candidate who is exceptional at coding but unprepared for system design.

**Total estimated hours: 150-180**

### What to Prioritize and What to Skip

| Priority | Activity | Hours | Why |
|----------|----------|-------|-----|
| **Critical** | Top 50 coding problems (pattern-based) | 50 | Covers 80% of interview patterns |
| **Critical** | 5 system designs practiced and articulated | 25 | Must pass system design at L4+ |
| **Critical** | 8 behavioral stories in STAR format | 15 | Cannot fake, must have real stories |
| **Important** | Mock interviews (6-8 mocks) | 20 | Performance under pressure |
| **Important** | Go-specific fluency (heap, sort, strings) | 10 | Language-specific competence |
| **Important** | Company-specific preparation | 10 | Tailored approach matters |
| **Skip** | Obscure algorithm topics (segment trees, Fenwick trees) | 0 | Low probability of appearing |
| **Skip** | Exhaustive problem coverage (200+ problems) | 0 | Not enough time for retention |
| **Skip** | Deep DP optimization (bitmask DP, digit DP) | 0 | High effort, low probability |

### The 50 Most Important Problems

These 50 problems cover the patterns that appear in 80%+ of FAANG coding interviews. Solve each one in Go, understand the pattern, and be able to re-solve from memory.

**Arrays and Strings (10 problems):**

| # | Problem | Pattern | Time Target |
|---|---------|---------|-------------|
| 1 | Two Sum | Hash map | 8 min |
| 2 | Best Time to Buy and Sell Stock | Single pass / Kadane variant | 10 min |
| 3 | Product of Array Except Self | Prefix/suffix arrays | 15 min |
| 4 | Maximum Subarray | Kadane's algorithm | 10 min |
| 5 | 3Sum | Sort + two pointers | 20 min |
| 6 | Container With Most Water | Two pointers | 15 min |
| 7 | Longest Substring Without Repeating Characters | Sliding window + hash map | 15 min |
| 8 | Minimum Window Substring | Sliding window + counting | 25 min |
| 9 | Group Anagrams | Hash map (sorted key) | 12 min |
| 10 | Merge Intervals | Sort + merge | 15 min |

**Linked Lists and Stacks (5 problems):**

| # | Problem | Pattern | Time Target |
|---|---------|---------|-------------|
| 11 | Reverse Linked List | Pointer manipulation | 8 min |
| 12 | Merge Two Sorted Lists | Two pointers | 10 min |
| 13 | Linked List Cycle | Fast/slow pointers | 10 min |
| 14 | Valid Parentheses | Stack | 8 min |
| 15 | LRU Cache | Hash map + doubly linked list | 25 min |

**Trees (8 problems):**

| # | Problem | Pattern | Time Target |
|---|---------|---------|-------------|
| 16 | Invert Binary Tree | DFS recursion | 5 min |
| 17 | Maximum Depth of Binary Tree | DFS | 5 min |
| 18 | Binary Tree Level Order Traversal | BFS | 12 min |
| 19 | Validate BST | DFS with range | 15 min |
| 20 | Lowest Common Ancestor | DFS | 15 min |
| 21 | Kth Smallest Element in a BST | Inorder traversal | 12 min |
| 22 | Serialize and Deserialize Binary Tree | BFS or preorder DFS | 25 min |
| 23 | Binary Tree Maximum Path Sum | DFS with global max | 20 min |

**Graphs (7 problems):**

| # | Problem | Pattern | Time Target |
|---|---------|---------|-------------|
| 24 | Number of Islands | BFS/DFS flood fill | 12 min |
| 25 | Clone Graph | BFS/DFS + hash map | 15 min |
| 26 | Course Schedule | Topological sort (BFS) | 15 min |
| 27 | Course Schedule II | Topological sort (result order) | 18 min |
| 28 | Word Ladder | BFS | 20 min |
| 29 | Network Delay Time | Dijkstra's algorithm | 20 min |
| 30 | Number of Connected Components | Union-Find | 15 min |

**Dynamic Programming (8 problems):**

| # | Problem | Pattern | Time Target |
|---|---------|---------|-------------|
| 31 | Climbing Stairs | 1D DP (Fibonacci variant) | 5 min |
| 32 | House Robber | 1D DP | 10 min |
| 33 | Coin Change | 1D DP (unbounded knapsack) | 15 min |
| 34 | Longest Increasing Subsequence | 1D DP (or binary search) | 18 min |
| 35 | Word Break | 1D DP | 15 min |
| 36 | Unique Paths | 2D DP | 10 min |
| 37 | Longest Common Subsequence | 2D DP | 15 min |
| 38 | Edit Distance | 2D DP | 20 min |

**Binary Search (4 problems):**

| # | Problem | Pattern | Time Target |
|---|---------|---------|-------------|
| 39 | Binary Search | Standard binary search | 5 min |
| 40 | Search in Rotated Sorted Array | Modified binary search | 15 min |
| 41 | Find Minimum in Rotated Sorted Array | Modified binary search | 12 min |
| 42 | Koko Eating Bananas | Binary search on answer | 15 min |

**Heap and Sorting (5 problems):**

| # | Problem | Pattern | Time Target |
|---|---------|---------|-------------|
| 43 | Top K Frequent Elements | Heap or bucket sort | 15 min |
| 44 | Merge K Sorted Lists | Min-heap | 18 min |
| 45 | Find Median from Data Stream | Two heaps | 20 min |
| 46 | Kth Largest Element in an Array | Quickselect or heap | 15 min |
| 47 | Task Scheduler | Greedy + heap | 20 min |

**Backtracking and Other (3 problems):**

| # | Problem | Pattern | Time Target |
|---|---------|---------|-------------|
| 48 | Subsets | Backtracking | 10 min |
| 49 | Permutations | Backtracking | 12 min |
| 50 | Word Search | Backtracking on grid | 20 min |

### Top 5 System Designs to Prepare

If you can only prepare 5 system designs, choose these - they cover the broadest range of components and patterns:

| Design | Key Components Covered |
|--------|----------------------|
| **URL Shortener** | Hashing, database design, caching, read-heavy optimization |
| **Twitter Feed** | Fanout, ranking, social graph, caching, real-time updates |
| **WhatsApp** | WebSockets, message delivery, group messaging, encryption |
| **Uber** | Geospatial indexing, real-time matching, location tracking |
| **Rate Limiter** | Distributed counting, Redis, sliding window, token bucket |

### Behavioral Essentials (5 Stories Minimum)

At minimum, prepare these 5 story types. Each should be a real story from your experience in STAR format:

| Story Type | Example Question | LP Mapping |
|------------|-----------------|------------|
| **Technical challenge** | "Tell me about the hardest technical problem you solved" | Dive Deep, Invent and Simplify |
| **Leadership/influence** | "Tell me about a time you led without authority" | Ownership, Earn Trust |
| **Conflict** | "Tell me about a disagreement with a teammate" | Have Backbone, Earn Trust |
| **Failure** | "Tell me about a project that failed" | Learn and Be Curious, Deliver Results |
| **Impact** | "Tell me about your biggest professional achievement" | Customer Obsession, Deliver Results |

### 4-Week Emergency Schedule

**Week 1 (40 hrs): Foundation Blitz**

| Day | Morning (3 hrs) | Afternoon (3 hrs) | Evening (2 hrs) |
|-----|-----------------|-------------------|-----------------|
| Mon-Fri | 6-8 problems/day from the "50 Most Important" list | Continue problems + Go fluency drills | Write behavioral stories |
| Sat | 8 problems (timed) + Go heap/sort practice | 1 system design (URL shortener) | Review all problems |
| Sun | Mock coding interview (45 min) + review | 1 system design (Twitter feed) | Behavioral story practice |

Target: Problems 1-25 solved. 2 system designs sketched. 3 behavioral stories written.

**Week 2 (40 hrs): Pattern Completion**

| Day | Morning (3 hrs) | Afternoon (3 hrs) | Evening (2 hrs) |
|-----|-----------------|-------------------|-----------------|
| Mon-Fri | 5-6 problems/day (problems 26-50) + re-solve weak ones | System design practice (1 design/day) | Behavioral refinement |
| Sat | Re-solve 10 hardest problems from Weeks 1-2, timed | System design: WhatsApp + Uber | Behavioral practice aloud |
| Sun | Mock interview (coding + system design) | Review and gap analysis | Rest |

Target: All 50 problems solved. 5 system designs sketched. 5 behavioral stories polished.

**Week 3 (40 hrs): Mock Interview Sprint**

| Day | Morning | Afternoon | Evening |
|-----|---------|-----------|---------|
| Mon | Mock coding interview | Re-solve weak problems (5-6) | System design review |
| Tue | System design mock (45 min) | Targeted coding practice | Behavioral mock |
| Wed | Mock coding interview | Re-solve weak problems | Company-specific research |
| Thu | System design mock | Company-tagged problems (8) | Behavioral practice |
| Fri | Mock coding interview | Company-specific system design | Full behavioral run-through |
| Sat | Full mock loop (4 rounds) | Post-loop review and gap fill | Rest |
| Sun | Light practice (3 easy problems) | System design notes review | Rest |

Target: 6+ mock interviews completed. Company-specific preparation started.

**Week 4 (30 hrs): Final Polish and Taper**

| Day | Activity | Hours |
|-----|----------|-------|
| Mon | Company-specific problems (6) + 1 system design review | 5 |
| Tue | Mock interview (target company style) + review | 4 |
| Wed | Re-solve 10 most important problems from the 50 list, timed | 4 |
| Thu | System design: re-articulate all 5 designs from memory | 3 |
| Fri | Behavioral: run through all 5 stories. Logistics preparation. | 2 |
| Sat | Light practice (3 easy problems) + rest | 2 |
| Sun | Complete rest. Early sleep. | 0 |

**Emergency Plan Reality Check:**

The 4-week plan will not make you as strong as the 12-week plan. Here is an honest assessment of your readiness after 4 weeks:

| Area | Expected Readiness | Risk |
|------|-------------------|------|
| Easy-Medium coding | Strong (80%) | Low - 50 problems cover core patterns |
| Hard coding | Moderate (50%) | Medium - limited DP and graph depth |
| System design (L4) | Adequate (65%) | Medium - 5 designs cover basics |
| System design (L5+) | Weak (40%) | High - insufficient depth and breadth |
| Behavioral | Adequate (60%) | Medium - 5 stories may not cover all LP probes |
| Go fluency | Good (70%) | Low - if you already know Go basics |

If you are targeting L5+ with only 4 weeks of preparation, consider delaying the interview by 4-8 weeks if possible. The pass rate for L5+ system design with 4 weeks of preparation is significantly lower than with 8+ weeks.


### Junior → FAANG: 4-Week Emergency Study Plan

The 4-week emergency plan is for candidates who have limited time before an interview. The focus must be ruthless: cover the minimum viable preparation set for each dimension and accept that depth will be limited. Priority order: (1) behavioral stories (you can prepare these in parallel with other activities), (2) system design fundamentals (5-6 key patterns to know cold), (3) coding patterns (the 10 most common algorithm patterns), (4) company-specific research. Skip topics that require deep learning in limited time (advanced dynamic programming, complex graph algorithms) and focus on high-frequency, high-signal topics.

### Senior @ FAANG: Emergency Plan for Senior Candidates: Risk Triage

Senior candidates using the 4-week emergency plan should do an honest risk triage at the start: which of the four interview dimensions is most likely to be the reason you do not receive an offer? For most senior candidates, the highest risk is the behavioral scope gap (stories at L4/L5 scope rather than L6) and the system design depth gap (inability to go deep on specific trade-offs under adversarial questioning). Spend 40% of your 4 weeks on behavioral story development, 40% on system design depth for your top 2-3 practice problems, and 20% on coding maintenance. Accept that you will not have comprehensive coverage and bet on doing your highest-risk areas well rather than all areas adequately.

---
