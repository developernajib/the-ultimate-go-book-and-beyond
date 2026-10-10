## Exercises

1. **Analyze Five Algorithms**: For each of the following, determine both time and space complexity - linear search, binary search, bubble sort, merge sort, and Fibonacci with memoization. Justify each answer with a step-by-step breakdown.

2. **Prove Big-O for Nested Loops**: Given the code below, formally prove the tight Big-O bound by counting exact operations and applying the limit definition:
   ```go
   for i := 0; i < n; i++ {
       for j := i; j < n; j++ {
           // O(1) work
       }
   }
   ```

3. **Amortized Analysis of Dynamic Array**: Implement a dynamic array (slice) that doubles capacity on overflow. Using the aggregate method, prove that `n` sequential `append` operations cost O(n) total, giving O(1) amortized cost per operation.

4. **Master Theorem Application**: Apply the Master Theorem to solve each recurrence and state which case applies: (a) T(n) = 4T(n/2) + n, (b) T(n) = 4T(n/2) + n², (c) T(n) = 4T(n/2) + n³. Verify your results by tracing the recursion tree.

5. **O(n log n) vs O(n²) Empirical Comparison**: Write a Go benchmark that measures actual wall-clock time for an O(n log n) sort and an O(n²) sort at input sizes n = 100, 1 000, 10 000, and 100 000. Plot the growth ratios and compare them to the theoretical predictions.

6. **Space-Time Trade-off - Hash Table vs Sorted Array**: Implement both a hash-table-based and a sorted-array-based lookup structure for a set of integer keys. Measure lookup, insertion, and deletion time at n = 10 000 and 100 000 elements. Record memory usage for each. Write a one-paragraph analysis discussing when you would choose each structure given a concrete space budget constraint.

### Junior → FAANG: Making Exercise Practice Interview-Ready

These six exercises are not just practice problems: they are interview preparation drills with a specific output format. For each one, produce three artifacts before moving on: the implementation, the complexity annotation (time and space with justification), and a test that verifies the implementation is correct.

Exercise 5 (benchmark comparison) is particularly valuable because it builds intuition about when asymptotic class differences become visible in wall-clock time. For n=100, O(n squared) and O(n log n) may differ by less than a microsecond. For n=100000, the difference is on the order of seconds versus milliseconds. Running the benchmark and seeing these numbers makes the theoretical analysis concrete and memorable.

Exercise 4 (Master Theorem) is a direct interview target. Practice until you can identify the three cases in under 60 seconds. The most common error is computing log base b of a incorrectly: log base 2 of 3 is approximately 1.58, not 1.5. Use the change-of-base formula and be precise.

### Senior @ FAANG: Designing Exercises That Build Engineering Maturity

The exercises in this section are designed for individual skill-building. A senior engineer adapts them for team use by adding constraints that mirror production realities.

For exercise 5, add a constraint: "the benchmark must run in CI and fail if the O(n squared) sort is faster than the O(n log n) sort at n=1000." This forces the engineer to think about benchmark reliability (warm-up iterations, variance, timer resolution) in addition to correctness.

For exercise 6, add an operational constraint: "the structure must fit within a 100 MB memory limit at n=10 million elements." This forces an explicit memory calculation (10 million 8-byte keys is 80 MB of raw data, and hash table overhead, unused capacity at typical load factors plus per-bucket metadata, pushes the total past the 100 MB limit, so the sorted array at roughly 80 MB becomes the viable option). The constraint transforms an abstract data structure comparison into an engineering decision with real consequences.

Adding these constraints to team engineering exercises is a senior-level contribution that builds the habit of reasoning under constraints, which is precisely what separates strong production engineers from strong algorithmic thinkers.

---
