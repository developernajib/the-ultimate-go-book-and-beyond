## 67.8 LeetCode Problems

### Problem Set with Solutions

| Problem | Difficulty | Pattern |
|---------|------------|---------|
| 206. Reverse Linked List | Easy | In-Place Reversal |
| 21. Merge Two Sorted Lists | Easy | Merge |
| 141. Linked List Cycle | Easy | Fast-Slow |
| 160. Intersection of Two Linked Lists | Easy | Two Pointers |
| 19. Remove Nth Node From End | Medium | Two Pointers |
| 2. Add Two Numbers | Medium | Dummy Node |
| 142. Linked List Cycle II | Medium | Fast-Slow |
| 24. Swap Nodes in Pairs | Medium | Dummy Node |
| 148. Sort List | Medium | Merge Sort |
| 138. Copy List with Random Pointer | Medium | Hash Map |
| 25. Reverse Nodes in k-Group | Hard | In-Place Reversal |
| 23. Merge k Sorted Lists | Hard | Divide & Conquer |

### Odd-Even Linked List

This problem asks you to rearrange a list so that all odd-indexed nodes appear before all even-indexed ones while preserving their relative order within each group. The solution maintains two running pointers (one advancing through odd positions and one through even), then splices the even sublist onto the end of the odd sublist in a single O(n) pass with O(1) extra space.

```go
// OddEvenList groups all odd-indexed nodes followed by even-indexed nodes
// LeetCode 328: Odd Even Linked List
// Time: O(n), Space: O(1)
func OddEvenList(head *ListNode) *ListNode {
    if head == nil || head.Next == nil {
        return head
    }

    odd := head
    even := head.Next
    evenHead := even

    for even != nil && even.Next != nil {
        odd.Next = even.Next
        odd = odd.Next
        even.Next = odd.Next
        even = even.Next
    }

    odd.Next = evenHead

    return head
}
```

### Partition List

LeetCode 86 asks you to partition a linked list around a pivot value `x` such that nodes with values less than `x` all precede nodes with values greater than or equal to `x`, without changing the relative order of nodes in either partition. The approach builds two separate dummy-headed sublists during a single traversal and then concatenates them, achieving O(n) time and O(1) space by reusing the existing nodes.

```go
// Partition rearranges list so all nodes < x come before nodes >= x
// LeetCode 86: Partition List
// Time: O(n), Space: O(1)
func Partition(head *ListNode, x int) *ListNode {
    // Create two separate lists
    beforeHead := &ListNode{}
    afterHead := &ListNode{}
    before := beforeHead
    after := afterHead

    curr := head
    for curr != nil {
        if curr.Val < x {
            before.Next = curr
            before = before.Next
        } else {
            after.Next = curr
            after = after.Next
        }
        curr = curr.Next
    }

    // Connect the two lists
    after.Next = nil
    before.Next = afterHead.Next

    return beforeHead.Next
}
```

### Reorder List

LeetCode 143 requires weaving the second half of the list (in reverse) into the first half in-place, producing the interleaved order L0→Ln→L1→Ln-1→…. The solution combines three well-known linked-list techniques in sequence: finding the midpoint with a fast-slow pointer, reversing the second half in-place, then merging the two halves by alternating nodes from each.

```go
// ReorderList reorders L0→L1→...→Ln-1→Ln to L0→Ln→L1→Ln-1→L2→Ln-2→...
// LeetCode 143: Reorder List
// Time: O(n), Space: O(1)
func ReorderList(head *ListNode) {
    if head == nil || head.Next == nil {
        return
    }

    // Step 1: Find middle
    slow, fast := head, head
    for fast.Next != nil && fast.Next.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }

    // Step 2: Reverse second half
    secondHalf := ReverseList(slow.Next)
    slow.Next = nil

    // Step 3: Merge alternately
    first, second := head, secondHalf
    for second != nil {
        temp1 := first.Next
        temp2 := second.Next

        first.Next = second
        second.Next = temp1

        first = temp1
        second = temp2
    }
}
```

### Junior -> FAANG: Building a Problem-to-Pattern Map

The problem table at the top of this section is the starting point for interview preparation. For each row, you should be able to: name the pattern, state the time and space complexity, and produce working code in under twenty minutes for Easy problems and under thirty minutes for Medium problems.

**OddEvenList pattern:** This is a two-pointer partitioning problem. The invariant is that `odd.Next` always points to the current even node, and `even.Next` always points to the next odd node. The loop terminates when `even` or `even.Next` is nil. Tracing through [1, 2, 3, 4, 5] for two iterations before coding eliminates most pointer errors.

**Partition List pattern:** Building two separate dummy-headed sublists and concatenating them is much cleaner than trying to partition in-place. The critical step that junior candidates often forget is setting `after.Next = nil` before the concatenation. Without this, the "after" sublist may retain a reference back into the "before" sublist if the last "after" node originally pointed to a "before" node.

**ReorderList pattern:** This problem combines three sub-patterns: find middle (fast-slow), reverse second half (in-place reversal), merge alternately (two-pointer merge). Being able to identify the three sub-patterns before coding is the L4 signal. Being able to combine them in the right order without a scratch diagram is the L5 signal.

**First-job habit:** For any problem in the "Hard" row of the table, budget extra time to write the function signatures and test inputs on paper before implementing. For `MergeKLists`, write `mergeKListsDC(lists []*ListNode, left, right int) *ListNode` and trace the base case (left == right) before the recursive case.

### Senior @ FAANG: Problem Classification and Systematic Preparation

**LeetCode problem selection as a signal.** In interview preparation, the value of a problem is not how many problems you can solve but how deeply you can discuss each one. For the twelve problems in this table, a senior candidate should be able to: (1) implement the canonical solution, (2) describe at least one alternative approach and its trade-offs, (3) identify the edge cases that the canonical solution handles, and (4) extend the problem to a harder variant and sketch the solution.

**`Partition List` generalizes to stream partitioning.** The pattern of building two dummy-headed sublists and concatenating them is the same pattern used to partition a stream of events into two channels in Go: create two channels (or two slices), route each event to its channel based on a predicate, then process each channel independently. The linked list version is the synchronous, single-threaded analog.

**`ReorderList` as a bar-raiser composition problem.** Bar raisers use `ReorderList` to test whether candidates can reason about correctness under composition. A common follow-up is: "Your `IsPalindrome` function from the previous problem also reverses the second half. If you call `IsPalindrome` and then `ReorderList` on the same list, is the result correct?" The answer depends entirely on whether `IsPalindrome` restores the list. The version in section 67.3 restores it in a `defer`, so the composition is safe. Had the restore been skipped, or written on the success path only, `IsPalindrome` would hand `ReorderList` a list truncated at the midpoint and the second call would silently operate on half the data. The interesting part of the answer is naming the general rule: a function whose name reads as a question must leave its input unchanged on every path, or its godoc must say plainly that it does not.

**Odd-Even vs. Partition: when to use each.** `OddEvenList` partitions by index (odd/even position). `Partition` partitions by value (less than / greater than or equal to pivot). Both produce a stable partition. The distinction matters when a problem says "maintain relative order": stable partitioning is guaranteed by both, but a sorting-based approach is not stable unless you choose a stable sort. In Go, `sort.Slice` and `slices.SortFunc` are explicitly not stable, and `sort.SliceStable` and `slices.SortStableFunc` are the ones that are. Reaching for the wrong one is how "maintain relative order" quietly breaks. See Chapter 79 for why stability is a property you must ask for rather than assume. A senior engineer reviewing a partition implementation should verify stability explicitly with a test that contains equal-valued elements, since a partition of distinct values cannot detect the bug at all.
