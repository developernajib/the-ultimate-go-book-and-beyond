export default `## 8.5 Generic Types

### Generic Structs

Generic structs parameterize the types of their fields, enabling reusable container types like stacks, queues, and trees that maintain type safety for any element type.

\`\`\`go
// Thread-safe generic stack
type Stack[T any] struct {
    mu    sync.RWMutex
    items []T
}

func NewStack[T any]() *Stack[T] {
    return &Stack[T]{items: make([]T, 0)}
}

func (s *Stack[T]) Push(item T) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.items = append(s.items, item)
}

func (s *Stack[T]) Pop() (T, bool) {
    s.mu.Lock()
    defer s.mu.Unlock()

    if len(s.items) == 0 {
        var zero T
        return zero, false
    }

    item := s.items[len(s.items)-1]
    s.items = s.items[:len(s.items)-1]
    return item, true
}

func (s *Stack[T]) Peek() (T, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    if len(s.items) == 0 {
        var zero T
        return zero, false
    }
    return s.items[len(s.items)-1], true
}

func (s *Stack[T]) Size() int {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return len(s.items)
}

func (s *Stack[T]) IsEmpty() bool {
    return s.Size() == 0
}

// Usage
intStack := NewStack[int]()
intStack.Push(1)
intStack.Push(2)
intStack.Push(3)

for !intStack.IsEmpty() {
    v, _ := intStack.Pop()
    fmt.Println(v)  // 3, 2, 1
}
\`\`\`

### Generic Queue

A generic queue implements FIFO semantics for any element type. Using a type parameter instead of \`any\` prevents mixing types within a single queue instance and eliminates type assertions at dequeue.

\`\`\`go
// Thread-safe generic queue
type Queue[T any] struct {
    mu    sync.RWMutex
    items []T
}

func NewQueue[T any]() *Queue[T] {
    return &Queue[T]{items: make([]T, 0)}
}

func (q *Queue[T]) Enqueue(item T) {
    q.mu.Lock()
    defer q.mu.Unlock()
    q.items = append(q.items, item)
}

func (q *Queue[T]) Dequeue() (T, bool) {
    q.mu.Lock()
    defer q.mu.Unlock()

    if len(q.items) == 0 {
        var zero T
        return zero, false
    }

    item := q.items[0]
    q.items = q.items[1:]
    return item, true
}

func (q *Queue[T]) Front() (T, bool) {
    q.mu.RLock()
    defer q.mu.RUnlock()

    if len(q.items) == 0 {
        var zero T
        return zero, false
    }
    return q.items[0], true
}

func (q *Queue[T]) Size() int {
    q.mu.RLock()
    defer q.mu.RUnlock()
    return len(q.items)
}
\`\`\`

### Generic Linked List

A generic linked list provides type-safe node traversal and insertion. The type parameter propagates through the node structure, ensuring all nodes hold values of the same type.

\`\`\`go
type ListNode[T any] struct {
    Value T
    Next  *ListNode[T]
    Prev  *ListNode[T]
}

type LinkedList[T any] struct {
    head *ListNode[T]
    tail *ListNode[T]
    size int
}

func NewLinkedList[T any]() *LinkedList[T] {
    return &LinkedList[T]{}
}

func (l *LinkedList[T]) Append(value T) {
    node := &ListNode[T]{Value: value}
    if l.head == nil {
        l.head = node
        l.tail = node
    } else {
        node.Prev = l.tail
        l.tail.Next = node
        l.tail = node
    }
    l.size++
}

func (l *LinkedList[T]) Prepend(value T) {
    node := &ListNode[T]{Value: value}
    if l.head == nil {
        l.head = node
        l.tail = node
    } else {
        node.Next = l.head
        l.head.Prev = node
        l.head = node
    }
    l.size++
}

func (l *LinkedList[T]) Remove(node *ListNode[T]) {
    if node.Prev != nil {
        node.Prev.Next = node.Next
    } else {
        l.head = node.Next
    }
    if node.Next != nil {
        node.Next.Prev = node.Prev
    } else {
        l.tail = node.Prev
    }
    l.size--
}

func (l *LinkedList[T]) ToSlice() []T {
    result := make([]T, 0, l.size)
    for node := l.head; node != nil; node = node.Next {
        result = append(result, node.Value)
    }
    return result
}

func (l *LinkedList[T]) ForEach(fn func(T)) {
    for node := l.head; node != nil; node = node.Next {
        fn(node.Value)
    }
}

func (l *LinkedList[T]) Size() int {
    return l.size
}
\`\`\`

### Generic Set

A generic set implements mathematical set operations on any comparable type. The \`comparable\` constraint ensures the type can be used as a map key, backing the set's O(1) membership test.

\`\`\`go
type Set[T comparable] struct {
    items map[T]struct{}
}

func NewSet[T comparable](items ...T) *Set[T] {
    s := &Set[T]{items: make(map[T]struct{})}
    for _, item := range items {
        s.Add(item)
    }
    return s
}

func (s *Set[T]) Add(items ...T) {
    for _, item := range items {
        s.items[item] = struct{}{}
    }
}

func (s *Set[T]) Remove(item T) {
    delete(s.items, item)
}

func (s *Set[T]) Contains(item T) bool {
    _, ok := s.items[item]
    return ok
}

func (s *Set[T]) Size() int {
    return len(s.items)
}

func (s *Set[T]) ToSlice() []T {
    result := make([]T, 0, len(s.items))
    for item := range s.items {
        result = append(result, item)
    }
    return result
}

// Set operations
func (s *Set[T]) Union(other *Set[T]) *Set[T] {
    result := NewSet[T](s.ToSlice()...)
    for item := range other.items {
        result.Add(item)
    }
    return result
}

func (s *Set[T]) Intersection(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for item := range s.items {
        if other.Contains(item) {
            result.Add(item)
        }
    }
    return result
}

func (s *Set[T]) Difference(other *Set[T]) *Set[T] {
    result := NewSet[T]()
    for item := range s.items {
        if !other.Contains(item) {
            result.Add(item)
        }
    }
    return result
}

func (s *Set[T]) IsSubset(other *Set[T]) bool {
    for item := range s.items {
        if !other.Contains(item) {
            return false
        }
    }
    return true
}
\`\`\`

### Generic LRU Cache

A generic LRU cache parameterizes both key and value types, enabling type-safe eviction-based caching without runtime type assertions. The key must satisfy \`comparable\` to be used in the underlying map.

\`\`\`go
// LRUCache with generics
type LRUCache[K comparable, V any] struct {
    mu       sync.Mutex
    capacity int
    items    map[K]*lruNode[K, V]
    list     *LinkedList[*lruNode[K, V]]
}

type lruNode[K comparable, V any] struct {
    key   K
    value V
    node  *ListNode[*lruNode[K, V]]
}

func NewLRUCache[K comparable, V any](capacity int) *LRUCache[K, V] {
    return &LRUCache[K, V]{
        capacity: capacity,
        items:    make(map[K]*lruNode[K, V]),
        list:     NewLinkedList[*lruNode[K, V]](),
    }
}

func (c *LRUCache[K, V]) Get(key K) (V, bool) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if node, ok := c.items[key]; ok {
        // Move to front (most recently used)
        c.list.Remove(node.node)
        c.list.Prepend(node)
        node.node = c.list.head
        return node.value, true
    }

    var zero V
    return zero, false
}

func (c *LRUCache[K, V]) Put(key K, value V) {
    c.mu.Lock()
    defer c.mu.Unlock()

    if node, ok := c.items[key]; ok {
        // Update existing
        node.value = value
        c.list.Remove(node.node)
        c.list.Prepend(node)
        node.node = c.list.head
        return
    }

    // Add new
    if c.list.Size() >= c.capacity {
        // Evict least recently used (tail)
        if c.list.tail != nil {
            evicted := c.list.tail.Value
            delete(c.items, evicted.key)
            c.list.Remove(c.list.tail)
        }
    }

    node := &lruNode[K, V]{key: key, value: value}
    c.list.Prepend(node)
    node.node = c.list.head
    c.items[key] = node
}

func (c *LRUCache[K, V]) Size() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.list.Size()
}
\`\`\`

### Generic Types Are a Library-Level Tool

Generic data structures (stack, queue, set, LRU cache) are the canonical good use of generic types. They are type-safe, reusable across every caller, and do not leak type parameters into application code. Application-level domain types (\`User\`, \`Order\`, \`Payment\`) should almost never be generic. When a domain type is generic, the team pays the complexity cost in every use site.

---
`;
