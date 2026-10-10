## 83F.3 The 12-Week Intensive Plan (Full-Time Preparation)

This plan assumes 8-10 hours of focused preparation per day, 6 days per week. It is designed for engineers who have left their previous job to prepare full-time, or who have a significant gap between jobs. If you are working full-time, use the 6-Month Plan in Section 83F.4 instead.

**Total estimated hours: 500-600**

### Plan Overview

This section provides a conceptual foundation for Plan Overview, establishing the terminology and mental model needed to understand the implementation details that follow.
```
+-----------------------------------------------------------------------+
|               12-WEEK INTENSIVE PLAN OVERVIEW                         |
+-----------------------------------------------------------------------+
|                                                                       |
|  Weeks 1-2:  FOUNDATION RESET                                        |
|              Arrays, strings, hash maps, sorting                      |
|              Go refresher, coding mechanics                           |
|              Target: 12-15 problems/day                               |
|                                                                       |
|  Weeks 3-4:  CORE PATTERNS                                           |
|              Two pointers, sliding window, binary search              |
|              Trees, BFS/DFS, recursion                                |
|              Target: 10-12 problems/day                               |
|                                                                       |
|  Weeks 5-6:  ADVANCED DSA                                            |
|              Dynamic programming, graphs, backtracking                |
|              Target: 8-10 problems/day                                |
|                                                                       |
|  Weeks 7-8:  SYSTEM DESIGN DEEP DIVE                                 |
|              2 full designs/day + 5 coding problems/day               |
|              Capacity estimation, database selection                  |
|                                                                       |
|  Weeks 9-10: MOCK INTERVIEW SPRINT                                   |
|              2 full mocks/day, targeted weak-area practice            |
|              Behavioral story refinement                              |
|                                                                       |
|  Week 11:    COMPANY-SPECIFIC PREP                                   |
|              Tailored to your target company                          |
|                                                                       |
|  Week 12:    FINAL SPRINT                                            |
|              Light practice, full mock loops, rest                    |
|                                                                       |
+-----------------------------------------------------------------------+
```

### Week 1-2: Foundation Reset

The goal of these two weeks is to rebuild your algorithmic fundamentals to automatic fluency. Even experienced engineers benefit from this reset because interview coding requires a different speed and style than production coding. You need to solve easy problems in under 10 minutes and medium problems in under 20 minutes - and that speed comes only from repetition.

**Go focus for Weeks 1-2:** Ensure you can write the following without hesitation or documentation lookup. Reference Parts 1-2 of this book as needed.

```go
// Slice operations you must know cold
nums := make([]int, 0, capacity)     // pre-allocated slice
nums = append(nums, val)              // append
copy(dst, src)                        // copy
nums = nums[:len(nums)-1]            // pop last element
slices.Sort(nums)                     // sort integers
slices.SortFunc(nums, func(a, b int) int { return cmp.Compare(a, b) })

// Map operations
m := make(map[string]int)
m[key] = value
val, ok := m[key]                    // comma-ok idiom
delete(m, key)
for k, v := range m { _ = k; _ = v } // iteration (random order)

// String operations
var sb strings.Builder               // efficient string building
sb.WriteByte(ch)
sb.WriteString(s)
result := sb.String()
chars := []byte(s)                   // mutable string operations
runes := []rune(s)                   // Unicode-safe operations

// Stack (using slice)
stack := []int{}
stack = append(stack, val)           // push
top := stack[len(stack)-1]           // peek
stack = stack[:len(stack)-1]         // pop

// Queue (using slice - for interviews, not production)
queue := []int{startVal}
front := queue[0]                    // peek
queue = queue[1:]                    // dequeue
queue = append(queue, val)           // enqueue
```

**Week 1 - Day by Day:**

| Day | Morning (2.5 hrs) | Midday (2 hrs) | Afternoon (2.5 hrs) | Evening (1 hr) |
|-----|-------------------|-----------------|---------------------|----------------|
| **Mon** | Go refresher: slices, maps, strings (Part 1-2 review) | **Arrays:** Two Sum, Best Time to Buy/Sell Stock, Contains Duplicate, Product of Array Except Self | **Arrays continued:** Maximum Subarray (Kadane's), Merge Intervals, Insert Interval | Write 2 behavioral stories (Chapter 81 story mining) |
| **Tue** | Review yesterday's solutions, re-solve any you struggled with | **Strings:** Valid Anagram, Group Anagrams, Longest Substring Without Repeating Chars, Valid Palindrome | **Strings continued:** Longest Palindromic Substring, Minimum Window Substring (stretch), String to Integer (atoi) | Practice telling 1 behavioral story aloud, 3 min max |
| **Wed** | Review + re-solve 3 problems from Mon-Tue | **Hash Maps:** Two Sum (re-solve for speed), Ransom Note, Isomorphic Strings, Word Pattern | **Hash Maps:** LRU Cache (medium-hard), Top K Frequent Elements, Subarray Sum Equals K | Read Chapter 80 introduction (system design overview) |
| **Thu** | Review + re-solve 3 hardest problems from week | **Sorting:** Merge Sort implementation in Go, Sort Colors, Kth Largest Element, Merge Intervals (re-solve) | **Sorting:** Meeting Rooms, Meeting Rooms II, Sort Characters by Frequency | Write 2 more behavioral stories |
| **Fri** | Timed practice: 3 easy problems in 30 min total | **Mixed practice:** 5 random medium problems from Mon-Thu topics | **Review session:** Create cheat sheet of patterns learned, Go idioms used | Read 1 system design case study (Chapter 80 or Chapter 64) |
| **Sat** | Full timed diagnostic: 2 easy + 2 medium in 60 min | **Weak area practice:** Re-solve problems you scored <3 on | **Behavioral:** Practice 4 stories with timer, refine based on recording | Rest afternoon / light reading |

**Week 2 - Day by Day:**

| Day | Morning (2.5 hrs) | Midday (2 hrs) | Afternoon (2.5 hrs) | Evening (1 hr) |
|-----|-------------------|-----------------|---------------------|----------------|
| **Mon** | **Linked Lists:** Reverse Linked List, Merge Two Sorted Lists, Linked List Cycle, Remove Nth Node From End | **Linked Lists:** Reorder List, Add Two Numbers, Copy List with Random Pointer | Review Go `container/list` package, practice implementing custom linked list | Behavioral story #5-6 |
| **Tue** | **Stacks:** Valid Parentheses, Min Stack, Evaluate Reverse Polish Notation, Daily Temperatures | **Stacks + Queues:** Implement Queue Using Stacks, Implement Stack Using Queues, Sliding Window Maximum | Go pattern: stack with `[]int{}` slice, practice clean stack operations | Read Chapter 68 (Stacks and Queues) for depth |
| **Wed** | **Matrix:** Set Matrix Zeroes, Spiral Matrix, Rotate Image, Search a 2D Matrix | **Matrix:** Word Search, Game of Life | Review all Week 1-2 patterns, create pattern recognition guide | Behavioral story practice (pick weakest 2, refine) |
| **Thu** | **Mixed review:** 8 problems from Weeks 1-2, timed 20 min each | **Implement from scratch:** Hash map, stack, queue, linked list - all in Go without any imports | Speed drill: re-solve 5 easy problems targeting <7 min each | System design: read about load balancers and CDNs |
| **Fri** | Timed assessment: 1 easy + 2 mediums + 1 medium-hard in 90 min | **Review and gap analysis:** Which patterns feel automatic? Which still require thought? | Create Week 3-4 focus list based on weaknesses found | Rest evening |
| **Sat** | **Comprehensive review:** Re-solve the 5 hardest problems from Weeks 1-2 | Mock coding interview: have a friend or use Pramp/interviewing.io for 45 min session | **Post-mock analysis:** Score yourself, identify top 3 weaknesses | Plan Week 3 focus areas |

**Week 1-2 Milestone Checklist:**

- [ ] Solved 80+ problems (mix of easy and medium)
- [ ] Can solve easy problems in <10 minutes consistently
- [ ] Can solve medium array/string/hash map problems in <20 minutes
- [ ] Go slice, map, and string operations are automatic (no documentation lookup)
- [ ] 6+ behavioral stories written in STAR format
- [ ] Practiced telling at least 3 stories aloud
- [ ] Read system design overview (Chapter 80 Sections 1-2)
- [ ] Completed 1 mock coding interview

### Week 3-4: Core Patterns

These two weeks introduce the patterns that appear most frequently in FAANG interviews. The shift from Week 1-2: you are no longer just solving problems - you are recognizing which pattern applies and executing it. Every problem you encounter should trigger pattern recognition: "This is a sliding window problem" or "This needs two pointers from both ends."

**Go focus for Weeks 3-4:** Master `container/heap` for priority queues and custom sort functions. These appear in 20-30% of FAANG coding interviews.

```go
// Priority queue using container/heap (Chapter 71)
type MinHeap []int

func (h MinHeap) Len() int           { return len(h) }
func (h MinHeap) Less(i, j int) bool { return h[i] < h[j] }
func (h MinHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *MinHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *MinHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}

// Custom sort for pairs/structs
type Interval struct{ Start, End int }

// Usage in interview
func demonstrateHeapAndSort() {
	h := &MinHeap{}
	heap.Init(h)
	heap.Push(h, 5)
	min := heap.Pop(h).(int)
	_ = min

	intervals := []Interval{{1, 3}, {2, 6}, {8, 10}}
	slices.SortFunc(intervals, func(a, b Interval) int {
		return cmp.Compare(a.Start, b.Start)
	})
}
```

**Week 3 - Day by Day:**

| Day | Morning (2.5 hrs) | Midday (2 hrs) | Afternoon (2.5 hrs) | Evening (1 hr) |
|-----|-------------------|-----------------|---------------------|----------------|
| **Mon** | **Two Pointers pattern study** (Chapter 66): theory + 3Sum, Container With Most Water, Trapping Rain Water | **Two Pointers:** Remove Duplicates from Sorted Array, Move Zeroes, Sort Colors (Dutch National Flag) | **Two Pointers advanced:** 4Sum, Minimum Size Subarray Sum | System design reading: Chapter 80 Section on capacity estimation |
| **Tue** | Review two-pointer solutions, re-solve Trapping Rain Water cold | **Sliding Window** (Chapter 66/78b): Longest Substring Without Repeating Chars (re-solve), Minimum Window Substring, Sliding Window Maximum | **Sliding Window:** Longest Repeating Character Replacement, Permutation in String, Find All Anagrams | Behavioral: map 3 stories to Amazon Leadership Principles |
| **Wed** | **Binary Search** (Chapter 77): theory + Binary Search, Search in Rotated Sorted Array, Find Minimum in Rotated Array | **Binary Search:** Search a 2D Matrix, Koko Eating Bananas, Median of Two Sorted Arrays (hard) | **Binary Search on answer:** Split Array Largest Sum, Capacity to Ship Packages, Magnetic Force Between Two Balls | System design: sketch URL shortener design (45 min timed) |
| **Thu** | Review all patterns so far, practice pattern recognition | **Trees intro** (Chapter 70): Invert Binary Tree, Maximum Depth, Same Tree, Subtree of Another Tree | **Trees DFS:** Validate BST, Kth Smallest in BST, Lowest Common Ancestor | Behavioral: refine stories #7-8 |
| **Fri** | **Trees BFS** (Chapter 70): Level Order Traversal, Zigzag Level Order, Right Side View | **Trees advanced:** Serialize/Deserialize Binary Tree, Binary Tree Maximum Path Sum, Construct from Preorder/Inorder | Speed drill: 5 easy tree problems in 40 min | Rest evening |
| **Sat** | **Timed practice:** 3 mediums (one two-pointer, one tree, one binary search) in 60 min | Mock coding interview (45 min) with peer or platform | **Review:** Pattern recognition drill - read 10 problem statements, identify pattern without solving | System design: read about database sharding |

**Week 4 - Day by Day:**

| Day | Morning (2.5 hrs) | Midday (2 hrs) | Afternoon (2.5 hrs) | Evening (1 hr) |
|-----|-------------------|-----------------|---------------------|----------------|
| **Mon** | **Recursion & DFS** deep dive: Permutations, Combinations, Subsets, Letter Combinations of Phone Number | **Recursion:** Combination Sum, Combination Sum II, Palindrome Partitioning | Review: write clean recursive template in Go, practice base case identification | System design: sketch Twitter feed design |
| **Tue** | **BFS deep dive:** Word Ladder, Open the Lock, Rotting Oranges, Shortest Path in Binary Matrix | **BFS + multi-source:** 01 Matrix, Walls and Gates, Pacific Atlantic Water Flow | Implement generic BFS template in Go with `[][]int` visited tracking | Behavioral: practice 2 stories with recording |
| **Wed** | **Heap/Priority Queue** (Chapter 71): Kth Largest Element (heap solution), Merge K Sorted Lists, Top K Frequent Elements (heap solution) | **Heap advanced:** Find Median from Data Stream, Reorganize String, Task Scheduler | Go `container/heap` deep practice: implement min-heap, max-heap, and custom struct heap from memory | System design reading: caching strategies |
| **Thu** | **Interval problems:** Merge Intervals (re-solve), Non-overlapping Intervals, Insert Interval (re-solve), Meeting Rooms II | **Mixed pattern practice:** 6 random mediums, identify pattern first, then solve | **Speed drill:** Re-solve 8 problems from Weeks 3-4, targeting <15 min each | Behavioral: write 2 more stories (#9-10) |
| **Fri** | **Comprehensive review:** Create master pattern cheat sheet with Go templates for each pattern | **Timed assessment:** 2 mediums + 1 hard in 75 min | **Gap analysis:** Update weak-area list, plan Week 5-6 focus | Rest |
| **Sat** | Full mock interview: 1 coding (45 min) + 1 mini system design (30 min) | **Post-mock review** and targeted practice on weakest pattern | **Behavioral mock:** Have someone ask you 5 behavioral questions, 3 min per answer | Week 3-4 retrospective |

**Week 3-4 Milestone Checklist:**

- [ ] Solved 70+ additional problems (140+ cumulative)
- [ ] Can identify which pattern applies to a problem within 2 minutes
- [ ] Two pointers, sliding window, binary search patterns are automatic
- [ ] Tree DFS/BFS patterns are fluent
- [ ] Can implement `container/heap` priority queue from memory in Go
- [ ] Completed URL shortener and Twitter feed system design sketches
- [ ] 10+ behavioral stories in STAR format
- [ ] Completed 3+ mock coding interviews (cumulative)
- [ ] Medium problems averaging <20 minutes

### Week 5-6: Advanced DSA

This is the most intellectually demanding phase. Dynamic programming, graph algorithms, and backtracking are where most candidates struggle and where the strongest differentiation occurs in interviews. Expect progress to feel slower - a hard DP problem might take 90 minutes on your first attempt. That is normal.

**Go focus for Weeks 5-6:** Practice translating recursive solutions to iterative DP. Go does not have tail call optimization, so deep recursion can stack overflow. Build muscle memory for 2D DP array initialization in Go.

```go
// 2D DP table initialization (common in DP problems)
func initDPTable(m, n int) [][]int {
	dp := make([][]int, m+1)
	for i := range dp {
		dp[i] = make([]int, n+1)
	}
	return dp
}

// Graph adjacency list (standard for BFS/DFS on graphs)
func buildAdjacencyList(edges [][]int) map[int][]int {
	adj := make(map[int][]int) // or [][]int if nodes are 0-indexed
	for _, edge := range edges {
		adj[edge[0]] = append(adj[edge[0]], edge[1])
		adj[edge[1]] = append(adj[edge[1]], edge[0]) // undirected
	}
	return adj
}

// Union-Find (Disjoint Set Union) template
type UnionFind struct {
	parent []int
	rank   []int
}

func NewUnionFind(n int) *UnionFind {
	uf := &UnionFind{
		parent: make([]int, n),
		rank:   make([]int, n),
	}
	for i := range uf.parent {
		uf.parent[i] = i
	}
	return uf
}

func (uf *UnionFind) Find(x int) int {
	if uf.parent[x] != x {
		uf.parent[x] = uf.Find(uf.parent[x]) // path compression
	}
	return uf.parent[x]
}

func (uf *UnionFind) Union(x, y int) bool {
	px, py := uf.Find(x), uf.Find(y)
	if px == py {
		return false
	}
	if uf.rank[px] < uf.rank[py] {
		px, py = py, px
	}
	uf.parent[py] = px
	if uf.rank[px] == uf.rank[py] {
		uf.rank[px]++
	}
	return true
}
```

**Week 5 - Dynamic Programming Focus:**

| Day | Morning (2.5 hrs) | Midday (2 hrs) | Afternoon (2.5 hrs) | Evening (1 hr) |
|-----|-------------------|-----------------|---------------------|----------------|
| **Mon** | **DP theory** (Chapter 73): overlapping subproblems, optimal substructure, memoization vs tabulation | **1D DP:** Climbing Stairs, House Robber, House Robber II, Decode Ways | **1D DP:** Coin Change, Longest Increasing Subsequence, Word Break | System design: read about message queues (Chapter 63) |
| **Tue** | Review yesterday's DP problems, re-solve without hints | **2D DP:** Unique Paths, Minimum Path Sum, Longest Common Subsequence | **2D DP:** Edit Distance, Interleaving String, Distinct Subsequences | Behavioral: practice 3 stories timed (90 sec each) |
| **Wed** | **DP on strings:** Longest Palindromic Subsequence, Palindrome Partitioning II, Regular Expression Matching | **DP on sequences:** Longest Increasing Subsequence (binary search optimization), Russian Doll Envelopes | **Review:** Write DP patterns cheat sheet - state definition, transition, base case for each problem type | System design: sketch a notification system |
| **Thu** | **Knapsack variants:** 0/1 Knapsack, Unbounded Knapsack, Partition Equal Subset Sum, Target Sum | **DP intervals:** Burst Balloons, Matrix Chain Multiplication, Stone Game | **Speed practice:** Re-solve 5 DP problems from the week, targeting correct state definition within 3 min | Behavioral: write failure story, practice delivery |
| **Fri** | **DP review:** Solve 3 DP problems you have not seen before (cold from LeetCode), 30 min each | **Mixed practice:** 4 problems mixing DP with earlier patterns (hash map, two pointer) | **DP timed assessment:** 1 medium + 1 hard DP in 55 min | Rest evening |
| **Sat** | Mock interview: 1 DP-focused coding round (45 min) | **Post-mock analysis** + re-solve missed problems | **System design practice:** Design a distributed cache (45 min timed) | Weekly review |

**Week 6 - Graphs, Backtracking, and Greedy:**

| Day | Morning (2.5 hrs) | Midday (2 hrs) | Afternoon (2.5 hrs) | Evening (1 hr) |
|-----|-------------------|-----------------|---------------------|----------------|
| **Mon** | **Graphs theory** (Chapter 72): representations, BFS, DFS, topological sort | **Graph BFS/DFS:** Clone Graph, Course Schedule, Course Schedule II (topological), Connected Components | **Graph advanced:** Cheapest Flights Within K Stops, Network Delay Time (Dijkstra) | System design: database selection criteria |
| **Tue** | **Union-Find:** Number of Connected Components, Redundant Connection, Accounts Merge | **Shortest path:** Dijkstra implementation in Go, Bellman-Ford overview, shortest path problems | **Graph practice:** Alien Dictionary, Reconstruct Itinerary, Critical Connections | Behavioral: Amazon LP mapping - map each story to top 5 LPs |
| **Wed** | **Backtracking** (Chapter 74): theory + N-Queens, Sudoku Solver, Restore IP Addresses | **Backtracking:** Word Search II (Trie + backtracking), Generate Parentheses (re-solve), Palindrome Partitioning | **Backtracking review:** Write generic backtracking template in Go, practice applying it | System design: read about consistency models (Chapter 64b) |
| **Thu** | **Greedy** (Chapter 75): Activity Selection, Jump Game, Jump Game II, Gas Station | **Greedy:** Partition Labels, Queue Reconstruction by Height, Non-overlapping Intervals (greedy approach) | **Mixed advanced:** 4 problems mixing graphs, DP, and greedy - identify approach first | Behavioral: refine and time all 12 stories |
| **Fri** | **Bit manipulation** (Chapter 76): Single Number, Number of 1 Bits, Counting Bits, Reverse Bits | **Trie** (Chapter 78): Implement Trie, Word Search II (re-solve), Design Add and Search Words | **Comprehensive timed drill:** 2 mediums + 1 hard from any Week 1-6 topic in 75 min | Rest |
| **Sat** | Full mock interview: 1 coding (45 min) + 1 system design (45 min) | **Post-mock review** and targeted weak-area practice | **Cumulative assessment:** 10 random problems from Weeks 1-6, score yourself | Week 5-6 retrospective, plan Weeks 7-8 |

**Week 5-6 Milestone Checklist:**

- [ ] Solved 60+ additional problems (200+ cumulative)
- [ ] Can identify DP state and transition for standard problem types
- [ ] Graph BFS/DFS, topological sort, and Union-Find are fluent
- [ ] Backtracking template is automatic
- [ ] Completed 3+ system design sketches
- [ ] 12+ behavioral stories polished and practiced
- [ ] Hard problems averaging <35 minutes (correct approach identified)
- [ ] Completed 5+ mock coding interviews (cumulative)
- [ ] Can implement Union-Find, Trie, and min-heap from memory in Go

### Week 7-8: System Design Deep Dive

The focus shifts to system design. You will maintain coding skills with 5 problems per day (down from 8-10) while dedicating the majority of your time to designing, articulating, and defending large-scale systems. This mirrors the actual interview weight at L5+ levels.

**Reference:** Chapter 80 (System Design Interviews), Chapter 60-64 (System Design implementations), Chapter 83B (Company-Specific Guide).

**Week 7 - Day by Day:**

| Day | Focus System Design | Coding Maintenance | Other |
|-----|--------------------|--------------------|-------|
| **Mon** | **ACED framework mastery** (Chapter 80): Architecture, Components, Extensibility, Deep Dive. Practice with URL shortener. | 5 medium problems (mix of topics) | Behavioral: 20 min story practice |
| **Tue** | **Design Twitter/X Feed:** fanout-on-write vs fanout-on-read, ranking, caching, notification integration | 5 medium problems | Read about real-world Twitter architecture |
| **Wed** | **Design WhatsApp:** WebSocket connections, message delivery guarantees, group messaging, E2E encryption at scale | 5 medium problems (graph focus) | System design review: rewrite Mon-Tue designs from memory |
| **Thu** | **Design YouTube:** video upload pipeline, transcoding, CDN, recommendation engine, view counting at scale | 3 medium + 2 hard problems | Behavioral: practice 4 stories with peer |
| **Fri** | **Design Uber/Lyft:** geospatial indexing, ride matching, ETA calculation, surge pricing, driver tracking | 5 medium problems (DP focus) | Review all 5 designs: can you draw each from memory? |
| **Sat** | **Capacity estimation drill:** Practice back-of-envelope calculations for all 5 designs from this week. 10 min per design. | Mock coding interview (45 min) | Full system design mock (45 min) |

**Week 8 - Day by Day:**

| Day | Focus System Design | Coding Maintenance | Other |
|-----|--------------------|--------------------|-------|
| **Mon** | **Design Rate Limiter** (Chapter 60): token bucket, sliding window, distributed rate limiting with Redis | 5 mixed problems | System design review: re-articulate 2 Week 7 designs |
| **Tue** | **Design Notification System** (Chapter 61): push vs pull, APNs/FCM integration, prioritization, delivery tracking | 5 mixed problems | Behavioral: practice conflict and failure stories |
| **Wed** | **Design Distributed Cache** (Chapter 62): consistent hashing, eviction policies, replication, cache stampede prevention | 5 mixed problems | Read: DDIA Chapter 5-6 (replication, partitioning) |
| **Thu** | **Design Message Queue** (Chapter 63): partitioning, consumer groups, exactly-once delivery, dead letter queues | 3 medium + 2 hard | Behavioral: full behavioral mock (30 min, 5 questions) |
| **Fri** | **Design Web Crawler:** politeness, URL frontier, deduplication, distributed crawling, robots.txt compliance | 5 mixed problems | Review all Week 7-8 designs from memory |
| **Sat** | **Full mock loop:** 1 coding (45 min) + 1 system design (45 min) + 1 behavioral (30 min) | Post-mock analysis and targeted practice | Compile system design cheat sheets for all 10 designs |

**System Design Articulation Framework (practice this for every design):**

```
+-----------------------------------------------------------------------+
|           45-MINUTE SYSTEM DESIGN INTERVIEW STRUCTURE                 |
+-----------------------------------------------------------------------+
|                                                                       |
|  Minutes 0-5:   REQUIREMENTS GATHERING                               |
|  ├── Functional requirements (what does the system do?)              |
|  ├── Non-functional requirements (scale, latency, availability)      |
|  ├── Clarify scope (what's in/out for this interview)                |
|  └── State your assumptions explicitly                                |
|                                                                       |
|  Minutes 5-10:  CAPACITY ESTIMATION                                  |
|  ├── Daily active users (DAU)                                        |
|  ├── QPS (queries per second) for read/write                         |
|  ├── Storage requirements (per day, per year)                        |
|  └── Bandwidth requirements                                          |
|                                                                       |
|  Minutes 10-15: HIGH-LEVEL DESIGN                                    |
|  ├── Draw major components (clients, servers, databases)             |
|  ├── Show data flow between components                               |
|  └── Identify the 2-3 core APIs                                      |
|                                                                       |
|  Minutes 15-30: DETAILED COMPONENT DESIGN                            |
|  ├── Database schema and data store selection                        |
|  ├── Detailed API design with request/response formats               |
|  ├── Caching strategy                                                 |
|  ├── Key algorithms (ranking, matching, routing)                     |
|  └── Data partitioning / sharding strategy                           |
|                                                                       |
|  Minutes 30-40: SCALABILITY & RELIABILITY                            |
|  ├── How to handle 10x, 100x scale                                   |
|  ├── Single points of failure and mitigation                         |
|  ├── Consistency vs availability trade-offs                           |
|  └── Monitoring, alerting, observability                             |
|                                                                       |
|  Minutes 40-45: WRAP-UP & QUESTIONS                                  |
|  ├── Summarize key design decisions                                   |
|  ├── Discuss what you would do differently with more time            |
|  └── Answer interviewer follow-up questions                          |
|                                                                       |
+-----------------------------------------------------------------------+
```

**Week 7-8 Milestone Checklist:**

- [ ] Can articulate 10 complete system designs from memory (45 min each)
- [ ] Capacity estimation is quick and accurate (back-of-envelope in <5 min)
- [ ] Can discuss database selection trade-offs (SQL vs NoSQL vs NewSQL)
- [ ] Understand caching strategies (cache-aside, write-through, write-behind)
- [ ] Can discuss consistency models (strong, eventual, causal)
- [ ] Coding skills maintained: medium problems still <20 min
- [ ] 250+ problems solved cumulative
- [ ] Completed 7+ mock interviews (cumulative)

### Week 9-10: Mock Interview Sprint

This is where preparation meets performance. The primary activity is simulated interviews - 2 per day, covering all three types (coding, system design, behavioral). The secondary activity is targeted practice on weaknesses revealed by mock interviews.

**Week 9 Daily Schedule:**

| Time | Activity |
|------|----------|
| 7:00-7:30 | Review yesterday's mock interview mistakes |
| 7:30-8:15 | **Mock Interview 1: Coding** (45 min, use Pramp/interviewing.io/peer) |
| 8:15-9:00 | Post-mock analysis: re-solve problem optimally, note communication gaps |
| 9:00-9:30 | Break |
| 9:30-11:00 | Targeted practice on weak area identified in mock (3-4 problems) |
| 11:00-11:45 | **Mock Interview 2: System Design** (45 min) |
| 11:45-12:30 | Post-mock analysis: refine design, practice articulation |
| 12:30-13:30 | Lunch + behavioral story review |
| 13:30-15:00 | Coding practice: 5 medium-hard problems, timed |
| 15:00-15:30 | Break |
| 15:30-16:30 | System design review: re-articulate today's design from memory |
| 16:30-17:00 | Behavioral story practice: 3 stories, timed 90 sec each |
| 17:00-17:30 | Plan tomorrow, update progress tracker |

**Week 10 Schedule:** Same structure as Week 9 but replace one daily coding mock with a behavioral mock every other day.

| Day | Mock 1 | Mock 2 | Focus Area |
|-----|--------|--------|------------|
| Mon | Coding | System Design | Usual routine |
| Tue | Coding | Behavioral | LP story delivery |
| Wed | Coding | System Design | Weak system design topic |
| Thu | Behavioral | Coding | Conflict/failure stories |
| Fri | Coding | System Design | Target company design style |
| Sat | **Full mock loop** - 4 rounds in sequence simulating onsite | | Endurance and composure practice |

**Mock Interview Quality Checklist (score yourself after every mock):**

| Dimension | 1 (Poor) | 3 (Acceptable) | 5 (Strong) |
|-----------|----------|-----------------|------------|
| Clarified requirements before coding | | | |
| Identified optimal approach within 5 min | | | |
| Communicated thought process throughout | | | |
| Wrote clean, compilable Go code | | | |
| Tested solution with examples and edge cases | | | |
| Discussed time/space complexity accurately | | | |
| Handled being stuck gracefully | | | |
| Managed time well (finished within limit) | | | |

**Week 9-10 Milestone Checklist:**

- [ ] Completed 20+ mock interviews across all types
- [ ] Mock coding scores consistently 3+ on all dimensions
- [ ] System design articulation is smooth and structured
- [ ] Can deliver 12 behavioral stories without notes
- [ ] Identified and addressed top 3 weaknesses
- [ ] Comfortable with the pressure of timed performance
- [ ] 280+ problems solved cumulative

### Week 11: Company-Specific Preparation

Dedicate this entire week to your primary target company. If you are interviewing at multiple companies, split the week proportionally.

**Google Week:**

| Day | Focus |
|-----|-------|
| Mon | Google-specific coding patterns: emphasis on optimization to theoretical lower bound, string/array manipulation, Google Docs coding (no IDE). Solve 8 Google-tagged problems on LeetCode. |
| Tue | Google system design: emphasis on scalability, data pipelines, ML infrastructure. Practice 2 Google-style designs (design Google Search, design Google Maps navigation). |
| Wed | Googleyness & Leadership: practice answering "Tell me about a time you helped a team succeed" and "Tell me about a time you took a risk that failed." Review Google cultural values. |
| Thu | Full Google mock loop: phone screen (45 min) + 2 coding + 1 system design + 1 G&L. |
| Fri | Review Google mock, targeted practice on weakest area. Research your target team (if team matching pre-interview). |
| Sat | Light practice (5 easy-medium problems), review all Google-specific notes, rest. |

**Meta Week:**

| Day | Focus |
|-----|-------|
| Mon | Meta coding style: speed over perfection, working code first then optimize. Solve 8 Meta-tagged problems. Practice coding fast. |
| Tue | Meta system design: real-time systems (News Feed, Messenger, Instagram Stories). Practice 2 Meta-style designs. Product sense integration. |
| Wed | Meta behavioral: "Move Fast" culture, direct feedback, building community. Practice 5 Meta-aligned stories. |
| Thu | Full Meta mock loop: coding (45 min) + coding (45 min) + system design (45 min) + behavioral (30 min). |
| Fri | Review mock, targeted practice. Research Meta's current products and engineering blog posts. |
| Sat | Light practice, rest. |

**Amazon Week:**

| Day | Focus |
|-----|-------|
| Mon | Amazon coding with LP integration: practice explaining your approach using Customer Obsession, Ownership, Bias for Action. Solve 8 Amazon-tagged problems. |
| Tue | Amazon system design: emphasis on practical, working systems. Practice 2 designs (design Amazon Order System, design Alexa voice processing). |
| Wed | **Leadership Principles deep dive** (Chapter 81): Map each of your 12+ stories to specific LPs. Practice the "tell me about a time..." format with LP probing follow-ups. |
| Thu | Full Amazon mock loop: coding + LP (45 min) + coding + LP (45 min) + system design (45 min) + Bar Raiser behavioral (45 min). |
| Fri | Review mock. Practice the 5 most-tested LPs: Customer Obsession, Ownership, Bias for Action, Deliver Results, Dive Deep. |
| Sat | Light practice, rest. |

### Week 12: Final Sprint

This is the taper week. Like an athlete before a marathon, you reduce volume while maintaining sharpness. Over-practicing in the final week leads to fatigue, not improvement.

**Week 12 - Day by Day:**

| Day | Activity | Duration | Notes |
|-----|----------|----------|-------|
| **Mon** | 5 easy-medium coding problems | 3 hrs | Confidence building, not new learning |
| | System design review: sketch 3 designs from memory | 2 hrs | No new designs - refine existing ones |
| | Behavioral: run through all 12 stories once | 1 hr | Polish, do not rewrite |
| **Tue** | **Full mock interview loop** (4-5 rounds in one day) | 5 hrs | Simulate actual onsite experience |
| | Post-loop review: identify any final gaps | 1 hr | |
| **Wed** | Targeted practice on any gaps from Tuesday mock | 3 hrs | Small, focused improvements |
| | Prepare interview logistics: travel, clothing, equipment | 1 hr | |
| | Light coding: 3 easy problems for confidence | 1 hr | |
| **Thu** | Morning: review pattern cheat sheets and system design notes | 2 hrs | Quick refresher, not deep study |
| | Afternoon: REST | 4 hrs | Walk, exercise, non-screen time |
| | Evening: prepare questions to ask your interviewers | 30 min | |
| **Fri** | **If interview is Monday:** Complete rest day. Light exercise, good food, early sleep. | | |
| | **If interview is later:** 3 easy problems + 1 system design sketch | 2 hrs max | |
| **Sat** | Rest day regardless of interview timing | | Good sleep is worth more than one more problem |

**Pre-Interview Logistics Checklist:**

- [ ] Interview schedule confirmed (times, format, interviewer names if available)
- [ ] Technical setup tested (camera, microphone, internet, IDE if allowed, backup plan)
- [ ] Quiet environment secured for the full interview day
- [ ] Phone charged, notifications silenced
- [ ] Water, snacks, and meals planned (do not interview hungry)
- [ ] Professional but comfortable clothing prepared
- [ ] Questions for interviewers prepared (2-3 genuine questions per round)
- [ ] Emergency contact information for recruiter saved
- [ ] Sleep schedule adjusted (8 hours minimum the night before)
- [ ] Morning routine planned (exercise, shower, breakfast - no last-minute cramming)

### Daily Schedule Template (Intensive Plan)

For any day during Weeks 1-10 where a specific schedule is not provided above, use this default template:

```
+-----------------------------------------------------------------------+
|             INTENSIVE PLAN - DEFAULT DAILY SCHEDULE                   |
+-----------------------------------------------------------------------+
|                                                                       |
|  07:00 - 07:30  Morning review: re-solve yesterday's hardest         |
|                  problem from memory                                  |
|                                                                       |
|  07:30 - 09:30  CODING SESSION 1 (focused pattern practice)          |
|                  4-5 problems targeting today's pattern               |
|                                                                       |
|  09:30 - 10:00  Break: walk, stretch, hydrate                        |
|                                                                       |
|  10:00 - 12:00  CODING SESSION 2 or SYSTEM DESIGN                    |
|                  Weeks 1-6: coding (3-4 more problems)               |
|                  Weeks 7+: system design (1 full design, 45 min)     |
|                                                                       |
|  12:00 - 13:00  Lunch + behavioral story practice (1-2 stories)      |
|                                                                       |
|  13:00 - 15:00  AFTERNOON SESSION (weak areas or new material)       |
|                  Target whatever your diagnostic flagged              |
|                                                                       |
|  15:00 - 15:30  Break: exercise or short walk                        |
|                                                                       |
|  15:30 - 17:00  MOCK INTERVIEW or TIMED PRACTICE                    |
|                  Full mock 2-3x/week, timed drill otherwise          |
|                                                                       |
|  17:00 - 18:00  REVIEW AND PLAN                                      |
|                  Review all problems from today                       |
|                  Update progress tracker                              |
|                  Plan tomorrow's focus areas                          |
|                                                                       |
|  18:00+          Rest. Do not study. Protect sleep.                   |
|                                                                       |
+-----------------------------------------------------------------------+
```


### Junior → FAANG: 12-Week Intensive Study Plan Basics

The 12-week intensive plan is designed for candidates who can dedicate 4-6 hours per day to preparation. The structure: weeks 1-3 cover algorithmic fundamentals (arrays, strings, trees, graphs, dynamic programming). Weeks 4-6 cover system design fundamentals (load balancing, caching, databases, message queues). Weeks 7-9 add behavioral preparation and company-specific research. Weeks 10-12 are mock interviews, refinement, and final preparation. The most important rule: do not skip the behavioral and company-specific weeks. They are as important as the technical weeks.

### Senior @ FAANG: 12-Week Plan for Senior Candidates: Accelerated Depth

For senior candidates using the 12-week intensive plan, the week-by-week structure needs adaptation. Weeks 1-3 should focus on algorithmic maintenance (2-3 problems per day, not 6-8) rather than fundamentals, because the fundamentals are already known. The freed time goes to system design depth: distributed systems theory (consistency models, consensus protocols, distributed transactions), company-specific architecture deep-dives (reading engineering blog posts and academic papers from target companies), and LLD practice. Weeks 7-9 should allocate more time to behavioral preparation than the standard plan, because the L6 behavioral story bank requires significant investment to develop at the right scope. The mock interview weeks should include at least two L6-specific mocks with calibrated feedback, not just standard mocks.

---
