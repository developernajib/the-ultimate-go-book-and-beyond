## Summary

Essential array and string techniques reference:

- **Two Pointers**: Opposite direction (two sum, container), same direction (remove duplicates)
- **Sliding Window**: Fixed size (anagrams), variable size (longest substring)
- **Prefix Sum**: Range queries, 2D prefix sums
- **Kadane's Algorithm**: Maximum subarray variants
- **String Matching**: KMP, Rabin-Karp, Z-algorithm

These patterns appear frequently in technical interviews and form the foundation for more complex problems.

### Junior → FAANG: What to Do with This Chapter Before Your Interview

Before any FAANG interview, run through these five areas as a self-assessment. Can you implement two-pointer problems (opposite direction and same direction) from scratch in under 15 minutes? Can you distinguish fixed-window from variable-window sliding window and implement the variable version with correct shrink logic? Can you compute a prefix sum array and answer range queries with the formula? Can you implement Kadane's and explain the max-versus-start decision at each step? Can you explain why KMP is O(n+m) and what the LPS array represents?

If any area feels uncertain, go back to its section and solve the exercises again with a timer. Interview preparation on algorithms is about repetition until the pattern fires automatically, not about understanding any single concept deeply in one sitting.

### Senior @ FAANG: This Chapter as an Engineering Culture Document

The patterns in this chapter are the foundation of Go data processing code. The choice of two-pointer over nested loops, sliding window over repeated recomputation, and `strings.Builder` over `+=` are not just performance choices: they are signals of engineering maturity that appear in code reviews, design discussions, and pair programming sessions.

A senior engineer who has internalized this chapter produces code that is faster, more readable, and more maintainable than code that lacks these patterns. More importantly, a senior engineer who has internalized these patterns can teach them to others through code review feedback, pairing, and documentation, multiplying their impact across the team. That multiplication is the defining characteristic of senior engineering at FAANG.
