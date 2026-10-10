## 78C.5 Linked List

Linked list problems test pointer manipulation. The key techniques are: **fast/slow pointers**, **dummy nodes**, and **reversing in place**.

---
### LC 206 - Reverse Linked List 🟢

**Key Insight**: Iterate through the list, reversing each pointer to point to the previous node.

```go
func reverseList(head *ListNode) *ListNode {
    var prev *ListNode
    curr := head

    for curr != nil {
        next := curr.Next
        curr.Next = prev
        prev = curr
        curr = next
    }
    return prev
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 92 - Reverse Linked List II 🟡

**Key Insight**: Do not reverse a sublist and stitch it back. Walk to the node before position `left`, then repeatedly lift the node after `curr` and splice it directly behind `prev`. The sublist reverses itself in place with no rejoining step.

```go
func reverseBetween(head *ListNode, left int, right int) *ListNode {
    dummy := &ListNode{Next: head} // left may be 1, so the head itself can move
    prev := dummy
    for i := 1; i < left; i++ {
        prev = prev.Next
    }

    curr := prev.Next // stays put and sinks as nodes are lifted over it
    for i := 0; i < right-left; i++ {
        moved := curr.Next
        curr.Next = moved.Next
        moved.Next = prev.Next
        prev.Next = moved
    }
    return dummy.Next
}
```

The head-insertion trick is what keeps this to a single pass. `curr` never moves: it starts as the first node of the range and ends as the last, drifting rightward as each successor is pulled in front of it. The dummy node removes the special case where `left == 1` and the list head changes, and `right - left` iterations means `left == right` correctly does nothing.

**Time**: O(n) - one walk to `left`, then `right - left` splices.
**Space**: O(1).

---
### LC 21 - Merge Two Sorted Lists 🟢

**Key Insight**: Use a dummy head node and compare elements from both lists, appending the smaller one.

```go
func mergeTwoLists(list1 *ListNode, list2 *ListNode) *ListNode {
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

    if list1 != nil {
        curr.Next = list1
    } else {
        curr.Next = list2
    }
    return dummy.Next
}
```
**Time**: O(n + m).
**Space**: O(1).

---
### LC 141 - Linked List Cycle 🟢

**Key Insight**: Floyd's cycle detection. Slow moves 1 step, fast moves 2 steps. If they meet, there is a cycle.

```go
func hasCycle(head *ListNode) bool {
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
**Time**: O(n).
**Space**: O(1).

---
### LC 143 - Reorder List 🟡

**Key Insight**: Find middle, reverse second half, then interleave the two halves.

```go
func reorderList(head *ListNode) {
    if head == nil || head.Next == nil {
        return
    }

    // Find middle
    slow, fast := head, head
    for fast.Next != nil && fast.Next.Next != nil {
        slow = slow.Next
        fast = fast.Next.Next
    }

    // Reverse second half
    var prev *ListNode
    curr := slow.Next
    slow.Next = nil
    for curr != nil {
        next := curr.Next
        curr.Next = prev
        prev = curr
        curr = next
    }

    // Merge two halves
    first, second := head, prev
    for second != nil {
        tmp1, tmp2 := first.Next, second.Next
        first.Next = second
        second.Next = tmp1
        first = tmp1
        second = tmp2
    }
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 19 - Remove Nth Node From End of List 🟡

**Key Insight**: Use two pointers n+1 apart. When the fast one reaches the end, slow sits right before the target.

```go
func removeNthFromEnd(head *ListNode, n int) *ListNode {
    dummy := &ListNode{Next: head}
    slow, fast := dummy, dummy

    for i := 0; i <= n; i++ {
        fast = fast.Next
    }

    for fast != nil {
        slow = slow.Next
        fast = fast.Next
    }

    slow.Next = slow.Next.Next
    return dummy.Next
}
```
**Time**: O(n).
**Space**: O(1).

---
### LC 2 - Add Two Numbers 🟡

**Key Insight**: Simulate digit-by-digit addition with a carry, creating new nodes for each result digit.

```go
func addTwoNumbers(l1 *ListNode, l2 *ListNode) *ListNode {
    dummy := &ListNode{}
    curr := dummy
    carry := 0

    for l1 != nil || l2 != nil || carry > 0 {
        sum := carry
        if l1 != nil {
            sum += l1.Val
            l1 = l1.Next
        }
        if l2 != nil {
            sum += l2.Val
            l2 = l2.Next
        }
        carry = sum / 10
        curr.Next = &ListNode{Val: sum % 10}
        curr = curr.Next
    }
    return dummy.Next
}
```
**Time**: O(max(m, n)).
**Space**: O(max(m, n)).

---
### LC 138 - Copy List with Random Pointer 🟡

**Key Insight**: Use a hash map from original node to cloned node. Two passes: create the clones, then wire up Next and Random.

```go
type Node struct {
    Val    int
    Next   *Node
    Random *Node
}

func copyRandomList(head *Node) *Node {
    if head == nil {
        return nil
    }

    cloneMap := make(map[*Node]*Node)

    curr := head
    for curr != nil {
        cloneMap[curr] = &Node{Val: curr.Val}
        curr = curr.Next
    }

    curr = head
    for curr != nil {
        cloneMap[curr].Next = cloneMap[curr.Next]
        cloneMap[curr].Random = cloneMap[curr.Random]
        curr = curr.Next
    }

    return cloneMap[head]
}
```
**Time**: O(n).
**Space**: O(n).

---
### LC 25 - Reverse Nodes in k-Group 🔴

**Key Insight**: Count k nodes ahead. If enough exist, reverse that segment in place, then recurse/iterate for the next group.

```go
func reverseKGroup(head *ListNode, k int) *ListNode {
    // Check if we have k nodes
    count := 0
    curr := head
    for curr != nil && count < k {
        curr = curr.Next
        count++
    }
    if count < k {
        return head
    }

    // Reverse k nodes
    var prev *ListNode
    curr = head
    for i := 0; i < k; i++ {
        next := curr.Next
        curr.Next = prev
        prev = curr
        curr = next
    }

    // head is now the tail of the reversed segment
    head.Next = reverseKGroup(curr, k)
    return prev
}
```
**Time**: O(n).
**Space**: O(n/k) for the recursion stack.

---
### LC 23 - Merge k Sorted Lists 🔴

**Key Insight**: Use a min-heap to always extract the smallest element across all k lists.

> **Note on `any` in heap implementations:** `container/heap` declares `Push(x any)` and
> `Pop() any` in its `heap.Interface`, so any implementation must funnel values through an
> empty interface and type-assert on the way out. That is a **stdlib constraint**, not outdated
> code: `container/heap` predates generics and its interface has not been reworked. All heap
> examples in this chapter type-assert for this reason. For new production code, consider a
> generic wrapper on top:
>
> ```go
> // Generic heap wrapper (recommended for new code)
> type Heap[T any] struct {
>     data []T
>     less func(a, b T) bool
> }
> ```
>
> This lets callers avoid type assertions while the wrapper handles the `any` plumbing
> internally. See the [`container/heap` docs](https://pkg.go.dev/container/heap) for details.

```go
import "container/heap"

type ListNodeHeap []*ListNode

func (h ListNodeHeap) Len() int           { return len(h) }
func (h ListNodeHeap) Less(i, j int) bool { return h[i].Val < h[j].Val }
func (h ListNodeHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *ListNodeHeap) Push(x any)        { *h = append(*h, x.(*ListNode)) }
func (h *ListNodeHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

func mergeKLists(lists []*ListNode) *ListNode {
    h := &ListNodeHeap{}
    heap.Init(h)

    for _, l := range lists {
        if l != nil {
            heap.Push(h, l)
        }
    }

    dummy := &ListNode{}
    curr := dummy
    for h.Len() > 0 {
        node := heap.Pop(h).(*ListNode)
        curr.Next = node
        curr = curr.Next
        if node.Next != nil {
            heap.Push(h, node.Next)
        }
    }
    return dummy.Next
}
```
**Time**: O(N log k) where N is total nodes.
**Space**: O(k).

---
### LC 146 - LRU Cache 🟡

**Key Insight**: Combine a hash map with a doubly linked list. The map gives O(1) access, the list gives O(1) eviction and promotion.

```go
type LRUCache struct {
    capacity   int
    cache      map[int]*dlNode
    head, tail *dlNode
}

type dlNode struct {
    key, val   int
    prev, next *dlNode
}

func Constructor(capacity int) LRUCache {
    head := &dlNode{}
    tail := &dlNode{}
    head.next = tail
    tail.prev = head
    return LRUCache{
        capacity: capacity,
        cache:    make(map[int]*dlNode),
        head:     head,
        tail:     tail,
    }
}

func (l *LRUCache) Get(key int) int {
    if node, ok := l.cache[key]; ok {
        l.moveToFront(node)
        return node.val
    }
    return -1
}

func (l *LRUCache) Put(key int, value int) {
    if node, ok := l.cache[key]; ok {
        node.val = value
        l.moveToFront(node)
        return
    }

    node := &dlNode{key: key, val: value}
    l.cache[key] = node
    l.addToFront(node)

    if len(l.cache) > l.capacity {
        lru := l.tail.prev
        l.removeNode(lru)
        delete(l.cache, lru.key)
    }
}

func (l *LRUCache) addToFront(node *dlNode) {
    node.prev = l.head
    node.next = l.head.next
    l.head.next.prev = node
    l.head.next = node
}

func (l *LRUCache) removeNode(node *dlNode) {
    node.prev.next = node.next
    node.next.prev = node.prev
}

func (l *LRUCache) moveToFront(node *dlNode) {
    l.removeNode(node)
    l.addToFront(node)
}
```
**Time**: O(1) for Get and Put.
**Space**: O(capacity).

---

### Junior → FAANG: Dummy Nodes and Pointer Safety

Linked list problems are where junior engineers create the most subtle bugs: losing a node reference before reassigning a pointer, advancing past nil, and forgetting to null-terminate the result list. The discipline: always draw the pointer state before and after each operation, especially during reversal. A three-pointer reversal (prev, curr, next) has exactly four steps per iteration. If your loop has more, something is wrong.

Dummy node usage: whenever the head of the result list might change (as in removing the first element or merging lists), use a dummy node whose `Next` will be the true head. This eliminates the special case for the first node and makes the loop uniform. The cost is one extra struct allocation, which is always acceptable in an interview.

LRU Cache (LC 146) is the capstone problem of this section and the most commonly asked design problem at FAANG. Practice the doubly linked list plus hash map implementation until you can write it from scratch in 15 minutes. The access order invariant (most recently used is at the front) and the eviction trigger (capacity exceeded on Put) must be stated before writing any code.

### Senior @ FAANG: LRU Cache in Production Caching Systems

The LRU Cache problem is a direct model of production in-memory caches. Go's `groupcache` and similar systems implement LRU eviction using exactly the doubly-linked list plus hash map structure. At scale, the mutex protecting the LRU list becomes a contention point: every cache access requires a list reorder under the mutex. Production systems address this with approximate LRU (sample k random elements, evict the oldest among them), segmented LRU (separate hot and cold segments), or clock-based eviction. Knowing the exact interview solution is the prerequisite for understanding why these production approximations exist and what correctness guarantees they sacrifice.
