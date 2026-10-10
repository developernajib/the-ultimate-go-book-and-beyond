## 67.14 Interview Pitfalls

### Pitfall 1: Losing the Head Reference

**Failure mode**: A candidate writes code to reverse a linked list but reuses `head` as the loop cursor, so by the time the loop ends there is nothing left pointing at the result. The tell is a `return head` that returns a node from the middle of the list.

```go
// ❌ WRONG: Losing head reference
func reverseBad(head *ListNode) *ListNode {
    for head.Next != nil {  // Also crashes on nil!
        next := head.Next
        head.Next = next.Next
        next.Next = head
        head = next  // We keep moving head, but need to track new head!
    }
    return head  // Wrong! This is some middle node
}

// ✅ CORRECT: Track the new head properly
func reverseGood(head *ListNode) *ListNode {
    var prev *ListNode
    curr := head

    for curr != nil {
        next := curr.Next  // Save next
        curr.Next = prev   // Reverse link
        prev = curr        // Move prev forward
        curr = next        // Move curr forward
    }

    return prev  // prev is now the new head
}
```

### Pitfall 2: Off-by-One in Two-Pointer Distance

**Failure mode**: Both pointers start at `head` rather than at a dummy node, so the gap is off by one and `slow` ends up *on* the target instead of one before it. The result is two different bugs depending on which node you asked to remove, which is what makes it confusing to debug.

```go
// ❌ WRONG: Off-by-one gap calculation
func removeNthFromEndBad(head *ListNode, n int) *ListNode {
    fast, slow := head, head

    // Move fast n steps
    for i := 0; i < n; i++ {
        fast = fast.Next
    }

    // slow now lands ON the target, not one before it.
    for fast != nil {
        fast = fast.Next
        slow = slow.Next
    }

    // Two distinct failures, and it is worth being exact about which is which:
    //
    //   n == 1 (remove the LAST node): slow walks all the way to the last
    //     node, slow.Next is nil, and slow.Next.Next PANICS.
    //
    //   n == len (remove the FIRST node): fast is already nil, so the second
    //     loop never runs and slow stays at head. This does NOT panic. It
    //     quietly deletes the SECOND node and returns a wrong list, which is
    //     the more dangerous outcome because nothing announces the bug.
    //
    // On [1,2] with n=2 this returns [1] - the correct answer is [2].
    slow.Next = slow.Next.Next
    return head
}

// ✅ CORRECT: Use dummy node to handle edge cases
func removeNthFromEndGood(head *ListNode, n int) *ListNode {
    dummy := &ListNode{Next: head}
    fast, slow := dummy, dummy

    // Move fast n+1 steps (so slow lands BEFORE target)
    for i := 0; i <= n; i++ {
        fast = fast.Next
    }

    for fast != nil {
        fast = fast.Next
        slow = slow.Next
    }

    slow.Next = slow.Next.Next
    return dummy.Next
}
```

### Pitfall 3: Not Handling Nil and Single-Node Cases

**Failure mode**: A recursive merge that dereferences before checking works on every hand-written example and panics the first time a list runs out. Since the recursion always ends with one list empty, this crashes on essentially every non-trivial input, not just on an empty argument.

```go
// ❌ WRONG: Assumes both lists have nodes
func mergeTwoListsBad(l1, l2 *ListNode) *ListNode {
    if l1.Val < l2.Val {  // Crashes if either is nil!
        l1.Next = mergeTwoListsBad(l1.Next, l2)
        return l1
    }
    l2.Next = mergeTwoListsBad(l1, l2.Next)
    return l2
}

// ✅ CORRECT: Check nil cases first
func mergeTwoListsGood(l1, l2 *ListNode) *ListNode {
    // Base cases - one or both lists empty
    if l1 == nil {
        return l2
    }
    if l2 == nil {
        return l1
    }

    if l1.Val < l2.Val {
        l1.Next = mergeTwoListsGood(l1.Next, l2)
        return l1
    }
    l2.Next = mergeTwoListsGood(l1, l2.Next)
    return l2
}
```

### Pitfall 4: Cycle Detection Without Proper Termination

**Failure mode**: Cycle detection written as an unconditional `for { }` on the assumption that a cycle always exists. On an acyclic list the fast pointer walks off the end and panics rather than returning false.

```go
// ❌ WRONG: Infinite loop risk
func hasCycleBad(head *ListNode) bool {
    slow, fast := head, head

    for {  // No exit condition!
        slow = slow.Next
        fast = fast.Next.Next  // Crashes if fast.Next is nil!
        if slow == fast {
            return true
        }
    }
}

// ✅ CORRECT: Check for nil and proper termination
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

    return false  // fast reached end, no cycle
}
```

### Pitfall 5: Modifying List While Iterating

**Failure mode**: A worker unlinks nodes from the queue it is walking and advances its cursor in the same step. Because the removal already moved the chain forward, advancing again steps over the node that took the removed one's place. In a work queue this reads as items being silently skipped, and it is load-dependent: it only misfires when two removable items happen to land next to each other, so it survives testing and shows up in production.

```go
// ❌ WRONG: advances past the node that replaced the removed one.
// This is the real bug, and it is subtle: the list IS modified, and the
// result looks right on most inputs.
func removeValuesBad(head *ListNode, val int) *ListNode {
    curr := head
    for curr != nil {
        if curr.Next != nil && curr.Next.Val == val {
            curr.Next = curr.Next.Next // unlink; a new node slides into place
        }
        curr = curr.Next // BUG: never inspects that new node
    }
    return head
}

// On [1, 2, 2, 3] removing 2, this returns [1, 2, 3]: the first 2 is
// unlinked, the second 2 slides into its place, and the unconditional
// advance skips straight past it. A single stray 2 survives.
// It also cannot remove the head at all, since nothing precedes it.

// ✅ CORRECT: Save next before modifying, use dummy node
func removeValuesGood(head *ListNode, val int) *ListNode {
    dummy := &ListNode{Next: head}
    prev := dummy
    curr := head

    for curr != nil {
        if curr.Val == val {
            prev.Next = curr.Next  // Remove current
            // Don't advance prev
        } else {
            prev = curr  // Only advance prev when keeping node
        }
        curr = curr.Next  // Always advance curr
    }

    return dummy.Next
}
```

### Interview Pitfalls Quick Reference

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Lost head reference | Can't return result | Use prev pointer, track new head |
| Off-by-one in gap | Wrong node deleted | Use dummy node, count carefully |
| Nil pointer crash | Runtime panic | Always check nil before accessing |
| Infinite cycle loop | Program hangs | Check fast && fast.Next != nil |
| Iterator corruption | Skipped/duplicate nodes | Save next pointer before modifying |
| Forgetting base cases | Empty list crash | Handle nil and single-node first |

### Junior -> FAANG: Using Incident Reports to Build Interview Intuition

The five failure modes in this section are the ones that actually end interviews. Reading them as stories rather than as code fixes builds the intuition needed to avoid them under pressure.

**Pitfall 1 (lost head in reversal):** This is the most common failure in entry-level reversal implementations. The fix is to use three pointers (`prev`, `curr`, `next`) and never reassign `head` during the loop. Memorize the three-line loop body: `next = curr.Next; curr.Next = prev; prev = curr; curr = next`. Write it without looking at reference code.

**Pitfall 2 (off-by-one in two-pointer gap):** The dummy node solves this completely. By starting both fast and slow at the dummy, moving fast `n+1` steps forward means that when fast reaches nil, slow is exactly one node before the target. Draw a five-node list, remove the second-to-last node (n=2), and trace both the bad and good versions. Then trace n=1 and n=5 specifically: those are the two ends where the bad version fails, and they fail differently, one by panicking and one by returning a plausible wrong answer.

**Pitfall 3 (nil on merge):** The base cases for recursive merge must come before any dereference. `if l1 == nil { return l2 }` and `if l2 == nil { return l1 }` are mandatory first lines. Any recursive linked list function must handle nil input before accessing any field.

**Pitfall 4 (infinite loop in cycle detection):** The loop condition `for fast != nil && fast.Next != nil` is the exact guard required. Practice writing it as a single phrase: "fast and fast-dot-next." Never use `for true` or `for {}` in cycle detection.

**Pitfall 5 (iterator corruption):** Always use a `prev` pointer and advance `curr` unconditionally. The `prev` pointer advances only when the current node is kept. The `curr` pointer advances on every iteration. Writing the loop structure with both pointers before filling in the conditional body prevents this class of bug. Test it with *adjacent* removable values (`[1,2,2,3]` removing 2) and with the target at the head, because a list where no two removable nodes touch will not expose the bug.

### Senior @ FAANG: Pitfalls as Systemic Risk Indicators

**Pitfall 1 as a code review pattern.** The head-loss bug is almost always caught in code review if reviewers check the return statement. Any function that accepts a `*ListNode` and returns a `*ListNode` should be reviewed by asking: "Can the return value be different from the input head?" If yes, the function must track the new head explicitly, and every call path must arrive at the correct return value. Adding this to the linked list section of a team's code review checklist prevents this pitfall from reaching production.

**Pitfall 2 as a test-driven development signal.** The off-by-one in `RemoveNthFromEnd` is exactly the kind of bug that table-driven tests with boundary values catch automatically. A test table that includes `{n: len(list), expected: head.Next}` (removing the first node) and `{n: 1, expected: all-but-last}` (removing the last node) would have caught this before review. Mandating boundary-value tests for all two-pointer functions is an L5 code review standard.

**Pitfall 3 as a nil-safety culture issue.** In Go, unlike languages with null-safety type systems (Kotlin, Swift, Rust), nil pointer dereferences are runtime panics. Teams that write a lot of linked list or tree code should consider a team norm: "Every exported function that accepts a pointer parameter must handle nil as a valid input." This norm is easier to enforce than a code review checklist because it is testable: add a test that calls every function with nil and verify no panic.

**Pitfall 5 as a production severity example.** Picture this bug in a payment queue: a worker unlinks processed entries while walking the chain and silently skips every transaction that follows another removable one. That is a Severity 1 defect, and its signature is the worst kind: no panic, no error log, correct behavior on every small test, and a defect rate that rises with load because adjacency of removable items gets more likely as the queue fills.

The general root cause is mutating a structure while a cursor walks it. Be precise about how this actually manifests in Go, because the folklore is unreliable:

- **Deleting from a `map` during `range`:** permitted by the spec. Entries not yet reached may or may not be produced, so the iteration is non-deterministic but not unsafe.
- **Appending to a slice during `range` over that slice:** well defined and frequently misdescribed. The range expression is evaluated once, so the loop runs exactly `len(s)` times as measured at entry and never sees the appended elements. It does not depend on backing array growth. The bug, when there is one, is the programmer expecting the loop to grow.
- **Concurrent map write during `range`:** genuinely fatal. The runtime throws "concurrent map writes" and the process dies unrecoverably.
- **Unlinking a linked list node under a cursor:** the case in this section, and the one with no runtime protection at all.

The fix differs by case, which is why lumping them together is unhelpful: for maps, iterate a snapshot of keys if you need determinism - for the linked list, keep a `prev` and advance it only when you keep a node.

---
