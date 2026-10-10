## 67.11 Common Mistakes (Extended)

### Mistake 1: Not Using Dummy Nodes for Edge Cases

Linked-list problems that may delete the head node require special-casing when the head itself is removed, leading to verbose conditional branches at the start of the function. A dummy node placed before the head eliminates this asymmetry: the head is treated like any other node, because `dummy.Next` always points to whatever is currently first in the list. This pattern is especially valuable in problems like deleting all duplicates, where the original head may need to be removed entirely.

```go
// ❌ BAD: Complex edge case handling without dummy
func deleteDuplicatesBad(head *ListNode) *ListNode {
    if head == nil || head.Next == nil {
        return head
    }

    // Complex handling for head deletion
    for head != nil && head.Next != nil && head.Val == head.Next.Val {
        val := head.Val
        for head != nil && head.Val == val {
            head = head.Next
        }
    }

    if head == nil {
        return nil
    }

    curr := head
    for curr.Next != nil && curr.Next.Next != nil {
        if curr.Next.Val == curr.Next.Next.Val {
            val := curr.Next.Val
            for curr.Next != nil && curr.Next.Val == val {
                curr.Next = curr.Next.Next
            }
        } else {
            curr = curr.Next
        }
    }

    return head
}

// ✅ GOOD: Clean solution with dummy node
func deleteDuplicatesGood(head *ListNode) *ListNode {
    dummy := &ListNode{Next: head}
    prev := dummy

    for head != nil {
        if head.Next != nil && head.Val == head.Next.Val {
            // Skip all duplicates
            for head.Next != nil && head.Val == head.Next.Val {
                head = head.Next
            }
            prev.Next = head.Next
        } else {
            prev = prev.Next
        }
        head = head.Next
    }

    return dummy.Next
}
```

### Mistake 2: Incorrect Cycle Detection Loop Condition

Floyd's cycle-detection algorithm advances the fast pointer two steps per iteration, so the loop guard must verify that both `fast` and `fast.Next` are non-nil before dereferencing `fast.Next.Next`. Checking only `fast.Next` leaves a window where `fast` itself is nil after the last valid step, causing a nil-pointer panic on the next dereference. The correct guard `fast != nil && fast.Next != nil` makes both conditions explicit and handles lists of any length.

```go
// ❌ BAD: Wrong loop condition causes nil pointer
func hasCycleBad(head *ListNode) bool {
    slow, fast := head, head

    // Bug: Should check fast AND fast.Next
    for fast.Next != nil {  // PANIC when fast is nil
        slow = slow.Next
        fast = fast.Next.Next
        if slow == fast {
            return true
        }
    }

    return false
}

// ✅ GOOD: Correct loop condition
func hasCycleGood(head *ListNode) bool {
    if head == nil || head.Next == nil {
        return false
    }

    slow, fast := head, head

    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
        if slow == fast {
            return true
        }
    }

    return false
}
```

### Mistake 3: Memory Leak When a Removed Node Escapes

This mistake is worth stating precisely, because the usual telling of it is wrong. You will often read that unlinking a node without setting `toDelete.Next = nil` leaks memory, on the theory that the removed node still points at its successor. That is reference-counting reasoning, and Go does not use reference counting. Go's collector is a tracing collector: it starts from the roots (goroutine stacks and globals) and marks what it can reach. A node that nothing points to is unreachable no matter what it points at, and the entire unlinked subgraph is collected in one cycle. Cyclic garbage is collected for the same reason.

So in the function below, `toDelete.Next = nil` accomplishes nothing at all. The node is already unreachable the instant `curr.Next` is redirected past it.

```go
// Both of these are equivalent from the GC's perspective. Once the node is
// unlinked and no one else holds it, it is unreachable and collectable,
// with or without the nil assignment.
func removeValue(head *ListNode, val int) *ListNode {
    dummy := &ListNode{Next: head}
    curr := dummy

    for curr.Next != nil {
        if curr.Next.Val == val {
            curr.Next = curr.Next.Next // removed node becomes unreachable here
        } else {
            curr = curr.Next
        }
    }

    return dummy.Next
}
```

The leak is real, but it needs one extra ingredient: **the removed node must survive the call**. The moment a removal API hands the node back to the caller, or stashes it in a free list, that node is reachable again, and its stale `Next` pointer pins every node behind it.

```go
// ❌ BAD: returns the removed node with its Next pointer intact.
// The caller holds one small node and unknowingly pins the entire tail
// of the list, which the GC can never reclaim.
func (l *List) RemoveBad(node *ListNode) *ListNode {
    node.Prev.Next = node.Next
    node.Next.Prev = node.Prev
    return node // node.Next and node.Prev still point into the live list
}

// ✅ GOOD: sever the removed node's outbound pointers before releasing it.
func (l *List) Remove(node *ListNode) *ListNode {
    node.Prev.Next = node.Next
    node.Next.Prev = node.Prev

    // Required: the caller keeps this node, so its pointers must not
    // reach back into the list.
    node.Next = nil
    node.Prev = nil

    return node
}
```

This is not a hypothetical. The standard library does exactly this, and says so. From `container/list`:

```go
func (l *List) remove(e *Element) {
    e.prev.next = e.next
    e.next.prev = e.prev
    e.next = nil // avoid memory leaks
    e.prev = nil // avoid memory leaks
    e.list = nil
    l.len--
}
```

`list.Remove` returns `e.Value` to the caller and the `*Element` may outlive the list, which is precisely why those two lines exist. The rule to carry away: nil out a removed node's pointers when the node escapes, and do not bother when it does not. Knowing which case you are in is the actual skill.

### Mistake 4: Not Preserving Original Head Reference

Go passes pointer parameters by value, so reassigning `head` inside a function only modifies the local copy. The caller's pointer is unaffected. However, the function itself loses its reference to the original head when it reuses the parameter as an iteration cursor, making it impossible to return the start of the list. Using a separate `curr` variable for traversal leaves `head` intact so it can be returned without any additional bookkeeping.

```go
// ❌ BAD: Returns wrong value after modification
func getLengthBad(head *ListNode) (int, *ListNode) {
    length := 0
    for head != nil {
        length++
        head = head.Next  // Modifying the parameter!
    }
    return length, head  // head is nil now!
}

// ✅ GOOD: Use separate variable
func getLengthGood(head *ListNode) (int, *ListNode) {
    length := 0
    curr := head
    for curr != nil {
        length++
        curr = curr.Next
    }
    return length, head  // Original head preserved
}
```

### Mistake 5: Wrong Reversal Between Positions

Reversing a sublist in place requires re-wiring three pointers in the correct order on each iteration: the extracted node must point to `prev.Next` (the current head of the reversed segment), and `prev.Next` must then be updated to point to the extracted node. The bad version connects `next.Next` directly to `curr` instead. On the first iteration the two are indistinguishable, because `prev.Next` and `curr` are the same node at that moment. From the second iteration on they diverge, and the extracted node gets spliced onto the segment's tail instead of its head, orphaning whatever the head was.

The failure is worse than "partially reversed". On `[1, 2, 3, 4, 5]` with left=2 and right=4 the bad version returns `[1, 4, 2, 5]`: node 3 is dropped from the list entirely and the output is shorter than the input. A test that only checks the first and last elements, or only checks that the output is a permutation of some prefix, will pass this. Assert the full sequence and the length.

```go
// ❌ BAD: Incorrect connection after reversal
func reverseBetweenBad(head *ListNode, left, right int) *ListNode {
    dummy := &ListNode{Next: head}
    prev := dummy

    for i := 1; i < left; i++ {
        prev = prev.Next
    }

    curr := prev.Next
    for i := 0; i < right-left; i++ {
        next := curr.Next
        curr.Next = next.Next
        next.Next = curr  // Bug: Should point to prev.Next
        prev.Next = next
    }

    return dummy.Next
}

// ✅ GOOD: Correct insertion after prev
func reverseBetweenGood(head *ListNode, left, right int) *ListNode {
    dummy := &ListNode{Next: head}
    prev := dummy

    // Move to node before left
    for i := 1; i < left; i++ {
        prev = prev.Next
    }

    curr := prev.Next

    // Reverse by inserting next node after prev
    for i := 0; i < right-left; i++ {
        next := curr.Next
        curr.Next = next.Next
        next.Next = prev.Next  // Point to current head of reversed section
        prev.Next = next       // Update prev to point to new head
    }

    return dummy.Next
}
```

### Junior -> FAANG: Systematic Bug Prevention

The five mistakes in this section are the five most common sources of linked list bugs in entry-level interview code. Memorizing the correct pattern for each is not enough. You need to understand the underlying cause so you can catch variants of the same bug.

**Mistake 1 (no dummy node):** The root cause is treating the head node as special. The dummy node pattern eliminates this specialness by giving every node, including the head, a predecessor. Internalize: "If my function might return a new head, add a dummy node."

**Mistake 2 (wrong cycle detection guard):** The root cause is reasoning about `fast.Next` without checking `fast` first. The invariant is: to access `fast.Next.Next`, you need `fast != nil` AND `fast.Next != nil`. Write these two conditions in that order, every time, without exception.

**Mistake 3 (memory leak):** Get the direction right. Go's collector traces from the roots, so a node with no *inbound* pointer is collected regardless of its *outbound* pointers. Clearing `Next` on a node that nobody holds is a no-op. It matters only when the removed node escapes: returned to the caller, pushed into a `sync.Pool`, or kept in a free list. Then its stale `Next` pins the whole tail. The question to ask at every removal is simply "does this node outlive the call?"

**Mistake 4 (parameter overwrite):** In Go, pointer parameters are passed by value. You can mutate what the pointer points to, but reassigning the pointer itself does not affect the caller. Assign `head` to a local `curr` at the function entry and use `curr` for iteration. Return whatever you want the caller to see as the new head.

**Mistake 5 (wrong sublist reversal):** The critical detail is `next.Next = prev.Next`, not `next.Next = curr`. The distinction is: `prev.Next` is the current head of the reversed segment, which changes on every iteration. `curr` is the tail of the reversed segment, which never moves. They happen to be equal on the first iteration, which is exactly why the bug survives a two-element test and then drops nodes on anything longer. Any time two expressions are coincidentally equal at loop entry, make sure your test data runs the loop at least twice.

### Senior @ FAANG: Mistake Categories as Code Review Signals

Each of the five mistakes in this section corresponds to a category of review comment that senior engineers should be able to articulate precisely.

**Mistake 1 in code reviews.** The review comment should explain the specific edge case that the missing dummy node fails to handle, not just say "add a dummy node." Example: "This function fails when the head is a duplicate because the loop starts at `head.Next` and never examines `head`. Add a dummy node and start at `dummy`."

**Mistake 2 as a fuzz target.** The cycle detection guard is exactly the kind of boundary condition that fuzzing finds effectively. A fuzzer that generates linked lists with lengths 0, 1, 2, 3, and random lengths will hit the nil dereference on the first nil-terminated list. Any production linked list library should have fuzz tests for cycle detection, middle finding, and reversal.

**Mistake 3 as a GC concern.** The failure mode is retention through an escaped node, and it is worth being able to reason about it precisely under memory profiling. If a removal API returns a node whose `Next` still points into the list, then any caller that caches that node, even one node in a map of "recently removed" entries, holds the entire tail live. The GC is behaving correctly: there genuinely is a path from a root to those nodes. In a heap profile this shows up as live memory attributed to the original list-building callsite, long after the list itself is logically gone, which is confusing precisely because the retaining reference is somewhere else entirely. `go tool pprof` heap profiles tell you where memory was allocated, not what is keeping it alive, so the allocation site is a red herring. The tool that answers "what is retaining this" is a heap dump inspected with `viewcore`, or simply auditing every API that hands out a node. The design-level fix is to not hand out nodes at all: return values, not `*Element`, and the class of bug disappears.

**Mistake 4 as an API contract issue.** In a public package, a function that modifies a linked list should document whether it returns the original head, a new head, or whether the caller must discard their previous head reference. Failure to document this is the API contract equivalent of Mistake 4: callers who hold the old head will observe a corrupted list if they continue to use it after a head-changing operation.

**Mistake 5 as an invariant documentation requirement.** The reversal-between-positions algorithm maintains the invariant that `prev.Next` always points to the current head of the growing reversed segment. This invariant should be documented as a comment inside the loop. Without the comment, the next engineer to read the code must re-derive the invariant from the pointer assignments, which is error-prone and time-consuming.

---
