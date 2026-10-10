## 83G.6 Getting Unstuck: The Recovery Playbook

This is the most important section in this chapter. Getting stuck is not a possibility --- it is a near-certainty. What matters is how you respond. The strategies below are ordered by situation, and each includes specific phrases you can say aloud.

### When You Do Not Know the Approach

You have read the problem. You have asked clarifying questions. You have worked through examples. And you have no idea how to solve it. This happens to everyone.

**Strategy 1: Think Aloud Through Brute Force**

Even when you cannot see the optimal solution, you can almost always describe a brute force approach. Start there.

> "OK, the most straightforward approach would be to try every possible combination and check each one. That would be O(2^n) which is too slow, but let me think about what makes it slow and whether I can avoid redundant work..."

Starting with brute force gives you three benefits: (1) it shows the interviewer you can at least approach the problem, (2) it often reveals the structure of a better solution, and (3) it buys you time to think.

**Strategy 2: Work Backwards from the Output**

Sometimes looking at what the answer looks like reveals how to get there.

> "The output is the length of the longest increasing subsequence. So the answer for any array is at least 1 (a single element). If I had the answer for the array without the last element, could I extend it? Yes --- if the last element is greater than the end of the current subsequence..."

This often leads naturally to dynamic programming or recursive approaches.

**Strategy 3: Draw Pictures and Examples**

Many problems that seem abstract become clear when visualized.

> "Let me draw out what's happening with a few examples. For the input [1, 3, 2, 4], I can see that... [drawing]"

Use the whiteboard or your notepad. Draw the data structure. Draw the state at each step. Draw the transformation from input to output.

**Strategy 4: Try Smaller Inputs**

If the problem with input size n is overwhelming, solve it for n=1, n=2, n=3 and look for patterns.

> "Let me try the smallest possible inputs. If the array has 1 element, the answer is 1. If it has 2 elements, the answer is 1 or 2 depending on whether they're sorted. For 3 elements..."

This builds intuition and often reveals the recursive structure of the problem.

**Strategy 5: Relate to Problems You Have Solved Before**

> "This reminds me of [known problem]. The key difference is [X]. Let me see if I can adapt that approach..."

Pattern recognition is a legitimate and expected skill. Interviewers want to see you connect problems to known patterns.

**Strategy 6: Ask for a Hint Gracefully**

There is no shame in asking for a hint. How you ask matters enormously.

**What to Say:**
> "I'm considering a few approaches but I'm not sure which direction would be most productive. Could you point me toward the right data structure to use?"

> "I'm stuck between a greedy approach and a dynamic programming approach. Would either of those be on the right track?"

> "I've been thinking about this for a few minutes and I want to make sure I'm not going down a rabbit hole. Could you give me a nudge in the right direction?"

**What NOT to Say:**
> "I have no idea. Can you help me?" (Too passive. Show what you've tried.)

> "Just tell me the approach." (Demanding and lazy.)

> "I give up." (Never, ever say this.)

**Strategy 7: The Brute Force Escape Hatch**

If all else fails, implement the brute force solution. A working brute force solution is infinitely better than no solution. Many candidates receive "Lean Hire" with a brute force solution and good communication, and "No Hire" with no solution despite claiming to know the optimal approach.

> "I haven't been able to find the optimal approach yet, but I can implement a brute force solution in the remaining time. I'd like to do that and then discuss how to optimize it."

Most interviewers will say yes, and many will then help you optimize it.

### When Your Code Has a Bug

You have written your solution. You are tracing through it. Something is wrong. The output does not match the expected result.

**Strategy 1: Systematic Debugging (Not Random Changes)**

The worst thing you can do is start randomly changing parts of your code. This signals panic and lack of engineering discipline. Instead:

> "The output should be 3 but I'm getting 2. Let me trace through the code step by step to find where the logic diverges from what I expect."

Walk through each line. At each step, state what you expect the value to be and what it actually is. The bug is at the point where expectation and reality diverge.

**Strategy 2: Check Off-by-One Errors**

The most common bug in interview code. Check:

```go
// These are different:
for i := 0; i < len(arr); i++ {}     // visits arr[0] through arr[len(arr)-1]
for i := 0; i <= len(arr); i++ {}    // visits arr[0] through arr[len(arr)] -- BUG: out of bounds
for i := 0; i < len(arr)-1; i++ {}   // visits arr[0] through arr[len(arr)-2] -- misses last element

// Slice ranges:
_ = arr[0:n]   // elements 0 through n-1
_ = arr[0:n-1] // elements 0 through n-2 -- did you mean to exclude the last one?
```

**Strategy 3: Verify Base Cases**

If you are writing a recursive solution, check that your base cases are correct and cover all termination conditions.

> "Let me check my base cases. When n is 0... when n is 1... when the array is empty... Yes, these all look correct. The bug must be in the recursive step."

**Strategy 4: Admit the Bug and Explain Your Fix**

When you find the bug, do not silently fix it. Explain what went wrong and why your fix is correct. This demonstrates debugging skill.

> "Ah, I see the issue. I'm initializing maxLen to 0, but for the case where all characters are unique, I should be updating maxLen inside the loop. Let me move this update... Yes, now when I trace through 'abc', maxLen correctly becomes 3."

**What to Say when you find a bug:**
> "I see the issue. I have an off-by-one error on line 5. The loop should use `<` instead of `<=` because..."

> "Found it. I forgot to handle the case where the map returns the zero value. I need to check `exists` as well as the value."

**What NOT to Say:**
> "Hmm, this should work..." (while staring blankly)
> "I don't understand why this is wrong." (for more than 30 seconds --- start debugging)

### When You Are Running Out of Time

You glance at the clock. 5 minutes left. You are not done. This is not a disaster if you handle it correctly.

**Strategy 1: Explain What You Would Do With More Time**

> "I have 5 minutes left and my solution handles the core case but doesn't cover [edge case]. With more time, I would add a check for [X] and optimize the inner loop from O(n) to O(1) using a hash map. Let me use the remaining time to test the core logic."

This demonstrates that you know what a complete solution looks like, even if you could not deliver it within the time constraint.

**Strategy 2: Prioritize Correctness Over Optimization**

A correct O(n^2) solution beats an incorrect O(n) solution every time.

> "My current solution is O(n^2) and I see how to optimize it to O(n) with a hash map, but I want to make sure the core logic is correct first. Let me trace through the example to verify."

**Strategy 3: Write Pseudocode for Remaining Parts**

If you cannot finish the implementation, write pseudocode that shows you know the algorithm:

```go
func solve(input []int) int {
    // Step 1: Build frequency map (O(n))
    freq := buildFrequencyMap(input)

    // Step 2: Use heap to find top K elements
    // I would use container/heap here with a min-heap of size K
    // Push each element, pop when size > K
    // Remaining K elements are the answer

    // Step 3: Return result
    // pseudocode: return heapToSlice(h)
}
```

**Strategy 4: The "I Know the Pattern" Technique**

If you recognize the pattern but cannot implement it in time:

> "This is a classic monotonic stack problem. The idea is to maintain a stack of indices in decreasing order of values. For each new element, we pop everything smaller and update the result. I could implement this in O(n) time and O(n) space. Unfortunately I'm running short on time, but the key insight is that each element is pushed and popped at most once."

This is not as good as a working solution, but it is far better than an incomplete implementation with no explanation.

### When You Completely Blank

Your mind is empty. You cannot think of anything. The problem might as well be in a foreign language. This is the panic moment. Here is what to do.

**Strategy 1: The 30-Second Reset Technique**

1. Stop. Take a breath. Say: "Let me take a moment to collect my thoughts."
2. Close your eyes for 5 seconds (not longer --- you do not want to seem like you are napping).
3. Look at the problem statement again, as if reading it for the first time.
4. Ask yourself: "What is the simplest version of this problem?"

This reset breaks the panic spiral. Your brain was stuck in a loop. You are forcing it to start fresh.

**Strategy 2: Start from First Principles**

Forget everything you know about algorithms. Just think about the problem.

> "OK, let me think about what I actually need to do here. I have a list of numbers. I need to find... Let me think about what it means to find that. If I had the answer, what would it look like? If I had to explain this to someone with no CS background, how would I describe the solution?"

**Strategy 3: The "Explain to a Junior" Trick**

Pretend you are explaining the problem to a junior developer. This shifts you from "I need to be brilliant" mode to "I need to be clear" mode, which ironically makes you more likely to find the solution.

> "If I were explaining this to someone junior, I'd say: 'We need to find two numbers that add up to the target. The simplest way is to check every pair. But that's slow. What if we could remember what numbers we've already seen?'"

**Strategy 4: Buy Time with Edge Case Discussion**

If you need time to think, fill the silence productively by discussing edge cases:

> "While I'm thinking about the approach, let me consider some edge cases. What if the array is empty? What if all elements are the same? What if the array has only one element? What if the target is negative?"

This is not stalling --- it is genuine problem analysis. And it often triggers insights about the solution.

**Strategy 5: Graceful Pivoting**

If you have been going down one path for more than 5 minutes with no progress, pivot.

> "I've been trying a recursive approach and it's getting complicated. Let me step back and think about whether an iterative approach with a stack might be simpler."

Interviewers value adaptability. Stubbornly pursuing a dead end is worse than admitting the approach isn't working and trying something different.

### When the Interviewer Seems Unhappy

You are coding. The interviewer frowns. Or sighs. Or asks a question in a tone that sounds skeptical. Your stress response tells you: "They think you're failing."

**Strategy 1: Do Not Panic --- Interviewers Have Poker Faces**

Many interviewers deliberately maintain a neutral expression to avoid giving hints. A frown might mean "I'm thinking about something else." A pause might mean "I'm reading your code." Do not interpret body language as judgment.

**Strategy 2: Ask Directly**

> "Am I on the right track with this approach, or would you suggest a different direction?"

This is not weakness. It is efficient communication. If you are going the wrong way, knowing now saves 10 minutes of wasted effort.

**Strategy 3: Do Not Apologize Excessively**

One apology is fine: "Sorry, let me reconsider." Multiple apologies ("I'm sorry I'm so slow, I'm sorry this is messy, I'm sorry I can't think of this") damage your perceived confidence without helping your solution.

**Strategy 4: Stay Positive and Keep Coding**

The interview is not over until it is over. Candidates who maintain a positive attitude and keep working score higher than those who give up --- even if the final solution is incomplete.

> "This is a tricky one. Let me try a different angle."

> "I haven't cracked the optimal approach yet, but I can implement a working solution."

**Strategy 5: The Sandwich Feedback Interpretation**

If the interviewer says "That's one approach... but what about [X]?", this is a hint, not criticism. The "one approach" part is acknowledging your work. The "what about [X]" part is pointing you toward a better solution. Use the hint.


### Junior → FAANG: How to Get Unstuck in a Coding Interview

Getting stuck in a coding interview is normal and does not automatically mean failure. The recovery playbook: (1) state your current state clearly ('I'm trying to figure out how to handle the case where the input has duplicates'), (2) try the simplest possible sub-problem (can you solve a version with no duplicates?), (3) think about the data structure (what structure would make the operation you need efficient?), (4) ask for a hint if you have genuinely exhausted your approaches (most interviewers will give a hint, and asking for one cleanly is better than silent struggling). The worst response to being stuck is to go silent and wait for inspiration. Narrate your thinking even when uncertain.

### Senior @ FAANG: Recovery Playbook at the Senior Level: Intellectual Transparency

At the senior level, getting stuck in a coding or system design interview should be handled with intellectual transparency: explicitly state what you know, what you do not know, and how you are reasoning through the gap. This models the behavior you want to see from engineers on your team. A candidate who says 'I know the problem requires topological sort, but I'm not certain how to handle the cycle detection case with bidirectional edges. Let me think through this step by step' is giving a much stronger L6 signal than a candidate who goes silent or guesses. The bar-raiser is specifically evaluating whether you handle uncertainty honestly and productively, because that is how you will handle uncertain production engineering problems.

---
