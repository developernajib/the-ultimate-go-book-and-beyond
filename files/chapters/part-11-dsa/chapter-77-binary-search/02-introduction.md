## Overview

Binary search is a fundamental algorithm that halves the search space at each step, achieving O(log n) time complexity. While the basic idea is simple, getting the boundary conditions right is notoriously tricky.

```
┌─────────────────────────────────────────────────────────────────┐
│                    BINARY SEARCH CONCEPT                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Search for 7 in sorted array: [1, 3, 5, 7, 9, 11, 13]          │
│                                                                 │
│  Step 1: left=0, right=6, mid=3 → arr[3]=7 ✓ Found!             │
│          [1, 3, 5, 7, 9, 11, 13]                                │
│           L        M           R                                │
│                                                                 │
│  Key Insight:                                                   │
│  Each comparison eliminates half of the remaining elements      │
│                                                                 │
│  Time: O(log n) - halving at each step                          │
│  Space: O(1) - iterative, O(log n) - recursive                  │
│                                                                 │
│  Common Templates:                                              │
│  1. Find exact match                                            │
│  2. Find first/last occurrence                                  │
│  3. Find insertion point                                        │
│  4. Binary search on answer                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: The Four Templates as a Decision Tree

The four templates listed above map directly to four question types. Before writing code in an interview, read the problem statement and ask: "Am I looking for a specific value? Use Template 1. Am I looking for the first or last position of a value? Use Template 2. Am I looking for where a value would be inserted? Use lower bound. Is the problem asking me to minimize or maximize something feasible? Use binary search on answer."

The diagram shows a 7-element sorted array where the target is found at the midpoint on the first try. Do not let this make you overconfident. Prepare for the harder cases: target not present, target at the first position, target at the last position, single-element array. Trace through your implementation for all four cases before declaring it correct.

The O(log n) complexity comes from a precise claim: the search space halves every iteration. Verify this for each template by checking that `right - left` strictly decreases every iteration. If you can construct an input where it does not decrease, you have an infinite loop bug.

### Senior @ FAANG: Teaching Binary Search Correctness by Invariant

The diagram's description of binary search as "halving at each step" is correct but insufficient for producing bug-free implementations. The precise mental model is the loop invariant, which is a predicate that is true before the loop, after every iteration, and implies the postcondition when the loop terminates.

For Template 1: Invariant is "if target exists in the array, it is in nums[left..right] inclusive." Before the loop, this is trivially true. After each iteration: if `nums[mid] < target`, target cannot be at mid or any index below mid (since array is sorted), so removing `[left..mid]` preserves the invariant by setting `left = mid + 1`. Symmetrically for `>`. When the loop ends with `left > right`, the invariant guarantees that if target existed, we would have found it, so returning -1 is correct.

Teaching engineers to write down this invariant before implementing the loop eliminates the majority of binary search bugs. At FAANG, this is the correct pedagogy: not "use `<=` because it works for single elements" but "the `<=` condition is required by the invariant, which specifies that a single-element search space must still be examined."
