# Chapter 66: Arrays and Strings

> *"Simple things should be simple, complex things should be possible."* - Alan Kay

Arrays and strings are the most fundamental data structures in all of computing. An array is a contiguous block of memory where elements of the same type are stored at fixed, predictable offsets - meaning element access is O(1) because you can calculate any element's address directly from the base pointer and the index. Strings in Go are immutable byte sequences: a two-word header holding a pointer and a length (16 bytes on 64-bit platforms), backed by a read-only region of memory. This seemingly simple model unlocks a vast universe of algorithmic techniques - two pointers, sliding windows, prefix sums, and in-place transformations - that form the bedrock of efficient data processing at every scale.

Arrays and strings dominate coding interviews because they require zero setup: every interviewer can ask a problem that fits on a whiteboard, and every candidate is expected to know the structure intimately. A large share of first-round coding screens at Google involve at least one array or string problem. Amazon's online assessment is heavily weighted toward these topics. Meta's interview process consistently features substring problems, anagram detection, and matrix manipulation. The algorithms that operate on these structures - two-pointer traversal, sliding window, prefix sums, Kadane's algorithm - appear repeatedly across all difficulty levels, from LC Easy warm-ups to LC Hard system design follow-ups that ask you to extend your solution to streaming data.

In production Go systems, arrays and strings are everywhere. Go's `[]byte` slice is the workhorse of network I/O - every HTTP request body, every database row, every file read passes through byte slices. The `strings` and `bytes` standard library packages provide O(n) search, O(n) split, and amortized O(n) build operations via `strings.Builder`. Go's string immutability means that naive concatenation in a loop is O(n²) - a critical gotcha that interviewers deliberately probe. Understanding the underlying memory model lets you write zero-allocation parsers, implement efficient tokenizers, and avoid the subtle performance traps that catch even experienced developers off guard.

**What you'll learn in this chapter:**

- Go slice internals: the three-word header (pointer, length, capacity) and how append triggers O(n) copies
- Two-pointer technique for in-place reversal, palindrome checking, and sorted array problems
- Sliding window pattern for maximum/minimum subarray problems with O(n) time and O(1) space
- Prefix sum arrays for O(1) range queries after O(n) preprocessing
- String manipulation in Go: `strings.Builder`, rune vs. byte iteration, and Unicode-safe operations
- Matrix (2D array) traversal patterns: spiral order, diagonal traversal, rotation in-place
- Common interview patterns: anagram detection, longest substring without repeating characters, container with most water
- Go-specific pitfalls: string concatenation in loops, slice sharing after reslicing, and off-by-one errors in window boundaries

**Why this matters in interviews:**

Arrays and strings appear in more FAANG coding rounds than any other topic. Google uses array problems to assess whether candidates can optimize from O(n²) brute force to O(n) in a single insight - a proxy for problem-solving maturity. Amazon's LP "Invent and Simplify" maps directly to finding the elegant O(n) solution over the obvious O(n²) one. LeetCode's Top 100 Liked Problems list is dominated by array and string problems. At Meta, string manipulation problems (valid parentheses, decode ways, word break) appear frequently in production-relevance questions. Difficulty ranges from Easy (two-sum, reverse string) to Hard (minimum window substring, trapping rain water). Every senior engineer is expected to solve medium-difficulty array problems in under 15 minutes.

**Prerequisites:** Chapter 65 (Complexity Analysis), Go slice and string fundamentals (Chapters 4-5).

### Junior → FAANG: Arrays and Strings as the Interview Foundation

Arrays and strings appear in more interview rounds than any other topic. The reason is not difficulty: it is versatility. A two-pointer problem can probe your ability to write clean loop logic. A sliding window problem tests whether you can maintain invariants under moving boundaries. A string manipulation problem checks whether you understand Go's immutability model. Together they cover a broad surface area of engineering judgment in a format that fits on a whiteboard.

Your first goal is to recognize the problem type within 60 seconds of reading the problem statement. "Sorted array, find pair that sums to target" is two-pointer. "Maximum sum of contiguous subarray" is Kadane's. "All substrings with at most k distinct characters" is sliding window. Building this recognition library is the highest-return preparation activity for array and string interviews.

Your second goal is to know Go's slice and string mechanics well enough that you never introduce a bug from language confusion. Strings are immutable: you cannot modify `s[0]`. Converting to `[]byte` gives you a mutable copy. Iterating with `range` over a string gives you runes, not bytes. `len(s)` gives bytes, not characters. Knowing these details prevents the class of bugs that cost candidates problems they otherwise could solve.

### Senior @ FAANG: Arrays and Strings in Production Go Systems

At production scale, arrays and strings are not just interview topics: they are the primary source of allocation pressure, GC overhead, and memory bugs in Go services. The idiomatic patterns in this chapter (using `strings.Builder` for concatenation, pre-allocating slices with `make([]T, 0, n)`, avoiding unnecessary `[]rune` conversions) translate directly into production code that handles higher throughput with lower latency.

A senior engineer reviewing a Go service for performance looks at three things related to this chapter's content: whether hot-path string processing uses `strings.Builder` or `bytes.Buffer` instead of `+`, whether slices in inner loops are pre-allocated with known capacity, and whether any code converts between `string` and `[]byte` more times than necessary (each conversion is an O(n) copy unless the compiler can prove immutability is preserved). Each of these is a concrete, measurable improvement that reduces allocation rate and GC pressure.

For platform engineers, understanding slice sharing semantics is critical for safety. When you reslice a large buffer to pass a portion to a downstream function, both the caller and callee share the backing array. A write in the callee modifies memory the caller still holds a reference to. The standard safe pattern is to copy when ownership semantics are unclear: `copy(dst, src)` is O(n) but prevents a class of data corruption bugs that are nearly impossible to diagnose under concurrent access.

---
