## 68.11 Common Mistakes

### Mistake 1: Empty Stack Access Without Checking

Accessing the last element of an empty slice causes a runtime panic, and stack operations are frequent sources of this error. Every pop and peek must guard against an empty collection before indexing, returning a sentinel value or a boolean `ok` flag to communicate absence cleanly.

```go
// ❌ BAD: Panic on empty stack
func peekBad(stack []int) int {
    return stack[len(stack)-1]  // Panic if empty!
}

func popBad(stack []int) ([]int, int) {
    top := stack[len(stack)-1]  // Panic if empty!
    return stack[:len(stack)-1], top
}

// ✅ GOOD: Always check before access
func peekGood(stack []int) (int, bool) {
    if len(stack) == 0 {
        return 0, false
    }
    return stack[len(stack)-1], true
}

func popGood(stack []int) ([]int, int, bool) {
    if len(stack) == 0 {
        return stack, 0, false
    }
    top := stack[len(stack)-1]
    return stack[:len(stack)-1], top, true
}
```

### Mistake 2: Queue Memory Leak with Slice

This is the most misexplained mistake in the chapter, so start with what is *not* true. Reslicing does not release anything, and `q.items = q.items[1:]` is not a fix. A slice header holds a pointer into a backing array, and the Go collector reclaims whole allocations, so a pointer into the middle of an array keeps the entire array alive, including everything sitting in front of the new start. The dequeued elements are still in that array and still reachable.

Measure it and the two "different" queues below are indistinguishable: enqueue 300 pointers to 64KB buffers and drain the queue completely, and the `front++` version retains 18.75 MB while the reslicing version retains 18.76 MB. Both report themselves as empty. The comment "re-slice to allow GC" is folklore.

What actually releases the payload is overwriting the slot with the zero value before the header moves past it. Do that and the same workload retains 0.01 MB.

```go
// ❌ BAD: front++ leaves every dequeued element reachable in the array
type BadQueue struct {
    items []*Payload
    front int
}

func (q *BadQueue) Dequeue() *Payload {
    val := q.items[q.front]
    q.front++ // items[0:front] are still live: nothing was cleared
    return val
}

// ❌ ALSO BAD: identical retention. Reslicing moves the header, not the data.
type StillBadQueue struct {
    items []*Payload
}

func (q *StillBadQueue) Dequeue() (*Payload, bool) {
    if len(q.items) == 0 {
        return nil, false
    }
    val := q.items[0]
    q.items = q.items[1:] // the element is now BEFORE the header, still in the array
    return val, true
}

// ✅ GOOD: clear the slot, then move the header
type GoodQueue struct {
    items []*Payload
}

func (q *GoodQueue) Dequeue() (*Payload, bool) {
    if len(q.items) == 0 {
        return nil, false
    }
    val := q.items[0]
    q.items[0] = nil // this line is the entire fix
    q.items = q.items[1:]
    return val, true
}

// ✅ BETTER: ring buffer. Bounds the array too, not just the elements.
// Note it must ALSO clear the slot: wrapping the index does not free
// what the slot points at.
type CircularQueue struct {
    items    []*Payload
    front    int
    rear     int
    size     int
    capacity int
}

func NewCircularQueue(capacity int) *CircularQueue {
    return &CircularQueue{
        items:    make([]*Payload, capacity),
        capacity: capacity,
    }
}

func (q *CircularQueue) Enqueue(val *Payload) bool {
    if q.size == q.capacity {
        return false
    }
    q.items[q.rear] = val
    q.rear = (q.rear + 1) % q.capacity
    q.size++
    return true
}

func (q *CircularQueue) Dequeue() (*Payload, bool) {
    if q.size == 0 {
        return nil, false
    }
    val := q.items[q.front]
    q.items[q.front] = nil // vacated slot must not keep the payload alive
    q.front = (q.front + 1) % q.capacity
    q.size--
    return val, true
}
```

Two boundaries on this rule. It only matters when the element type contains pointers: a `[]int` queue has nothing to release, since the ints are the data and the array is the allocation. And the backing array itself is still retained by `GoodQueue` even after clearing, because the header points into it. That is usually irrelevant, since an array of 300 pointers is 2.4KB against the 18.8MB of payloads it was pinning. The ring buffer bounds both.

### Mistake 3: Wrong Monotonic Stack Direction

A common error is confusing the pop condition direction: a decreasing stack should pop elements that are smaller than the incoming value, not larger. Mixing up `<` and `>` silently produces incorrect results rather than a compile error, making this bug difficult to catch without carefully tracing examples through the algorithm.

```go
// ❌ BAD: this does not compute "next greater" at all.
//
// What makes it dangerous is that it is not broken code. It is a correct
// implementation of a DIFFERENT function wearing the wrong name: it returns
// the previous greater-OR-EQUAL element. It runs, it never panics, and it
// returns a plausible array of the right length.
//
// Two errors compound here, which is why the result is so far off:
//   1. Direction. The answer is written for the element being PUSHED
//      (result[i], read off whatever survives the pops), whereas "next
//      greater" writes the answer for the element being POPPED
//      (result[idx] = nums[i]).
//   2. Strictness. The pop uses <, so equal elements survive on the stack
//      and get reported as the answer. That turns "previous greater" into
//      "previous greater-or-equal", which is a third distinct function.
//
// On [2, 1, 2, 4, 3] this returns [-1, 2, 2, -1, 4], while next greater is
// [4, 2, 4, -1, -1] and previous strictly greater is [-1, 2, -1, -1, 4].
// Three plausible arrays, three different functions, one name.
func nextGreaterBad(nums []int) []int {
    result := make([]int, len(nums))
    stack := []int{}

    for i := 0; i < len(nums); i++ {
        for len(stack) > 0 && nums[stack[len(stack)-1]] < nums[i] {
            stack = stack[:len(stack)-1]
        }
        if len(stack) > 0 {
            result[i] = nums[stack[len(stack)-1]] // answers for i, not for the popped
        } else {
            result[i] = -1
        }
        stack = append(stack, i)
    }

    return result
}

// ✅ GOOD: Clear monotonic stack logic
func nextGreaterGood(nums []int) []int {
    n := len(nums)
    result := make([]int, n)
    for i := range result {
        result[i] = -1  // Default: no greater element
    }

    stack := []int{}  // Stack of indices, decreasing values

    for i := 0; i < n; i++ {
        // Pop all smaller elements - we found their next greater
        for len(stack) > 0 && nums[stack[len(stack)-1]] < nums[i] {
            idx := stack[len(stack)-1]
            stack = stack[:len(stack)-1]
            result[idx] = nums[i]  // nums[i] is the next greater
        }
        stack = append(stack, i)
    }

    return result
}
```

### Mistake 4: Incorrect Bracket Matching

Bracket matching has two distinct failure modes that both must be handled: a closing bracket arriving when the stack is empty (too many closers), and leftover openers remaining on the stack after the string ends (too many openers). Forgetting the final `len(stack) == 0` check will accept strings like `"("` as valid.

```go
// ❌ BAD: Doesn't handle all cases
func isValidBad(s string) bool {
    stack := []rune{}
    pairs := map[rune]rune{')': '(', ']': '[', '}': '{'}

    for _, c := range s {
        if c == '(' || c == '[' || c == '{' {
            stack = append(stack, c)
        } else {
            // Bug: doesn't check if stack is empty
            if stack[len(stack)-1] != pairs[c] {  // Panic if empty!
                return false
            }
            stack = stack[:len(stack)-1]
        }
    }

    return true  // Bug: should check if stack is empty
}

// ✅ GOOD: Handle all edge cases
func isValidGood(s string) bool {
    stack := []rune{}
    pairs := map[rune]rune{')': '(', ']': '[', '}': '{'}

    for _, c := range s {
        if c == '(' || c == '[' || c == '{' {
            stack = append(stack, c)
        } else if expected, isClosing := pairs[c]; isClosing {
            if len(stack) == 0 || stack[len(stack)-1] != expected {
                return false
            }
            stack = stack[:len(stack)-1]
        }
        // Ignore non-bracket characters
    }

    return len(stack) == 0  // Must be completely balanced
}
```

### Mistake 5: Inefficient Sliding Window Maximum

The brute-force O(nk) solution scans the entire window for each position, which becomes prohibitively slow for large windows. The monotonic deque solution reduces this to O(n) by observing that any element smaller than a newer element can never be the window maximum and can be discarded immediately.

```go
// ❌ BAD: O(n*k) approach
func maxSlidingWindowBad(nums []int, k int) []int {
    if len(nums) == 0 {
        return nil
    }

    result := make([]int, len(nums)-k+1)
    for i := 0; i <= len(nums)-k; i++ {
        maxVal := nums[i]
        for j := i; j < i+k; j++ {
            maxVal = max(maxVal, nums[j])  // O(k) for each window
        }
        result[i] = maxVal
    }

    return result
}

// ✅ GOOD: O(n) using monotonic deque
func maxSlidingWindowGood(nums []int, k int) []int {
    if len(nums) == 0 {
        return nil
    }

    result := make([]int, len(nums)-k+1)
    deque := []int{}  // Stores indices, values are decreasing

    for i := 0; i < len(nums); i++ {
        // Remove indices outside window
        for len(deque) > 0 && deque[0] <= i-k {
            deque = deque[1:]
        }

        // Remove smaller elements (they can't be max)
        for len(deque) > 0 && nums[deque[len(deque)-1]] < nums[i] {
            deque = deque[:len(deque)-1]
        }

        deque = append(deque, i)

        // Add to result once we have a full window
        if i >= k-1 {
            result[i-k+1] = nums[deque[0]]
        }
    }

    return result
}
```

### Junior -> FAANG: Preventing the Five Common Mistakes

These five mistakes appear in entry-level interview code with high frequency. Memorizing the correct pattern for each is more effective than trying to debug them during the interview.

**Mistake 1 (empty stack access):** The fix is a two-value return `(T, bool)`. Internalize this as a Go idiom: any function that may not find a value returns `(value, ok)`. Never index a slice without checking `len(s) > 0` first.

**Mistake 2 (queue memory leak):** Three claims to unlearn together. `q.items = q.items[1:]` is O(1), not O(n). It does not shift anything. And it does not let the GC collect the removed element. The fix is `q.items[0] = nil` before the reslice, and for a long-lived queue, a ring buffer that also clears the vacated slot. For an interview problem that drains a bounded input and returns, none of this matters and saying so is the right answer.

**Mistake 3 (wrong monotonic stack direction):** The key is to remember the correspondence: decreasing stack (pop smaller) finds the next greater element. Increasing stack (pop larger) finds the next smaller element. When you write the pop condition, say out loud "I am popping smaller elements because I found their next greater." This connects the code to the intent.

**Mistake 4 (bracket matching missing final check):** The template is: process the string, then check `len(stack) == 0` at the end. Always return `len(stack) == 0`, not `true`. This is the second failure mode.

**Mistake 5 (O(nk) sliding window):** If you see a sliding window problem, always ask "can I avoid recomputing the maximum from scratch each step?" The answer is yes with a monotonic deque. The O(nk) approach is never acceptable at the L4 level.

### Senior @ FAANG: Mistakes as Code Review Categories

**Mistake 1 as an API design standard.** Every stack, queue, and deque operation that may fail due to empty state should return `(T, bool)`. This is documented in the Go standard library (`sync.Map.Load`, `map[K]V` two-value form). A production library that panics on empty access instead of returning a bool is an API design flaw that will cause panics in any caller that does not check `IsEmpty` before every call. The review comment should be: "Change the return type from T to (T, bool) to communicate absence without panicking."

**Mistake 2 as a memory profiling trigger.** This leak never appears in a CPU profile, and it is easy to misread in a heap profile: `go tool pprof` attributes memory to its *allocation* site, so the growth is blamed on whatever built the payloads, not on the queue that is pinning them. A service with stable throughput and a steadily climbing heap should be audited for any structure that shrinks a slice of pointers without clearing the vacated slot, which includes queues, stacks, and object pools. The tell is that the structure's own `Size()` is flat while the heap is not.

**Mistake 3 as a test requirement.** Wrong monotonic stack direction produces incorrect but plausible-looking results: a full-length array of sensible-looking values that answers a different question. Test the full output array against a brute-force oracle, not a spot check. For `NextGreaterElement([2, 1, 2, 4, 3])` the expected output is `[4, 2, 4, -1, -1]`, while the direction-confused version returns `[-1, 2, 2, -1, 4]`. Note that these agree at index 1, so a test asserting only `result[1] == 2` passes both. Include duplicate values in the fixture too, since strictness bugs are invisible on distinct inputs. The brute-force O(n^2) version is four lines and is the right oracle: write it, run both on random arrays, and compare entire outputs.

**Mistake 4 as a parser correctness requirement.** The two failure modes of bracket matching (unmatched closer and unmatched opener) correspond to two different validation states. Production parsers (JSON validators, XML parsers, code formatters) must handle both. A JSON validator that returns "valid" for `{"key": "value"` (missing closing brace) is a correctness bug, not a performance issue. Fuzz testing with malformed inputs is the most effective way to catch both failure modes.

**Mistake 5 as a performance requirement.** The O(nk) approach does n*k work, so the question is simply whether n*k fits your budget, and the answer depends on your budget rather than on a threshold that can be quoted here. What is worth internalizing is the shape: the brute-force cost is quadratic in the *window size*, so it degrades exactly when someone widens the window, which is a configuration change rather than a code change and therefore arrives without review. A limiter or analytics job that is comfortable at k=100 and falls over at k=10,000 has a hundredfold regression triggered by editing a YAML file. The deque removes the k from the complexity entirely, which is why it is worth reaching for even when the current k is small.

---
