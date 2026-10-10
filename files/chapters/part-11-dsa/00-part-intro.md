# Part XI: Data Structures & Algorithms

*"An algorithm must be seen to be believed."* - Donald Knuth

---

Data structures and algorithms remain the single most important factor in FAANG coding interviews. Every major technology company - Google, Meta, Amazon, Apple, Microsoft, Netflix - uses algorithmic problem-solving as the primary filter in their hiring process. At senior levels, you are expected to solve medium-to-hard problems fluently, analyze time and space complexity on the spot, and discuss alternative approaches with their trade-offs. There is no shortcut around this requirement, and no amount of system design or behavioral preparation compensates for weak algorithmic fundamentals.

Beyond interviews, DSA knowledge shapes how you write production code every day. Choosing the right data structure for an in-memory index can be the difference between millisecond and second response times. Understanding graph algorithms helps you model dependency resolution in build systems. Knowing dynamic programming techniques lets you optimize resource allocation in scheduling systems. The engineers who instinctively reach for the right data structure and algorithm produce systems that are orders of magnitude more efficient than those who rely on brute force and hope.

Go provides a clean, minimal environment for implementing data structures and algorithms. Unlike languages with massive standard libraries that hide complexity behind abstractions, Go encourages you to understand what is happening at the implementation level. The `sort` package uses pattern-defeating quicksort, the `container/heap` package exposes the heap interface directly, and maps are implemented as hash tables with specific growth characteristics. This transparency makes Go an excellent language for learning and implementing DSA concepts.

**What this part covers:**
- Chapter 65: Complexity Analysis - Big O notation, time and space analysis, amortized analysis, and common complexity classes
- Chapter 66: Arrays and Strings - two pointers, sliding window, prefix sums, and string manipulation patterns
- Chapter 67: Linked Lists - singly and doubly linked lists, cycle detection, reversal, and merge operations
- Chapter 68: Stacks and Queues - implementations, monotonic stacks, queue variations, and practical applications
- Chapter 69: Hash Tables - maps, sets, collision handling, consistent hashing, and hash-based problem patterns
- Chapter 70: Trees and Binary Search Trees - traversals, BST operations, balanced trees, and tree-based interview patterns
- Chapter 71: Heaps and Priority Queues - min/max heaps, heap operations, top-K problems, and median tracking
- Chapter 72: Graphs - BFS, DFS, shortest paths, topological sort, minimum spanning trees, and graph modeling
- Chapter 73: Dynamic Programming - memoization, tabulation, state transition design, and classic DP problem families
- Chapter 74: Backtracking - permutations, combinations, constraint satisfaction, and pruning strategies
- Chapter 75: Greedy Algorithms - greedy choice property, interval scheduling, and when greedy solutions are optimal
- Chapter 76: Bit Manipulation - bitwise operations, bit tricks, and bit-level problem-solving techniques
- Chapter 77: Binary Search Variations - search on sorted arrays, search on answer space, and advanced binary search patterns
- Chapter 78: Tries and Advanced Data Structures - tries, segment trees, Fenwick trees, union-find, and specialized structures
- Chapter 78B: Coding Interview Patterns - the recurring problem shapes behind most FAANG coding rounds
- Chapter 78C: Top 150 LeetCode Problems - a curated checklist with Go solutions and pattern tagging
- Chapter 78D: Advanced Data Structures - segment trees, Fenwick trees, sweep line, and monotonic stacks in depth
- Chapter 79: Sorting and Selection - the comparison lower bound, pdqsort as Go actually implements it, stability as a contract, quickselect and top-k, and sorting data that exceeds memory

**How to use this part:**
Follow the chapters sequentially from 65 through 79. Complexity analysis in chapter 65 is essential for evaluating every solution you write afterward. Chapters 66 through 69 cover foundational data structures and should be mastered before moving to the more complex topics in chapters 70 through 79. Within each chapter, solve the practice problems before reading the solutions - active problem-solving builds the pattern recognition that interviews demand.

**FAANG relevance:**
You will face 2-3 coding rounds in every FAANG on-site interview, and each round tests algorithmic problem-solving. Google expects you to write correct, optimized code on a whiteboard. Meta emphasizes speed and communication. Amazon ties problems to leadership principles. This part prepares you for all of these formats by building fluency in every major problem category, using Go as the implementation language that you will use in real interviews.

---

### Junior → FAANG: Building the Algorithmic Foundation

Most engineers entering their first job underestimate how often DSA knowledge surfaces in day-to-day work. The misconception is that algorithms belong only in interviews, not in production. In reality, every time you choose a slice over a map, write a search function, or optimize a hot loop, you are applying algorithmic thinking.

Start by internalizing Big-O notation before touching any specific data structure. If you cannot articulate why appending to a Go slice is amortized O(1) but inserting at index 0 is O(n), you are not ready to reason about correctness or performance tradeoffs. Work through chapter 65 slowly and return to it after each subsequent chapter.

Build the habit of asking two questions about every function you write: what is the time complexity, and what is the space complexity? At entry-level interviews, interviewers often accept a correct but suboptimal solution if the candidate clearly identifies the complexity and suggests how to improve it. Showing awareness is more valuable than silence.

Practice problems in Go specifically. The language has no built-in priority queue, sort requires implementing `sort.Interface` or using `slices.SortFunc`, and linked lists must be built from scratch. These constraints force understanding rather than importing convenience wrappers. Entry-point FAANG bar: solve easy problems in under 10 minutes and medium problems in under 25 minutes with correct complexity analysis.

### Senior @ FAANG: Platform Thinking and Algorithmic Governance

At the senior and staff level, your relationship with DSA shifts from personal proficiency to organizational leverage. You are no longer the person who solves the problem: you are the person who shapes how your team approaches classes of problems.

**ADR framing for algorithmic decisions:** When your team adopts a new approach to indexing, search, or scheduling, write an Architecture Decision Record that documents the algorithm chosen, the complexity class it operates in, the alternatives considered, and the scale thresholds at which the decision should be revisited. This transforms an ad-hoc choice into institutional knowledge.

**Maturity model for algorithmic practice on a team:**
- Level 1: Engineers solve problems correctly but do not analyze complexity.
- Level 2: Engineers analyze complexity but choose suboptimally under time pressure.
- Level 3: Engineers select algorithms based on measured production data, not theoretical analysis alone.
- Level 4: Engineers build internal tooling or libraries that encode correct algorithmic choices, preventing junior engineers from making expensive mistakes by default.

Senior engineers at Google and Meta are expected to operate at Level 3 and push teams toward Level 4. This means instrumenting production code to validate that theoretical complexity matches observed latency curves, and building feedback loops between performance monitoring and code review.

**Bar-raiser signals in DSA interviews at L6/L7:** The interview is not about whether you solve the problem. It is about how you navigate ambiguity, communicate tradeoffs, and recognize when a seemingly clever optimization introduces hidden complexity costs. A bar-raiser will deliberately introduce constraints mid-problem to observe your adaptability. They will ask you to compare two correct solutions and explain which you would ship and why, taking into account cache behavior, memory allocation pressure, garbage collection impact in Go, and operability under production load.

**Staff-level concern: algorithmic debt.** Every shortcut taken in algorithm selection accumulates. A team that consistently uses O(n^2) solutions because "n is small" will eventually face an n that is not small, and refactoring under load is painful and risky. Staff engineers identify algorithmic debt early, quantify its risk with load projections, and schedule remediation before it becomes a crisis. Use this part of the book to build the vocabulary that lets you have those conversations credibly with both engineers and engineering managers.
