## Exercises

### Exercise 1: Remove Duplicates from Sorted List II
Given a sorted linked list, delete all nodes that have duplicate numbers, leaving only distinct numbers.

### Exercise 2: Split Linked List in Parts
Given a linked list and k, split it into k consecutive parts with sizes differing by at most 1.

### Exercise 3: Next Greater Node
For each node, find the value of the first greater node after it.

### Exercise 4: Reverse Linked List in Groups of Given Size
Reverse every k nodes, but unlike problem 25, if remaining nodes are less than k, reverse them too.

### Junior -> FAANG: Exercise Strategy for Maximum Interview Readiness

These four exercises are deliberately chosen to expose the gaps that most commonly appear in entry-level interviews. Before solving each one, read the problem statement twice and identify which pattern from the decision tree applies.

**Exercise 1 (Remove Duplicates II):** The dummy node is mandatory because the original head may be a duplicate and must be removed. The key insight is that when you detect a run of duplicates, you must skip all of them, not just one. Trace [1, 1, 2, 3] and [1, 2, 2, 3] before coding to verify your loop handles both the "first node is duplicate" and "middle node is duplicate" cases.

**Exercise 2 (Split in Parts):** This problem tests mathematical reasoning: `baseSize = length / k` and `extra = length % k`. The first `extra` parts get one more element. Map this arithmetic to pointer movements before writing any loop.

**Exercise 3 (Next Greater Node):** This is a linked list problem (LeetCode 1019) that requires a stack. Converting the list to a slice first simplifies the algorithm because the monotonic stack pattern wants index access. Recognizing that some linked list problems are easier to solve by first converting to a slice is a practical interview insight. The monotonic stack itself is covered in Chapter 68, so solve that section first if the pattern is unfamiliar.

**Exercise 4 (Reverse in Groups, including remainder):** The difference from `ReverseKGroup` is that the partial final group is also reversed. This means you do not need the initial count to check if k nodes remain. You can reverse every group unconditionally and let the loop naturally terminate when nodes run out.

### Senior @ FAANG: Exercise Design as a Pedagogical Tool

These exercises are staged to cover four distinct skill layers: edge-case handling (Exercise 1), mathematical reasoning over list structure (Exercise 2), cross-data-structure composition (Exercise 3), and algorithm variant recognition (Exercise 4).

**Exercise 1 as a code review litmus test.** `deleteDuplicates` (LeetCode 82) is a common early-round interview problem. The correct solution with a dummy node is eight lines. A solution without a dummy node is eighteen lines with multiple special cases. In a code review, the longer solution indicates that the author does not yet have the dummy-node pattern as a reflex. A senior reviewer's comment should not just say "use a dummy node" but should explain which invariant the dummy node maintains and why that invariant eliminates the special cases.

**Exercise 2 as a systems thinking exercise.** Splitting a list into k parts with sizes differing by at most one is the list-level analog of load balancing, and `length/k` plus `length%k` extras handed to the first parts is provably optimal: it is the only split where max part minus min part is at most one. Do not confuse this with consistent hashing, which solves a different problem and does not work this way. Consistent hashing places nodes at pseudorandom points on a ring and gives each one whatever arc happens to precede it, which is why it needs many virtual nodes per server just to approach even distribution. It accepts worse balance than this exercise achieves in exchange for something this exercise cannot offer: when k changes, only the keys near the affected arc move, instead of every element being reassigned. That trade, balance for stability under resharding, is the conversation worth having.

**Exercise 3 as an interview flexibility signal.** The willingness to convert a list to a slice before applying an algorithm is a practical engineering judgment, not a concession. In a production codebase, converting a linked list to a slice for batch processing, sorting, or indexed access, and then converting back if needed, is often the correct choice. The interview signal is whether the candidate makes this choice deliberately and can justify it (O(n) space, simpler algorithm, one-time conversion amortized over the batch operation) rather than insisting on a pure linked-list solution.

**Exercise 4 as a variant-recognition exercise.** The difference between `ReverseKGroup` (leave remainder unchanged) and this exercise (reverse remainder too) is a one-word difference in the problem statement. Senior engineers train themselves to spot these variant-defining details because they appear in API contracts, feature specifications, and edge case definitions. Missing the "reverse remainder too" detail produces code that passes all tests except the specific edge case where `n % k != 0`, which is a regression risk in production.

---
