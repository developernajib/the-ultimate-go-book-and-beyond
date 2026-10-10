## Exercises

### Exercise 1: Asteroid Collision
Given an array of asteroids with size and direction (positive=right, negative=left), determine which survive after all collisions.

### Exercise 2: Remove K Digits
Remove k digits from a number string to make the smallest possible number.

### Exercise 3: Online Stock Span
Design a class that returns how many consecutive days the price has been less than or equal to today's price.

### Exercise 4: Decode String
Given an encoded string like "3[a2[c]]", decode it to "accaccacc".

### Junior -> FAANG: Exercise-to-Pattern Mapping

Each exercise here requires recognizing which stack variant to use.

**Asteroid Collision (Exercise 1):** This is a simulation problem using a plain stack. The stack represents asteroids moving to the right. When a left-moving asteroid arrives, it may destroy one or more right-moving asteroids on the stack. The collision loop continues until the left-moving asteroid is destroyed or the stack is empty (or the top is also left-moving). Trace `[5, 10, -5]` by hand before coding.

**Remove K Digits (Exercise 2):** This is a monotonic increasing stack problem. The invariant is: maintain the smallest possible number by removing large digits from the stack when a smaller digit arrives. Pop while the top is larger than the current digit and k > 0. After the loop, if k > 0, pop the last k digits (they are the largest remaining). Handle leading zeros and empty result.

**Online Stock Span (Exercise 3):** This is a "previous greater or equal" monotonic stack problem stored as state across calls. The stack holds (price, span) pairs. When a new price arrives, pop all pairs with price less than or equal to the new price and accumulate their spans. The new span is the accumulated span plus one.

**Decode String (Exercise 4):** This is a two-stack problem (count stack and string stack). When you encounter `[`, push the current count and string. When you encounter `]`, pop and repeat the current string by the popped count, then prepend the popped string. This is the same pattern as expression evaluation with parentheses.

**First-job habit:** For each exercise, write the invariant that your stack maintains. For asteroid collision: "the stack contains only right-moving asteroids." For remove k digits: "the stack is non-decreasing." For stock span: "the stack contains decreasing prices." Writing the invariant first drives the loop condition.

### Senior @ FAANG: Exercise Design as Skill Layering

**Asteroid Collision: simulation correctness.** This problem requires careful collision loop logic: the inner `for` loop runs while the incoming asteroid is alive, the top is positive, and the top is smaller than the absolute value of the incoming asteroid. Three conditions, three possible outcomes: top is destroyed (pop and continue), both are destroyed (pop and set alive=false), incoming is destroyed (set alive=false). Any implementation that does not handle all three outcomes correctly fails the tie case (`[8, -8]` should yield `[]`). In a code review, verify the tie case is explicitly tested.

**Remove K Digits: greedy correctness proof.** The greedy argument is: removing a digit that is larger than the next digit reduces the number because the next digit moves one position to the left. This is provably optimal because any other removal sequence produces a number that is lexicographically larger. A senior engineer reviewing this solution should ask: "Is there a test case where removing the last k digits is required?" Yes: `"1234", k=2` yields `"12"` because no digit is larger than the next, so the loop removes nothing, and the trailing pop is needed. Verify this case is in the test suite.

**Stock Span: stateful problem design.** `StockSpanner` maintains state across `next` calls, which raises the question: is the state correctly initialized? A fresh `StockSpanner` should have an empty stack. If two `StockSpanner` instances are used concurrently (unlikely but possible in a test harness), they must not share state. The design using a struct with a `stack` field is correct. A singleton global variable would not be. In a production service, `StockSpanner` would be instantiated per user or per session, not globally.

**Decode String: recursion vs. iteration, and the resource limit that actually matters.** The recursive solution in `16-6812-exercises-with-solutions.md` uses stack depth proportional to nesting depth, and the iterative two-stack version moves that state to the heap. Prefer the iterative version, but be honest about why, because the usual justification does not survive arithmetic.

Nesting depth is bounded by the input length, since every level costs at least a `[`. A goroutine stack starts at 2KB and grows by copying up to a 1GB default limit, so overflowing it needs on the order of a million frames, which needs a megabyte-scale input of nothing but brackets. Meanwhile the *output* grows multiplicatively: `99[99[99["a"]]]` is only three levels deep and already expands to 970,299 characters, and ten levels of `99[...]` is about 9 x 10^19 characters. The process dies of memory exhaustion, unrecoverably, long before recursion depth is interesting, and switching to the iterative version does not help at all because both must materialize the same string.

So the real lesson for a service accepting user-submitted encoded strings is not "use iteration". It is to reject the input before decoding it: multiply the repeat counts as you parse, and fail fast when the projected output exceeds a limit you chose. That is a validation problem, not a recursion problem. Iteration is still the better default, for the reason given in the linked list chapter, but it is a secondary concern here.

---
