## 67.5 Merge Techniques

Merging sorted linked lists is the cornerstone of linked-list sorting: because nodes are already ordered, the only work is selecting the smaller head at each step and advancing that list's pointer, so no comparisons are wasted. Merging k lists naively would cost O(kN), but the divide-and-conquer approach halves the problem at each level, reducing total work to O(N log k). The min-heap variant achieves the same asymptotic bound while allowing streaming access to all k lists simultaneously, which is useful when lists arrive lazily or are too large to hold in memory at once.

```go
package linkedlist

import "container/heap"

// MergeTwoLists merges two sorted lists into one sorted list
// LeetCode 21: Merge Two Sorted Lists
// Time: O(n + m), Space: O(1)
//
// The <= (rather than <) is what makes this merge stable: on a tie the node
// from list1, the earlier run, is emitted first. SortList below inherits its
// stability from exactly this line.
func MergeTwoLists(list1, list2 *ListNode) *ListNode {
    dummy := &ListNode{}
    curr := dummy

    for list1 != nil && list2 != nil {
        if list1.Val <= list2.Val {
            curr.Next = list1
            list1 = list1.Next
        } else {
            curr.Next = list2
            list2 = list2.Next
        }
        curr = curr.Next
    }

    // Append remaining nodes
    if list1 != nil {
        curr.Next = list1
    } else {
        curr.Next = list2
    }

    return dummy.Next
}

// MergeKLists merges k sorted lists using divide and conquer
// LeetCode 23: Merge k Sorted Lists
// Time: O(N log k) where N is total nodes, k is number of lists
// Space: O(log k) for recursion
func MergeKLists(lists []*ListNode) *ListNode {
    if len(lists) == 0 {
        return nil
    }

    return mergeKListsDC(lists, 0, len(lists)-1)
}

func mergeKListsDC(lists []*ListNode, left, right int) *ListNode {
    if left == right {
        return lists[left]
    }

    mid := left + (right-left)/2
    l := mergeKListsDC(lists, left, mid)
    r := mergeKListsDC(lists, mid+1, right)

    return MergeTwoLists(l, r)
}

// MergeKListsHeap merges k sorted lists using a min-heap
// Time: O(N log k), Space: O(k)

type ListNodeHeap []*ListNode

func (h ListNodeHeap) Len() int           { return len(h) }
func (h ListNodeHeap) Less(i, j int) bool { return h[i].Val < h[j].Val }
func (h ListNodeHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }

func (h *ListNodeHeap) Push(x any) {
    *h = append(*h, x.(*ListNode))
}

func (h *ListNodeHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

func MergeKListsHeap(lists []*ListNode) *ListNode {
    h := &ListNodeHeap{}
    heap.Init(h)

    // Add head of each list to heap
    for _, list := range lists {
        if list != nil {
            heap.Push(h, list)
        }
    }

    dummy := &ListNode{}
    curr := dummy

    for h.Len() > 0 {
        // Get smallest node
        node := heap.Pop(h).(*ListNode)
        curr.Next = node
        curr = curr.Next

        // Add next node from same list
        if node.Next != nil {
            heap.Push(h, node.Next)
        }
    }

    return dummy.Next
}

// SortList sorts a linked list using merge sort
// LeetCode 148: Sort List
// Time: O(n log n), Space: O(log n) for recursion
func SortList(head *ListNode) *ListNode {
    if head == nil || head.Next == nil {
        return head
    }

    // Find middle
    slow, fast := head, head.Next
    for fast != nil && fast.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }

    // Split list
    mid := slow.Next
    slow.Next = nil

    // Recursively sort both halves
    left := SortList(head)
    right := SortList(mid)

    // Merge sorted halves
    return MergeTwoLists(left, right)
}

// InsertionSortList sorts using insertion sort
// LeetCode 147: Insertion Sort List
// Time: O(n^2), Space: O(1)
func InsertionSortList(head *ListNode) *ListNode {
    dummy := &ListNode{}
    curr := head

    for curr != nil {
        // Save next node
        next := curr.Next

        // Find insertion position.
        // The <= is load-bearing. With a plain <, the scan stops at the
        // FIRST node equal to curr and splices curr in ahead of it, which
        // reverses every run of equal keys and makes the sort unstable.
        // Advancing past equals inserts curr after them, preserving input
        // order among ties.
        prev := dummy
        for prev.Next != nil && prev.Next.Val <= curr.Val {
            prev = prev.Next
        }

        // Insert current node
        curr.Next = prev.Next
        prev.Next = curr

        curr = next
    }

    return dummy.Next
}
```

### Junior -> FAANG: Merge as the Foundation of List Sorting

`MergeTwoLists` is the most important merge function to have memorized. It is the leaf operation of merge sort for linked lists, the base case of divide-and-conquer k-way merge, and a standalone Easy problem on LeetCode (21). The dummy node pattern is mandatory here: without it, you need a special case for choosing between `list1` and `list2` as the initial head, and that branching makes the code more complex than necessary.

The most common mistake in `MergeTwoLists` is failing to append the remaining nodes after the main loop. When one list is exhausted, the remaining nodes of the other list are already in sorted order and can be attached in O(1) with `curr.Next = list1` (or `list2`). Forgetting this and writing a second loop to copy remaining nodes is a correctness issue that interviewers notice immediately.

**Interview framing for `MergeKLists`:** This is a Medium-to-Hard problem that distinguishes L4 from L5 candidates. The naive O(kN) approach (merge lists one by one) is immediately visible. The O(N log k) divide-and-conquer approach requires recognizing that `MergeTwoLists` is associative and can be applied at multiple levels of a binary tree of merges. State the time complexity derivation: N total nodes, log k levels of merging, O(N log k) total. Then implement it.

**Heap variant (`MergeKListsHeap`):** The min-heap approach is algorithmically equivalent to divide-and-conquer but streams results rather than recursing. It is more useful in practice when k is large and the lists arrive from external sources (e.g., sorted log files from k servers). Mention this use case in the interview.

**`SortList` interview framing:** Bottom-up merge sort achieves O(n log n) time and O(1) space (no recursion stack) by iterating pass widths 1, 2, 4, 8,.... The recursive variant shown is O(log n) stack depth. For an interview, either variant is acceptable, but mentioning the bottom-up O(1) space variant is an L5 signal.

### Senior @ FAANG: Merge Techniques in Distributed Data Processing

**Production relevance of k-way merge.** The k-way merge with a min-heap is the core algorithm behind external merge sort, which is how databases sort tables larger than memory. Each sorted run is one "list" in the k-way merge, and the heap holds one element from each run. This pattern appears in sort-merge joins, in LSM-tree compaction, where each SSTable is one sorted run and the heap merges them into a new level, and in any log aggregator that interleaves timestamp-ordered streams from many hosts. A senior engineer who recognizes a "merge sorted streams" problem and immediately reaches for a min-heap is demonstrating the same algorithm in a production context.

**ADR: divide-and-conquer vs. heap for k-way merge.** The divide-and-conquer approach allocates O(log k) stack frames. The heap approach allocates O(k) heap space for the priority queue. For very large k (thousands of sorted files), the heap approach is preferable because it is iterative and avoids recursion depth concerns. For small k (two to ten lists), the divide-and-conquer approach has better constant factors because it avoids heap operations. Document this in the design review when choosing between the two implementations.

**`InsertionSortList` and when it is appropriate.** Insertion sort on a linked list is O(n^2) time, O(1) space, and stable only if the insertion scan advances past equal keys, as noted in the code above. Its running time is proportional to the number of inversions, so a nearly sorted list costs close to O(n). Do not repeat the usual claim that insertion sort wins on cache behavior here: that argument belongs to arrays, where insertion sort walks a contiguous block. On a linked list every comparison chases a pointer to a node that may sit anywhere on the heap, so this version has poor locality, and merge sort on a linked list allocates no auxiliary array either. The honest reason to pick it is simplicity and the near-sorted case, not cache behavior. In production this is almost never right for general-purpose sorting, but it is a reasonable choice for maintaining a small sorted list under frequent single-element insertions, such as a priority-ordered work queue with bounded depth.

**Bar-raiser question: what is the space complexity of recursive `MergeKLists`?** The divide-and-conquer implementation recurses to depth log k, each frame holding two sublist pointers. The stack space is O(log k). The heap holds k nodes at any time, so heap space is O(k). For an interview, articulating both and stating which dominates under different k/N regimes is an L6-level answer.

For a full treatment of sorting itself, including the comparison lower bound, pdqsort, and stability as a formal property, see Chapter 79.
