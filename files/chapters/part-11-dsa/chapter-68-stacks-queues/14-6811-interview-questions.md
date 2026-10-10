## 68.12 Interview Questions

### Question 1: Design a Min Stack

**Problem**: Design a stack that supports push, pop, top, and getMin in O(1) time.

```go
// Solution: Use auxiliary stack to track minimums
type MinStack struct {
    stack    []int
    minStack []int
}

func Constructor() MinStack {
    return MinStack{}
}

func (s *MinStack) Push(val int) {
    s.stack = append(s.stack, val)

    // Push to minStack if empty or <= current min
    if len(s.minStack) == 0 || val <= s.minStack[len(s.minStack)-1] {
        s.minStack = append(s.minStack, val)
    }
}

func (s *MinStack) Pop() {
    if len(s.stack) == 0 {
        return
    }

    top := s.stack[len(s.stack)-1]
    s.stack = s.stack[:len(s.stack)-1]

    // Pop from minStack if it was the minimum
    if top == s.minStack[len(s.minStack)-1] {
        s.minStack = s.minStack[:len(s.minStack)-1]
    }
}

func (s *MinStack) Top() int {
    return s.stack[len(s.stack)-1]
}

func (s *MinStack) GetMin() int {
    return s.minStack[len(s.minStack)-1]
}

// Alternative: Single stack, each entry carrying the min at its own depth.
//
// This trades memory for simplicity in the opposite direction from the
// auxiliary stack: it always stores one extra int per element, where
// minStack stores an entry only when a new minimum arrives. On strictly
// increasing input minStack holds one entry and this holds n. On strictly
// decreasing input both hold n. The payoff is that Pop needs no special
// case at all: the min is simply whatever the new top says it is.
type MinStackSingle struct {
    stack []element
}

type element struct {
    val int
    min int
}

func (s *MinStackSingle) Push(val int) {
    minVal := val
    if len(s.stack) > 0 && s.stack[len(s.stack)-1].min < val {
        minVal = s.stack[len(s.stack)-1].min
    }
    s.stack = append(s.stack, element{val: val, min: minVal})
}

func (s *MinStackSingle) Pop() {
    if len(s.stack) == 0 {
        return
    }
    s.stack = s.stack[:len(s.stack)-1]
}

func (s *MinStackSingle) Top() (int, bool) {
    if len(s.stack) == 0 {
        return 0, false
    }
    return s.stack[len(s.stack)-1].val, true
}

func (s *MinStackSingle) GetMin() int {
    return s.stack[len(s.stack)-1].min
}

// Test
func TestMinStack(t *testing.T) {
    s := Constructor()
    s.Push(-2)
    s.Push(0)
    s.Push(-3)

    if got := s.GetMin(); got != -3 {
        t.Errorf("GetMin() = %d, want -3", got)
    }

    s.Pop()

    if got := s.Top(); got != 0 {
        t.Errorf("Top() = %d, want 0", got)
    }

    if got := s.GetMin(); got != -2 {
        t.Errorf("GetMin() = %d, want -2", got)
    }
}
```

### Question 2: Implement Queue using Stacks

**Problem**: Implement a queue using two stacks.

```go
// Solution: Use two stacks - one for push, one for pop
type MyQueue struct {
    pushStack []int
    popStack  []int
}

func ConstructorQueue() MyQueue {
    return MyQueue{}
}

// Push adds element to back of queue
// Time: O(1)
func (q *MyQueue) Push(x int) {
    q.pushStack = append(q.pushStack, x)
}

// Pop removes and returns front element
// Time: Amortized O(1)
func (q *MyQueue) Pop() int {
    q.moveToPopStack()
    top := q.popStack[len(q.popStack)-1]
    q.popStack = q.popStack[:len(q.popStack)-1]
    return top
}

// Peek returns front element without removing
// Time: Amortized O(1)
func (q *MyQueue) Peek() int {
    q.moveToPopStack()
    return q.popStack[len(q.popStack)-1]
}

// Empty returns true if queue is empty
func (q *MyQueue) Empty() bool {
    return len(q.pushStack) == 0 && len(q.popStack) == 0
}

// moveToPopStack transfers elements when popStack is empty
func (q *MyQueue) moveToPopStack() {
    if len(q.popStack) == 0 {
        for len(q.pushStack) > 0 {
            top := q.pushStack[len(q.pushStack)-1]
            q.pushStack = q.pushStack[:len(q.pushStack)-1]
            q.popStack = append(q.popStack, top)
        }
    }
}

// Test
func TestMyQueue(t *testing.T) {
    q := ConstructorQueue()
    q.Push(1)
    q.Push(2)

    if got := q.Peek(); got != 1 {
        t.Errorf("Peek() = %d, want 1", got)
    }

    if got := q.Pop(); got != 1 {
        t.Errorf("Pop() = %d, want 1", got)
    }

    if got := q.Empty(); got != false {
        t.Errorf("Empty() = %v, want false", got)
    }
}
```

### Question 3: Daily Temperatures

**Problem**: Given daily temperatures, return an array where result[i] is the number of days you have to wait for a warmer temperature.

```go
// Solution: Monotonic decreasing stack
func dailyTemperatures(temperatures []int) []int {
    n := len(temperatures)
    result := make([]int, n)
    stack := []int{}  // Stack of indices

    for i := 0; i < n; i++ {
        // Pop all temperatures that current temp is warmer than
        for len(stack) > 0 && temperatures[stack[len(stack)-1]] < temperatures[i] {
            prevIdx := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            result[prevIdx] = i - prevIdx
        }
        stack = append(stack, i)
    }

    // Remaining indices have no warmer day (result stays 0)
    return result
}

// Optimized with backward iteration
func dailyTemperaturesBackward(temperatures []int) []int {
    n := len(temperatures)
    result := make([]int, n)
    hottest := 0

    for i := n - 1; i >= 0; i-- {
        if temperatures[i] >= hottest {
            hottest = temperatures[i]
            continue  // result[i] stays 0
        }

        // Search for next warmer day
        days := 1
        for temperatures[i+days] <= temperatures[i] {
            days += result[i+days]
        }
        result[i] = days
    }

    return result
}

// Test
func TestDailyTemperatures(t *testing.T) {
    tests := []struct {
        input    []int
        expected []int
    }{
        {
            []int{73, 74, 75, 71, 69, 72, 76, 73},
            []int{1, 1, 4, 2, 1, 1, 0, 0},
        },
        {
            []int{30, 40, 50, 60},
            []int{1, 1, 1, 0},
        },
        {
            []int{30, 60, 90},
            []int{1, 1, 0},
        },
    }

    for _, tt := range tests {
        got := dailyTemperatures(tt.input)
        for i := range got {
            if got[i] != tt.expected[i] {
                t.Errorf("dailyTemperatures(%v) = %v, want %v",
                    tt.input, got, tt.expected)
                break
            }
        }
    }
}
```

### Junior -> FAANG: Interview Question Deep Dives

**Min Stack (Question 1):** This is the canonical O(1) space-per-entry min-tracking problem. The auxiliary `minStack` approach is easy to explain and implement correctly. The single-stack approach (storing each element alongside its running minimum as an `element` struct) uses only one slice but requires the struct overhead. In an interview, choose the two-stack approach and explain it clearly. Mention the single-stack variant as an optimization if asked.

**Queue from Stacks (Question 2):** The core insight is amortized O(1) for pop and peek: each element crosses from pushStack to popStack exactly once, so total work per element is O(1). Write the `moveToPopStack` helper first (it is called by both `Pop` and `Peek`), then implement the main operations as one-liners that call it. This structure makes the code easier to read and reason about.

**Daily Temperatures (Question 3):** The backward iteration solution is clever but harder to explain. The forward monotonic stack solution is the canonical approach. Lead with the stack solution and mention the backward iteration as an alternative. For the forward solution, emphasize: "I push indices because I need the day difference, not just the temperature comparison."

**Testing habit for interview questions:** Each test case in this section covers one behavioral condition. Before adding a test, ask "which behavior am I testing?" For Min Stack: test that `GetMin` returns the correct minimum after popping the current minimum (not just any element). For Queue using Stacks: test that ordering is preserved after interleaved push and pop operations. For Daily Temperatures: test all-decreasing input (`[90, 80, 70, 60]`, expected `[0, 0, 0, 0]`) and all-increasing input (`[60, 70, 80, 90]`, expected `[1, 1, 1, 0]`).

### Senior @ FAANG: Interview Question Extensions and Production Context

**Min Stack as a monitoring primitive.** A min stack is directly applicable to maintaining a running minimum metric over a sliding time window: push each new measurement, pop expired measurements, and call `GetMin` to get the current window minimum. The challenge in production is that expiry is time-based (pop measurements older than T seconds), not count-based (pop the top). The monotonic deque (section 68.7) handles this case more naturally than the min stack, because it supports both back removal (dominated elements) and front removal (expired elements). Knowing the boundary between where min stack is appropriate and where monotonic deque is better is an L5 design decision.

**Queue from Stacks: the amortized analysis as an interview differentiator.** Most L4 candidates can implement the two-stack queue. L5 candidates can prove the amortized cost formally: define a potential function Phi equal to the size of the input stack. Every push increases Phi by 1 (actual cost 1 plus potential increase 1 equals amortized cost 2). Every pop costs either 1 (if output is non-empty, no potential change) or n+1 (transfer n elements, decrease Phi by n, actual cost n+1 minus n equals amortized cost 1). Total amortized cost per operation is O(1). Stating this proof in an interview is an L5/L6 signal that the candidate understands amortized analysis formally, not just intuitively.

**Daily Temperatures backward iteration: the jump-pointer trick.** The backward solution reuses `result[i+days]` as a jump pointer: if `temps[i+days] <= temps[i]`, that day is not warm enough, and every day between it and *its* next warmer day is cooler still, so the whole span can be skipped in one hop. Resist calling this path compression. Path compression, as in union-find, *rewrites* the pointers it traverses so later traversals are shorter, and nothing here is rewritten: `result` entries to the right are already final and are read, not updated. It is a jump pointer over an already-computed suffix, which is closer to a skip list's forward pointers than to union-find.

The complexity is worth checking rather than asserting, since a loop nested in a loop invites suspicion. Instrument the inner hop and it stays linear: on an adversarial sawtooth the total hop count is about n/2 for n from a thousand to a hundred thousand, a flat ratio. The monotonic stack solution is O(n) time and O(n) space. The backward solution is O(n) time and O(1) extra space beyond the output. Prefer the stack version in an interview because it generalizes to every other next-greater problem, and reach for this one only when the auxiliary space genuinely matters.

---
