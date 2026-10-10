## 83F.2 Self-Assessment: Where Are You Starting From?

Before selecting a study plan, you need an honest assessment of your current readiness. Skipping this step leads to wasted time - either repeating topics you already know or jumping into advanced material before the foundations are solid.

### Diagnostic Coding Assessment

Set aside 3.5 hours of uninterrupted time. Use a plain text editor (not an IDE with autocomplete). Time each problem individually. Do not look up any solutions.

**Easy Problems (10 minutes each):**

| # | Problem | Key Pattern | Reference |
|---|---------|-------------|-----------|
| 1 | Two Sum | Hash map lookup | Chapter 69 |
| 2 | Valid Parentheses | Stack | Chapter 68 |
| 3 | Merge Two Sorted Lists | Linked list + two pointers | Chapter 67 |

**Medium Problems (20 minutes each):**

| # | Problem | Key Pattern | Reference |
|---|---------|-------------|-----------|
| 4 | 3Sum | Two pointers + sorting | Chapter 66 |
| 5 | Binary Tree Level Order Traversal | BFS + queue | Chapter 70 |
| 6 | Coin Change | Dynamic programming | Chapter 73 |
| 7 | Number of Islands | Graph BFS/DFS | Chapter 72 |

**Hard Problems (35 minutes each):**

| # | Problem | Key Pattern | Reference |
|---|---------|-------------|-----------|
| 8 | Merge K Sorted Lists | Heap (priority queue) | Chapter 71 |
| 9 | Word Ladder | BFS + graph construction | Chapter 72 |
| 10 | Longest Increasing Subsequence (LIS) | DP with binary search optimization | Chapter 73 |

**Scoring rubric:**

| Result | Points |
|--------|--------|
| Solved optimally within time limit | 3 |
| Solved with correct but suboptimal approach within time limit | 2 |
| Solved but exceeded time limit | 1 |
| Could not solve or incorrect solution | 0 |

**Score interpretation (out of 30):**

| Score | Level | Recommended Plan |
|-------|-------|-----------------|
| 0-8 | Beginner | 6-Month Plan or 9-Month Career Switcher Plan |
| 9-15 | Developing | 6-Month Plan starting at Month 2 |
| 16-21 | Intermediate | 12-Week Intensive Plan |
| 22-26 | Advanced | 12-Week Plan starting at Week 5, or 4-Week Emergency Plan |
| 27-30 | Ready | 4-Week Emergency Plan (polish and practice) |

### System Design Diagnostic

Spend 45 minutes on each problem. Write or sketch your design on paper or a whiteboard.

**Problem 1 (L4-L5):** Design a URL shortener like TinyURL. Requirements: 100M new URLs/day, 10:1 read-to-write ratio, URLs expire after configurable TTL.

**Problem 2 (L5-L6):** Design a real-time chat system like WhatsApp. Requirements: 500M daily active users, 1:1 and group chats, message delivery guarantees, end-to-end encryption.

**System design scoring (per problem, out of 15):**

| Area | Points | Criteria |
|------|--------|----------|
| Requirements clarification | 0-2 | Did you ask about scale, users, features, constraints? |
| Capacity estimation | 0-2 | Did you estimate QPS, storage, bandwidth? |
| High-level design | 0-3 | Clear component diagram with data flow? |
| Database design | 0-2 | Appropriate schema, data store selection with rationale? |
| Scalability | 0-3 | Sharding, caching, load balancing, CDN? |
| Trade-offs | 0-3 | Consistency vs availability, latency vs throughput? |

**Score interpretation (out of 30):**

| Score | System Design Readiness |
|-------|------------------------|
| 0-8 | Need fundamental study (start Chapter 80 from scratch) |
| 9-15 | Foundations present, need structured practice |
| 16-22 | Competent, focus on depth and articulation |
| 23-30 | Strong, focus on advanced topics and speed |

### Behavioral Readiness Check

Answer these questions honestly:

| Question | Yes/No |
|----------|--------|
| Can you tell 3 stories about technical challenges you solved? | |
| Can you tell 2 stories about conflicts with teammates? | |
| Can you tell 2 stories about projects that failed? | |
| Can you tell 2 stories about leadership or mentoring? | |
| Can you tell 2 stories about going above and beyond? | |
| Can you quantify the impact of at least 5 stories with numbers? | |
| Have you practiced telling any of these stories out loud? | |
| Can you map your stories to Amazon's Leadership Principles? | |

Score: Count your "Yes" answers.

| Score | Behavioral Readiness |
|-------|---------------------|
| 0-2 | Critical gap - behavioral prep needed immediately (Chapter 81) |
| 3-5 | Stories exist but need refinement and practice |
| 6-7 | Good foundation, need company-specific mapping |
| 8 | Ready for mock behavioral interviews |

### Go Proficiency Self-Assessment

Rate yourself 1-5 on each topic:

| Topic | 1 (Never used) | 3 (Can use with docs) | 5 (Expert, no docs needed) |
|-------|-----------------|----------------------|---------------------------|
| Slices: creation, append, copy, slicing | | | |
| Maps: creation, iteration, deletion, comma-ok | | | |
| Structs and methods (value vs pointer receivers) | | | |
| Interfaces (implicit satisfaction, type assertions) | | | |
| Error handling (custom errors, wrapping, Is/As) | | | |
| Goroutines and channels (send, receive, select) | | | |
| sync package (Mutex, WaitGroup, Once, Map) | | | |
| context package (WithCancel, WithTimeout, Values) | | | |
| container/heap (implementing heap.Interface) | | | |
| sort/slices (SortFunc, custom comparators) | | | |
| strings (Builder, manipulation, conversion) | | | |
| Testing (table-driven tests, benchmarks, subtests) | | | |

**Score interpretation (out of 60):**

| Score | Go Readiness |
|-------|-------------|
| 12-24 | Significant gaps - work through Parts 1-4 of this book before starting interview prep |
| 25-36 | Functional but not fluent - integrate Go review into first 2 weeks of any plan |
| 37-48 | Comfortable - focus on interview-specific patterns (heap, sort, strings.Builder) |
| 49-60 | Fluent - Go is a competitive advantage, focus on runtime internals for senior roles |

### Composite Readiness Matrix

Combine your scores to determine your overall starting position:

```
+-----------------------------------------------------------------------+
|                    COMPOSITE READINESS SCORING                        |
+-----------------------------------------------------------------------+
|                                                                       |
|  Coding Score:  ___ / 30    (Section 82F.2 diagnostic)               |
|  System Design: ___ / 30    (Section 82F.2 diagnostic)               |
|  Behavioral:    ___ / 8     (Section 82F.2 checklist)                |
|  Go Proficiency: ___ / 60   (Section 82F.2 self-rating)             |
|                                                                       |
|  +----------------------------------------------------------------+  |
|  | STARTING LEVEL       | CRITERIA                                |  |
|  +----------------------------------------------------------------+  |
|  | Level 1: Foundation   | Coding <10 OR Go <25 OR                |  |
|  |   (Start from zero)   | System Design <5                       |  |
|  +----------------------------------------------------------------+  |
|  | Level 2: Developing   | Coding 10-18, Go 25-36,                |  |
|  |   (Need structure)    | System Design 5-15                     |  |
|  +----------------------------------------------------------------+  |
|  | Level 3: Intermediate | Coding 18-24, Go 37-48,                |  |
|  |   (Need practice)     | System Design 15-22                    |  |
|  +----------------------------------------------------------------+  |
|  | Level 4: Advanced     | Coding 24-28, Go 49+,                  |  |
|  |   (Need polish)       | System Design 22+                      |  |
|  +----------------------------------------------------------------+  |
|  | Level 5: Ready        | Coding 28+, Go 55+,                    |  |
|  |   (Need execution)    | System Design 25+, Behavioral 7+       |  |
|  +----------------------------------------------------------------+  |
|                                                                       |
|  YOUR LEVEL: ___                                                      |
|                                                                       |
|  RECOMMENDED PLAN:                                                    |
|  Level 1 -> 6-Month Plan (Section 82F.4)                             |
|  Level 2 -> 6-Month Plan starting Month 2 (Section 82F.4)           |
|  Level 3 -> 12-Week Intensive (Section 82F.3)                        |
|  Level 4 -> 12-Week Plan starting Week 5 (Section 82F.3)            |
|  Level 5 -> 4-Week Emergency Plan (Section 82F.5)                    |
|                                                                       |
+-----------------------------------------------------------------------+
```


### Junior → FAANG: Honest Self-Assessment for FAANG Preparation

Self-assessment is the starting point for an effective study plan. The most common failure mode is inaccurate self-assessment: overestimating your strength in coding and underestimating the gap in system design and behavioral depth. Accurate self-assessment requires external calibration: not 'I think I am good at system design' but 'I completed a mock system design and the feedback said I covered the high-level architecture but did not address capacity, trade-offs, or failure modes'. Use mock interviews, not self-evaluation, as your calibration tool.

### Senior @ FAANG: Self-Assessment as a Baseline Measurement Protocol

Senior candidates should conduct a structured baseline measurement before starting any study plan. The protocol: complete one timed coding problem (medium difficulty, 30 minutes), one timed system design mock (45 minutes with feedback from an L5+ engineer), and one recorded behavioral interview using your current story bank. Review each session with a rubric and assign a score per dimension. This baseline reveals where your preparation time will have the highest return on investment. A senior engineer who scores high on coding and behavioral but low on system design depth should invert the standard study plan allocation and spend the majority of time on system design.

---
