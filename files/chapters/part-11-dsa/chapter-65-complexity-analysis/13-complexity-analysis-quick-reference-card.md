## Complexity Analysis Quick Reference Card

This card condenses the entire chapter into a single lookup table for use during coding interviews and code review. The "Interview Red Flags" section is particularly important: each anti-pattern listed represents a common performance mistake that silently degrades O(n) algorithms to O(n²). For example, string concatenation with `+=` in a loop allocates a new backing array on every iteration, turning a linear pass into quadratic work that only becomes visible at scale.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    COMPLEXITY CHEAT SHEET                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  GROWTH RATES (slowest to fastest)                                      │
│  O(1) < O(log n) < O(n) < O(n log n) < O(n²) < O(2ⁿ) < O(n!)            │
│                                                                         │
│  COMMON PATTERNS                                                        │
│  ├─ Single loop over n elements           → O(n)                        │
│  ├─ Nested loops (both over n)            → O(n²)                       │
│  ├─ Loop with i *= 2                      → O(log n)                    │
│  ├─ Outer O(n), inner O(log n)            → O(n log n)                  │
│  ├─ Two pointers converging               → O(n)                        │
│  ├─ Binary search                         → O(log n)                    │
│  ├─ Recursion: T(n) = T(n-1) + O(1)       → O(n)                        │
│  ├─ Recursion: T(n) = T(n-1) + O(n)       → O(n²)                       │
│  ├─ Recursion: T(n) = 2T(n/2) + O(n)      → O(n log n)                  │
│  └─ Recursion: T(n) = 2T(n-1)             → O(2ⁿ)                       │
│                                                                         │
│  GO BUILT-IN OPERATIONS                                                 │
│  ├─ Slice access/assign                   → O(1)                        │
│  ├─ Slice append (amortized)              → O(1)                        │
│  ├─ Map get/set/delete                    → O(1) average                │
│  ├─ String concatenation                  → O(n+m)                      │
│  ├─ strings.Builder.WriteString           → O(1) amortized              │
│  └─ slices.SortFunc                       → O(n log n)                  │
│                                                                         │
│  INTERVIEW RED FLAGS                                                    │
│  ✗ String += in loop                      → O(n²), use Builder          │
│  ✗ Contains() in loop                     → O(n²), use map              │
│  ✗ Sorting when only need top-k           → Use heap O(n log k)         │
│  ✗ Recursion without memoization          → Often exponential           │
│  ✗ Forgetting recursion stack space       → O(depth) space              │
│                                                                         │
│  SPACE COMPLEXITY RULES                                                 │
│  ├─ Recursion depth d                     → O(d) stack space            │
│  ├─ Creating n-element array              → O(n)                        │
│  ├─ HashMap with n keys                   → O(n)                        │
│  └─ In-place modification                 → O(1) extra space            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Using the Reference Card as an Interview Anchor

This card works best as a mental checklist rather than a memorized table. Before submitting any interview solution, run through the red flags section: does my solution build a string with `+=` in a loop? does it call `Contains()` inside a loop? does it sort when I only need top-k? does any recursion lack memoization? does it ignore recursion stack space?

For the growth rate ordering, the practical consequence at interview scale is: O(n squared) is the threshold for "probably too slow for n=10000." If your solution is O(n squared) and the constraint says n can be 100000, you need a better approach. O(n log n) is generally acceptable. O(n) is ideal. O(log n) is excellent. O(1) is only possible if you have done precomputation.

Commit the Go built-in complexity table to memory. Interviewers specifically test knowledge of `strings.Builder` versus `+=`, and of amortized O(1) append, because these are Go-specific details that distinguish candidates who have production Go experience from those who only know the language academically.

### Senior @ FAANG: Extending the Reference Card for Your Team

This quick reference card is a template that senior engineers should customize for their team's specific context. A team working on a search engine has different hot-path patterns than a team building a financial transaction processor. The relevant "interview red flags" for a search team might include "sorting result sets larger than k when a heap suffices" and "full text scans when an inverted index lookup is available."

Creating and maintaining a team-specific performance reference document is a low-cost, high-impact senior engineering contribution. The document should include the complexity of every major data structure and algorithm used in the team's codebase, the expected input sizes for each, and the complexity budget for each hot path (for example, "search ranking must complete in under 10ms, which at 100k candidates means each candidate's scoring function must be O(1) or O(log n)").

Distributing this document to new team members during onboarding reduces the time it takes them to write production-quality code. Making it a living document that is updated when a new pattern is identified or when a production incident reveals a new anti-pattern turns individual incidents into team knowledge.

---
