## 67.3 Fast-Slow Pointer Technique

The fast-slow pointer (Floyd's cycle detection) is a fundamental technique for linked list problems.

```
┌─────────────────────────────────────────────────────────────────┐
│                  FAST-SLOW POINTER TECHNIQUE                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Finding Middle:                                                │
│                                                                 │
│  Step 1: slow = 1, fast = 1                                     │
│       ↓                                                         │
│  [1] → [2] → [3] → [4] → [5] → nil                              │
│       ↓                                                         │
│                                                                 │
│  Step 2: slow = 2, fast = 3                                     │
│            ↓                                                    │
│  [1] → [2] → [3] → [4] → [5] → nil                              │
│                 ↓                                               │
│                                                                 │
│  Step 3: slow = 3, fast = 5                                     │
│                 ↓ (MIDDLE!)                                     │
│  [1] → [2] → [3] → [4] → [5] → nil                              │
│                           ↓                                     │
│                                                                 │
│  When fast reaches end, slow is at middle                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
package linkedlist

// FindMiddle returns the middle node of a linked list
// For even-length lists, returns the second middle node
// Time: O(n), Space: O(1)
func FindMiddle(head *ListNode) *ListNode {
    if head == nil {
        return nil
    }

    slow, fast := head, head

    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }

    return slow
}

// FindMiddleFirst returns the first middle for even-length lists
// Time: O(n), Space: O(1)
func FindMiddleFirst(head *ListNode) *ListNode {
    if head == nil {
        return nil
    }

    slow, fast := head, head

    // Stop when fast.Next.Next would be nil
    for fast.Next != nil && fast.Next.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }

    return slow
}

// HasCycle detects if a linked list has a cycle
// LeetCode 141: Linked List Cycle
// Time: O(n), Space: O(1)
func HasCycle(head *ListNode) bool {
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

// DetectCycle returns the node where cycle begins, or nil if no cycle
// LeetCode 142: Linked List Cycle II
// Time: O(n), Space: O(1)
//
// Mathematical proof:
// Let L = distance from head to cycle start
// Let C = cycle length
// Let K = distance from cycle start to meeting point, with 0 <= K < C
//
// First, why slow has traveled exactly L + K and not more: slow enters the
// cycle at step L. From that moment fast is already in the cycle, and each
// iteration closes the gap between them by exactly one. The gap is at most
// C-1, so they meet within C-1 further steps. Slow therefore never completes
// a full lap, and its total distance is L + K.
//
// When they meet:
// - slow has traveled: L + K
// - fast has traveled: L + K + n*C (where n >= 1)
//
// Since fast travels 2x speed:
// 2(L + K) = L + K + n*C
// L + K = n*C
// L = n*C - K
//
// Read that as a statement modulo C: L is congruent to (C - K) mod C, and
// (C - K) is exactly the forward distance from the meeting point to the
// cycle start. So a pointer walking L steps from the head and a pointer
// walking L steps forward from the meeting point both land on the entry.
// The second pointer simply laps the cycle (n-1) extra times on the way.
//
// Note this is a congruence, NOT the equality "L equals the distance from
// the meeting point to the entry". With L=7 and C=3 the meeting point sits
// 1 step from the entry, not 7. Both pointers still arrive together after
// exactly L steps, which is all the algorithm needs.
func DetectCycle(head *ListNode) *ListNode {
    if head == nil || head.Next == nil {
        return nil
    }

    slow, fast := head, head

    // Phase 1: Detect cycle
    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next

        if slow == fast {
            // Cycle detected
            // Phase 2: Find cycle start
            slow = head
            for slow != fast {
                slow = slow.Next
                fast = fast.Next
            }
            return slow
        }
    }

    return nil
}

// FindCycleLength returns the length of the cycle, or 0 if no cycle
func FindCycleLength(head *ListNode) int {
    cycleNode := DetectCycle(head)
    if cycleNode == nil {
        return 0
    }

    length := 1
    curr := cycleNode.Next
    for curr != cycleNode {
        length++
        curr = curr.Next
    }

    return length
}

// GetIntersectionNode finds where two lists intersect
// LeetCode 160: Intersection of Two Linked Lists
// Time: O(m + n), Space: O(1)
//
// Technique: Let both pointers travel the same total distance
// If there's an intersection, they'll meet at the intersection point
func GetIntersectionNode(headA, headB *ListNode) *ListNode {
    if headA == nil || headB == nil {
        return nil
    }

    pA, pB := headA, headB

    // When pointer reaches end of one list, redirect to head of other list
    // This ensures both pointers travel the same distance
    for pA != pB {
        if pA == nil {
            pA = headB
        } else {
            pA = pA.Next
        }

        if pB == nil {
            pB = headA
        } else {
            pB = pB.Next
        }
    }

    return pA // either intersection point or nil
}

// RemoveNthFromEnd removes the n-th node from the end
// LeetCode 19: Remove Nth Node From End of List
// Time: O(n), Space: O(1)
func RemoveNthFromEnd(head *ListNode, n int) *ListNode {
    // Use dummy node to handle edge case of removing head
    dummy := &ListNode{Next: head}
    slow, fast := dummy, dummy

    // Move fast n+1 steps ahead. LeetCode guarantees n is in range, but
    // unguarded this loop dereferences nil the moment it is not, so real
    // code must check rather than trust the caller.
    for i := 0; i <= n; i++ {
        if fast == nil {
            return head // n is larger than the list; nothing to remove
        }
        fast = fast.Next
    }

    // Move both until fast reaches end
    for fast != nil {
        slow = slow.Next
        fast = fast.Next
    }

    // slow.Next is the node to remove
    slow.Next = slow.Next.Next

    return dummy.Next
}

// IsPalindrome checks if a linked list is a palindrome
// LeetCode 234: Palindrome Linked List
// Time: O(n), Space: O(1)
//
// The list is left exactly as it was found. Restoration is deferred so that
// it runs on every exit path, including the early mismatch. Skipping it is
// the classic bug in this problem: reversing the second half detaches it,
// so a caller who reuses the list afterwards silently sees it truncated at
// the midpoint.
func IsPalindrome(head *ListNode) bool {
    if head == nil || head.Next == nil {
        return true
    }

    // Step 1: Find the end of the first half.
    // This loop stops slow at the FIRST middle, so for odd lengths the
    // center node stays in the first half and is never compared, which is
    // exactly what we want.
    slow, fast := head, head
    for fast.Next != nil && fast.Next.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }

    // Step 2: Detach and reverse the second half.
    secondHalfHead := ReverseList(slow.Next)

    // Step 3: Restore the list on every return path.
    defer func() {
        slow.Next = ReverseList(secondHalfHead)
    }()

    // Step 4: Compare. The second half is never longer than the first,
    // so it is the correct loop bound.
    firstHalf, secondHalf := head, secondHalfHead
    for secondHalf != nil {
        if firstHalf.Val != secondHalf.Val {
            return false
        }
        firstHalf = firstHalf.Next
        secondHalf = secondHalf.Next
    }

    return true
}
```

### Junior -> FAANG: Recognizing and Applying the Pattern

The fast-slow pointer technique is one of the most frequently tested patterns in linked list interviews. It solves five canonical problems: finding the middle, detecting a cycle, finding the cycle entry, checking for a palindrome, and finding the k-th node from the end. All five reduce to the same two-pointer invariant: slow advances one step per iteration, fast advances two steps per iteration.

The biggest mistake junior candidates make is getting the loop termination condition wrong. There are two variants and they produce different results for even-length lists:
- `for fast != nil && fast.Next != nil` stops slow at the second middle for even-length lists.
- `for fast.Next != nil && fast.Next.Next != nil` stops slow at the first middle for even-length lists.

Draw a four-node list, trace both variants, and commit the difference to memory. Interviewers often ask "what does your code return for an even-length list?" as a follow-up, and a fluent answer demonstrates that you understand the mechanism, not just the pattern.

**First-job habit:** When you apply the fast-slow pattern, write a comment at the loop entry stating what invariant holds: "slow is at position k, fast is at position 2k." This documents your reasoning and makes the loop termination condition self-evident to a reviewer.

**Worked example for interviews:** For cycle detection, say: "If there is no cycle, fast will reach nil and the loop exits. If there is a cycle, fast will eventually catch slow because the gap between them decreases by one per iteration." Then for cycle entry detection, say: "After meeting, if I move one pointer back to head and advance both one step at a time, they meet at the cycle entry because the math shows L = nC - K." Writing or saying this derivation signals genuine understanding.

### Senior @ FAANG: Algorithmic Depth and Production Applicability

**The mathematical guarantee.** Floyd's cycle detection algorithm has a formal proof. Let L be the distance from head to the cycle entry, C be the cycle length, and K be the distance from the cycle entry to the first meeting point. When slow and fast first meet, slow has traveled L + K and fast has traveled 2(L + K). Since fast has also traveled some multiple of C extra (to stay in the cycle), we get L + K = nC for some integer n, which means L = nC - K. This is why resetting slow to head and advancing both pointers one step at a time finds the entry: both pointers travel exactly L more steps to reach the cycle entry.

**Production applicability.** Cycle detection in linked lists is not just a toy problem. The same algorithm detects cycles in functional state machines, detects circular references in reference-counted object graphs, and identifies infinite loops in graph traversal. Its most famous application is Pollard's rho factorization, which runs Floyd's on the sequence produced by iterating a polynomial modulo n. Note that Go's own runtime does no such tracing for deadlock detection: `checkdead` simply observes that no goroutine is runnable and no timer or network poll can wake one, then panics with "all goroutines are asleep". It builds no dependency graph, which is why it cannot detect a deadlock among a subset of goroutines while others keep running.

**ADR: space-time trade-off for cycle detection.** The fast-slow pointer approach uses O(1) space. A hash set approach uses O(n) space but handles non-pointer cycle detection (e.g., cycles in sequences defined by pure functions). For production code that must detect cycles in arbitrary directed graphs (not just linked lists), a DFS-based approach with coloring (white/gray/black) is more general and equally O(V+E) in time. The decision between these approaches depends on whether the input is guaranteed to be list-structured (use fast-slow) or general (use DFS).

**Bar-raiser question: can you adapt Floyd's algorithm to detect a rho-shaped path?** A rho-shaped path has a tail of length L leading into a cycle of length C. The algorithm detects this when fast equals slow. Extending this to count the number of distinct rho-shaped paths in a functional mapping (f: X -> X) requires applying Floyd's to the sequence x, f(x), f(f(x)), ... for each starting point x. This generalization appears in factorization algorithms (Pollard's rho) and is an L6-level application of the underlying mathematical structure.

**Palindrome check: the O(1) space variant.** The `IsPalindrome` function above mutates the list by reversing the second half, checks, then restores it in a `defer`. Restoring is not optional polish. Without it the function is a read-shaped operation that silently truncates its input, and the `defer` matters specifically because the mismatch path returns early. Even with restoration, mutating a shared data structure during a read-like operation is a concurrency hazard: for the duration of the check the list is observably broken to any other goroutine. A bar raiser will ask: "How would you make this safe under concurrent reads?" The answer involves either a read lock held for the full duration of the palindrome check (including the reversal and restoration), or copying the values into a slice (O(n) space) to avoid mutation entirely. The choice depends on whether space is more constrained than lock contention.
