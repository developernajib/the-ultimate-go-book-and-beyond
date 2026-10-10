# Chapter 72: Graphs

> *"The Internet is not a thing. It's a graph. And if you understand graphs, you understand the Internet."*
> - Unknown

Graphs are among the most expressive data structures in computer science. Arrays, linked lists, and trees each impose a strict sequential or hierarchical order. Graphs impose nothing: they are free-form networks capable of modeling virtually any relationship between entities. From social networks and web page links to flight routes and dependency graphs in build systems, the graph abstraction is everywhere. Mastering graphs is not merely an academic exercise. It is a core competency for any engineer working on real-world systems at scale.

In Go, graphs are pleasant to build because maps, slices, and structs give you adjacency lists and adjacency matrices with minimal ceremony. Whether you represent a graph as `map[int][]int` or a custom `Node` struct with pointer-linked neighbors, Go lets you match the data structure to the problem without fighting the language. Concurrency is a subtler story than it first appears: goroutines make it easy to *write* a parallel traversal, but graph traversal parallelizes poorly by nature. BFS has some parallelism within a level, DFS has essentially none (its ordering is inherently sequential), and the synchronization needed to share a visited set often costs more than it saves. Treat concurrent traversal as something to measure, not something to assume is faster.

This chapter covers the two foundational traversal strategies, Breadth-First Search (BFS) and Depth-First Search (DFS), along with the algorithms built on top of them: cycle detection, topological sorting, shortest paths via Dijkstra's and Bellman-Ford, and connected component analysis. You will implement each algorithm from scratch in idiomatic Go, study their time and space complexity, and learn the mental models that let you recognize which algorithm applies to a given problem in seconds, which is a critical skill in a timed interview.

**What you'll learn in this chapter:**

- Representing graphs as adjacency lists and adjacency matrices in Go using maps and slices
- Implementing iterative and recursive DFS and BFS with proper visited-node tracking
- Detecting cycles in directed and undirected graphs using DFS coloring and Union-Find
- Computing topological orderings with Kahn's algorithm (BFS-based) and DFS-based post-order reversal
- Finding shortest paths with Dijkstra's algorithm (O((V+E) log V)) and Bellman-Ford (O(VE)) for negative weights
- Identifying strongly connected components using Kosaraju's and Tarjan's algorithms
- Recognizing the 15+ most common graph problem patterns tested at FAANG companies

**Why this matters in interviews:**

Graphs are one of the highest-frequency topics in technical screens and onsites, and grid problems disguised as "islands," "regions," or "connections" are BFS/DFS in costume. Topological sort shows up as dependency resolution and course scheduling. Dijkstra's surfaces in network routing and minimum-cost paths. Interviewers are not just checking whether you know the algorithm. They are watching whether you choose the right traversal strategy, handle the edge cases that actually bite (disconnected graphs, self-loops, negative weights, the empty graph), and communicate while coding under pressure. In Go specifically, clean use of a visited `map[int]bool` or `[]bool` and a slice-backed queue reads well.

**Prerequisites:** Chapter 70 (Trees and Tree Traversal), Chapter 71 (Heaps and Priority Queues), familiarity with Go maps and slices, and basic recursion.

### Junior → FAANG: Why Graphs Feel Hard and How to Approach Them

Graphs feel hard to juniors primarily because they lack a fixed shape. Arrays have indices, trees have parent-child relationships, but graphs have arbitrary connectivity. The first step to graph fluency is accepting that there is no single "correct" way to traverse a graph. There are strategies, and you choose based on what the problem asks.

The two fundamental strategies are BFS (use when you need shortest paths or level-by-level exploration) and DFS (use when you need reachability, cycle detection, or topological ordering). If you cannot immediately identify which one a problem needs, ask: "Do I care about distance?" If yes, use BFS. If the problem is about connectivity or ordering with no distance requirement, use DFS as the default.

You will hear that recursive DFS "blows the stack in Go on large inputs." Be precise, because the folk version is wrong in a way an interviewer may catch. Go does not give a goroutine a small fixed stack. Each goroutine starts at 2 KB and the runtime **grows** the stack automatically by copying it to a larger block as needed, up to a limit of 1 GB on 64-bit platforms (250 MB on 32-bit), tunable via `debug.SetMaxStack`. A graph with a few thousand vertices will not come close: a few thousand frames is trivial, and recursive DFS is perfectly fine there.

The real risk is *depth*, not vertex count, and the two are only equal in the worst case. A million-vertex graph shaped like a long path recurses a million frames deep and can genuinely exhaust the limit, whereas a million-vertex graph of depth 20 is untroubled. So the honest rule is: recursion depth is bounded by the longest path, and you convert to an explicit stack when that could plausibly reach the millions, or when you simply cannot bound it from the input. Exceeding the limit is a fatal "goroutine stack exceeds limit" error that no `recover` can catch, which is a good reason to reach for the iterative version when in doubt.

Entry-level interview entry point: implement BFS and DFS from scratch on a `map[int][]int` adjacency list before memorizing any specific algorithm. Everything else in this chapter is built on these two foundations.

### Senior @ FAANG: Graphs as the Universal Abstraction

Staff engineers at FAANG companies think of graphs as the universal abstraction for relationships. Every dependency system is a DAG. Every social network is an undirected sparse graph. Every routing table is a weighted directed graph. Every state machine is a directed graph. The question is not "is this a graph problem?" but "which graph algorithm applies here?"

At L6, the evaluation criterion shifts from "can you implement Dijkstra's?" to "can you model this novel business problem as a graph, choose the correct algorithm, and reason about the algorithm's behavior under adversarial inputs?" A bar-raiser question might present a logistics optimization problem with conflicting priorities (cost vs. speed vs. reliability) and ask you to model it as a multi-objective shortest-path problem, then reason about the computational trade-offs of exact vs. approximate solutions.

The platform-level implication is that graph algorithms are architectural primitives in large systems. Build system dependency resolution (Bazel, Pants) uses topological sort on a DAG of millions of targets. Distributed transaction coordination uses cycle detection to prevent deadlocks. Network topology analysis uses connected components and bridge-finding to identify single points of failure. Staff engineers who own these systems must reason about graph algorithm correctness, not just implementation, when the graph has hundreds of millions of vertices and edges.

---
