# Chapter 77: Binary Search Variations

> *"Binary search is trivial to describe, but astonishingly easy to implement incorrectly."*
> - Jon Bentley, Programming Pearls

Binary search is deceptively simple in concept and notoriously tricky in practice. Every computer science student learns it in year one: divide the search space in half, compare the midpoint, recurse on the relevant half, terminate in O(log n). Yet Jon Bentley reported that when he asked professional programmers to write a correct binary search, most of the submitted implementations were buggy. Off-by-one errors, incorrect loop invariants, and premature termination conditions make this "simple" algorithm a reliable discriminator of algorithmic precision. FAANG interviewers know this, and they use binary search problems specifically to test whether you can maintain loop invariants under pressure.

What elevates binary search from a lookup algorithm to a problem-solving paradigm is the insight that it applies to any monotone predicate over an ordered domain, not just to sorted arrays. If you can define a condition that is false for all elements before some threshold and true for all elements after (or vice versa), you can binary search for that threshold. This opens up a large class of problems: search in rotated sorted arrays, find the first or last occurrence of a target, locate the minimum in a rotated array, find the kth smallest element in a matrix, minimize the maximum, maximize the minimum, and binary search on the answer itself (a technique where the "array" is the answer space, not the input). In Go, this paradigm is implemented with explicit `lo`, `hi`, and `mid` variables, and the discipline to choose between `lo <= hi` and `lo < hi` loop conditions intentionally rather than by trial and error.

This chapter teaches binary search as a thinking framework, not just an algorithm. You will start with the correct canonical implementation and build up through every major variation: leftmost and rightmost boundary search, search in rotated arrays, peak element finding, and the "binary search on answer" meta-technique applied to problems like Koko Eating Bananas, Split Array Largest Sum, and Minimize Max Distance to Gas Station. The midpoint calculation `mid = lo + (hi-lo)/2` is drilled until it becomes automatic. By the end of this chapter, binary search is not an algorithm you remember. It is a reflex you apply.

**What you'll learn in this chapter:**

- Implementing the canonical binary search in Go with the correct loop invariant and overflow-safe midpoint
- Finding leftmost and rightmost boundaries using the `lo <= hi` vs `lo < hi` template distinction
- Searching in rotated sorted arrays with and without duplicates using split-point analysis
- Finding peak elements and minimum in rotated arrays in O(log n) with proper boundary handling
- Applying binary search on the answer space to optimization problems: Koko Eating Bananas, Capacity to Ship Packages, Split Array Largest Sum
- Performing 2D binary search on sorted matrices (search a 2D matrix I and II) with index mapping
- Using `sort.Search` from Go's standard library for idiomatic binary search in production code
- Identifying the problem patterns where binary search on the answer replaces a linear scan over candidates with a logarithmic one

**Why this matters in interviews:**

Binary search is baseline competency. Failing to implement a correct binary search is a red flag in any algorithmic round. The "binary search on answer" technique appears in problems that many candidates first approach with brute force or DP, so recognizing the shape early is a strong signal. Rotated array and boundary-search variants are common. So are optimization problems dressed up in logistics or capacity planning framing, which are binary search on the answer under a different name. A screen may start with a standard binary search and then pivot to "what if the array is rotated?" or "what if there are duplicates?", specifically to see if you can adjust your invariants in real time. The precision this chapter builds, knowing when to move `hi = mid` versus `hi = mid-1`, is what turns correct-in-theory into correct-in-code.

**Prerequisites:** Chapter 66 (Arrays and Strings), Chapter 65 (Complexity Analysis), understanding of O(log n) complexity and loop invariant reasoning. Chapter 79 (Sorting and Selection) covers the sorted-input precondition that every binary search depends on.

---

### Junior -> FAANG: Binary Search as a Precision Skill

Binary search is the algorithm where being "basically right" is not enough. You can understand the concept perfectly and still produce buggy code because the correctness lives in three specific decisions: the initial bounds, the loop condition, and the update rule. Junior candidates who treat binary search as "I divide the search space in half" rather than "I maintain a precise loop invariant" will produce infinite loops or off-by-one errors under pressure.

The entry-point habit is to write the loop invariant as a comment before writing the loop body. For exact-match search the invariant is "the target, if it exists, is within [left, right]." For lower-bound search the invariant is "the answer is within [left, right)." Writing this forces you to choose the correct condition and update rule rather than guessing.

Practice the two templates until they are reflexes. Template 1 (`left <= right`, exact match) and Template 2 (`left < right`, boundary finding) cover all binary search problems. The question "which template?" should be answerable in five seconds based on whether you are looking for a specific value or a boundary position.

For the interview entry point: expect a standard binary search in the first five minutes of a phone screen, then a rotated array or boundary variant. The rotation variant is where unprepared candidates fail. Know the invariant for rotated search: "at least one of the two halves defined by mid is always fully sorted."

### Senior @ FAANG: Binary Search as a Design Paradigm

At the senior level, binary search is not an algorithm to implement. It is a design pattern to apply. The question "can I binary search on the answer?" eliminates brute-force and dynamic programming approaches to an entire class of optimization problems. Any problem of the form "find the minimum X such that condition C(X) holds" where C is monotone admits binary search on the answer in O(log(answer_range) * cost_of_C). Recognizing this shape immediately reduces the solution space and communicates algorithmic maturity to an interviewer.

In production systems, binary search is the foundation of several critical components: log-structured storage (SSTable level-based search), time-series databases (timestamp range queries), inverted index intersection (posting list binary search for AND queries), and rate limiter threshold computation. A senior engineer is expected to know which components in their system use binary search, what their worst-case inputs are, and whether the sortedness precondition each one depends on is actually enforced anywhere.

The `sort.Search` function in Go is the canonical production binary search. It implements the lower-bound template with a monotone predicate, which is the most general form. Any team using raw `lo`/`hi` loops where `sort.Search` would suffice has a readability debt. Raise this in code review.

ADR signal for bar-raisers: an L6 candidate will note that the Go standard library's `sort.Search` documentation explicitly warns that the predicate must be monotone and that violating this contract produces undefined results without a panic or error. This is a footgun in a large codebase where the predicate is passed across package boundaries. Monotonicity cannot be checked cheaply at call time, since verifying it exhaustively costs O(n) and defeats the point of the search. The staff-level move is to push the check to where it is affordable: assert the predicate's monotonicity in tests over generated inputs, and keep the invariant documented at the type or constructor that produces the ordered data, rather than trusting each call site to have gotten it right.
