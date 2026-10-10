## Exercises

### Exercise 1: Reconstruct Itinerary
Given a list of airline tickets, find the itinerary that uses all tickets.

### Exercise 2: Critical Connections
Find all edges whose removal disconnects the graph (bridges).

### Exercise 3: Cheapest Flights Within K Stops
Find the cheapest price with at most K stops. Reach for a round-limited Bellman-Ford rather than Dijkstra: the stop budget is a constraint on path *length in edges*, which Dijkstra's greedy ordering does not track.

### Exercise 4: Alien Dictionary
Given sorted words in an alien language, derive the character order.

### Junior → FAANG: Exercise Approach Strategy

Each exercise in this section involves a non-obvious graph modeling step before any algorithm applies.

For Reconstruct Itinerary: model airports as vertices and tickets as directed edges. The problem asks for an Eulerian path, one that uses every *edge* exactly once. Note the trap: this is about edges, not vertices, so it is not a DFS-with-visited-set problem, and a vertex may legitimately be entered many times. Hierholzer's algorithm (DFS appending to the result in post-order, then reversing) is O(E). LeetCode 332 also demands the lexicographically smallest itinerary, so you sort each airport's destinations first, which makes the whole thing O(E log E).

For Critical Connections: model connections as undirected edges and find the bridges, edges whose removal disconnects the graph. Tarjan's bridge algorithm tracks each vertex's discovery time and the lowest discovery time reachable from its subtree, and an edge (u, v) is a bridge exactly when nothing in v's subtree can reach back above v. Rated Hard, and a recurring favorite in infrastructure-flavored interviews.

For Cheapest Flights Within K Stops: model as a weighted directed graph with a stop constraint. Round-limited Bellman-Ford (K+1 rounds, snapshotting distances between rounds) or level-by-level BFS both work. The key insight is that K stops means at most K+1 edges. See Section 72.7 for why the between-rounds snapshot is mandatory and what silently breaks without it.

For Alien Dictionary: extract ordering constraints by comparing adjacent words character by character, build a directed graph, and run topological sort. The edge cases (prefix ordering violation) make this harder than it looks.

### Senior @ FAANG: Exercise Design Principles for Distinguishing L5 from L6

These four exercises are calibrated for L5 candidates. The difference in L6 evaluation is not the solution but the surrounding reasoning.

An L5 solution to Alien Dictionary produces correct code. An L6 solution does the same and then: identifies the ambiguity when multiple valid orderings exist (the problem asks for "any" valid ordering, but a real system might need a deterministic one, requiring stable topological sort), recognizes that the input "sorted words in an alien language" is an assumption that must be validated (what if the input is actually not sorted? the algorithm must detect this), and extends the algorithm to handle the online variant (new words arrive incrementally, maintain the topological ordering without full recomputation).

For Critical Connections, an L6 solution adds: the distinction between bridges and articulation points (vertices whose removal disconnects the graph), the observation that in a production network, bridges represent single points of failure that should be flagged for redundancy, and the operational consequence (add a redundant link to eliminate each bridge, prioritized by traffic volume across that link).

This framing, from algorithm to operational implication, is the L6 bar for graph interview problems.

---
