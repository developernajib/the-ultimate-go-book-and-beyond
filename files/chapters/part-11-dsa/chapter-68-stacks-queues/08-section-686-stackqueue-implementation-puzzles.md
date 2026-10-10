## 68.6 Stack/Queue Implementation Puzzles

### Implement Queue Using Stacks

Simulating a queue with two stacks exploits a lazy reversal strategy: elements are pushed onto an "input" stack, and dequeue operations transfer the entire input stack to an "output" stack (reversing order) only when the output stack is empty. Each element crosses from input to output exactly once, making dequeue O(1) amortized despite the occasional O(n) transfer. This two-stack queue is a classic interview design question because it demonstrates amortized analysis reasoning.

**Proving the amortization.** The claim is that any sequence of n operations costs O(n) total, so each costs O(1) amortized. Hand-waving "each element moves once" is the right intuition, but the accounting argument is what an interviewer is listening for, and it comes in two equivalent forms.

*The accounting method.* Charge each `Push` three units of work: one to push onto `input` now, one prepaid for its eventual move off `input`, and one prepaid for its eventual push onto `output`. `Push` therefore costs O(1) and leaves two units of credit sitting on that element. When a transfer runs, every element it moves pays for its own move out of the credit deposited at push time, so the transfer costs the caller nothing new. `Pop` spends O(1) popping from `output`. Since each element is pushed once and transferred at most once, credit is never overdrawn. Total cost for n operations is at most 3n, which is O(n).

*The potential method.* Define the potential Phi = len(input), which is zero on an empty queue and never negative, both of which the method requires. `Push` has real cost 1 and raises Phi by 1, so its amortized cost is 1 + 1 = 2. A `Pop` that finds `output` non-empty has real cost 1 and leaves Phi unchanged, so its amortized cost is 1. A `Pop` that triggers a transfer of k elements has real cost about k + 1, but drops Phi from k to 0, so its amortized cost is (k + 1) - k = 1. Every operation is O(1) amortized, and since Phi starts at zero and stays non-negative, the sum of amortized costs bounds the true total.

Note what the bound does *not* say. A single `Pop` can genuinely take O(n) wall-clock time, so this structure is fine for throughput and unsuitable for hard latency targets: the worst case is unchanged, only the average over a sequence is good. Note also that the credit argument breaks the moment `transfer` is allowed to run while `output` is non-empty, since elements could then cross more than once and pay for a move they never deposited credit for. The `if len(q.output) == 0` guard is not an optimization. It is the precondition the entire proof rests on.

```go
// MyQueue implements a queue using two stacks
// LeetCode 232: Implement Queue using Stacks
type MyQueue struct {
    input  []int // for push
    output []int // for pop
}

func QueueConstructor() MyQueue {
    return MyQueue{}
}

// Push adds element to the back
// Time: O(1)
func (q *MyQueue) Push(x int) {
    q.input = append(q.input, x)
}

// transfer moves elements from input to output
func (q *MyQueue) transfer() {
    if len(q.output) == 0 {
        for len(q.input) > 0 {
            q.output = append(q.output, q.input[len(q.input)-1])
            q.input = q.input[:len(q.input)-1]
        }
    }
}

// Pop removes element from the front
// Time: O(1) amortized
func (q *MyQueue) Pop() int {
    q.transfer()
    val := q.output[len(q.output)-1]
    q.output = q.output[:len(q.output)-1]
    return val
}

// Peek returns the front element
// Time: O(1) amortized
func (q *MyQueue) Peek() int {
    q.transfer()
    return q.output[len(q.output)-1]
}

// Empty returns true if queue is empty
func (q *MyQueue) Empty() bool {
    return len(q.input) == 0 && len(q.output) == 0
}
```

### Implement Stack Using Queues

Simulating a stack with a single queue requires making every push O(n): after enqueueing the new element, rotate the entire queue so the new element is at the front. This ensures all pops and peeks are O(1) because the most-recently-pushed element is always at the queue head. The trade-off is O(n) push to obtain O(1) pop, the opposite amortization direction compared to the queue-from-stacks design.

```go
// MyStack implements a stack using a single queue
// LeetCode 225: Implement Stack using Queues
type MyStack struct {
    queue []int
}

func StackConstructor() MyStack {
    return MyStack{}
}

// Push adds element to the top
// Time: O(n) - rotate the queue
func (s *MyStack) Push(x int) {
    s.queue = append(s.queue, x)

    // Rotate to make the new element first
    for i := 0; i < len(s.queue)-1; i++ {
        s.queue = append(s.queue, s.queue[0])
        s.queue = s.queue[1:]
    }
}

// Pop removes element from the top
// Time: O(1)
func (s *MyStack) Pop() int {
    val := s.queue[0]
    s.queue = s.queue[1:]
    return val
}

// Top returns the top element
// Time: O(1)
func (s *MyStack) Top() int {
    return s.queue[0]
}

// Empty returns true if stack is empty
func (s *MyStack) Empty() bool {
    return len(s.queue) == 0
}
```

### Min Stack

A min stack augments a standard stack with a parallel auxiliary stack that tracks the running minimum at each level. When a new value is pushed, the auxiliary stack records the minimum of that value and the current minimum, ensuring that `GetMin` always returns the correct result in O(1) regardless of the push/pop order. The optimized variant eliminates the auxiliary stack by storing encoded differences, reducing space at the cost of slightly more complex arithmetic during push and pop.

```go
// MinStack supports push, pop, top, and getMin in O(1)
// LeetCode 155: Min Stack
type MinStack struct {
    stack    []int
    minStack []int
}

func MinStackConstructor() MinStack {
    return MinStack{}
}

// Push adds element to stack
// Time: O(1)
func (s *MinStack) Push(val int) {
    s.stack = append(s.stack, val)

    if len(s.minStack) == 0 || val <= s.minStack[len(s.minStack)-1] {
        s.minStack = append(s.minStack, val)
    }
}

// Pop removes top element
// Time: O(1)
func (s *MinStack) Pop() {
    top := s.stack[len(s.stack)-1]
    s.stack = s.stack[:len(s.stack)-1]

    if top == s.minStack[len(s.minStack)-1] {
        s.minStack = s.minStack[:len(s.minStack)-1]
    }
}

// Top returns top element
// Time: O(1)
func (s *MinStack) Top() int {
    return s.stack[len(s.stack)-1]
}

// GetMin returns minimum element
// Time: O(1)
func (s *MinStack) GetMin() int {
    return s.minStack[len(s.minStack)-1]
}

// MinStackOptimized uses less space by storing the difference from the
// running minimum instead of a parallel stack.
//
// IMPORTANT, and the reason this is a puzzle rather than a recommendation:
// Push stores v - s.min, which overflows if the operands span more than
// half the int64 range. Go's `int` is 64-bit on every platform this book
// targets, so `val int` accepts values this encoding cannot represent.
// Push(MaxInt64) then Push(MinInt64) wraps the difference, and the minimum
// is restored to garbage on the way back out. It is silent: no panic, just
// a wrong answer from GetMin.
//
// This is safe only because LeetCode 155 bounds values to the int32 range,
// where any difference fits in int64 with room to spare. That is a property
// of the problem statement, not of the algorithm. Production code taking a
// full-range `int` must either bound the input explicitly or use the plain
// two-stack MinStack above, which cannot overflow because it never does
// arithmetic on the values at all. The auxiliary stack costs memory and
// buys correctness over the entire domain of its type. Take that trade.
type MinStackOptimized struct {
    stack []int64
    min   int64
}

func MinStackOptimizedConstructor() MinStackOptimized {
    return MinStackOptimized{}
}

// Push encodes val relative to the current minimum.
// Precondition: val fits in the int32 range. See the type comment.
func (s *MinStackOptimized) Push(val int) {
    v := int64(val)
    if len(s.stack) == 0 {
        s.stack = append(s.stack, 0)
        s.min = v
    } else {
        s.stack = append(s.stack, v-s.min)
        if v < s.min {
            s.min = v
        }
    }
}

func (s *MinStackOptimized) Pop() {
    top := s.stack[len(s.stack)-1]
    s.stack = s.stack[:len(s.stack)-1]

    if top < 0 {
        s.min = s.min - top
    }
}

func (s *MinStackOptimized) Top() int {
    top := s.stack[len(s.stack)-1]
    if top < 0 {
        return int(s.min)
    }
    return int(s.min + top)
}

func (s *MinStackOptimized) GetMin() int {
    return int(s.min)
}
```

### Max Stack

A max stack extends the stack interface with `PeekMax` and `PopMax` operations that access or remove the maximum element regardless of its position. The canonical O(log n) solution pairs a stack with a max-heap and uses a lazy-deletion map: removed elements are marked by ID, and both the stack and heap skip over stale entries during access. This design avoids the O(n) cost of eagerly removing elements from the heap while keeping all primary operations at O(log n).

```go
// MaxStack supports push, pop, top, peekMax, and popMax
// LeetCode 716: Max Stack
import (
    "container/heap"
)

type MaxStack struct {
    stack    []*Element
    maxHeap  *ElementHeap
    removed  map[int]bool
    counter  int
}

type Element struct {
    val int
    id  int
}

type ElementHeap []*Element

func (h ElementHeap) Len() int { return len(h) }
func (h ElementHeap) Less(i, j int) bool {
    if h[i].val == h[j].val {
        return h[i].id > h[j].id // more recent first
    }
    return h[i].val > h[j].val // max heap
}
func (h ElementHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *ElementHeap) Push(x any) { *h = append(*h, x.(*Element)) }
func (h *ElementHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

func MaxStackConstructor() MaxStack {
    h := &ElementHeap{}
    heap.Init(h)
    return MaxStack{
        maxHeap: h,
        removed: make(map[int]bool),
    }
}

func (s *MaxStack) Push(x int) {
    elem := &Element{val: x, id: s.counter}
    s.counter++
    s.stack = append(s.stack, elem)
    heap.Push(s.maxHeap, elem)
}

func (s *MaxStack) Pop() int {
    s.cleanStack()
    top := s.stack[len(s.stack)-1]
    s.stack = s.stack[:len(s.stack)-1]
    s.removed[top.id] = true
    return top.val
}

func (s *MaxStack) Top() int {
    s.cleanStack()
    return s.stack[len(s.stack)-1].val
}

func (s *MaxStack) PeekMax() int {
    s.cleanHeap()
    return (*s.maxHeap)[0].val
}

func (s *MaxStack) PopMax() int {
    s.cleanHeap()
    maxElem := heap.Pop(s.maxHeap).(*Element)
    s.removed[maxElem.id] = true
    return maxElem.val
}

func (s *MaxStack) cleanStack() {
    for len(s.stack) > 0 && s.removed[s.stack[len(s.stack)-1].id] {
        s.stack = s.stack[:len(s.stack)-1]
    }
}

func (s *MaxStack) cleanHeap() {
    for s.maxHeap.Len() > 0 && s.removed[(*s.maxHeap)[0].id] {
        heap.Pop(s.maxHeap)
    }
}
```

Two things about this `MaxStack` are worth naming rather than skipping past.

The `removed` map and the heap both grow without bound. Every id ever deleted stays in the map forever, so 10,000 push-and-pop pairs leave 10,000 map entries and 10,000 dead heap nodes behind a stack that is empty. This is the same shape of mistake as the LFU frequency buckets in Chapter 67.

The tempting one-line fix, deleting the id inside the cleanup loops, does not work, and understanding why is the real lesson. Each element is reachable from two places, the stack and the heap, so its id may only be forgotten once *both* have discarded it, and the cleanup loops only ever inspect the stack top and the heap root. `Pop` marks an id and removes the element from the stack, but nothing scans the heap for it. If `PeekMax` is never called, `cleanHeap` never runs, and neither the map entry nor the heap node is ever touched again. No amount of tightening the lazy loops repairs this: laziness means cleanup happens only where you happen to look, and dead entries buried in the middle of the heap are never looked at.

So the trade is sharper than "lazy is usually cheaper". Lazy deletion bounds work per operation by making bookkeeping proportional to total throughput rather than to live data. That is correct for LeetCode, where the process exits, and wrong for a service, where it is a leak.

The version that actually bounds memory removes eagerly, and it needs no `removed` map at all. Store each element's heap position on the element, maintain it in `Swap`, and `Pop` can then call `heap.Remove(h, e.heapIdx)` directly in O(log n):

```go
func (h ElementHeap) Swap(i, j int) {
    h[i], h[j] = h[j], h[i]
    h[i].heapIdx = i // keep the back-reference in sync
    h[j].heapIdx = j
}
```

With that in place the heap size always equals the logical stack size, 50,000 push-and-pop pairs leave nothing behind, and every operation stays O(log n). The cost is that `Swap` now writes two extra fields on every sift, which is a bounded constant. Pay it.

The `Less` tie-break on `id` is also load-bearing. Two elements with equal values must resolve in favour of the more recently pushed one, because `PopMax` is specified to remove the topmost maximum. Drop the tie-break and `push(5), push(5), popMax()` may remove the lower 5, leaving the stack in an order the caller never created.

### Junior -> FAANG: Implementation Puzzles as Amortized Analysis Practice

The three puzzles in this section (queue from stacks, stack from queue, min stack) are canonical interview questions that test amortized analysis reasoning, not just implementation correctness.

**Queue from two stacks (`MyQueue`):** The key insight is lazy transfer. You transfer from `input` to `output` only when `output` is empty. Each element crosses from input to output exactly once, so the amortized cost per dequeue is O(1) even though individual transfers may take O(n). State this analysis explicitly in the interview: "Each element is moved at most once, so the total work is O(n) for n operations, giving O(1) amortized."

**Stack from queue (`MyStack`):** The push is O(n) because after enqueueing the new element, you rotate the entire queue to bring the new element to the front. Every subsequent pop is O(1). This is the opposite trade-off from the two-stack queue. Mention this explicitly: "I'm making push O(n) to get O(1) pop, the reverse of the queue-from-stacks design."

**Min stack (`MinStack`):** The auxiliary minStack approach is correct and easy to explain. The optimized `MinStackOptimized` encodes differences to save space but is harder to reason about. For interviews, use the auxiliary stack and mention the optimized version exists if asked about space efficiency.

**Max stack (`MaxStack`):** This is a Hard problem (LeetCode 716). The lazy deletion approach with a heap and a removed-ID set is the canonical O(log n) solution. The key insight is that you do not eagerly remove elements from the heap when they are popped from the main stack: you mark them as removed and skip them during `PeekMax` and `PopMax`. Mention this design in the interview if asked, as it demonstrates familiarity with lazy deletion as a general technique.

**First-job habit:** For any "implement X using Y" puzzle, start by stating the amortized complexity you are targeting for each operation before writing code. This forces you to think about the trade-off before choosing an implementation approach.

### Senior @ FAANG: Implementation Puzzles as Design Patterns

**Amortized batching as a general scheduling idea.** The shape of the two-stack queue, do nothing until forced, then do a whole batch at once and amortize it, recurs throughout systems work: buffered writers flush on fill, LSM trees compact when a level exceeds a threshold, and slice `append` copies on doubling. Recognizing the shape is more valuable than the specific structure.

Do not claim this is how Go's scheduler works, because it is not. Go's scheduler was described in the chapter introduction: each P has a fixed 256-entry lock-free ring buffer, not a pair of stacks, plus a `runnext` slot that intentionally breaks FIFO for cache locality, with a lock-protected global queue absorbing overflow. Work stealing takes half of another P's ring rather than transferring between two local stacks, and the batching there exists to amortize the cost of touching another P's queue, which is a contention argument rather than the credit argument above. The two structures share an intuition and nothing else, and an interviewer who knows the runtime will notice the difference.

**`MinStack` correctness under pop.** The critical invariant is that `minStack` always reflects the minimum of the current `stack`. When the top of `stack` equals the top of `minStack`, they must be popped together. If you use `<` instead of `<=` in the push condition (pushing to `minStack` only when strictly less than current min), you will incorrectly pop the wrong minimum when two equal values are pushed and the first is popped. Always use `<=`. Test this invariant with `push(3), push(3), pop()` and verify `GetMin()` still returns 3.

**`MaxStack` lazy deletion as a general pattern.** Lazy deletion appears in multiple data structures beyond `MaxStack`: in priority queues where elements can be canceled after enqueue (task schedulers with cancellation support), in Bloom filters with deletion support (counting Bloom filters), and in cache invalidation schemes. The pattern is: mark items as deleted rather than eagerly removing them from the data structure, and skip marked items during access operations. The trade-off is that deleted items consume space until they are reached during a skip operation. For systems with high deletion rates and infrequent access, eager deletion may be preferred. For systems with low deletion rates and frequent access, lazy deletion has lower amortized cost. Document this trade-off in the implementation.

**Bar-raiser: `MaxStack` with O(1) all operations.** A comparison-based max stack cannot have O(1) `popMax`, and this is not a hand-wave. It follows from a reduction to sorting, which is the kind of answer that ends the question:

> Suppose `Push` and `PopMax` were both O(1) amortized. Take n arbitrary values, push all of them (n operations, O(n) total), then call `PopMax` n times (n operations, O(n) total). `PopMax` returns the largest remaining element each time, so the output is the input in descending order. We have sorted n arbitrary values in O(n) comparisons. That contradicts the Omega(n log n) lower bound for comparison-based sorting, which is proved in Chapter 79 from the decision-tree argument. Therefore no such structure exists.

Three things make this a strong answer. It rules out amortized O(1) and not merely worst-case O(1), because the reduction only ever uses the total cost of a sequence. It shows the O(log n) achieved by the lazy-deletion implementation above is optimal rather than merely the best we thought of, since n operations at O(log n) gives exactly the O(n log n) that sorting demands. And it identifies the escape hatch: the bound assumes comparisons are the only operation on values, so a max stack over small integers can beat it using the same trick that lets counting sort beat O(n log n). A bar raiser asking for O(1) is testing whether you can recognize an impossibility rather than search for an algorithm that cannot exist. The correct answer is "no, and here is the reduction."
