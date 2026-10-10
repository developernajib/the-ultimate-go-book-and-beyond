## Exercises

### Exercise 1: Word Break
Given a string and dictionary, determine if it can be segmented into words.

### Exercise 2: Perfect Squares
Find minimum number of perfect squares that sum to n.

### Exercise 3: Decode Ways
Count ways to decode a digit string to letters (A=1, B=2, ...).

### Exercise 4: Interleaving String
Check if string c is an interleaving of strings a and b.

### Junior → FAANG: How to Use Exercises Effectively

These four exercises represent common FAANG interview problem categories. For each exercise, follow a strict discipline: write the five-step framework (state, recurrence, base cases, order, final answer) before touching code. Resist the urge to look at solutions until you have either solved the problem or spent at least 20 minutes on a genuine attempt.

Word Break is a 1D DP where `dp[i]` means the prefix of length `i` is fully segmentable. The key is the inner loop over split points, which runs in O(n^2) total. The dictionary lookup should use a hash set (`map[string]bool`) for O(1) per lookup. A common mistake is using O(n) linear search through the word list, which makes the overall complexity O(n^2 * |dict|).

Perfect Squares is an unbounded knapsack where the "coins" are perfect square numbers and the "amount" is n. Precomputing the squares up to n before the main DP loop avoids redundant computation. The mathematical shortcut (Lagrange's four-square theorem) is an interesting follow-up but not expected in an interview.

Decode Ways (LeetCode 91) is a Fibonacci-pattern DP with extra constraints on valid two-digit decodings. The state `dp[i]` represents the number of ways to decode the first i digits. At each step, you check whether the last one digit forms a valid letter and whether the last two digits form a valid letter (10-26, no leading zero).

### Senior @ FAANG: Exercise Design as a Coaching Signal

When coaching junior engineers or conducting mock interviews, these four exercises serve as calibration problems. Word Break and Decode Ways distinguish candidates who understand 1D DP from those who have memorized it. The tell is whether the candidate can modify the solution when a constraint changes: "what if words can overlap?" or "what if digit 0 can also map to a space character?" Candidates who understand the recurrence can adapt. Those who memorized cannot.

Interleaving String (LeetCode 97) is the most useful calibration problem because it requires a 2D DP state (`dp[i][j]` means the first i characters of s1 and first j characters of s2 can form the first i+j characters of s3) that is not immediately obvious from the problem statement. A candidate who derives this state independently, rather than recalling it, demonstrates genuine DP fluency. It earns its place in senior loops precisely because the state design step, not the recurrence, is the hard part.

### Junior → FAANG: Using Exercises as Deliberate Practice

The four exercises here are chosen because each has a non-obvious entry point. For each one, spend the first 10 minutes of your practice session writing the five-step framework in plain English before opening any code editor. For word break, the entry point is "what does `dp[i] = true` mean?" (the prefix of length i is fully segmentable). For perfect squares, the entry point is "this is coin change where the coins are precomputed perfect square numbers." For decode ways, the entry point is "this is Fibonacci but with two conditional cases instead of one unconditional sum." For interleaving string, the entry point is "the state needs two indices, one into s1 and one into s2."

After implementing each exercise, write at least one edge case test that you think of yourself (not from the problem description). For decode ways, test the string "0" (should return 0), "10" (should return 1), and "100" (should return 0). Writing your own edge cases demonstrates that you understand the boundary behavior of the recurrence, not just the happy path.

### Senior @ FAANG: Exercises as Interview Loop Design Tools

These four exercises represent four different ways that DP interview problems are made harder in senior-level loops. Word break is harder because it requires choosing the right inner data structure (hash set, not linear scan). Perfect squares is harder because the coins are not given explicitly (you must precompute them). Decode ways is harder because the single-digit and two-digit cases are conditional (not all two-digit combinations are valid). Interleaving string is harder because the state design step is genuinely non-obvious.

When designing interview problems for senior engineer candidates, these properties (unusual input preprocessing, conditional recurrence, non-obvious state) are the levers that control difficulty. A problem where the recurrence is obvious but the state design requires insight is appropriate for L5. A problem where both the state design and the recurrence require original reasoning is appropriate for L6. Using these four exercises as a design template helps create fair, differentiated interview problems rather than relying on obscurity or problem recall.

---
