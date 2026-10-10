## 72.9 Common Graph Problems

This section covers frequently asked graph problems that combine the traversal and algorithmic techniques from earlier sections. These problems appear regularly in technical interviews at top companies and test your ability to recognize which graph technique to apply. Each problem requires you to model the situation as a graph (sometimes implicitly) and then apply the appropriate traversal or algorithm.

### Clone Graph

Cloning a graph means creating a deep copy where every node and edge is duplicated without sharing any references with the original. The main challenge is handling cycles: if node A points to node B and node B points back to node A, a naive recursive copy would loop forever. The solution is to maintain a hash map of already-cloned nodes. When you encounter a node that has already been copied, you return the existing clone instead of creating a new one.

```go
// CloneGraph creates a deep copy of a graph
// LeetCode 133: Clone Graph
type Node struct {
    Val       int
    Neighbors []*Node
}

func CloneGraph(node *Node) *Node {
    if node == nil {
        return nil
    }

    cloned := make(map[*Node]*Node)

    var clone func(*Node) *Node
    clone = func(n *Node) *Node {
        if n == nil {
            return nil
        }

        if c, ok := cloned[n]; ok {
            return c
        }

        c := &Node{Val: n.Val}
        cloned[n] = c

        for _, neighbor := range n.Neighbors {
            c.Neighbors = append(c.Neighbors, clone(neighbor))
        }

        return c
    }

    return clone(node)
}
```

### Bipartite Graph Check

A graph is bipartite if its vertices can be divided into two groups such that every edge connects a vertex in one group to a vertex in the other group. Think of it as a two-coloring problem: can you color every vertex red or blue so that no two adjacent vertices share the same color? The algorithm uses BFS to assign alternating colors to neighbors. If any neighbor already has the same color as the current vertex, the graph is not bipartite.

```go
// IsBipartite checks if graph can be 2-colored
// LeetCode 785: Is Graph Bipartite?
func IsBipartite(graph [][]int) bool {
    n := len(graph)
    color := make([]int, n) // 0: uncolored, 1 or -1: colors

    for i := 0; i < n; i++ {
        if color[i] == 0 {
            if !bfsColor(graph, i, color) {
                return false
            }
        }
    }

    return true
}

func bfsColor(graph [][]int, start int, color []int) bool {
    queue := []int{start}
    color[start] = 1

    for len(queue) > 0 {
        node := queue[0]
        queue = queue[1:]

        for _, neighbor := range graph[node] {
            if color[neighbor] == 0 {
                color[neighbor] = -color[node]
                queue = append(queue, neighbor)
            } else if color[neighbor] == color[node] {
                return false
            }
        }
    }

    return true
}
```

### Word Ladder

The Word Ladder problem asks for the shortest sequence of single-character transformations to convert one word into another, where every intermediate word must exist in a given dictionary. This is a classic BFS problem on an implicit graph: each word is a vertex, and two words are connected by an edge if they differ by exactly one character. BFS guarantees the shortest transformation sequence because it explores all words reachable in one step before exploring those reachable in two steps.

```go
// LadderLength finds shortest transformation sequence
// LeetCode 127: Word Ladder
func LadderLength(beginWord string, endWord string, wordList []string) int {
    wordSet := make(map[string]bool)
    for _, word := range wordList {
        wordSet[word] = true
    }

    if !wordSet[endWord] {
        return 0
    }

    queue := []string{beginWord}
    level := 1

    for len(queue) > 0 {
        size := len(queue)
        for i := 0; i < size; i++ {
            word := queue[0]
            queue = queue[1:]

            if word == endWord {
                return level
            }

            // Try changing each character
            wordBytes := []byte(word)
            for j := 0; j < len(wordBytes); j++ {
                original := wordBytes[j]
                for c := byte('a'); c <= 'z'; c++ {
                    if c == original {
                        continue
                    }
                    wordBytes[j] = c
                    newWord := string(wordBytes)
                    if wordSet[newWord] {
                        queue = append(queue, newWord)
                        delete(wordSet, newWord)
                    }
                }
                wordBytes[j] = original
            }
        }
        level++
    }

    return 0
}
```

Two details carry this implementation. `delete(wordSet, newWord)` on enqueue is the visited-marking rule from Section 72.2 in disguise: the word is claimed at discovery, so it cannot be enqueued again from a sibling in the same level. And the `size := len(queue)` snapshot is what makes `level` meaningful, since it processes exactly the current level before incrementing. Reading `len(queue)` inside the loop instead would let words enqueued this level be counted as part of it and the returned distance would be wrong.

### Junior → FAANG: Recognizing Graph Problems in Disguise

The three problems in this section look different on the surface but share the graph traversal structure.

Clone Graph: the "visited map" pattern (original node to cloned node) is reused in any graph copy or transformation problem. Whenever you need to produce a new structure that mirrors an existing one while handling cycles, the visited map is the tool.

Bipartite Check: the "two-coloring" insight is reused in problems about conflict-free assignment, scheduling with alternating constraints, and matching problems. If the problem asks "can we partition these entities into two groups such that no two entities in the same group are in conflict?", it is a bipartite check.

Word Ladder: the BFS-on-implicit-graph pattern is reused in state-space search. The "state" is a word, and two states are adjacent if they differ by one character. The graph is never built: neighbors are generated on demand, which is the only reason this is tractable at all, since the full graph over a large dictionary would be enormous.

The precondition that makes BFS valid here is that **every transition costs the same**. One character change is one step, so fewest-edges equals cheapest, which is exactly what BFS finds. Give the transitions different costs and BFS is simply wrong and you need Dijkstra. Sliding puzzles, Rubik's cube, and lock-cracking (LeetCode 752) all fit the uniform-cost mold, which is why they are all BFS.

Practice exercise: before coding any of these, write the graph model explicitly: what are the vertices? What are the edges? What is the starting vertex? What is the goal? Answering these four questions before coding prevents the most common mistake of starting to code without a clear graph model.

### Senior @ FAANG: Common Graph Problems as System Design Primitives

Clone Graph is the formal basis for deep copy. When a service receives a structure it must either share references (risking concurrent modification) or deep-copy it. The identity map from original to clone is what makes this work on object graphs with cycles or shared substructure, and it is why `copy.deepcopy` in Python keeps a memo dict and Java's serialization keeps a handle table: both must preserve *sharing*, not merely avoid infinite recursion. If two fields point at the same object, a correct deep copy leaves them pointing at the same clone. Note the contrast with protobuf cloning, which needs none of this, because protobuf messages are trees by construction and cannot contain cycles or shared references at all. Knowing which of your data structures is a tree and which is a graph tells you whether you need the map.

Bipartite check surfaces in scheduling systems: can a set of tasks be divided into two groups such that tasks in the same group do not conflict? In job shop scheduling, "conflict" means "using the same machine." The bipartite check determines whether the conflict graph is 2-colourable, which directly answers the scheduling question. If the graph is not bipartite, a more general graph colouring algorithm (NP-complete in general) is required, and heuristics or relaxations must be used.

Word Ladder and its generalisations (state-space BFS) are the algorithmic foundation of explicit-state model checking. The checker treats the system's state machine as a graph, states as vertices and transitions as edges, and searches for a path from the initial state to one violating a safety property. BFS is preferred over DFS here for a practical reason: it yields the *shortest* counterexample, and a 4-step trace is enormously easier to debug than a 400-step one. TLA+'s TLC model checker does exactly this, and SPIN performs explicit-state search too (DFS by default, with BFS available).

Do not lump every checker together, though. Symbolic model checkers such as NuSMV do not enumerate a state graph at all: they represent sets of states as boolean formulas (BDDs, or a SAT solver in bounded model checking) and compute reachability symbolically, precisely to escape the state explosion that defeats explicit enumeration. Same verification question, fundamentally different machinery. The staff-level move is recognizing that a verification problem is state-space reachability, and then knowing that "enumerate it" and "encode it symbolically" are both on the table, with state space size deciding between them.
