## 67.7 Common Patterns and Mistakes

### Pattern Summary

Recognizing which pattern to apply before writing any code is what separates fast, correct solutions from time-consuming dead ends. The decision tree below maps the structural property of the problem (cycle detection, order reversal, merging, etc.) directly to the canonical technique that solves it in optimal time and space. Internalising this mapping lets you immediately pick a starting approach rather than trial-and-erroring through implementations.

```
┌─────────────────────────────────────────────────────────────────┐
│                 LINKED LIST PATTERN DECISION TREE               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Problem Type                    Pattern to Use                 │
│  ─────────────                   ──────────────                 │
│                                                                 │
│  Find middle/cycle?     ───────► Fast-Slow Pointers             │
│                                                                 │
│  Edge cases complex?    ───────► Dummy Node                     │
│                                                                 │
│  Change order?          ───────► In-Place Reversal              │
│                                                                 │
│  Combine lists?         ───────► Merge Technique                │
│                                                                 │
│  K-th from end?         ───────► Two Pointers (n-k gap)         │
│                                                                 │
│  Duplicate node refs?   ───────► Hash Map                       │
│                                                                 │
│  Sorted lists?          ───────► Two Pointers / Merge           │
│                                                                 │
│  Recursive structure?   ───────► Recursion / Stack              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Common Mistakes

Linked list bugs almost always stem from the same four failure modes: overwriting the head pointer before saving it, dereferencing without a nil guard, trying to remove a node while holding only a reference to it (rather than its predecessor), and choosing the wrong loop termination condition for the fast-slow middle-finding algorithm. The examples below show the broken version alongside the correct fix so the exact difference is visible.

```go
package linkedlist

// Mistake 1: Losing reference to head
// WRONG:
func wrongDelete(head *ListNode, val int) *ListNode {
    for head != nil && head.Val == val {
        head = head.Next // We're modifying head!
    }
    return head // What if all nodes were deleted?
}

// CORRECT: Use dummy node
func correctDelete(head *ListNode, val int) *ListNode {
    dummy := &ListNode{Next: head}
    curr := dummy

    for curr.Next != nil {
        if curr.Next.Val == val {
            curr.Next = curr.Next.Next
        } else {
            curr = curr.Next
        }
    }

    return dummy.Next
}

// Mistake 2: Not handling nil cases
// WRONG:
func wrongReverse(head *ListNode) *ListNode {
    prev := head.Next // Panics if head is nil!
    // ...
    return prev
}

// CORRECT: Handle nil
func correctReverse(head *ListNode) *ListNode {
    if head == nil {
        return nil
    }
    // ...
    return head
}

// Mistake 3: Modifying while iterating
// WRONG:
func wrongRemove(head *ListNode) *ListNode {
    curr := head
    for curr != nil {
        if curr.Val == 0 {
            // Can't remove curr while iterating!
        }
        curr = curr.Next
    }
    return head
}

// CORRECT: Use prev pointer
func correctRemove(head *ListNode) *ListNode {
    dummy := &ListNode{Next: head}
    prev := dummy

    for prev.Next != nil {
        if prev.Next.Val == 0 {
            prev.Next = prev.Next.Next
        } else {
            prev = prev.Next
        }
    }

    return dummy.Next
}

// Mistake 4: Wrong fast-slow initialization for finding middle
// For finding first middle (1,2,3,4 -> 2):
func firstMiddle(head *ListNode) *ListNode {
    // Required: this loop reads fast.Next before any check, so without
    // the guard it panics on the empty list. Note that secondMiddle
    // below tests fast != nil first and so needs no guard. The two
    // variants differ in nil safety, not only in which middle they pick.
    if head == nil {
        return nil
    }

    slow, fast := head, head
    for fast.Next != nil && fast.Next.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }
    return slow
}

// For finding second middle (1,2,3,4 -> 3):
func secondMiddle(head *ListNode) *ListNode {
    slow, fast := head, head
    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }
    return slow
}
```

### Junior -> FAANG: Internalizing the Decision Tree

The pattern decision tree at the top of this section is the most valuable artifact in the chapter for interview preparation. Before every linked list problem, run through it mentally: "Does this problem ask me to find a cycle, middle, or intersection? Use fast-slow. Does it ask me to simplify edge cases involving head deletion? Use a dummy node. Does it ask me to change the order of nodes? Use in-place reversal."

The four common mistakes in this section are all categories of bugs you will produce unless you actively guard against them:

1. **Losing the head reference**: Use a dummy node or a separate return variable. Never iterate with `head` directly.
2. **Missing nil checks**: Treat nil as a valid input representing the empty list, not an error.
3. **Modifying while iterating**: Always hold a `prev` pointer so you can rewire without losing the forward chain.
4. **Wrong fast-slow initialization**: Commit to memory which termination condition produces the first vs. second middle.

**Interview practice protocol:** Implement each of the four "CORRECT" versions from memory without looking at the code. Time yourself. A junior candidate should be able to write `correctDelete` in under two minutes, and `correctRemove` in under three minutes. Fluency at this level signals to interviewers that these are reflexes, not recalled facts.

### Senior @ FAANG: Pattern Governance and Code Review Standards

**Codifying patterns as code review checklists.** A senior engineer's job includes setting standards that prevent the common mistakes above at the team level. A linked list code review checklist might include: (1) Is there a nil guard at the function entry for every pointer parameter? (2) Is a dummy node used whenever the function might return a new head? (3) Is the loop termination condition for fast-slow explicitly justified by a comment? (4) Is there a test case for nil input, single-node input, and two-node input?

**Pattern selection as an ADR artifact.** When a team member proposes a linked list solution to a problem that is better solved with a slice, the code review should include an explicit ADR-style note: "We considered a linked list for O(1) mid-sequence deletion but chose a slice because the actual access pattern is append-only and the O(n) slice shift is only triggered on cancellation, which happens at less than 1% of the event rate." This reasoning prevents future engineers from "optimizing" the slice to a linked list based on theoretical complexity without empirical evidence.

**Mistake 3 (modifying while iterating) as a production incident pattern.** The payment-queue pitfall in `17-6712-interview-pitfalls.md` is the same bug wearing a business costume: a worker mutates the queue it is walking and drops or double-processes entries. Two Go idioms that look like this bug are worth ruling out, because engineers cite them often and both are wrong:

- Deleting from a `sync.Map` inside a `Range` callback is explicitly permitted. The godoc only warns that `Range` does not necessarily reflect a consistent snapshot, not that mutation is unsafe.
- Appending to a slice inside `for i := range s` does not produce an unbounded loop. The range expression is evaluated once, so the loop runs over the original length.

The genuine Go instances of this class are: deleting keys from a plain `map` while ranging it, where the spec says entries not yet reached may or may not be produced, so the iteration is non-deterministic rather than merely surprising; and holding a `*ListNode` cursor while another function unlinks the node under it, which is exactly the linked list bug. The fix in all cases is the same: iterate over a snapshot, or advance a predecessor pointer rather than mutating the structure the cursor is standing on.

**Fast-slow wrong initialization as a systemic risk.** The distinction between `firstMiddle` and `secondMiddle` is a correctness-under-composition issue. If a caller assumes it receives the first middle but the implementation returns the second middle, a palindrome check or list reversal produces wrong results for even-length lists. In a production library, this is a contract that must be documented in the function's godoc and tested with even-length inputs as explicit test cases. A senior engineer reviewing a PR that adds or modifies a middle-finding function should immediately check whether the existing tests cover even-length inputs.
