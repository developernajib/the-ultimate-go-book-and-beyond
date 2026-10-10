## 67.1 Linked List Fundamentals

### Singly Linked List

A singly linked list stores elements in nodes where each node holds a value and a pointer to the next node, making head insertions O(1) while tail access and arbitrary index lookups require O(n) traversal. The implementation below wraps the raw node pointer in a `SinglyLinkedList` struct that tracks size, providing safe boundary-checked `Get`, `AddAtIndex`, and `DeleteAtIndex` operations alongside convenience helpers for converting to and from Go slices.

```go
package linkedlist

// ListNode represents a node in a singly linked list
type ListNode struct {
    Val  int
    Next *ListNode
}

// SinglyLinkedList provides operations on a singly linked list
type SinglyLinkedList struct {
    Head *ListNode
    size int
}

// NewSinglyLinkedList creates an empty singly linked list
func NewSinglyLinkedList() *SinglyLinkedList {
    return &SinglyLinkedList{}
}

// Size returns the number of nodes
func (l *SinglyLinkedList) Size() int {
    return l.size
}

// IsEmpty returns true if the list is empty
func (l *SinglyLinkedList) IsEmpty() bool {
    return l.size == 0
}

// Get returns the value at the given index
// Time: O(n), Space: O(1)
func (l *SinglyLinkedList) Get(index int) (int, bool) {
    if index < 0 || index >= l.size {
        return 0, false
    }

    curr := l.Head
    for i := 0; i < index; i++ {
        curr = curr.Next
    }

    return curr.Val, true
}

// AddAtHead inserts a node at the beginning
// Time: O(1), Space: O(1)
func (l *SinglyLinkedList) AddAtHead(val int) {
    newNode := &ListNode{Val: val, Next: l.Head}
    l.Head = newNode
    l.size++
}

// AddAtTail appends a node at the end
// Time: O(n), Space: O(1)
func (l *SinglyLinkedList) AddAtTail(val int) {
    newNode := &ListNode{Val: val}

    if l.Head == nil {
        l.Head = newNode
    } else {
        curr := l.Head
        for curr.Next != nil {
            curr = curr.Next
        }
        curr.Next = newNode
    }

    l.size++
}

// AddAtIndex inserts a node at the given index
// Time: O(n), Space: O(1)
func (l *SinglyLinkedList) AddAtIndex(index int, val int) bool {
    if index < 0 || index > l.size {
        return false
    }

    if index == 0 {
        l.AddAtHead(val)
        return true
    }

    curr := l.Head
    for i := 0; i < index-1; i++ {
        curr = curr.Next
    }

    newNode := &ListNode{Val: val, Next: curr.Next}
    curr.Next = newNode
    l.size++

    return true
}

// DeleteAtIndex removes the node at the given index
// Time: O(n), Space: O(1)
func (l *SinglyLinkedList) DeleteAtIndex(index int) bool {
    if index < 0 || index >= l.size {
        return false
    }

    if index == 0 {
        l.Head = l.Head.Next
        l.size--
        return true
    }

    curr := l.Head
    for i := 0; i < index-1; i++ {
        curr = curr.Next
    }

    curr.Next = curr.Next.Next
    l.size--

    return true
}

// ToSlice converts the list to a slice (for testing)
func (l *SinglyLinkedList) ToSlice() []int {
    result := make([]int, 0, l.size)
    curr := l.Head
    for curr != nil {
        result = append(result, curr.Val)
        curr = curr.Next
    }
    return result
}

// FromSlice creates a list from a slice
func FromSlice(nums []int) *ListNode {
    if len(nums) == 0 {
        return nil
    }

    head := &ListNode{Val: nums[0]}
    curr := head
    for i := 1; i < len(nums); i++ {
        curr.Next = &ListNode{Val: nums[i]}
        curr = curr.Next
    }

    return head
}
```

### Doubly Linked List

A doubly linked list extends each node with a backward `Prev` pointer, enabling O(1) head and tail insertion and deletion as well as bidirectional traversal. The implementation uses sentinel head and tail nodes to eliminate edge-case nil checks, and the `Get` method optimizes access time by starting traversal from whichever end is closer to the requested index.

```go
package linkedlist

// DoublyListNode represents a node in a doubly linked list
type DoublyListNode struct {
    Val  int
    Prev *DoublyListNode
    Next *DoublyListNode
}

// DoublyLinkedList with head and tail sentinels
type DoublyLinkedList struct {
    head *DoublyListNode // sentinel head
    tail *DoublyListNode // sentinel tail
    size int
}

// NewDoublyLinkedList creates an empty doubly linked list
func NewDoublyLinkedList() *DoublyLinkedList {
    l := &DoublyLinkedList{
        head: &DoublyListNode{},
        tail: &DoublyListNode{},
    }
    l.head.Next = l.tail
    l.tail.Prev = l.head
    return l
}

// Size returns the number of nodes
func (l *DoublyLinkedList) Size() int {
    return l.size
}

// IsEmpty returns true if the list is empty
func (l *DoublyLinkedList) IsEmpty() bool {
    return l.size == 0
}

// Get returns the value at the given index
// Time: O(n), Space: O(1)
// Optimized: starts from head or tail based on index
func (l *DoublyLinkedList) Get(index int) (int, bool) {
    if index < 0 || index >= l.size {
        return 0, false
    }

    var curr *DoublyListNode

    // Start from head or tail depending on which is closer
    if index < l.size/2 {
        curr = l.head.Next
        for i := 0; i < index; i++ {
            curr = curr.Next
        }
    } else {
        curr = l.tail.Prev
        for i := l.size - 1; i > index; i-- {
            curr = curr.Prev
        }
    }

    return curr.Val, true
}

// addBetween inserts a node between two nodes
func (l *DoublyLinkedList) addBetween(val int, pred, succ *DoublyListNode) {
    newNode := &DoublyListNode{
        Val:  val,
        Prev: pred,
        Next: succ,
    }
    pred.Next = newNode
    succ.Prev = newNode
    l.size++
}

// AddAtHead inserts a node at the beginning
// Time: O(1), Space: O(1)
func (l *DoublyLinkedList) AddAtHead(val int) {
    l.addBetween(val, l.head, l.head.Next)
}

// AddAtTail appends a node at the end
// Time: O(1), Space: O(1)
func (l *DoublyLinkedList) AddAtTail(val int) {
    l.addBetween(val, l.tail.Prev, l.tail)
}

// AddAtIndex inserts a node at the given index
// Time: O(n), Space: O(1)
func (l *DoublyLinkedList) AddAtIndex(index int, val int) bool {
    if index < 0 || index > l.size {
        return false
    }

    // Find the predecessor node
    var pred *DoublyListNode
    if index < l.size/2 {
        pred = l.head
        for i := 0; i < index; i++ {
            pred = pred.Next
        }
    } else {
        pred = l.tail
        for i := l.size; i > index; i-- {
            pred = pred.Prev
        }
        pred = pred.Prev
    }

    l.addBetween(val, pred, pred.Next)
    return true
}

// deleteNode removes a node from the list
func (l *DoublyLinkedList) deleteNode(node *DoublyListNode) int {
    pred := node.Prev
    succ := node.Next
    pred.Next = succ
    succ.Prev = pred
    l.size--
    return node.Val
}

// DeleteAtIndex removes the node at the given index
// Time: O(n), Space: O(1)
func (l *DoublyLinkedList) DeleteAtIndex(index int) (int, bool) {
    if index < 0 || index >= l.size {
        return 0, false
    }

    // Find the node to delete
    var curr *DoublyListNode
    if index < l.size/2 {
        curr = l.head.Next
        for i := 0; i < index; i++ {
            curr = curr.Next
        }
    } else {
        curr = l.tail.Prev
        for i := l.size - 1; i > index; i-- {
            curr = curr.Prev
        }
    }

    return l.deleteNode(curr), true
}

// DeleteFirst removes the first node
// Time: O(1), Space: O(1)
func (l *DoublyLinkedList) DeleteFirst() (int, bool) {
    if l.IsEmpty() {
        return 0, false
    }
    return l.deleteNode(l.head.Next), true
}

// DeleteLast removes the last node
// Time: O(1), Space: O(1)
func (l *DoublyLinkedList) DeleteLast() (int, bool) {
    if l.IsEmpty() {
        return 0, false
    }
    return l.deleteNode(l.tail.Prev), true
}

// ToSlice converts the list to a slice
func (l *DoublyLinkedList) ToSlice() []int {
    result := make([]int, 0, l.size)
    curr := l.head.Next
    for curr != l.tail {
        result = append(result, curr.Val)
        curr = curr.Next
    }
    return result
}
```

### Circular Linked List

A circular linked list connects the last node back to the first, forming a ring with no nil terminus, which makes rotation (advancing the logical start by one position) an O(1) pointer reassignment. The implementation tracks only the tail node, since `tail.Next` always gives the head, and the classic Josephus problem demonstrates circular lists in action by repeatedly eliminating every k-th person until one survivor remains.

```go
package linkedlist

// CircularLinkedList represents a circular singly linked list
type CircularLinkedList struct {
    tail *ListNode // points to the last node
    size int
}

// NewCircularLinkedList creates an empty circular linked list
func NewCircularLinkedList() *CircularLinkedList {
    return &CircularLinkedList{}
}

// Size returns the number of nodes
func (l *CircularLinkedList) Size() int {
    return l.size
}

// IsEmpty returns true if the list is empty
func (l *CircularLinkedList) IsEmpty() bool {
    return l.size == 0
}

// First returns the first element
func (l *CircularLinkedList) First() (int, bool) {
    if l.IsEmpty() {
        return 0, false
    }
    return l.tail.Next.Val, true
}

// Last returns the last element
func (l *CircularLinkedList) Last() (int, bool) {
    if l.IsEmpty() {
        return 0, false
    }
    return l.tail.Val, true
}

// Rotate moves the first element to the back
// Time: O(1), Space: O(1)
func (l *CircularLinkedList) Rotate() {
    if l.size > 1 {
        l.tail = l.tail.Next // old head becomes new tail
    }
}

// AddFirst inserts at the front
// Time: O(1), Space: O(1)
func (l *CircularLinkedList) AddFirst(val int) {
    if l.IsEmpty() {
        l.tail = &ListNode{Val: val}
        l.tail.Next = l.tail // points to itself
    } else {
        newNode := &ListNode{Val: val, Next: l.tail.Next}
        l.tail.Next = newNode
    }
    l.size++
}

// AddLast inserts at the back
// Time: O(1), Space: O(1)
func (l *CircularLinkedList) AddLast(val int) {
    l.AddFirst(val)
    l.tail = l.tail.Next // move tail to new node
}

// RemoveFirst removes and returns the first element
// Time: O(1), Space: O(1)
func (l *CircularLinkedList) RemoveFirst() (int, bool) {
    if l.IsEmpty() {
        return 0, false
    }

    head := l.tail.Next
    val := head.Val

    if l.size == 1 {
        l.tail = nil
    } else {
        l.tail.Next = head.Next
    }

    l.size--
    return val, true
}

// ToSlice converts to a slice (for testing)
func (l *CircularLinkedList) ToSlice() []int {
    if l.IsEmpty() {
        return []int{}
    }

    result := make([]int, 0, l.size)
    curr := l.tail.Next // start from head
    for i := 0; i < l.size; i++ {
        result = append(result, curr.Val)
        curr = curr.Next
    }
    return result
}

// JosephusProblem solves the Josephus problem
// n people stand in a circle, every k-th person is eliminated
// Returns the position of the last survivor (1-indexed)
func JosephusProblem(n, k int) int {
    // Create circular list with people numbered 1 to n
    circle := NewCircularLinkedList()
    for i := n; i >= 1; i-- {
        circle.AddFirst(i)
    }

    // Eliminate every k-th person
    for circle.Size() > 1 {
        // Move to the (k-1)th position (person before elimination)
        for i := 0; i < k-1; i++ {
            circle.Rotate()
        }
        circle.RemoveFirst() // eliminate k-th person
    }

    survivor, _ := circle.First()
    return survivor
}
```

This Josephus implementation is O(n*k) time: it performs n-1 eliminations, each preceded by k-1 rotations. That is fine for demonstrating the structure, but if an interviewer asks for the survivor and not the elimination order, the closed-form recurrence `J(1) = 0; J(i) = (J(i-1) + k) mod i`, converted back to 1-indexing at the end, answers in O(n) time and O(1) space with no list at all. Knowing both, and knowing why you would still build the list when the elimination order itself is the output, is the point.

### Junior -> FAANG: Making Implementation Fluent Under Pressure

The code in this section covers three distinct list variants. For interviews, you will almost never need to implement all three from scratch. What you need is instant recall of the key primitives for each.

For singly linked lists, the critical primitives are: insert at head (O(1), no traversal), append at tail (O(n) without tail pointer), delete at index (requires predecessor reference), and traversal. Any problem that asks you to "implement a linked list" is almost always asking for these four.

For doubly linked lists, the sentinel pattern (head and tail dummy nodes with no data) is worth memorizing. It eliminates every edge case that arises when the list is empty or has one element. The `addBetween` helper shown in the code above is the key building block: once you have it, every insert becomes a two-argument call specifying predecessor and successor, and the main logic never touches nil.

For circular lists, the single pointer to `tail` is the insight. `tail.Next` gives the head in O(1), and rotation is a single pointer reassignment. Practice the Josephus problem as a worked example: it forces you to think about what "removing the current element" means when you only hold the predecessor.

**First-job habit:** When you start a new linked list implementation, write the sentinel/dummy node setup and the helper methods first (`addBetween`, `removeNode`). Then every public method is one or two lines. This approach produces shorter, more reviewable code than writing each operation independently.

### Senior @ FAANG: Design Decisions in List APIs and Concurrency Models

**API surface decisions.** The implementations above expose `Head` publicly, which is useful for testing but dangerous in production libraries. A production-grade list type should keep `head` unexported and expose only the behavioral interface (add, remove, iterate). Exposing the head allows callers to traverse and mutate the list without going through the guarded methods, breaking invariants including size tracking and sentinel integrity.

**Generics versus interface trade-off.** The implementation uses concrete `int` values. A production library would use a type parameter `[T any]` or `[T comparable]`. The decision between `any` and `comparable` depends on whether the list needs to support `Contains` or equality-based removal. Using `comparable` at the type level makes the constraint explicit and enables the compiler to catch misuse rather than deferring to runtime.

**Concurrency model selection.** Every implementation above is unsynchronized, which is the right default: the caller decides the policy. When you do add synchronization, the spectrum runs from a single mutex, through an RWMutex, to sharding, to a channel-based design. For high-throughput lists shared across goroutines, RWMutex is rarely the right answer because a write-heavy workload serializes completely and you have paid for a more expensive lock to get nothing. A sharded approach, where the list is partitioned into N segments each with its own lock, reduces contention at the cost of approximate global ordering. For use cases that tolerate approximate ordering (a work-stealing scheduler, for example), this trade-off is correct. For use cases that require strict FIFO or LIFO across all goroutines (a shared undo stack), a single mutex or a channel-based design is appropriate, and this choice belongs in the package godoc.

**Bar-raiser signal: size tracking accuracy under concurrent mutation.** `size` is a plain `int` incremented and decremented outside any lock. That is correct here only because the type is documented as unsynchronized. The moment someone wraps these methods in a mutex but leaves `Size()` reading the field directly, they have a data race that `go test -race` will catch. The fix is either to read and write size under the same mutex or to make it a `sync/atomic` value. The choice depends on whether `Size()` must be consistent with the list state at the moment of the call (mutex) or may be an approximate count (atomic). A concurrent `Size()` that is merely approximate is often fine, but it must be documented as such, because callers who write `if l.Size() > 0 { l.DeleteFirst() }` have written a race regardless of how `Size` is implemented.

**Node cleanup on removal.** `deleteNode` unlinks a node but leaves that node's own `Prev` and `Next` pointing into the list. If a caller holds a reference to a removed node, those stale pointers keep every node reachable from it alive, and the garbage collector cannot reclaim a list you believe you have emptied. The standard library hits exactly this problem: `container/list.Remove` explicitly nils the removed element's pointers with the comment "avoid memory leaks". Production code should do the same:

```go
func (l *DoublyLinkedList) deleteNode(node *DoublyListNode) int {
    pred := node.Prev
    succ := node.Next
    pred.Next = succ
    succ.Prev = pred

    // Unlink the removed node so a caller holding it cannot
    // keep the rest of the list reachable.
    node.Prev = nil
    node.Next = nil

    l.size--
    return node.Val
}
```
