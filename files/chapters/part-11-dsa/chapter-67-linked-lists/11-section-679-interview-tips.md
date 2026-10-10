## 67.9 Interview Tips

### Time and Space Complexity

| Operation | Singly Linked | Doubly Linked | Array |
|-----------|---------------|---------------|-------|
| Access by index | O(n) | O(n) | O(1) |
| Insert at head | O(1) | O(1) | O(n) |
| Insert at tail | O(n)* | O(1) | O(1)** |
| Insert at middle | O(n) | O(n) | O(n) |
| Delete at head | O(1) | O(1) | O(n) |
| Delete at tail | O(n) | O(1) | O(1) |
| Search | O(n) | O(n) | O(n) |

*O(1) with tail pointer
**Amortized

### Interview Strategy

1. **Clarify**: Ask about edge cases (empty list, single node, cycles)
2. **Draw**: Always visualize with diagrams before coding
3. **Dummy Node**: Use it whenever head might change
4. **Verify**: Trace through with a small example
5. **Edge Cases**: Test nil, single node, two nodes

### Common Follow-Up Questions

1. "Can you do it in O(1) space?" - Avoid using hash maps if possible
2. "Can you do it in one pass?" - Consider what information you need upfront
3. "What if the list is very long?" - Consider iterative vs recursive (stack overflow)
4. "How would you handle concurrent access?" - Discuss locking strategies

### Junior -> FAANG: Using the Complexity Table and Strategy Checklist

The complexity table is a reference to internalize before the interview, not to look up during it. The three comparisons that matter most are:

- Insert at head: O(1) for both singly and doubly linked lists, O(n) for arrays. This is the core advantage of linked lists.
- Delete at tail: O(n) for singly without a tail pointer, O(1) for doubly. This is why LRU caches use doubly linked lists.
- Access by index: O(n) for both list types, O(1) for arrays. This is the core disadvantage that makes linked lists inappropriate for random access workloads.

**Using the five-step strategy in real interviews:**
1. Clarifying: Spend sixty seconds asking about empty list, single node, and cycles. Do not start coding until these are answered.
2. Drawing: Literally put three or four nodes on paper with arrows. Point to each node as you trace your algorithm.
3. Dummy node: Add it automatically whenever your function might return a new head.
4. Verifying: After coding, trace through your three-node example step by step and confirm the output matches your expectation.
5. Edge cases: Test nil, single node, and two nodes. For reversal problems, also test palindromes and alternating values.

**Handling follow-up questions with confidence:**
- "O(1) space?": Explain which hash map you would remove and what pointer technique replaces it.
- "One pass?": Explain what information you need at each step and whether it can be computed without a second traversal.
- "Very long list?": The answer is "switch from recursive to iterative to avoid O(n) stack depth."
- "Concurrent access?": Mention RWMutex for read-heavy workloads and sync.Mutex for write-heavy workloads, then mention sharding for high throughput.

### Senior @ FAANG: Interview Strategy as a Signal of Engineering Maturity

**The follow-up questions as L5/L6 differentiators.** The four follow-up questions listed are not incidental: they are the dimensions along which interviewers separate L4 from L5 candidates. An L4 candidate gives correct answers. An L5 candidate gives correct answers with trade-off analysis and production context.

For "O(1) space," the L5 answer identifies which hash map in the original solution is eliminated, what pointer technique replaces it (the interleaving trick for copy-with-random-pointer, the two-pointer reset for palindrome), and what invariant the pointer technique exploits that makes it correct.

For "one pass," the L5 answer identifies whether the problem is information-theoretically solvable in one pass. Finding the k-th node from the end is one-pass because the two-pointer gap technique computes the result while accumulating it. Sorting a list is not one-pass because comparison-based sorting requires omega(n log n) comparisons regardless of representation.

For "very long list," the L5 answer is specific about Go's stack behavior. A goroutine starts with a 2KB stack, not the 8KB that gets repeated in interviews, and it grows by copying: when a function's prologue finds insufficient room, the runtime allocates a stack twice the size, moves the frames, and rewrites the pointers into them. So deep recursion does not fault, it silently pays for repeated copying, and it is bounded by `runtime/debug.SetMaxStack` (1GB on 64-bit by default) before it panics with "stack overflow". The number to quote is the depth: recursive merge sort on a list recurses to depth log n, which is about 24 frames for 10 million nodes and entirely harmless. The dangerous shape is recursion that is linear in n, such as `ReverseListRecursive`, where 10 million frames is a real crash. Distinguishing O(log n) from O(n) recursion depth is the actual signal here, not reciting a stack size. For production code processing arbitrarily long lists, iterative algorithms with O(1) auxiliary space remain the safe default, and this constraint should be documented.

For "concurrent access," the L5 answer goes beyond naming a mutex. It discusses read-write lock granularity (are most operations reads or writes?), whether a snapshot-based approach (copy the list before traversal) is appropriate for the workload, and whether the list is shared across goroutines by design or by accident. Lists shared by accident (passed through channels that multiple goroutines receive from) are a common source of data races in junior code that a senior review should catch.
