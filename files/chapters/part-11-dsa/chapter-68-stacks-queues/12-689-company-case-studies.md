## 68.10 Company Case Studies

### Collaborative Editor: Undo/Redo with Two Stacks

The dual-stack pattern is the textbook implementation of undo/redo in any editor. Real collaborative editors layer operational transformation or CRDT machinery on top, and that layer is where the genuinely hard problems live, but the two-stack core is where every implementation starts:

```go
// Undo/redo system using the command pattern
package docs

import (
    "sync"
    "time"
)

// Command represents a document operation
type Command interface {
    Execute() error
    Undo() error
    Description() string
}

// TextInsertCommand represents inserting text
type TextInsertCommand struct {
    docID    string
    position int
    text     string
    author   string
    timestamp time.Time
}

func (c *TextInsertCommand) Execute() error {
    // Insert text at position
    return nil
}

func (c *TextInsertCommand) Undo() error {
    // Remove inserted text
    return nil
}

func (c *TextInsertCommand) Description() string {
    return "Insert text"
}

// UndoRedoManager manages document history
type UndoRedoManager struct {
    undoStack []Command
    redoStack []Command
    maxSize   int

    // Collaborative editing support
    userStacks map[string]*UserHistory  // Per-user undo stacks

    mu sync.RWMutex
}

type UserHistory struct {
    undoStack []Command
    redoStack []Command
}

// NewUndoRedoManager creates a new manager
func NewUndoRedoManager(maxSize int) *UndoRedoManager {
    return &UndoRedoManager{
        undoStack:  make([]Command, 0),
        redoStack:  make([]Command, 0),
        maxSize:    maxSize,
        userStacks: make(map[string]*UserHistory),
    }
}

// Execute performs a command and adds to undo stack
func (m *UndoRedoManager) Execute(cmd Command, userID string) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    if err := cmd.Execute(); err != nil {
        return err
    }

    // Add to global undo stack
    m.undoStack = append(m.undoStack, cmd)
    if len(m.undoStack) > m.maxSize {
        m.undoStack = m.undoStack[1:]
    }

    // Clear redo stack - new action invalidates redo
    m.redoStack = nil

    // Add to user's undo stack
    if m.userStacks[userID] == nil {
        m.userStacks[userID] = &UserHistory{}
    }
    m.userStacks[userID].undoStack = append(m.userStacks[userID].undoStack, cmd)
    m.userStacks[userID].redoStack = nil

    return nil
}

// Undo reverts the last command for a user
func (m *UndoRedoManager) Undo(userID string) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    history := m.userStacks[userID]
    if history == nil || len(history.undoStack) == 0 {
        return nil
    }

    // Pop from undo stack
    cmd := history.undoStack[len(history.undoStack)-1]
    history.undoStack = history.undoStack[:len(history.undoStack)-1]

    // Execute undo
    if err := cmd.Undo(); err != nil {
        return err
    }

    // Push to redo stack
    history.redoStack = append(history.redoStack, cmd)

    return nil
}

// Redo reapplies the last undone command
func (m *UndoRedoManager) Redo(userID string) error {
    m.mu.Lock()
    defer m.mu.Unlock()

    history := m.userStacks[userID]
    if history == nil || len(history.redoStack) == 0 {
        return nil
    }

    // Pop from redo stack
    cmd := history.redoStack[len(history.redoStack)-1]
    history.redoStack = history.redoStack[:len(history.redoStack)-1]

    // Re-execute
    if err := cmd.Execute(); err != nil {
        return err
    }

    // Push back to undo stack
    history.undoStack = append(history.undoStack, cmd)

    return nil
}

// BatchUndo undoes multiple commands
func (m *UndoRedoManager) BatchUndo(userID string, count int) error {
    for i := 0; i < count; i++ {
        if err := m.Undo(userID); err != nil {
            return err
        }
    }
    return nil
}
```

### API Gateway: Request Rate Limiter with Sliding Window

A queue-based sliding window is a standard rate-limiter shape for high-traffic APIs:

```go
// Sliding window rate limiter
package ratelimit

import (
    "fmt"
    "sync"
    "time"
)

// SlidingWindowLimiter implements sliding window rate limiting
type SlidingWindowLimiter struct {
    windowSize time.Duration
    maxRequests int

    // Use deque for efficient sliding window
    requests    []time.Time
    front       int
    rear        int
    capacity    int

    mu sync.Mutex
}

// NewSlidingWindowLimiter creates a new limiter
func NewSlidingWindowLimiter(windowSize time.Duration, maxRequests int) *SlidingWindowLimiter {
    return &SlidingWindowLimiter{
        windowSize:  windowSize,
        maxRequests: maxRequests,
        requests:    make([]time.Time, maxRequests+1),
        capacity:    maxRequests + 1,
    }
}

// Allow checks if a request is allowed
// Time: O(1) amortized
func (l *SlidingWindowLimiter) Allow() bool {
    l.mu.Lock()
    defer l.mu.Unlock()

    now := time.Now()
    windowStart := now.Add(-l.windowSize)

    // Remove expired requests from front
    for l.size() > 0 && l.requests[l.front].Before(windowStart) {
        l.front = (l.front + 1) % l.capacity
    }

    // Check if under limit
    if l.size() >= l.maxRequests {
        return false
    }

    // Add new request
    l.requests[l.rear] = now
    l.rear = (l.rear + 1) % l.capacity

    return true
}

func (l *SlidingWindowLimiter) size() int {
    return (l.rear - l.front + l.capacity) % l.capacity
}

// TokenBucketLimiter implements token bucket algorithm
type TokenBucketLimiter struct {
    capacity     int
    tokens       int
    refillRate   float64  // tokens per second
    lastRefill   time.Time

    mu sync.Mutex
}

// NewTokenBucketLimiter creates a new token bucket
func NewTokenBucketLimiter(capacity int, refillRate float64) *TokenBucketLimiter {
    return &TokenBucketLimiter{
        capacity:   capacity,
        tokens:     capacity,
        refillRate: refillRate,
        lastRefill: time.Now(),
    }
}

// Allow checks if a request is allowed and consumes a token
func (l *TokenBucketLimiter) Allow() bool {
    l.mu.Lock()
    defer l.mu.Unlock()

    l.refill()

    if l.tokens > 0 {
        l.tokens--
        return true
    }

    return false
}

// refill converts elapsed time into whole tokens.
//
// The subtle part is what lastRefill advances to. Setting it to `now` throws
// away the fraction of a token's worth of time that did not round up, and
// that loss repeats on every call, so the bucket delivers measurably less
// than refillRate. At 1 token/sec polled every 1.5s, each call converts 1
// token and discards 0.5s: after 15 seconds the bucket holds 10 tokens
// instead of 15, a third of the configured rate gone with nothing logged.
// Advance lastRefill only by the time actually converted, so the remainder
// carries into the next call.
func (l *TokenBucketLimiter) refill() {
    now := time.Now()
    elapsed := now.Sub(l.lastRefill).Seconds()
    newTokens := int(elapsed * l.refillRate)

    if newTokens > 0 {
        l.tokens = min(l.capacity, l.tokens+newTokens)

        consumed := time.Duration(float64(newTokens) / l.refillRate * float64(time.Second))
        l.lastRefill = l.lastRefill.Add(consumed)

        // If the bucket saturated, drop the unconverted credit rather than
        // banking it: otherwise a long idle period accumulates arbitrary
        // backdated time and the next burst exceeds capacity.
        if l.tokens == l.capacity && l.lastRefill.Before(now) {
            l.lastRefill = now
        }
    }
}

// DistributedRateLimiter for multi-node rate limiting
type DistributedRateLimiter struct {
    localLimiter  *SlidingWindowLimiter
    redisClient   RedisClient
    keyPrefix     string
    windowSize    time.Duration
    maxRequests   int
}

type RedisClient interface {
    ZAdd(key string, score float64, member string) error
    ZRemRangeByScore(key string, min, max float64) error
    ZCard(key string) (int64, error)
    Expire(key string, expiration time.Duration) error
}

// Allow checks rate limit using Redis sorted set.
//
// NOT PRODUCTION READY, and the reason is worth studying. The four Redis
// calls below are four separate round trips with no atomicity between them.
// Two concurrent requests can both run ZRemRangeByScore and ZCard, both
// observe count == maxRequests-1, and both ZAdd. The limit is exceeded and
// nothing detects it. The window is a check-then-act race, which is the
// same defect class as calling IsEmpty() before Pop() on a shared stack,
// only now the two halves are separated by a network.
//
// The fix is to make the whole decision one atomic operation on the Redis
// side, via a Lua script through EVAL, since Redis runs a script to
// completion on its single thread:
//
//     local trimmed = redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
//     local count   = redis.call('ZCARD', KEYS[1])
//     if count >= tonumber(ARGV[3]) then return 0 end
//     redis.call('ZADD', KEYS[1], ARGV[2], ARGV[4])
//     redis.call('PEXPIRE', KEYS[1], ARGV[5])
//     return 1
//
// Note also the member value. Using a second UnixNano() call as the member
// is a latent bug: it is a different instant from the score, and on a
// coarse clock two requests can collide on the same member, in which case
// ZADD updates the existing element instead of adding one and the limiter
// silently undercounts. Use a unique member (a random token or a counter),
// not a timestamp.
func (l *DistributedRateLimiter) Allow(userID string) bool {
    key := l.keyPrefix + userID
    now := float64(time.Now().UnixNano())
    windowStart := now - float64(l.windowSize.Nanoseconds())

    // Remove old entries
    l.redisClient.ZRemRangeByScore(key, 0, windowStart)

    // Count requests in window
    count, _ := l.redisClient.ZCard(key)

    if count >= int64(l.maxRequests) {
        return false
    }

    // Add new request
    l.redisClient.ZAdd(key, now, fmt.Sprintf("%d", time.Now().UnixNano()))
    l.redisClient.Expire(key, l.windowSize*2)

    return true
}
```

### E-Commerce: Order Processing Queue

Order pipelines commonly prioritize work (express before standard, retries before fresh jobs), which is a priority queue by definition:

```go
// Order processing with a priority queue
package orders

import (
    "container/heap"
    "sync"
    "time"
)

// Order represents a customer order
type Order struct {
    ID          string
    CustomerID  string
    Items       []OrderItem
    Priority        int  // 1=Prime, 2=Standard, 3=Economy
    CreatedAt       time.Time
    PromisedBy      time.Time
    TotalValueCents int64

    index int  // Heap index
}

type OrderItem struct {
    ProductID string
    Quantity  int
}

// OrderHeap implements heap.Interface
type OrderHeap []*Order

func (h OrderHeap) Len() int { return len(h) }

func (h OrderHeap) Less(i, j int) bool {
    // Priority order: Prime > Standard > Economy
    // Within same priority, earlier promised delivery first
    // Within same delivery, higher value first
    if h[i].Priority != h[j].Priority {
        return h[i].Priority < h[j].Priority
    }
    if !h[i].PromisedBy.Equal(h[j].PromisedBy) {
        return h[i].PromisedBy.Before(h[j].PromisedBy)
    }
    return h[i].TotalValueCents > h[j].TotalValueCents
}

func (h OrderHeap) Swap(i, j int) {
    h[i], h[j] = h[j], h[i]
    h[i].index = i
    h[j].index = j
}

func (h *OrderHeap) Push(x any) {
    n := len(*h)
    order := x.(*Order)
    order.index = n
    *h = append(*h, order)
}

func (h *OrderHeap) Pop() any {
    old := *h
    n := len(old)
    order := old[n-1]
    old[n-1] = nil
    order.index = -1
    *h = old[0 : n-1]
    return order
}

// OrderProcessor manages order queue
type OrderProcessor struct {
    queue      *OrderHeap
    orderMap   map[string]*Order  // For O(1) lookup
    processing map[string]bool    // Orders being processed

    mu sync.Mutex
}

// NewOrderProcessor creates a new processor
func NewOrderProcessor() *OrderProcessor {
    h := &OrderHeap{}
    heap.Init(h)
    return &OrderProcessor{
        queue:      h,
        orderMap:   make(map[string]*Order),
        processing: make(map[string]bool),
    }
}

// Enqueue adds an order to the processing queue
func (p *OrderProcessor) Enqueue(order *Order) {
    p.mu.Lock()
    defer p.mu.Unlock()

    heap.Push(p.queue, order)
    p.orderMap[order.ID] = order
}

// Dequeue gets the next order to process
func (p *OrderProcessor) Dequeue() *Order {
    p.mu.Lock()
    defer p.mu.Unlock()

    if p.queue.Len() == 0 {
        return nil
    }

    order := heap.Pop(p.queue).(*Order)
    delete(p.orderMap, order.ID)
    p.processing[order.ID] = true

    return order
}

// UpdatePriority changes an order's priority
func (p *OrderProcessor) UpdatePriority(orderID string, newPriority int) bool {
    p.mu.Lock()
    defer p.mu.Unlock()

    order, exists := p.orderMap[orderID]
    if !exists {
        return false
    }

    order.Priority = newPriority
    heap.Fix(p.queue, order.index)
    return true
}

// CancelOrder removes an order from the queue
func (p *OrderProcessor) CancelOrder(orderID string) bool {
    p.mu.Lock()
    defer p.mu.Unlock()

    order, exists := p.orderMap[orderID]
    if !exists {
        return false
    }

    heap.Remove(p.queue, order.index)
    delete(p.orderMap, orderID)
    return true
}

// GetQueueStats returns queue statistics
func (p *OrderProcessor) GetQueueStats() QueueStats {
    p.mu.Lock()
    defer p.mu.Unlock()

    stats := QueueStats{
        TotalOrders: p.queue.Len(),
    }

    for _, order := range *p.queue {
        switch order.Priority {
        case 1:
            stats.PrimeOrders++
        case 2:
            stats.StandardOrders++
        case 3:
            stats.EconomyOrders++
        }
    }

    return stats
}

type QueueStats struct {
    TotalOrders    int
    PrimeOrders    int
    StandardOrders int
    EconomyOrders  int
}
```

### Junior -> FAANG: Reading Case Studies for System Design Vocabulary

These three case studies give you vocabulary and design patterns for system design interviews.

**Undo/Redo (command pattern + two stacks):** In a system design interview about collaborative editing, describing undo/redo as two stacks over a command interface demonstrates knowledge of the standard approach. The key detail is that a new action clears the redo stack. The advanced detail is that per-user undo stacks let user A's undo leave user B's edits alone, and the honest follow-up is that this is where the two-stack model starts to break down: if A and B edit overlapping text, A's undo may no longer be applicable, which is why real collaborative editors carry transformation logic rather than raw inverse commands.

**Rate Limiter (ring buffer + token bucket):** Rate limiting is one of the most common system design topics. The two variants shown are the sliding window log (ring buffer of timestamps) and the token bucket. Knowing both and being able to compare them is an L4/L5 signal. The distributed version using Redis sorted sets shows how to extend to multi-node scale, and also shows how easy it is to write a limiter that does not limit: see the atomicity note on that function.

**Order Processing (priority queue with `heap.Fix`):** Priority queues appear in task scheduling system design questions. The `heap.Fix` call for priority updates and the `heap.Remove` call for cancellations are Go-specific details that demonstrate practical familiarity with `container/heap` beyond basic push and pop, and both depend on the `index` field being maintained inside `Swap`.

**First-job habit:** After reading each case study, write down one thing you would add if you were productionizing it. For the undo/redo system: add a configurable max history depth per user. For the rate limiter: add a metrics endpoint that reports current window size and remaining capacity. For the order processor: add dead-letter queue handling for orders that fail processing after N attempts.

### Senior @ FAANG: Case Study Analysis as Design Review Practice

**Undo/Redo: collaborative editing concurrency.** The `UndoRedoManager` uses a single global `undoStack` alongside per-user stacks. The global stack is protected by a single mutex. In a collaborative editing system with hundreds of concurrent users, this single mutex becomes a contention point for every document edit. The production fix is to shard the global history by document ID, with each document shard having its own mutex. The per-user stacks are already user-scoped and have lower contention. A design review should raise this concern and require a sharding strategy with documented shard count rationale.

**Rate Limiter: accuracy vs. performance trade-off.** The sliding window log (ring buffer) provides exact counting within the window but requires O(maxRequests) space per rate-limiter instance. For a service with millions of unique users, this is prohibitive. The token bucket uses O(1) space per user but applies rate limiting at a coarser granularity (burst allowance is the full bucket capacity). The distributed rate limiter using Redis sorted sets is accurate but adds network latency to every request. The ADR question is: "What is the acceptable false positive rate for rate limiting?" If any false allowance is unacceptable (security-critical endpoints), use Redis. If some burst tolerance is acceptable (API rate limiting), use token bucket. Document the choice.

**Order Processor: priority mutation correctness.** The `UpdatePriority` method calls `heap.Fix(p.queue, order.index)` after changing `order.Priority`. This is correct because `heap.Fix` restores the heap property by sifting the element up or down. However, it requires that `order.index` is maintained correctly throughout the heap's lifetime. The `Swap` method updates both `h[i].index = i` and `h[j].index = j` to keep indices current. A code review must verify that `index` is updated on every `Swap` call. If any sorting or copying operation on the heap bypasses `Swap`, indices become stale and `heap.Fix` will corrupt the heap. This is a subtle correctness requirement that should be explicitly documented in the heap type's godoc.

---
