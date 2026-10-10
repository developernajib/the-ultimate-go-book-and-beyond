## Learning Objectives

By the end of this chapter, you will:
- Understand graph representations (adjacency list, adjacency matrix, edge list)
- Master BFS and DFS traversals for both directed and undirected graphs
- Detect cycles and find connected components
- Apply topological sorting for dependency resolution
- Implement Union-Find for disjoint set operations
- Solve shortest path, minimum spanning tree, and other classic graph problems

### Junior → FAANG: Prioritizing the Learning Objectives

Not all objectives carry equal weight. Roughly ranked by how often they surface: BFS and DFS come up in nearly every graph interview and are the foundation everything else builds on. Cycle detection and topological sort are next, then Union-Find, then shortest paths, with MST the least common of the group. Weight your study time in that order, and note that the ranking is mostly a consequence of dependency: you cannot do topological sort without DFS, so time spent on traversal pays twice.

The single highest-value skill is recognizing whether a problem is a BFS or DFS problem within 60 seconds of reading it. Practice this recognition separately from implementation: read the problem statement, write "BFS" or "DFS" in the margin, then check your answer against the solution. Do this for 20 problems before coding any of them.

### Senior @ FAANG: Objectives as a Curriculum Design Framework

At staff level, you may be responsible for designing technical interviews, onboarding curricula, or engineering education programs. The objectives list above is a starting point for curriculum design, but it lacks observable success criteria and does not address the gap between "knows the algorithm" and "can apply it to novel problems."

A mature curriculum adds three things to each objective: a worked example, a set of variations that test the same concept in different clothing, and a reflection question that asks the engineer to compare two approaches and justify their choice. For example, "Apply topological sorting" becomes: worked example (course schedule), variations (alien dictionary, parallel courses, task dependency ordering), reflection (when would you prefer DFS-based post-order reversal over Kahn's BFS-based approach?). This structure produces engineers who can reason about graph algorithms, not just recall them.
