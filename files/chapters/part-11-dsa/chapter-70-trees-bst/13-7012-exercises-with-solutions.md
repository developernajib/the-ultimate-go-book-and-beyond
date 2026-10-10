## 70.11 Exercises with Solutions

### Exercise 1: Serialize and Deserialize BST

Serializing a BST is more compact than serializing a general binary tree because you do not need to encode null sentinels: the BST ordering invariant alone is sufficient to unambiguously reconstruct the tree during deserialization. The trick is to use a preorder traversal for serialization (so the root is always encountered first), then rebuild recursively by passing `[min, max]` bounds. Any value outside those bounds signals that the current subtree has ended and control should return to the caller without consuming the next token.

```go
import (
    "math"
    "strconv"
    "strings"
)

type Codec struct{}

func (c *Codec) serialize(root *TreeNode) string {
    if root == nil {
        return ""
    }

    var sb strings.Builder
    var preorder func(*TreeNode)
    preorder = func(node *TreeNode) {
        if node == nil {
            return
        }
        sb.WriteString(strconv.Itoa(node.Val))
        sb.WriteString(",")
        preorder(node.Left)
        preorder(node.Right)
    }

    preorder(root)
    return sb.String()
}

func (c *Codec) deserialize(data string) *TreeNode {
    if data == "" {
        return nil
    }

    vals := strings.Split(data, ",")
    idx := 0

    var build func(min, max int) *TreeNode
    build = func(min, max int) *TreeNode {
        if idx >= len(vals) || vals[idx] == "" {
            return nil
        }

        val, _ := strconv.Atoi(vals[idx])
        if val < min || val > max {
            return nil
        }

        idx++
        return &TreeNode{
            Val:   val,
            Left:  build(min, val),
            Right: build(val, max),
        }
    }

    // Bound with the full range of int, not int32. TreeNode.Val is an int,
    // which is 64-bit on every platform this book targets, so -1<<31 would
    // silently reject any legitimate value outside the int32 range.
    //
    // These sentinels are safe here (unlike in BST *validation*) because the
    // comparisons are inclusive: nothing is < math.MinInt or > math.MaxInt, so
    // a node holding either extreme is still accepted.
    return build(math.MinInt, math.MaxInt)
}
```

### Junior -> FAANG: BST Serialization Compared to General Tree Serialization

The BST-specific serializer is more compact than the general tree serializer (LC 297) because it omits null sentinels. The general tree serializer must write "null" for every absent child because the tree is not ordered, so the deserializer cannot infer from values alone which elements belong to which subtree. The BST serializer exploits the BST property: during deserialization, `[min, max]` bounds are passed down the recursion and any value outside the bounds signals "this subtree is empty, return nil." This elegantly encodes tree structure in the value ordering itself.

Watch the bounds type. Writing `build(-1<<31, 1<<31-1)` is a reflex imported from languages where `int` means 32 bits, and it is wrong here: Go's `int` is 64-bit on every platform this book targets, so those literals silently reject any legitimate node outside the int32 range. The fix is `math.MinInt` and `math.MaxInt`.

It is worth being precise about why sentinels are acceptable here but not in BST *validation*. The comparison in this deserializer is inclusive (`val < min || val > max`), so a node holding exactly `math.MinInt` still passes, and the sentinel cannot be confused with real data. In validation the same trick fails, because there you must distinguish "no bound on this side" from "bounded at MinInt", and a sentinel cannot express that difference. That is why the validation code uses nil pointers for unbounded. Same-looking problem, different correct answer, and the deciding question is whether the sentinel value can ever collide with real data in a way that changes the outcome.

Practice coding both serializers (general BFS and BST preorder) from memory. Being able to explain why the BST version is more compact demonstrates deep understanding of the BST invariant.

### Senior @ FAANG: Serialization Format Design at Platform Scale

The serialization format shown here (comma-separated integers) is readable but not efficient at scale. A BST representing a routing table or permission hierarchy can contain millions of nodes, and the decimal format costs one byte per digit plus a separator, so its size depends on the values rather than only on the node count. A fixed-width binary encoding costs exactly 8 bytes per node for an `int`, which is a loss for small values and a large win for big ones, and it removes the `strconv.Atoi` parse entirely. Measure against your actual value distribution instead of assuming, because "binary is smaller" is false for a tree of single-digit numbers.

Protocol Buffer encoding (varint + field numbers) would be the production choice: variably-width integers for smaller values, deterministic field ordering, forward-compatible schema evolution. A staff engineer designing a tree serialization protocol asks: "What is the expected value distribution? What is the read-to-write ratio for serialized data? Will this format need to evolve over time without breaking existing readers?" The answers determine whether to use a text format (human readable, debuggable, slightly larger), a binary format (compact, fast), or a schema-aware format like protobuf (compact, fast, and schema-evolvable).

The deserialize function's recursive bounds approach is also a form of speculative decoding: the deserializer makes assumptions about the tree structure based on the BST invariant and backtracks (returns nil) when those assumptions are violated. This pattern appears in parser combinator designs and is a useful mental model for any recursive descent parsing problem.

---
