## 67.6 Advanced Linked List Problems

### Add Two Numbers

Adding two numbers stored as reversed linked lists requires simulating the grade-school addition algorithm digit by digit, propagating a carry value from one node to the next. Each node represents a single digit with the least significant digit at the head, so traversal order naturally follows arithmetic order. When the lists have different lengths or a final carry remains, the loop must continue until all input and carry are exhausted.

```go
// AddTwoNumbers adds two numbers represented as reversed linked lists
// LeetCode 2: Add Two Numbers
// Input: (2 -> 4 -> 3) + (5 -> 6 -> 4) = 342 + 465 = 807
// Output: 7 -> 0 -> 8
// Time: O(max(m, n)), Space: O(max(m, n))
func AddTwoNumbers(l1, l2 *ListNode) *ListNode {
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

// AddTwoNumbersII adds two numbers in forward order
// LeetCode 445: Add Two Numbers II
// Input: (7 -> 2 -> 4 -> 3) + (5 -> 6 -> 4) = 7243 + 564 = 7807
// Output: 7 -> 8 -> 0 -> 7
// Time: O(m + n), Space: O(m + n)
func AddTwoNumbersII(l1, l2 *ListNode) *ListNode {
    // Use stacks to reverse order
    stack1, stack2 := []int{}, []int{}

    for l1 != nil {
        stack1 = append(stack1, l1.Val)
        l1 = l1.Next
    }

    for l2 != nil {
        stack2 = append(stack2, l2.Val)
        l2 = l2.Next
    }

    var head *ListNode
    carry := 0

    for len(stack1) > 0 || len(stack2) > 0 || carry > 0 {
        sum := carry

        if len(stack1) > 0 {
            sum += stack1[len(stack1)-1]
            stack1 = stack1[:len(stack1)-1]
        }

        if len(stack2) > 0 {
            sum += stack2[len(stack2)-1]
            stack2 = stack2[:len(stack2)-1]
        }

        carry = sum / 10
        node := &ListNode{Val: sum % 10, Next: head}
        head = node
    }

    return head
}
```

### Copy List with Random Pointer

Deep-copying a linked list where each node also holds an arbitrary `Random` pointer is tricky because the target of a random pointer may not yet have been created when you first encounter it. The hash-map approach solves this by making two passes: one to clone all nodes and one to wire up both `Next` and `Random` references using the map as a lookup. The space-optimized variant instead interleaves copied nodes directly into the original list, allowing random pointers to be set without any extra memory, then separates the two lists in a final pass.

```go
// Node for problem with random pointer
type RandomNode struct {
    Val    int
    Next   *RandomNode
    Random *RandomNode
}

// CopyRandomList creates a deep copy of a list with random pointers
// LeetCode 138: Copy List with Random Pointer
// Time: O(n), Space: O(n)
func CopyRandomList(head *RandomNode) *RandomNode {
    if head == nil {
        return nil
    }

    // Map original nodes to copied nodes
    nodeMap := make(map[*RandomNode]*RandomNode)

    // First pass: create all nodes
    curr := head
    for curr != nil {
        nodeMap[curr] = &RandomNode{Val: curr.Val}
        curr = curr.Next
    }

    // Second pass: set next and random pointers
    curr = head
    for curr != nil {
        if curr.Next != nil {
            nodeMap[curr].Next = nodeMap[curr.Next]
        }
        if curr.Random != nil {
            nodeMap[curr].Random = nodeMap[curr.Random]
        }
        curr = curr.Next
    }

    return nodeMap[head]
}

// CopyRandomListO1Space creates a deep copy with O(1) extra space
// Time: O(n), Space: O(1) (excluding output)
func CopyRandomListO1Space(head *RandomNode) *RandomNode {
    if head == nil {
        return nil
    }

    // Step 1: Interleave copied nodes
    // A -> A' -> B -> B' -> C -> C'
    curr := head
    for curr != nil {
        copied := &RandomNode{Val: curr.Val, Next: curr.Next}
        curr.Next = copied
        curr = copied.Next
    }

    // Step 2: Set random pointers for copied nodes
    curr = head
    for curr != nil {
        if curr.Random != nil {
            curr.Next.Random = curr.Random.Next
        }
        curr = curr.Next.Next
    }

    // Step 3: Separate the two lists
    dummy := &RandomNode{}
    copyCurr := dummy
    curr = head

    for curr != nil {
        copyCurr.Next = curr.Next
        curr.Next = curr.Next.Next

        copyCurr = copyCurr.Next
        curr = curr.Next
    }

    return dummy.Next
}
```

### Flatten a Multilevel Doubly Linked List

A multilevel doubly linked list extends the standard doubly linked structure by giving each node an optional `Child` pointer that points to a separate sublist. Flattening it means merging every child sublist inline, in depth-first order, so the result is a single-level doubly linked list. The recursive approach delegates flattening to a helper that returns the tail of each sublist, enabling clean splicing of children between the current node and its original successor.

```go
// MultiLevelNode represents a node in a multilevel doubly linked list
type MultiLevelNode struct {
    Val   int
    Prev  *MultiLevelNode
    Next  *MultiLevelNode
    Child *MultiLevelNode
}

// Flatten flattens a multilevel doubly linked list
// LeetCode 430: Flatten a Multilevel Doubly Linked List
// Time: O(n), Space: O(depth) for recursion
func Flatten(head *MultiLevelNode) *MultiLevelNode {
    if head == nil {
        return nil
    }

    flattenDFS(head)
    return head
}

// flattenDFS flattens the list and returns the tail
func flattenDFS(head *MultiLevelNode) *MultiLevelNode {
    curr := head
    var tail *MultiLevelNode

    for curr != nil {
        next := curr.Next

        if curr.Child != nil {
            // Flatten child list
            childTail := flattenDFS(curr.Child)

            // Connect curr -> child
            curr.Next = curr.Child
            curr.Child.Prev = curr

            // Connect childTail -> next
            if next != nil {
                childTail.Next = next
                next.Prev = childTail
            }

            // Clear child pointer
            curr.Child = nil

            tail = childTail
        } else {
            tail = curr
        }

        curr = next
    }

    return tail
}

// FlattenIterative flattens using iteration with stack
// Time: O(n), Space: O(depth)
func FlattenIterative(head *MultiLevelNode) *MultiLevelNode {
    if head == nil {
        return nil
    }

    // Use dummy node and stack
    dummy := &MultiLevelNode{Next: head}
    stack := []*MultiLevelNode{}

    curr := head
    prev := dummy

    for curr != nil || len(stack) > 0 {
        if curr == nil {
            // Pop from stack
            curr = stack[len(stack)-1]
            stack = stack[:len(stack)-1]
        }

        // Connect
        prev.Next = curr
        curr.Prev = prev

        // If has child and next, push next to stack
        if curr.Child != nil {
            if curr.Next != nil {
                stack = append(stack, curr.Next)
            }
            curr.Next = curr.Child
            curr.Child = nil
        }

        prev = curr
        curr = curr.Next
    }

    // Disconnect dummy
    dummy.Next.Prev = nil

    return dummy.Next
}
```

### LRU Cache Using Linked List

An LRU (Least Recently Used) cache evicts the least recently accessed item whenever capacity is exceeded, requiring both O(1) lookup and O(1) reordering. Combining a hash map with a doubly linked list achieves this: the map provides instant node lookup by key, while the list maintains access order with sentinel head and tail nodes to simplify pointer manipulation. Every `Get` and `Put` operation moves the accessed node to the head of the list, keeping the tail as the eviction candidate.

```go
// LRUNode represents a node in the LRU cache
type LRUNode struct {
    key, value int
    prev, next *LRUNode
}

// LRUCache implements an LRU cache using doubly linked list and hash map
// LeetCode 146: LRU Cache
type LRUCache struct {
    capacity int
    cache    map[int]*LRUNode
    head     *LRUNode // most recently used
    tail     *LRUNode // least recently used
}

// Constructor creates a new LRU cache
func Constructor(capacity int) LRUCache {
    head := &LRUNode{}
    tail := &LRUNode{}
    head.next = tail
    tail.prev = head

    return LRUCache{
        capacity: capacity,
        cache:    make(map[int]*LRUNode),
        head:     head,
        tail:     tail,
    }
}

// removeNode removes a node from the list
func (c *LRUCache) removeNode(node *LRUNode) {
    node.prev.next = node.next
    node.next.prev = node.prev
}

// addToHead adds a node right after head
func (c *LRUCache) addToHead(node *LRUNode) {
    node.prev = c.head
    node.next = c.head.next
    c.head.next.prev = node
    c.head.next = node
}

// moveToHead moves an existing node to head
func (c *LRUCache) moveToHead(node *LRUNode) {
    c.removeNode(node)
    c.addToHead(node)
}

// removeTail removes and returns the least recently used node
func (c *LRUCache) removeTail() *LRUNode {
    node := c.tail.prev
    c.removeNode(node)
    return node
}

// Get retrieves a value from the cache
// Time: O(1)
func (c *LRUCache) Get(key int) int {
    if node, ok := c.cache[key]; ok {
        c.moveToHead(node)
        return node.value
    }
    return -1
}

// Put adds or updates a value in the cache
// Time: O(1)
func (c *LRUCache) Put(key int, value int) {
    if node, ok := c.cache[key]; ok {
        node.value = value
        c.moveToHead(node)
        return
    }

    // Create new node
    newNode := &LRUNode{key: key, value: value}
    c.cache[key] = newNode
    c.addToHead(newNode)

    // Check capacity
    if len(c.cache) > c.capacity {
        tail := c.removeTail()
        delete(c.cache, tail.key)
    }
}
```

### Junior -> FAANG: Recognizing the Composite Data Structure

The LRU cache is the canonical example of a problem that requires combining two data structures. Neither a hash map alone nor a linked list alone is sufficient. The hash map provides O(1) key lookup but has no concept of order. The doubly linked list maintains access order but requires O(n) lookup to find a specific key. Together they achieve O(1) for both.

The key insight to communicate in an interview is why the list must be doubly linked. When evicting the tail node, you must update the second-to-last node's `next` pointer to point to the tail sentinel. Without a backward pointer, finding the predecessor requires O(n) traversal, which would drop `Put` to O(n) and defeat the whole design. The sentinel head and tail nodes eliminate all nil checks during add and remove operations: every real node always has a valid predecessor and successor (the sentinels).

The second insight, and the one candidates most often miss, is why `LRUNode` stores `key` as well as `value`. The node is found through the map on a `Get`, so the key looks redundant. It is not. On eviction you start from `tail.prev`, holding only a node, and you must delete that entry from the map, which requires its key. Without the back-reference you would have to scan the map to find which key maps to this node, turning O(1) eviction into O(n). Storing the key in the node is what closes the loop between the two structures.

**Add Two Numbers interview habit:** When you see a "compute on lists" problem, immediately check whether the digits are stored in forward or reverse order. LeetCode 2 uses reverse order (least significant digit at head), which aligns with the carry propagation direction. LeetCode 445 uses forward order, which requires reversing or using a stack. State this observation out loud before writing code.

**Copy List with Random Pointer - the O(1) space trick:** The interleaving approach (A -> A' -> B -> B' -> ...) is an elegant technique that eliminates the hash map by embedding the mapping directly into the list structure. The observation is that after interleaving, `curr.Next.Random = curr.Random.Next` because the copy of `curr.Random` is always `curr.Random.Next`. This pattern generalizes to any "duplicate a structure with cross-references" problem.

**Flatten multilevel list:** The iterative stack approach is easier to reason about than the recursive approach in a time-pressured interview because it avoids reasoning about return values and tail linking simultaneously. Practice both so you can choose the one that feels more natural under pressure.

### Senior @ FAANG: LRU Cache Design at Scale and Production Considerations

**LRU as a platform decision.** The LRU implementation shown is single-threaded. In a production Go service, every concurrent `Get` and `Put` requires locking because both operations mutate the linked list. The naive fix adds a `sync.Mutex` wrapper. The production concern is lock contention: a single global mutex on a heavily accessed LRU cache becomes the bottleneck in a high-QPS service.

**Sharded LRU for concurrency.** A sharded cache splits the key space into N shards, each with its own LRU list, hash map, and mutex. Sharding reduces contention by a factor of N at the cost of imprecise global LRU ordering: the globally least-recently-used item may not be the least-recently-used item within its shard. For most application-level caches (HTTP response caches, database query caches), this approximation is acceptable and the throughput gain is significant. Document the approximation in the design doc.

**ADR: LRU vs. TinyLFU.** Modern high-performance caches (Caffeine in Java, Ristretto in Go) use TinyLFU or Window-TinyLFU rather than pure LRU. TinyLFU maintains frequency counters using a compact probabilistic data structure (Count-Min Sketch) and combines frequency with recency to make better eviction decisions for workloads with non-uniform access distributions. A staff-level engineer evaluating cache implementations should ask whether the workload is LRU-friendly (scan-resistant, no hot key skew) before choosing pure LRU.

**Bar-raiser question: LFU cache design.** The LFU cache (implemented in `15-6712-interview-questions.md`) extends the LRU concept by evicting the least frequently accessed key rather than the least recently accessed. The implementation requires a frequency-indexed set of doubly linked lists plus a hash map, maintaining a `minFreq` pointer for O(1) eviction. This is a Hard LeetCode problem (460) and is the expected next step after LRU in a senior-track interview. A candidate who can implement LFU cleanly and explain the `minFreq` update invariant is demonstrating L5 algorithmic fluency.
