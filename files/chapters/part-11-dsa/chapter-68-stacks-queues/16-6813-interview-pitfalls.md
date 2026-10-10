## 68.14 Interview Pitfalls

### Pitfall 1: Empty Stack Pop Without Checking

**Failure mode**: A parentheses validator panics on input `")("` because it indexes the stack top before checking that the stack has one. The tell is that the string is perfectly ordinary: it is not a weird edge case, just a closer arriving first.

```go
// ❌ WRONG: Panic on empty stack
func isValidBad(s string) bool {
    stack := []rune{}
    pairs := map[rune]rune{')': '(', ']': '[', '}': '{'}

    for _, c := range s {
        if c == '(' || c == '[' || c == '{' {
            stack = append(stack, c)
        } else {
            // Crashes on ")(" input - stack is empty!
            if stack[len(stack)-1] != pairs[c] {
                return false
            }
            stack = stack[:len(stack)-1]
        }
    }
    return len(stack) == 0
}

// ✅ CORRECT: Always check before pop
func isValidGood(s string) bool {
    stack := []rune{}
    pairs := map[rune]rune{')': '(', ']': '[', '}': '{'}

    for _, c := range s {
        if c == '(' || c == '[' || c == '{' {
            stack = append(stack, c)
        } else {
            // Check empty FIRST
            if len(stack) == 0 || stack[len(stack)-1] != pairs[c] {
                return false
            }
            stack = stack[:len(stack)-1]
        }
    }
    return len(stack) == 0
}
```

### Pitfall 2: Wrong Monotonic Stack Direction

**Failure mode**: A candidate confuses the increasing and decreasing monotonic stack for "next greater element" and burns twenty minutes debugging, because the wrong version does not crash. It returns a full array of plausible numbers that answers a different question.

```go
// ❌ WRONG: this computes the PREVIOUS SMALLER-OR-EQUAL element.
//
// Two independent errors, and it is worth separating them because each
// alone changes the answer:
//   1. The pop condition is inverted. `nums[top] > nums[i]` pops LARGER
//      elements and keeps smaller ones, which builds an increasing stack.
//      Next-greater needs a decreasing stack, so it must pop SMALLER.
//   2. The assignment goes to the wrong element. Reading the surviving
//      stack top answers for i (a "previous" query). Next-greater must
//      assign to the element being popped, with nums[i] as its answer.
//
// On [2, 1, 3, 3, 5, 4] this returns [-1, -1, 1, 3, 3, 3]. Next greater is
// [3, 3, 5, 5, -1, -1]. Not one entry matches, and yet nothing looks wrong
// at a glance, which is exactly why this survives a spot-check test.
func nextGreaterBad(nums []int) []int {
    result := make([]int, len(nums))
    for i := range result {
        result[i] = -1
    }
    stack := []int{}  // Indices

    for i := 0; i < len(nums); i++ {
        for len(stack) > 0 && nums[stack[len(stack)-1]] > nums[i] {
            stack = stack[:len(stack)-1]
        }
        if len(stack) > 0 {
            result[i] = nums[stack[len(stack)-1]]  // answers for i, not the popped
        }
        stack = append(stack, i)
    }
    return result
}

// ✅ CORRECT: Decreasing stack, assign when popping
func nextGreaterGood(nums []int) []int {
    result := make([]int, len(nums))
    for i := range result {
        result[i] = -1
    }
    stack := []int{}  // Indices

    for i := 0; i < len(nums); i++ {
        // Pop SMALLER elements - current is their "next greater"
        for len(stack) > 0 && nums[stack[len(stack)-1]] < nums[i] {
            idx := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            result[idx] = nums[i]  // nums[i] is next greater for idx
        }
        stack = append(stack, i)
    }
    return result
}
```

### Pitfall 3: Queue Memory Leak with Slice Dequeue

**Failure mode**: A long-running service OOMs because its queue never releases dequeued elements. The queue reports itself as empty the whole time. This one is worth extra care, because the fix people reach for does not work.

```go
// ❌ WRONG: front++ leaves everything before front reachable in the array
type LeakyQueue struct {
    items []*Job
    front int  // Index of front element
}

func (q *LeakyQueue) Dequeue() *Job {
    val := q.items[q.front]
    q.front++  // items[0:front] are still live
    return val
}

// ❌ STILL WRONG: reslicing changes the header, not the array.
// The dequeued *Job now sits behind the header, still inside the same
// allocation, and an interior pointer keeps that whole allocation alive.
// Measured: 300 pointers to 64KB buffers, drained to len==0, retains
// 18.75 MB with front++ and 18.76 MB with this. It is not a fix.
type StillLeakyQueue struct {
    items []*Job
}

func (q *StillLeakyQueue) Dequeue() (*Job, bool) {
    if len(q.items) == 0 {
        return nil, false
    }
    val := q.items[0]
    q.items = q.items[1:]
    return val, true
}

// ✅ CORRECT: clear the slot so the element is genuinely unreferenced.
// Same workload: 0.01 MB retained.
type GoodQueue struct {
    items []*Job
}

func (q *GoodQueue) Dequeue() (*Job, bool) {
    if len(q.items) == 0 {
        return nil, false
    }
    val := q.items[0]
    q.items[0] = nil // the fix
    q.items = q.items[1:]
    return val, true
}

// ✅ BEST for a long-lived queue: ring buffer, which bounds the array too.
// It must also nil the vacated slot - wrapping an index frees nothing.
type CircularQueue struct {
    items    []*Job
    front    int
    size     int
    capacity int
}
```

### Pitfall 4: Forgetting to Store Indices in Monotonic Stack

**Failure mode**: A candidate stores values instead of indices in a monotonic stack for "daily temperatures", then cannot compute the day gap because the position information was thrown away at push time. The pop condition still reads naturally, which is what makes it a trap: the code looks right until the moment you need `i - prevIdx` and have no `prevIdx`.

```go
// ❌ WRONG: Storing values loses position information.
// Note this version does not even compile: `i` is never used, because
// there is nothing to use it for. Go refusing to build this is the
// compiler telling you the design is wrong.
func dailyTemperaturesBad(temps []int) []int {
    result := make([]int, len(temps))
    stack := []int{}  // Storing temperatures directly

    for _, t := range temps {
        for len(stack) > 0 && stack[len(stack)-1] < t {
            stack = stack[:len(stack)-1]
            // We can't calculate days because we don't know
            // WHICH day had that temperature!
        }
        stack = append(stack, t)
    }
    return result // always all zeros
}

// ✅ CORRECT: Store indices, access values through array
func dailyTemperaturesGood(temps []int) []int {
    result := make([]int, len(temps))
    stack := []int{}  // Store INDICES

    for i := 0; i < len(temps); i++ {
        for len(stack) > 0 && temps[stack[len(stack)-1]] < temps[i] {
            prevIdx := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            result[prevIdx] = i - prevIdx  // Now we can calculate!
        }
        stack = append(stack, i)  // Push index, not value
    }
    return result
}
```

### Pitfall 5: Incorrect Sliding Window Deque Cleanup

**Failure mode**: A sliding window maximum produces wrong results intermittently because the window boundary check compares a stored index against a value. Both are `int`, so the compiler is silent, and the answers are only wrong when a stale element happens to be the largest, which is why it passes casual testing.

```go
// ❌ WRONG: Comparing values for window boundary
func maxSlidingWindowBad(nums []int, k int) []int {
    result := []int{}
    deque := []int{}  // Should store indices

    for i := 0; i < len(nums); i++ {
        // WRONG: This removes by value, not by index!
        for len(deque) > 0 && deque[0] < nums[i]-k {
            deque = deque[1:]
        }
        // ... rest of logic
    }
    return result
}

// ✅ CORRECT: Compare indices for window boundary
func maxSlidingWindowGood(nums []int, k int) []int {
    result := []int{}
    deque := []int{}  // Store indices

    for i := 0; i < len(nums); i++ {
        // Remove indices outside window (by INDEX, not value)
        for len(deque) > 0 && deque[0] <= i-k {
            deque = deque[1:]
        }

        // Remove smaller elements (they can't be max)
        for len(deque) > 0 && nums[deque[len(deque)-1]] < nums[i] {
            deque = deque[:len(deque)-1]
        }

        deque = append(deque, i)

        if i >= k-1 {
            result = append(result, nums[deque[0]])
        }
    }
    return result
}
```

### Interview Pitfalls Quick Reference

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Empty stack pop | Runtime panic | Always check len(stack) > 0 first |
| Wrong monotonic direction | Incorrect results | Draw examples, verify pop condition |
| Queue memory leak | OOM in production | Nil the vacated slot - ring buffer for long-lived queues (reslicing alone does NOT fix it) |
| Values instead of indices | Can't calculate positions | Store indices, access via array |
| Window boundary by value | Stale elements remain | Compare index against i-k |
| Forgetting result initialization | -1 not set for "not found" | Initialize result array properly |

---

### Junior -> FAANG: Using Incident Reports to Build Pitfall Immunity

The five failure modes in this section share a structure: a specific mistake, code that panics or quietly returns wrong answers, and a fix that comes down to internalizing one invariant. Note that only the first one panics. The other four produce plausible output, which is why they are worth memorizing rather than trusting yourself to notice.

**Pitfall 1 (empty stack pop in parentheses validation):** The fix is a compound condition: `len(stack) == 0 || stack[top] != expected`. Always write the length check first. In Go, short-circuit evaluation means the second condition is only evaluated if the first is false, so the order matters. Commit the pattern "check length before indexing" as an unconditional rule for all slice-based stack and queue operations.

**Pitfall 2 (wrong monotonic stack direction):** The confusion between "next greater" and "previous greater" stems from not being precise about which elements are popped and when the result is assigned. The rule is: when you pop an element from the stack, you assign the result for that element, and the current element at index `i` is the trigger. So the current element is the "next" and the popped element is the one whose answer you are filling. Tracing `[2, 1, 3]` for two iterations on paper forces this distinction into memory.

**Pitfall 3 (queue memory leak):** The backing array is pinned as long as any slice header points into it, and incrementing `front` does not release earlier elements. So far so standard. The part almost everyone gets wrong is the fix: `q.items = q.items[1:]` releases nothing either, because the dequeued element is still inside the same pinned array, merely behind the header. The fix is `q.items[0] = nil` before the reslice, and a ring buffer that also clears its vacated slot for anything long-lived. If the element type has no pointers (`[]int`), there is nothing to release and none of this applies.

**Pitfall 4 (values instead of indices in monotonic stack):** The rule is mechanical: monotonic stacks always store indices. Values are accessed via the array. There is no exception to this rule for problems that require positional information (distance, count, width). The only time you might store values is if the problem asks purely for the value and the position is irrelevant, which is rare.

**Pitfall 5 (window boundary by value in sliding window deque):** The window check compares the front index of the deque to `i - k`, not the value stored there. Write this as a comment in the code: "Remove indices outside the window boundary." The word "indices" in the comment prevents the confusion between index comparison and value comparison.

**First-job interview habit:** Before submitting any stack or queue solution, run through the quick reference table above and verify that your implementation explicitly handles each pitfall. This takes thirty seconds and prevents the most common class of runtime failures in live interviews.

### Senior @ FAANG: Pitfalls as Systemic Engineering Risk Categories

Each pitfall in this section represents a class of production risk that extends well beyond interview code.

**Pitfall 1 as a nil-safety culture gap.** In Go, a nil pointer dereference and an out-of-bounds slice access both produce runtime panics. Neither is a compile-time error. Teams that rely on "the code hasn't panicked yet" as a safety signal are operating without a safety net. Production stacks and queues should return `(T, bool)` from every access operation, and the boolean should be checked at every call site. A code review standard that rejects any stack or queue access without a length guard is the correct governance response to Pitfall 1 at scale.

**Pitfall 2 as a test coverage gap.** Wrong monotonic stack direction produces plausible-looking but incorrect results. The only reliable defense is full-output test coverage. A test that checks `result[0]` and `result[len-1]` but not all intermediate indices will pass with the wrong direction in many inputs. For any monotonic stack implementation, the test suite must include an input where every position has a valid answer (not just the edges), and the expected output must be verified for every index.

**Pitfall 3 as a production memory incident pattern.** Go's collector cannot reclaim what is still reachable, and a slice header holds the entire backing allocation regardless of where in it the header points. A queue that only advances `front`, or only reslices, keeps every element it ever held from position zero onward. At high throughput the leak accumulates until OOM, and OOM in Go is a `fatal error` rather than a recoverable panic, so the process simply dies.

Two traps in diagnosing this. First, `pprof` heap profiles attribute memory to its *allocation* site, so the growth is blamed on whatever created the payloads and the queue looks innocent. The signal to correlate is the structure's own `Size()` staying flat while the heap climbs. Second, the obvious fix is the wrong one: reslicing is not the answer, clearing the slot is. Replace the front-index queue with a ring buffer that nils its vacated slots, bound the queue explicitly, and alert on queue depth rather than only on heap size, since depth is the leading indicator and heap is the lagging one.

**Pitfall 4 as a documentation contract.** The rule "store indices, access values via array" should appear in the package documentation for any monotonic stack implementation. A future engineer who reads the stack type without the documentation context may try to store values for what seems like a simpler interface, reintroducing the bug. Explicit documentation of the invariant ("this deque stores array indices, values are accessed as `nums[deque[i]]`") prevents the reintroduction.

**Pitfall 5 as an index vs. value type confusion.** The window boundary check `deque[0] <= i - k` is an index comparison. The value comparison would be `nums[deque[0]] <= nums[i] - k`, which is semantically completely different. This confusion is a specific instance of a general Go trap: because deques store `int`, the compiler accepts both comparisons without complaint. Stronger typing (a `dequeIndex` type that cannot be compared directly to a value) would catch this at compile time. For production sliding window implementations, consider wrapping the deque element type to prevent accidental value comparisons.

**Bar-raiser signal: pitfall classification.** A bar raiser who asks "what are the most common failure modes for stack and queue implementations?" is looking for a candidate who can classify pitfalls systematically: empty-state access (Pitfall 1), algorithmic direction errors (Pitfall 2), resource management (Pitfall 3), type-level confusion (Pitfall 4), and index vs. value semantic errors (Pitfall 5). Organizing five pitfalls into four categories and explaining the underlying cause of each demonstrates engineering depth beyond memorizing specific bugs.
