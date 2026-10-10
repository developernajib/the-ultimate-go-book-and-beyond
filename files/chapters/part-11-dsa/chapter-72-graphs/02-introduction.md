## Overview

Graphs are versatile data structures that model relationships between objects. They appear everywhere: social networks, road maps, computer networks, dependency systems, and more. Mastering graph algorithms is essential for solving complex real-world problems.

```
┌─────────────────────────────────────────────────────────────────┐
│                    GRAPH TERMINOLOGY                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Undirected Graph:          Directed Graph (Digraph):           │
│                                                                 │
│      A ─── B                    A ───► B                        │
│      │   ╱ │                    │    ╱ │                        │
│      │  ╱  │                    │   ╱  │                        │
│      │ ╱   │                    ▼  ╱   ▼                        │
│      C ─── D                    C ◄─── D                        │
│                                                                 │
│  Weighted Graph:            Directed Acyclic Graph (DAG):       │
│                                                                 │
│      A ─5─ B                    A ───► B ───► E                 │
│      │    ╱│                    │      │                        │
│      3   2 1                    ▼      ▼                        │
│      │  ╱  │                    C ───► D                        │
│      C ─4─ D                                                    │
│                                                                 │
│  Terminology:                                                   │
│  • Vertex/Node: Points in the graph (A, B, C, D)                │
│  • Edge: Connection between vertices                            │
│  • Degree: Number of edges connected to a vertex                │
│  • Path: Sequence of vertices connected by edges                │
│  • Cycle: Path that starts and ends at same vertex              │
│  • Connected: Path exists between any two vertices              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Graph Vocabulary in Interview Communication

Using graph terminology precisely signals algorithmic maturity to interviewers. Practice using these terms in sentences before your interview.

Correct: "This problem has cycles in the dependency graph, which means topological sort will return a partial ordering. I need to detect the cycle explicitly."

Incorrect: "The things point to each other in a loop so I can't sort them."

The distinction between directed and undirected graphs matters for algorithm choice. Cycle detection in an undirected graph uses a parent-tracking DFS: any edge to a visited vertex that is not the one you came from closes a cycle. In a directed graph that test is wrong, because reaching an already-visited vertex may just be a cross edge into a finished branch, which is not a cycle at all. The usual fix is a three-color DFS (white unvisited, gray on the current recursion stack, black fully explored), where only an edge into a **gray** vertex is a back edge and therefore a cycle.

Say "typically uses" rather than "requires", though. Three-color DFS is one option, not the only one: Kahn's algorithm detects a directed cycle without any DFS at all, simply by noticing that it could not order every vertex. Knowing two mechanisms for the same property, and why they agree, is a stronger signal than knowing one by rote.

A common interview miscommunication: saying "the graph is connected" when you mean "the graph might have disconnected components." Always check for disconnected components by iterating over all vertices, not just starting BFS/DFS from vertex 0.

### Senior @ FAANG: Graph Modeling as an Engineering Discipline

The deepest value of graph theory for a staff engineer is not any specific algorithm. It is the modeling discipline. Recognizing that a business problem is a graph problem, choosing the correct graph representation, and selecting the algorithm that matches the graph's properties (directed vs undirected, weighted vs unweighted, sparse vs dense, cyclic vs acyclic) is the engineering judgment that L6 interviews test.

A concrete example: a content moderation team is asked to detect coordinated inauthentic behavior, meaning networks of fake accounts amplifying each other. The graph model has accounts as vertices and engagement edges (likes, shares, follows). The representation is Compressed Sparse Row, which stores the adjacency list as two flat arrays and is the standard choice once edges run to the billions, because it removes per-list allocation overhead and scans contiguously.

The algorithm choice is where the judgment lives, and the honest answer is that SCC is probably the wrong tool. Tarjan's finds strongly connected components exactly in O(V+E), but an SCC only says "mutually reachable", and on a dense social graph a single giant SCC swallows most of the network, which tells you nothing. What you actually want is *dense subgraph* or community detection, which is a different problem: Louvain or label propagation for scale, or a stochastic block model when you want a generative story you can reason about. Noticing that the textbook algorithm with the closest-sounding name does not answer the question is exactly the modeling discipline being tested.

This is what graph mastery looks like at staff level: not "I know Tarjan's algorithm" but "I know when Tarjan's is the right choice, when it is not, and how to communicate that decision to a product team who does not speak graph theory."
