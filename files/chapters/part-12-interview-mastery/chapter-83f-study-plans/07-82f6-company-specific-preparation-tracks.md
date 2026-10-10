## 83F.6 Company-Specific Preparation Tracks

These tracks supplement the main study plans with company-specific focus areas. Dedicate 1-2 weeks of your plan (typically the penultimate week) to your target company.

For detailed company profiles, interview processes, and Go solutions, see Chapter 83B (FAANG+ Company-Specific Preparation Guide).

### Google Track

**What makes Google unique:**
- Hiring committee model (interviewers do not make the final decision)
- Team matching happens after offer decision
- Emphasis on algorithmic optimality (must reach theoretical lower bound)
- Googleyness & Leadership round (culture + soft skills)
- Google Docs coding (no IDE, no autocomplete)

**Preparation priorities:**

| Priority | Focus Area | Time Allocation |
|----------|------------|-----------------|
| 1 | Optimal algorithm solutions | 40% |
| 2 | Clean, readable code (as if for code review) | 20% |
| 3 | System design with Go-specific depth | 20% |
| 4 | Googleyness stories (helping others, humility, learning) | 10% |
| 5 | Go runtime knowledge (GC, scheduler, memory model) | 10% |

**30 Most-Tested Google Problems:**

| # | Problem | Difficulty | Pattern |
|---|---------|------------|---------|
| 1 | Median of Two Sorted Arrays | Hard | Binary search |
| 2 | Trapping Rain Water | Hard | Two pointers / stack |
| 3 | Longest Substring Without Repeating Characters | Medium | Sliding window |
| 4 | Merge K Sorted Lists | Hard | Heap |
| 5 | Word Ladder | Hard | BFS |
| 6 | Serialize and Deserialize Binary Tree | Hard | DFS/BFS |
| 7 | Alien Dictionary | Hard | Topological sort |
| 8 | Minimum Window Substring | Hard | Sliding window |
| 9 | Course Schedule II | Medium | Topological sort |
| 10 | Binary Tree Maximum Path Sum | Hard | DFS |
| 11 | Edit Distance | Medium | 2D DP |
| 12 | Word Search II | Hard | Trie + backtracking |
| 13 | LRU Cache | Medium | Hash map + linked list |
| 14 | Number of Islands | Medium | BFS/DFS |
| 15 | Find Median from Data Stream | Hard | Two heaps |
| 16 | Burst Balloons | Hard | Interval DP |
| 17 | Longest Increasing Subsequence | Medium | DP + binary search |
| 18 | Meeting Rooms II | Medium | Sorting + heap |
| 19 | Sliding Window Maximum | Hard | Deque |
| 20 | Task Scheduler | Medium | Greedy + heap |
| 21 | Decode Ways | Medium | 1D DP |
| 22 | Word Break | Medium | DP |
| 23 | Accounts Merge | Medium | Union-Find |
| 24 | Pacific Atlantic Water Flow | Medium | Multi-source BFS |
| 25 | Design Search Autocomplete System | Hard | Trie + priority queue |
| 26 | Split Array Largest Sum | Hard | Binary search on answer |
| 27 | Robot Room Cleaner | Hard | Backtracking + DFS |
| 28 | Snapshot Array | Medium | Binary search + design |
| 29 | Longest String Chain | Medium | DP |
| 30 | Minimum Cost to Hire K Workers | Hard | Sorting + heap |

**Google system design favorites:**
- Design Google Search ranking
- Design Google Maps navigation
- Design Google Docs collaborative editing
- Design YouTube video processing pipeline
- Design Gmail notification system

**Google interview timeline:**
Recruiter screen (1 week) -> Phone screen (1-2 weeks) -> Virtual onsite (2-4 weeks) -> Hiring Committee (2-6 weeks) -> Team matching (1-4 weeks) -> SVP review (1-2 weeks for L5+) -> Offer

Total: 4-12 weeks typical. Can extend to 16+ weeks due to HC backlog.

### Meta/Facebook Track

**What makes Meta unique:**
- Fast interview process (2-4 weeks start to finish)
- Emphasis on speed (solve problems quickly, then optimize)
- Product sense valued in system design
- "Move Fast" culture permeates evaluation
- Two coding rounds, one system design, one behavioral

**Preparation priorities:**

| Priority | Focus Area | Time Allocation |
|----------|------------|-----------------|
| 1 | Fast problem solving (speed over perfection initially) | 35% |
| 2 | System design with product sense | 25% |
| 3 | Working code first, then optimize | 20% |
| 4 | Meta cultural values (Move Fast, Be Direct, Build Social Value) | 10% |
| 5 | Graph and social network-type problems | 10% |

**30 Most-Tested Meta Problems:**

| # | Problem | Difficulty | Pattern |
|---|---------|------------|---------|
| 1 | Valid Palindrome II | Easy | Two pointers |
| 2 | Subarray Sum Equals K | Medium | Prefix sum + hash map |
| 3 | Binary Tree Vertical Order Traversal | Medium | BFS + hash map |
| 4 | Nested List Weight Sum | Medium | DFS |
| 5 | Random Pick with Weight | Medium | Prefix sum + binary search |
| 6 | Add Binary | Easy | String manipulation |
| 7 | Buildings with an Ocean View | Medium | Stack / reverse traversal |
| 8 | Lowest Common Ancestor III | Medium | DFS |
| 9 | Dot Product of Two Sparse Vectors | Medium | Hash map / two pointers |
| 10 | Range Sum of BST | Easy | DFS |
| 11 | Minimum Remove to Make Valid Parentheses | Medium | Stack |
| 12 | Product of Array Except Self | Medium | Prefix/suffix |
| 13 | Clone Graph | Medium | BFS/DFS |
| 14 | Merge Intervals | Medium | Sorting |
| 15 | 3Sum | Medium | Two pointers |
| 16 | Binary Tree Right Side View | Medium | BFS |
| 17 | Pow(x, n) | Medium | Binary exponentiation |
| 18 | Simplify Path | Medium | Stack |
| 19 | Accounts Merge | Medium | Union-Find |
| 20 | Insert Delete GetRandom O(1) | Medium | Hash map + array |
| 21 | Group Anagrams | Medium | Hash map |
| 22 | Word Break | Medium | DP |
| 23 | LRU Cache | Medium | Hash map + linked list |
| 24 | Alien Dictionary | Hard | Topological sort |
| 25 | K Closest Points to Origin | Medium | Quickselect / heap |
| 26 | Diameter of Binary Tree | Easy | DFS |
| 27 | Continuous Subarray Sum | Medium | Prefix sum + modulo |
| 28 | Making A Large Island | Hard | Union-Find / DFS |
| 29 | Minimum Add to Make Parentheses Valid | Medium | Counting |
| 30 | Task Scheduler | Medium | Greedy |

**Meta system design favorites:**
- Design Facebook News Feed
- Design Instagram Stories
- Design Facebook Messenger
- Design Facebook Live Video
- Design Privacy Settings System

### Amazon Track

**What makes Amazon unique:**
- Leadership Principles (LPs) are integrated into EVERY round, including coding
- Bar Raiser has explicit veto power
- Written communication valued (Amazon's "six-pager" culture)
- Working Backwards from the customer
- Two behavioral rounds + coding rounds with LP components

**Preparation priorities:**

| Priority | Focus Area | Time Allocation |
|----------|------------|-----------------|
| 1 | Leadership Principles mastery (stories for all 16) | 30% |
| 2 | Coding with LP narration | 25% |
| 3 | System design (practical, working systems) | 20% |
| 4 | "Working Backwards" thinking in system design | 15% |
| 5 | Customer obsession in every answer | 10% |

**Top 5 Leadership Principles to prepare deeply (most commonly tested):**

1. **Customer Obsession:** "Tell me about a time you went above and beyond for a customer."
2. **Ownership:** "Tell me about a time you took ownership of something outside your area."
3. **Bias for Action:** "Tell me about a time you made a decision without complete data."
4. **Deliver Results:** "Tell me about a time you delivered a project under a tight deadline."
5. **Dive Deep:** "Tell me about a time you had to debug a complex system issue."

For each LP, prepare 2-3 stories. You need 10-15 stories total that can flex across different LPs.

**30 Most-Tested Amazon Problems:**

| # | Problem | Difficulty | Pattern |
|---|---------|------------|---------|
| 1 | Two Sum | Easy | Hash map |
| 2 | LRU Cache | Medium | Design |
| 3 | Number of Islands | Medium | BFS/DFS |
| 4 | Merge Two Sorted Lists | Easy | Linked list |
| 5 | Best Time to Buy and Sell Stock | Easy | Single pass |
| 6 | Merge Intervals | Medium | Sorting |
| 7 | Course Schedule | Medium | Topological sort |
| 8 | Word Break | Medium | DP |
| 9 | Reorder Data in Log Files | Medium | Custom sort |
| 10 | Min Stack | Medium | Stack design |
| 11 | K Closest Points to Origin | Medium | Heap |
| 12 | Trapping Rain Water | Hard | Two pointers |
| 13 | Longest Palindromic Substring | Medium | DP / expand around center |
| 14 | Copy List with Random Pointer | Medium | Hash map |
| 15 | Search in Rotated Sorted Array | Medium | Binary search |
| 16 | Partition Labels | Medium | Greedy |
| 17 | Top K Frequent Words | Medium | Heap |
| 18 | Subtree of Another Tree | Easy | DFS |
| 19 | Maximum Subarray | Medium | Kadane's |
| 20 | Min Cost to Connect All Points | Medium | Kruskal's / Prim's |
| 21 | Rotting Oranges | Medium | Multi-source BFS |
| 22 | Meeting Rooms II | Medium | Sorting + heap |
| 23 | Design Tic-Tac-Toe | Medium | Design |
| 24 | Sliding Window Maximum | Hard | Deque |
| 25 | Word Ladder | Hard | BFS |
| 26 | Coin Change | Medium | DP |
| 27 | Serialize and Deserialize Binary Tree | Hard | DFS/BFS |
| 28 | Critical Connections in a Network | Hard | Tarjan's |
| 29 | Design a File System | Medium | Trie / hash map |
| 30 | Analyze User Website Visit Pattern | Medium | Hash map + combinations |

### Apple Track

**What makes Apple unique:**
- Team-specific hiring (you interview for a specific team, not "Apple")
- Emphasis on craftsmanship and attention to detail
- Deep domain knowledge expected for the team's problem space
- Secrecy culture affects information availability
- Code quality matters as much as correctness

**Preparation priorities:**

| Priority | Focus Area | Time Allocation |
|----------|------------|-----------------|
| 1 | Clean, well-structured code | 30% |
| 2 | Domain knowledge for target team | 25% |
| 3 | System design with quality emphasis | 20% |
| 4 | Problem-solving approach (process over speed) | 15% |
| 5 | Cultural fit (innovation, craftsmanship, secrecy) | 10% |

**Key preparation strategies:**
- Research the specific team's product area deeply before interviewing
- Practice writing exceptionally clean, well-documented code
- Prepare to discuss trade-offs in detail (Apple values thoughtful engineering)
- Have stories about attention to detail and craftsmanship
- Expect follow-up questions about real-world implementation details

### Microsoft Track

**What makes Microsoft unique:**
- Growth mindset culture (learn-it-all vs. know-it-all)
- Team matching often happens during interview process
- Diverse interview styles across different organizations
- As Appropriate (AA) interviewer makes final decision
- Generally considered the most "friendly" FAANG interview experience

**Preparation priorities:**

| Priority | Focus Area | Time Allocation |
|----------|------------|-----------------|
| 1 | Well-rounded coding (not just optimal - clear and maintainable) | 30% |
| 2 | System design (practical, not theoretical) | 25% |
| 3 | Growth mindset stories (learning, adapting, improving) | 20% |
| 4 | Communication clarity | 15% |
| 5 | Collaboration and teamwork emphasis | 10% |

### Netflix Track

**What makes Netflix unique:**
- No junior hiring (L5+ equivalent only)
- Culture fit is paramount ("Netflix Culture Deck" is required reading)
- Freedom and responsibility model
- Top-of-market compensation (no equity vesting schedule - all upfront)
- Keeper test: "Would I fight to keep this person?"

**Preparation priorities:**

| Priority | Focus Area | Time Allocation |
|----------|------------|-----------------|
| 1 | Senior-level system design | 30% |
| 2 | Culture alignment (judgment, impact, curiosity, courage) | 25% |
| 3 | Technical depth in your domain | 20% |
| 4 | Leadership and ownership stories | 15% |
| 5 | Coding (still tested but less weighted than at Google) | 10% |

### Stripe Track

**What makes Stripe unique:**
- Practical, real-world coding problems (build a feature, not solve a puzzle)
- API design emphasis
- System reliability and payment processing focus
- Bug fix/code review rounds
- Strong engineering culture with emphasis on writing

**Preparation priorities:**

| Priority | Focus Area | Time Allocation |
|----------|------------|-----------------|
| 1 | Practical coding (implement a real feature) | 30% |
| 2 | API design and clean interfaces | 25% |
| 3 | System reliability and fault tolerance | 20% |
| 4 | Code review skills | 15% |
| 5 | Financial/payment domain knowledge | 10% |

### Other Tier-1 Companies

**Uber:** Strong emphasis on system design (geospatial, real-time). Go is a primary language. Expect Uber-specific designs (ride matching, ETA, surge pricing). Culture: "Do the right thing" + "Build with heart."

**Airbnb:** Cross-functional interview (product sense + engineering). Behavioral heavily weighted. Expect to discuss trade-offs in search ranking, pricing, trust and safety. Culture fit interview is unique to Airbnb.

**LinkedIn:** Similar to Microsoft (parent company) but with social graph emphasis. Expect LinkedIn-specific designs (feed ranking, connections, job matching). Strong growth mindset culture.

**X (formerly Twitter):** Real-time systems emphasis. Timeline, trending topics, notification systems. Engineering culture varies significantly by team post-acquisition.

**Databricks / Snowflake:** Data engineering focus. Expect distributed systems questions, query optimization, data lake architecture. Strong coding fundamentals still tested.


### Junior → FAANG: Company-Specific Preparation Track Basics

Company-specific preparation tracks focus your effort on the dimensions that matter most for each target company. For Amazon, the LP behavioral preparation is the highest-priority unique investment. For Google, depth in distributed systems and algorithmic complexity is the differentiator. For Meta, product impact framing and speed-quality balance stories are specific to the culture. For Apple, craftsmanship and attention to detail signal the right values. For Netflix, autonomy and high-performance culture signals matter most.

### Senior @ FAANG: Company-Specific Tracks as ADR-Level Career Decisions

Senior candidates building company-specific preparation tracks should treat the selection of which tracks to invest in as an architectural decision: the investment is non-trivial, the preparation creates path dependencies (Amazon LP deep-dive creates a story bank that does not transfer as efficiently to other companies), and the choice reflects your actual preferences about where you want to work. The ADR for the track selection should capture: which companies are genuinely high-priority targets versus fallback options, what is the incremental preparation effort for each company beyond the common base, and what is the expected return on that incremental investment. This structured thinking prevents the inefficient strategy of applying broadly to all FAANG companies with uniform preparation, which produces mediocre results at all companies.

---
