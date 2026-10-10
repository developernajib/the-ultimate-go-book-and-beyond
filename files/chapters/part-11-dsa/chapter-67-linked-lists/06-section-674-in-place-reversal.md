## 67.4 In-Place Reversal

Reversing a linked list in-place requires only three pointers (`prev`, `curr`, and `next`), because each node's `Next` pointer must be redirected before the forward reference is lost. The algorithm processes one node per iteration: save the forward link, point `curr.Next` backward to `prev`, then advance both pointers. No additional memory is needed because the existing nodes are rewired rather than copied, making it O(1) space despite touching every node exactly once.

```
┌─────────────────────────────────────────────────────────────────┐
│                     IN-PLACE REVERSAL                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Original:                                                      │
│  [1] → [2] → [3] → [4] → nil                                    │
│                                                                 │
│  Step 1: prev=nil, curr=1, next=2                               │
│  nil ← [1]   [2] → [3] → [4] → nil                              │
│         ↑     ↑                                                 │
│       prev  curr                                                │
│                                                                 │
│  Step 2: prev=1, curr=2, next=3                                 │
│  nil ← [1] ← [2]   [3] → [4] → nil                              │
│               ↑     ↑                                           │
│             prev  curr                                          │
│                                                                 │
│  Step 3: prev=2, curr=3, next=4                                 │
│  nil ← [1] ← [2] ← [3]   [4] → nil                              │
│                     ↑     ↑                                     │
│                   prev  curr                                    │
│                                                                 │
│  Step 4: prev=3, curr=4, next=nil                               │
│  nil ← [1] ← [2] ← [3] ← [4]   nil                              │
│                           ↑     ↑                               │
│                         prev  curr                              │
│                                                                 │
│  Result: prev is the new head                                   │
│  nil ← [1] ← [2] ← [3] ← [4]                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
package linkedlist

// ReverseList reverses a singly linked list iteratively
// LeetCode 206: Reverse Linked List
// Time: O(n), Space: O(1)
func ReverseList(head *ListNode) *ListNode {
    var prev *ListNode
    curr := head

    for curr != nil {
        next := curr.Next  // save next node
        curr.Next = prev   // reverse the link
        prev = curr        // move prev forward
        curr = next        // move curr forward
    }

    return prev
}

// ReverseListRecursive reverses a singly linked list recursively
// Time: O(n), Space: O(n) due to recursion stack
func ReverseListRecursive(head *ListNode) *ListNode {
    if head == nil || head.Next == nil {
        return head
    }

    newHead := ReverseListRecursive(head.Next)
    head.Next.Next = head
    head.Next = nil

    return newHead
}

// ReverseBetween reverses nodes from position left to right
// LeetCode 92: Reverse Linked List II
// Time: O(n), Space: O(1)
func ReverseBetween(head *ListNode, left int, right int) *ListNode {
    if head == nil || left == right {
        return head
    }

    dummy := &ListNode{Next: head}
    prev := dummy

    // Move to node before the reversal section
    for i := 1; i < left; i++ {
        prev = prev.Next
    }

    // Start reversal
    curr := prev.Next

    // Reverse by inserting each node after prev
    for i := 0; i < right-left; i++ {
        next := curr.Next
        curr.Next = next.Next
        next.Next = prev.Next
        prev.Next = next
    }

    return dummy.Next
}

// ReverseKGroup reverses nodes in k-group
// LeetCode 25: Reverse Nodes in k-Group
// Time: O(n), Space: O(1)
func ReverseKGroup(head *ListNode, k int) *ListNode {
    // k <= 1, not k == 1. With k == 0 the loop below subtracts zero from
    // count on every pass and spins forever while wiping the list, and a
    // negative k is meaningless. Both must exit here.
    if head == nil || k <= 1 {
        return head
    }

    // Count total nodes
    count := 0
    curr := head
    for curr != nil {
        count++
        curr = curr.Next
    }

    dummy := &ListNode{Next: head}
    prevGroupEnd := dummy

    for count >= k {
        groupStart := prevGroupEnd.Next
        curr := groupStart

        // Reverse k nodes
        var prev *ListNode
        for i := 0; i < k; i++ {
            next := curr.Next
            curr.Next = prev
            prev = curr
            curr = next
        }

        // Connect with previous group
        prevGroupEnd.Next = prev
        groupStart.Next = curr

        // Move to next group
        prevGroupEnd = groupStart
        count -= k
    }

    return dummy.Next
}

// SwapPairs swaps every two adjacent nodes
// LeetCode 24: Swap Nodes in Pairs
// Time: O(n), Space: O(1)
func SwapPairs(head *ListNode) *ListNode {
    dummy := &ListNode{Next: head}
    prev := dummy

    for prev.Next != nil && prev.Next.Next != nil {
        first := prev.Next
        second := prev.Next.Next

        // Swap
        first.Next = second.Next
        second.Next = first
        prev.Next = second

        prev = first
    }

    return dummy.Next
}

// RotateRight rotates the list to the right by k places
// LeetCode 61: Rotate List
// Time: O(n), Space: O(1)
func RotateRight(head *ListNode, k int) *ListNode {
    if head == nil || head.Next == nil || k == 0 {
        return head
    }

    // Find length and tail
    length := 1
    tail := head
    for tail.Next != nil {
        length++
        tail = tail.Next
    }

    // Normalize k
    k = k % length
    if k == 0 {
        return head
    }

    // Find new tail (length - k - 1 steps from head)
    newTail := head
    for i := 0; i < length-k-1; i++ {
        newTail = newTail.Next
    }

    // Rotate
    newHead := newTail.Next
    newTail.Next = nil
    tail.Next = head

    return newHead
}
```

### Junior -> FAANG: Mastering the Three-Pointer Reversal

In-place list reversal is the second most frequently tested linked list pattern after fast-slow pointers. The iterative three-pointer approach (`prev`, `curr`, `next`) is mandatory to memorize. The recursive approach is useful to know but carries O(n) stack space and risks stack overflow on very long lists.

The single most important habit is saving `curr.Next` into `next` at the start of each loop body. Without this save, the forward reference is lost the moment you assign `curr.Next = prev`. Every student who writes this algorithm for the first time loses the forward reference at least once. Writing `next := curr.Next` as the first line of the loop body, before any mutation, is the preventive measure.

**Worked example for `ReverseBetween`:** The key insight is that you need a pointer to the node just before position `left`. This is why the `prev` cursor starts at the `dummy` node rather than `head`. After moving `prev` forward `left-1` times, `curr = prev.Next` is the first node to reverse. The inner loop then does `right-left` iterations, each time pulling `curr.Next` to the front of the reversed segment. Trace this on a list [1, 2, 3, 4, 5] with left=2, right=4 before the interview.

**`ReverseKGroup` interview framing:** This is a Hard LeetCode problem that combines counting (to check if k nodes remain) with group reversal. The critical edge case is when fewer than k nodes remain: the problem statement specifies they are left as-is. Before coding, state this edge case explicitly. The point of the problem is whether you handle partial groups by falling out of the loop condition rather than bolting on a special case that duplicates the reversal logic.

**First-job habit:** When you write a reversal function, trace it on a two-node list and a single-node list immediately. These are the cases where off-by-one errors in loop conditions first appear.

### Senior @ FAANG: Reversal Patterns in Production and Interview Depth

**Production relevance.** In-place list reversal appears in two production contexts. The first is LRU cache reordering, where a recently accessed node must be moved to the head of the doubly linked list without allocating new nodes. The doubly linked list makes this O(1) without reversal, but the underlying pointer manipulation is the same discipline. The second is stream processing, where a batch of items arrives in reverse timestamp order and must be reordered in-place before downstream processing.

**`ReverseKGroup` as a bar-raiser differentiator.** The expected L5 solution is the iterative approach shown in the code above (count total, iterate in groups of k, connect adjacent groups). A bar-raiser will ask for the recursive solution and then ask about its space complexity. The recursive solution is O(n/k) stack depth, which is O(n) in the worst case (k=1). For very long lists, the iterative approach is strictly required. Being able to produce both solutions and articulate the space trade-off is an L6 signal.

**`SwapPairs` generalizes to `ReverseKGroup`.** Recognizing that `SwapPairs` is a special case of `ReverseKGroup` with k=2 is a pattern-recognition signal. A candidate who immediately identifies this relationship and shows how the general algorithm degenerates to the special case demonstrates systematic thinking rather than problem-memorization.

**`RotateRight` as an ADR exercise.** The rotation implementation computes length, normalizes k, and rewires two pointers. In a code review, a senior engineer should ask: "Is computing the full length acceptable here, or do we have a performance requirement that makes it too expensive?" For a list of known bounded length (e.g., a sliding window buffer), the length computation is O(n) and acceptable. For a list of unknown length in a latency-sensitive hot path, pre-maintaining a length field (as the `SinglyLinkedList` struct does) eliminates the traversal. The review comment should be prescriptive: "Add a length field and update it in AddAtHead/AddAtTail/DeleteAtIndex to make RotateRight O(1) for the length lookup." Note this changes only the constant factor: `RotateRight` still walks to the new tail, so it remains O(n) overall.
