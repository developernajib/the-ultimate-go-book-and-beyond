## 83F.4 The 6-Month Balanced Plan (Working Full-Time)

Most engineers preparing for FAANG interviews are working full-time jobs. This plan requires 15-20 hours per week - roughly 2-3 hours on weekdays and 6-8 hours on weekends. The key is consistency: missing one day is recoverable. missing one week sets you back significantly due to the forgetting curve.

**Total estimated hours: 400-500**

### Plan Overview

The six months are divided into phases of increasing intensity and shifting focus: early months build foundational coding fluency, middle months layer in system design and behavioral depth, and the final month targets the specific company's style. Each phase is deliberately sequenced so that skills compound, you cannot effectively practice system design trade-offs before you can solve medium coding problems fluently, and behavioral stories only land when you have real technical wins to anchor them.

```
+-----------------------------------------------------------------------+
|                 6-MONTH BALANCED PLAN OVERVIEW                        |
+-----------------------------------------------------------------------+
|                                                                       |
|  Month 1:  FOUNDATION (15 hrs/week)                                  |
|            Go refresher + arrays, strings, hash maps                 |
|            Begin behavioral story mining                              |
|                                                                       |
|  Month 2:  INTERMEDIATE PATTERNS (15 hrs/week)                       |
|            Two pointers, sliding window, binary search               |
|            Trees, stacks, linked lists                                |
|                                                                       |
|  Month 3:  ADVANCED DSA + SYSTEM DESIGN INTRO (18 hrs/week)         |
|            DP, graphs, backtracking                                   |
|            Begin system design reading                                |
|                                                                       |
|  Month 4:  SYSTEM DESIGN + BEHAVIORAL (18 hrs/week)                  |
|            System design practice (2/week)                            |
|            Behavioral story refinement                                |
|                                                                       |
|  Month 5:  MOCK INTERVIEWS + WEAK AREAS (20 hrs/week)               |
|            2-3 mock interviews per week                               |
|            Targeted weak-area drilling                                |
|                                                                       |
|  Month 6:  COMPANY-SPECIFIC + FINAL PREP (20 hrs/week)              |
|            Target company preparation                                 |
|            Full mock loops, tapering                                  |
|                                                                       |
+-----------------------------------------------------------------------+
```

### Month 1: Foundation (15 hours/week)

**Weekday Schedule (2.5 hours/day, 5 days):**

| Time | Mon | Tue | Wed | Thu | Fri |
|------|-----|-----|-----|-----|-----|
| Evening Session 1 (1.5 hrs) | Go refresher: slices, maps, strings | 3 easy array problems | 3 easy string problems | 3 easy hash map problems | Review week's problems |
| Evening Session 2 (1 hr) | 2 easy problems (any topic) | 2 easy problems | 2 medium problems (attempt) | 2 medium problems | Write 1 behavioral story |

**Weekend Schedule (3-4 hours/day, Saturday + Sunday):**

| Time | Saturday | Sunday |
|------|----------|--------|
| Morning (2 hrs) | 5 medium problems (array/string focus) | 5 medium problems (hash map/sorting) |
| Afternoon (1.5 hrs) | Review all problems from the week, re-solve hardest 3 | Begin Chapter 80 (system design intro), write 2 behavioral stories |

**Month 1 Problem Targets (by week):**

| Week | Topics | Target Problems | Key Problems to Solve |
|------|--------|-----------------|----------------------|
| 1 | Go basics + Easy arrays | 20 easy | Two Sum, Best Time to Buy/Sell Stock, Contains Duplicate, Maximum Subarray |
| 2 | Strings + Hash Maps | 15 easy + 5 medium | Valid Anagram, Group Anagrams, Longest Substring Without Repeating Characters, Top K Frequent Elements |
| 3 | Sorting + Matrix | 10 easy + 10 medium | Merge Intervals, Sort Colors, Set Matrix Zeroes, Spiral Matrix |
| 4 | Mixed review + assessment | 5 easy + 15 medium | LRU Cache, Product of Array Except Self, timed assessment (90 min, 4 problems) |

**Month 1 Milestones:**

- [ ] 70+ problems solved (majority easy, some medium)
- [ ] Go slice/map/string operations are fluent (no docs lookup)
- [ ] Can solve easy problems in <10 min
- [ ] 4+ behavioral stories drafted
- [ ] Read system design overview (Chapter 80 Sections 1-2)

### Month 2: Intermediate Patterns (15 hours/week)

**Weekly Pattern Focus:**

| Week | Primary Pattern | Secondary Pattern | Problem Count |
|------|----------------|-------------------|---------------|
| 5 | Two Pointers | Linked Lists | 20 medium |
| 6 | Sliding Window | Stacks | 18 medium |
| 7 | Binary Search | Heaps/Priority Queues | 18 medium |
| 8 | Trees (DFS/BFS) | Recursion basics | 18 medium |

**Key problems for each week:**

**Week 5 - Two Pointers + Linked Lists:**
- 3Sum, Container With Most Water, Trapping Rain Water (stretch goal)
- Reverse Linked List, Merge Two Sorted Lists, Linked List Cycle, Remove Nth Node

**Week 6 - Sliding Window + Stacks:**
- Minimum Window Substring, Longest Repeating Character Replacement, Permutation in String
- Valid Parentheses, Min Stack, Daily Temperatures, Evaluate Reverse Polish Notation

**Week 7 - Binary Search + Heaps:**
- Search in Rotated Sorted Array, Find Minimum in Rotated Sorted Array, Koko Eating Bananas
- Kth Largest Element, Merge K Sorted Lists, Find Median from Data Stream

**Week 8 - Trees + Recursion:**
- Level Order Traversal, Validate BST, Lowest Common Ancestor, Serialize/Deserialize Binary Tree
- Subsets, Permutations, Combination Sum

**Month 2 Milestones:**

- [ ] 140+ problems solved cumulative
- [ ] Can identify patterns within 2-3 minutes for standard problems
- [ ] `container/heap` implementation from memory in Go
- [ ] Medium problems averaging <25 min
- [ ] First mock coding interview completed (weekend)
- [ ] 6+ behavioral stories drafted

### Month 3: Advanced DSA + System Design Intro (18 hours/week)

This month increases to 18 hours/week. The additional 3 hours go to system design reading and practice.

**Weekly Focus:**

| Week | DSA Focus (12 hrs) | System Design (4 hrs) | Behavioral (2 hrs) |
|------|--------------------|-----------------------|---------------------|
| 9 | Dynamic Programming 1D | Read DDIA Ch 1-4, sketch URL shortener | Story refinement |
| 10 | Dynamic Programming 2D + strings | Read DDIA Ch 5-7, sketch Twitter feed | Practice 4 stories aloud |
| 11 | Graphs (BFS/DFS, topological sort) | Sketch WhatsApp, read caching strategies | Write 2 more stories |
| 12 | Graphs (Union-Find, shortest path) + Backtracking | Sketch rate limiter, read Chapter 60 | Map stories to Amazon LPs |

**Key DP problems to master:**
- 1D: Climbing Stairs, House Robber, Coin Change, Longest Increasing Subsequence, Word Break, Decode Ways
- 2D: Unique Paths, Longest Common Subsequence, Edit Distance, Minimum Path Sum
- Knapsack: Partition Equal Subset Sum, Target Sum
- Intervals: Burst Balloons (stretch)

**Key Graph problems to master:**
- BFS/DFS: Number of Islands, Clone Graph, Pacific Atlantic Water Flow
- Topological sort: Course Schedule, Course Schedule II, Alien Dictionary
- Union-Find: Number of Connected Components, Redundant Connection, Accounts Merge
- Shortest path: Network Delay Time (Dijkstra), Cheapest Flights Within K Stops

**Month 3 Milestones:**

- [ ] 200+ problems solved cumulative
- [ ] Can solve standard DP problems (1D, knapsack, LCS) within 25 min
- [ ] Graph traversal and topological sort are fluent
- [ ] Union-Find implementation from memory in Go
- [ ] 4 system design sketches completed
- [ ] 10+ behavioral stories in STAR format
- [ ] 2+ mock coding interviews completed

### Month 4: System Design + Behavioral (18 hours/week)

The ratio shifts: system design and behavioral take center stage while coding shifts to maintenance mode.

**Weekly Schedule:**

| Day | Weekday (2.5 hrs) | Weekend (4 hrs/day) |
|-----|--------------------|--------------------|
| Mon | 4 coding problems (mixed medium-hard) | |
| Tue | 1 system design practice (45 min) + review | |
| Wed | 4 coding problems (weak areas) | |
| Thu | Behavioral practice (stories, timed) + 2 problems | |
| Fri | 1 system design practice + 2 problems | |
| Sat | | Full system design practice (2 designs) + 4 coding problems |
| Sun | | Mock interview (1 coding + 1 system design) + behavioral practice |

**System design topics for Month 4 (2 per week, 8 total):**

| Week | Design 1 | Design 2 |
|------|----------|----------|
| 13 | YouTube/Video Streaming | Notification System (Chapter 61) |
| 14 | Uber/Ride Sharing | Distributed Cache (Chapter 62) |
| 15 | Google Search | Message Queue (Chapter 63) |
| 16 | E-Commerce Platform | Web Crawler |

**Month 4 Milestones:**

- [ ] 240+ problems solved cumulative
- [ ] Can articulate 8+ system designs in 45 minutes
- [ ] Capacity estimation is quick and accurate
- [ ] 12+ behavioral stories polished
- [ ] 4+ mock interviews completed (cumulative)
- [ ] Coding maintained: medium problems <20 min

### Month 5: Mock Interviews + Weak Areas (20 hours/week)

Increase to 20 hours/week. Primary focus: mock interviews and targeted weakness elimination.

**Weekly Schedule:**

| Activity | Hours/Week |
|----------|------------|
| Mock interviews (2-3 full mocks, including setup and review) | 6 |
| Targeted coding practice (weak patterns only) | 6 |
| System design review and practice | 4 |
| Behavioral practice | 2 |
| Review and planning | 2 |

**Mock Interview Cadence:**

| Week | Mocks | Focus |
|------|-------|-------|
| 17 | 2 coding + 1 system design | General readiness assessment |
| 18 | 2 coding + 1 behavioral | Behavioral delivery under pressure |
| 19 | 1 coding + 1 system design + 1 behavioral | Balanced assessment |
| 20 | Full mock loop (4 rounds in one day) | Endurance and stamina |

**Weak Area Identification Protocol:**

After every mock interview, score yourself on a 1-5 scale for each dimension. Track scores over time. Any dimension that scores below 3 twice in a row becomes your priority focus for the next 3 days.

| Dimension | Mock 1 | Mock 2 | Mock 3 | Mock 4 | Trend |
|-----------|--------|--------|--------|--------|-------|
| Pattern recognition | | | | | |
| Code quality | | | | | |
| Time management | | | | | |
| Communication | | | | | |
| Edge case handling | | | | | |
| System design structure | | | | | |
| Capacity estimation | | | | | |
| Trade-off articulation | | | | | |
| Behavioral story depth | | | | | |
| Composure under pressure | | | | | |

**Month 5 Milestones:**

- [ ] 280+ problems solved cumulative
- [ ] 10+ mock interviews completed (cumulative)
- [ ] Mock interview scores consistently 3+ on all dimensions
- [ ] No weak areas scoring below 3 in last 3 mocks
- [ ] System design articulation is smooth (no major gaps)
- [ ] Behavioral stories are natural (no scripted feeling)

### Month 6: Company-Specific + Final Prep (20 hours/week)

**Weeks 21-22: Company-Specific Preparation**

Dedicate these two weeks to your primary target company. Use the company-specific tracks in Section 83F.6 and Chapter 83B.

| Activity | Hours/Week |
|----------|------------|
| Company-specific coding problems (tagged on LeetCode) | 6 |
| Company-specific system design emphasis | 4 |
| Company-specific behavioral preparation | 4 |
| Full mock interviews (company style) | 4 |
| Review and planning | 2 |

**Weeks 23-24: Final Sprint and Taper**

Week 23: Reduced volume. 5 problems/day (easy-medium only). 1 system design review. 1 mock interview. Focus on confidence, not new learning.

Week 24: Interview week taper. See Week 12 of the Intensive Plan for the exact schedule. Key principle: rest and confidence are more valuable than one more solved problem.

**Month 6 Milestones:**

- [ ] 300+ problems solved cumulative
- [ ] Deep familiarity with target company's interview style
- [ ] All system designs can be articulated from memory
- [ ] All behavioral stories mapped to target company's values/principles
- [ ] Full mock loop completed at company-specific difficulty
- [ ] Logistics planned and confirmed
- [ ] Well-rested and confident

### Balancing Work + Prep Without Burnout

**The non-negotiable rules:**

1. **Sleep 7-8 hours every night.** Sleep deprivation destroys the memory consolidation that makes practice effective. Studying for 3 hours on 6 hours of sleep is less effective than studying for 2 hours on 8 hours of sleep.

2. **Take one full day off per week.** The 6-month plan builds in Sunday afternoon rest or a full Saturday off. Respect this. Burnout at Month 4 makes Months 5-6 useless.

3. **Morning practice is better than evening practice.** If your schedule allows, wake up 1.5 hours early to practice before work. Your brain is fresher and problems solved in the morning are retained better.

4. **Tell your family/partner your plan.** The 6-month commitment affects them too. Set expectations, schedule quality time, and ask for support.

5. **Reduce other commitments.** Decline non-essential social events during months 3-6. This is temporary. You are investing in a career change that will pay dividends for years.

**When you fall behind schedule:**

- Behind by 1 week: Extend the current phase by 1 week, compress the final sprint slightly.
- Behind by 2 weeks: Extend total timeline by 2 weeks. Do not try to compress and catch up - that causes burnout.
- Behind by 1 month: Reassess. Either extend to 7 months or recalibrate your target (e.g., target L4 instead of L5).
- Feeling burned out: Take 3-5 days completely off. No studying, no LeetCode, no system design reading. Return to the plan at 80% volume for 1 week before ramping back up.


### Junior → FAANG: 6-Month Balanced Study Plan for Working Engineers

The 6-month balanced plan is designed for candidates who are preparing while working full-time and can commit 1-2 hours per day, 5-6 days per week. The pacing is slower and more sustainable. Months 1-2 cover algorithmic patterns at a pace of 1-2 problems per day. Months 3-4 add system design preparation at 2-3 sessions per week. Months 5-6 shift focus to mock interviews, behavioral preparation, and company-specific research. The key discipline is consistency over intensity: 1 hour per day for 6 months produces better results than 8 hours per day for 2 weeks.

### Senior @ FAANG: 6-Month Plan as a Senior Career Investment

Senior candidates using the 6-month plan should treat it as a career investment rather than interview preparation. The skills being developed (distributed systems depth, behavioral storytelling at organizational scope, structured trade-off analysis) are valuable independent of whether you receive an offer at any specific company. This framing reduces anxiety and enables a more patient, thorough approach. The 6-month timeline also provides room for setbacks: a preparation gap of 2-3 weeks due to a demanding work project or a personal obligation can be absorbed without derailing the plan. Build in explicit buffer weeks (no scheduled preparation) every 6-8 weeks to allow recovery and avoid burnout.

---
