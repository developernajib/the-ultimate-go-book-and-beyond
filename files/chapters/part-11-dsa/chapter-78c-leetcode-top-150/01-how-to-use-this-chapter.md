## How to Use This Chapter

- **First pass**: Read the key insight, then solve the problem yourself before looking at the solution.
- **Second pass**: Time yourself. Aim for 15 minutes on Easy, 25 minutes on Medium, 40 minutes on Hard.
- **Third pass**: Explain each solution aloud as if in an interview. If you cannot explain the "why," revisit.

**Difficulty Legend**: 🟢 Easy | 🟡 Medium | 🔴 Hard

---

### Junior → FAANG: Making the Three-Pass Protocol Work

The three-pass protocol is only effective if each pass has a different objective. The first pass tests whether you can derive the pattern independently. The second pass tests whether your implementation is fast enough. The third pass tests whether you can communicate the approach clearly. Compressing all three into one sitting defeats the purpose: spaced repetition across multiple sittings is what moves a problem from "I can solve it with hints" to "I can derive it cold."

For the timing targets (15/25/40 minutes), start the timer only after you have read the problem and stated the pattern. Pattern identification time is a separate skill measured separately. If you cannot state the pattern in 90 seconds, that is the gap to fix, not the implementation time.

Third-pass explanation habit: use the STAR framing adapted for algorithms. "The problem asks for X. The insight is Y. The approach is Z. The complexity is A time and B space. The edge cases are C and D." Practicing this exact script makes interview explanations feel natural rather than improvised.

### Senior @ FAANG: Three-Pass Thinking Applied to Code Review

The three-pass protocol maps directly to effective code review. First pass: read the diff and identify which algorithmic pattern is being used. If the pattern is inappropriate for the problem size or constraints, flag it. Second pass: check the implementation for correctness relative to the pattern's invariants (are edge cases handled, are complexity claims accurate). Third pass: evaluate readability and whether a future maintainer can understand the algorithm from the code and comments alone.

Senior engineers who apply this three-pass discipline to code review provide substantially higher-quality feedback than those who focus only on syntax and style. The first pass is where the most impactful bugs are caught, because an incorrect pattern choice produces wrong answers for certain input distributions even if the code is syntactically perfect. Building this review habit in yourself and explicitly teaching it to the engineers you mentor is a high-value investment.
