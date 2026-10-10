## Exercises

1. **Two-Pointer Sorted Pair Sum**: Given a sorted array of integers and a target value, use the two-pointer technique to find all unique pairs that sum to the target. Achieve O(n) time and O(1) extra space. Handle duplicate pairs correctly.

2. **Sliding Window Maximum**: Given an array and a window size `k`, return the maximum value in every contiguous window of size `k`. Implement an O(n) solution using a monotonic deque and compare it against the naive O(nk) approach with benchmarks.

3. **In-Place String Reversal**: Reverse a string represented as a `[]byte` in place without allocating any extra memory. Then extend the solution to reverse individual words in a sentence in place (e.g., `"the sky is blue"` → `"blue is sky the"`).

4. **Longest Substring Without Repeating Characters** (LeetCode 3): Implement the sliding window solution in Go. Clearly annotate each pointer movement, explain the invariant maintained by the window, and state the time and space complexity.

5. **Minimum Window Substring** (LeetCode 76): Given strings `s` and `t`, find the minimum window in `s` that contains all characters of `t`. Use a sliding window with two frequency maps. Analyze why the solution is O(|s| + |t|) and not O(|s|·|t|).

6. **Rotate Matrix 90 Degrees In-Place**: Given an n×n matrix, rotate it 90 degrees clockwise without using an extra matrix. Implement the transpose-then-mirror approach, prove it produces a correct rotation, and state the space complexity.

7. **Find All Anagrams in a String** (LeetCode 438): Given strings `s` and `p`, return the starting indices of all anagrams of `p` in `s`. Use a fixed-size sliding window with a character frequency comparison in O(|s|) time. Discuss why comparing raw frequency arrays is more efficient than sorting substrings.

### Junior → FAANG: Using These Exercises as Mock Interviews

Each exercise in this list is calibrated for a different difficulty level and a different technique. Exercise 1 (sorted pair sum) and Exercise 3 (string reversal) are warm-up problems that should take under 10 minutes. Exercises 4 and 7 (longest substring without repeating, anagrams) are standard FAANG phone screen problems that should take 20-30 minutes with full explanation. Exercises 2 and 5 (sliding window maximum, minimum window substring) are harder problems that appear in on-site rounds and require 30-45 minutes with a complete analysis.

Treat each exercise as a mock interview by timing yourself, narrating your thought process out loud, and presenting the complexity analysis as part of the solution. The goal is not just to produce correct code but to produce correct code with a clear verbal explanation in the allotted time. The verbal explanation is what separates a hire from a strong hire at FAANG.

### Senior @ FAANG: Designing Team Interview Rounds from These Exercises

These exercises form a natural interview question bank. Exercise 2 (sliding window maximum with monotonic deque) is a strong on-site coding question for L5 and above because the O(n) solution requires a non-obvious data structure choice, and the follow-up questions ("what is the space complexity of the deque?", "how would you modify this for a minimum instead of maximum?", "how would you handle a stream of unknown length?") cleanly differentiate L5 from L6 candidates.

Exercise 6 (rotate matrix in-place) is excellent for assessing geometric reasoning and code clarity. The transpose-then-mirror implementation is elegant and correct, but the candidate should also be able to explain why it works and handle the edge cases (1x1 matrix, 2x2 matrix) without panicking. The follow-up "what if the matrix is not square?" tests whether the candidate can generalize a solution beyond its initial assumptions.

Exercise 5 (minimum window substring) is a calibration question: if a candidate cannot solve this in 35 minutes with a working implementation, that is a strong signal for an L4 or below hire recommendation at FAANG. If a candidate solves it in 20 minutes with correct complexity analysis and then proposes the follow-up of extending to multiple patterns simultaneously (Aho-Corasick), that is a strong signal for L6 or above.

---
