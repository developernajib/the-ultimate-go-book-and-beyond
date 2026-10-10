## 72.14 Exercises with Solutions

These exercises give you hands-on practice with the graph algorithms covered in this chapter. Each includes a complete Go solution that you should try to implement yourself before reading. Working through these will reinforce the patterns and help you internalize the common techniques.

### Exercise 1: Clone Graph

This exercise revisits the Clone Graph problem with a clean, self-contained solution. The key insight is using a visited map of original-to-clone node pointers to handle cycles and avoid infinite recursion. DFS recursively clones each node and its neighbors, returning the already-cloned copy if the node was previously visited.

```go
func cloneGraph(node *Node) *Node {
    if node == nil {
        return nil
    }

    visited := make(map[*Node]*Node)

    var clone func(*Node) *Node
    clone = func(n *Node) *Node {
        if n == nil {
            return nil
        }

        if cloned, exists := visited[n]; exists {
            return cloned
        }

        newNode := &Node{Val: n.Val}
        visited[n] = newNode

        for _, neighbor := range n.Neighbors {
            newNode.Neighbors = append(newNode.Neighbors, clone(neighbor))
        }

        return newNode
    }

    return clone(node)
}
```

### Junior → FAANG: Clone Graph as a Template for Graph Copy Problems

The visited map pattern in the Clone Graph solution is reusable for any graph copy or transformation problem:

1. Create a map from old node to new node.
2. Before recursing into a node's neighbors, add the new node to the map.
3. When you encounter a node that is already in the map, return the mapped node without recursing.

Step 2 (adding to the map before recursing) is critical for correctness on cyclic graphs. If you recurse first and add to the map after, a cycle will cause infinite recursion.

This same pattern appears in serialization (converting a graph to JSON, avoiding infinite loops from cycles), transformation (converting one graph type to another), and memoization (avoiding recomputation in recursive algorithms over graphs).

Practice: implement Clone Graph, then extend it to deep-copy a graph where each node carries a `map[string]interface{}` payload. This extension tests whether you understand the pattern versus just memorized the specific code.

### Senior @ FAANG: Graph Copy Semantics in Distributed Systems

The Clone Graph problem formalizes a fundamental question in distributed systems: what are the semantics of copying a data structure across a network boundary?

Separate two cases that are easy to blur together, because the answer differs completely.

**Within one address space**, the choice is real: share references (cheap, but the receiver sees the sender's mutations) or deep copy (isolated, but O(V+E) every time). Clone Graph is the deep-copy algorithm, and the identity map is what preserves sharing structure rather than merely terminating.

**Across a network boundary there is no choice at all.** Two processes share no address space, so a pointer means nothing on the far side. Every cross-service send is already a deep copy by construction: serialization flattens the object graph and the receiver rebuilds it. This is why "use copy-on-write to avoid the deep copy over the network" is not a thing. What serialization *does* need from Clone Graph is the identity map, because a format that follows references blindly will loop forever on a cycle, and one that ignores identity will silently duplicate shared substructure and lose the fact that two fields pointed at the same object.

Copy-on-write is the right answer to the in-process (or shared-storage) version of the question: share until someone writes, then copy just the touched part. That is the basis of MVCC snapshots in databases and of the copy-on-write B-trees in local filesystems such as ZFS and Btrfs. Distributed systems get similar leverage from immutability plus content addressing, where an unchanged subgraph simply is not resent, which is the same idea reached by a different road.

A staff engineer designing a replication or caching layer picks between these explicitly: always-deep-copy (strong isolation, high cost), copy-on-write (lazy isolation, lower cost, in-process or shared-storage only), and reference sharing with explicit synchronization (no isolation, cheapest, riskiest). Document the choice in the service contract and verify it with integration tests that deliberately mutate the shared structure and assert the other side does not observe it. That test is the only thing standing between "we chose sharing" and "we accidentally chose sharing".

---
