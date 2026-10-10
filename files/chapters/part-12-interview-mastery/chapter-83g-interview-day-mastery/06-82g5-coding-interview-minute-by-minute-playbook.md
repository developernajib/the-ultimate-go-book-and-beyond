## 83G.5 Coding Interview: Minute-by-Minute Playbook

This section gives you a precise timeline for a 45-minute coding interview. Treat it as a recipe. Follow it exactly until it becomes second nature, then adapt it to your style.

### Minutes 0--5: Problem Understanding

**What to do:**

1. **Listen carefully** to the problem statement. Do not start solving while the interviewer is still talking.
2. **Restate the problem** in your own words. "So if I understand correctly, I need to find the length of the longest substring without repeating characters. Is that right?"
3. **Work through the example** the interviewer provides. Do it by hand on paper or whiteboard. "Let me trace through this example: for 'abcabcbb', I'd start at 'a'..."
4. **Create your own example.** Choose a small, meaningful input. "Let me also try 'aab' to make sure I handle duplicates."
5. **Identify edge cases.** "What about an empty string? A string with all the same character?"
6. **Confirm constraints.** "The string length can be up to 10^5? So I should aim for O(n) or O(n log n)?"

**What to Say:**
> "Let me make sure I understand the problem before I start thinking about approaches."

> "I want to work through this example by hand to build intuition."

> "Just to confirm --- the input is always valid? Or do I need to handle nil/empty inputs?"

**What NOT to Say:**
> "Got it." (Then immediately start coding.)

> "This is just a sliding window problem." (Pattern-matching before understanding.)

> "I've seen this one before." (Even if you have. It sounds like you memorized the answer.)

### Minutes 5--10: Approach Selection

**What to do:**

1. **State the brute force approach first.** Always. Even if you know a better approach. "The naive approach would be to check every substring, which would be O(n^3). That's too slow for the constraints, but let me think about how to improve it."

2. **Think aloud about optimization.** "The brute force recalculates a lot of information. If I use a sliding window and a set to track characters in the current window, I can do this in O(n)..."

3. **Identify the pattern.** Map the problem to a known pattern (sliding window, two pointers, BFS/DFS, dynamic programming, etc.) and explain why it applies.

4. **State your approach clearly before coding.** "Here's my plan: I'll use a sliding window with two pointers and a map to track the last index of each character. When I encounter a repeat, I'll move the left pointer to just past the last occurrence. I'll track the maximum window size throughout."

5. **Confirm with the interviewer.** "Does this approach sound reasonable? Should I code it up?"

**What to Say:**
> "Let me start with the brute force and then see if I can optimize."

> "This reminds me of the sliding window pattern. Let me think about whether that applies here."

> "My approach has O(n) time and O(min(n, k)) space where k is the character set size. Should I proceed with this?"

**What NOT to Say:**
> "I have no idea how to approach this." (Even if you don't. Say "Let me think through some options.")

> "Is this right?" (asking before you've committed to an approach --- show confidence)

> *Complete silence for 2+ minutes.* (Think aloud. Silence makes interviewers nervous.)

### Minutes 10--30: Implementation

This is the main coding phase. Your goals are: write correct code, maintain communication, and demonstrate clean coding habits.

**Clean code habits under pressure:**

```go
// GOOD: Even under pressure, use meaningful names
func lengthOfLongestSubstring(s string) int {
    lastSeen := make(map[byte]int) // character -> last index
    maxLen := 0
    windowStart := 0

    for windowEnd := 0; windowEnd < len(s); windowEnd++ {
        ch := s[windowEnd]
        if lastIdx, exists := lastSeen[ch]; exists && lastIdx >= windowStart {
            windowStart = lastIdx + 1
        }
        lastSeen[ch] = windowEnd
        if currentLen := windowEnd - windowStart + 1; currentLen > maxLen {
            maxLen = currentLen
        }
    }
    return maxLen
}

// BAD: Panic coding with meaningless names
func f(s string) int {
    m := make(map[byte]int)
    r := 0
    l := 0
    for i := 0; i < len(s); i++ {
        if v, ok := m[s[i]]; ok && v >= l {
            l = v + 1
        }
        m[s[i]] = i
        if i-l+1 > r {
            r = i - l + 1
        }
    }
    return r
}
```

Both solutions are logically identical. The first gets a better interview score because it demonstrates professional coding habits. Under pressure, your instinct will be to use short variable names "to save time." Resist this. Clear names cost seconds and save minutes of confusion.

**Variable naming when your brain is foggy:**

If you cannot think of the perfect variable name, use these conventions:

```
Purpose                     Quick Name       Better Name (if brain allows)
───────────────────────────────────────────────────────────────────────────
Loop counter                i, j, k          idx, row, col
Hash map for counting       counts           charCount, freqMap
Hash map for lookup         seen             lastSeen, visited
Result to return            result           maxLen, shortestPath
Two pointers                left, right      windowStart, windowEnd
Stack                       stack            parenStack, callStack
Queue                       queue            bfsQueue, taskQueue
Current node in tree        node             current, curr
Temporary variable          temp             swapVal
```

**Writing Go code on a whiteboard (in-person tips):**

1. **Write large.** Small handwriting is hard to read and looks uncertain.
2. **Leave space between lines.** You will need to insert code later.
3. **Skip the package declaration and imports.** Say "I'll assume standard imports."
4. **Use simplified error handling.** On a whiteboard, you can write `// handle err` instead of the full `if err != nil { return err }` pattern. Just acknowledge it verbally.
5. **Do not erase.** Cross out mistakes with a single line. Erasing and rewriting wastes time.
6. **Use a different color marker for changes** if available.
7. **Step back periodically** to read your code from the interviewer's perspective.

**Handling syntax uncertainty gracefully:**

If you cannot remember exact Go syntax for something, say so and use pseudocode for that part:

**What to Say:**
> "I can't remember the exact syntax for initializing a heap in Go, but the logic would be: push this element, then if the heap size exceeds k, pop the minimum. Let me write it as pseudocode and come back to the exact syntax."

> "I know Go's sort package has a function for this --- I believe it's sort.Slice with a custom comparator. Let me write it that way and verify the syntax if we have time."

**What NOT to Say:**
> "I don't know Go syntax." (Too vague. Be specific about what you are unsure of.)

> *Silently writing incorrect syntax and hoping the interviewer doesn't notice.*

**When to use pseudocode vs. real code:**

- Use pseudocode for complex algorithms while you work out the logic, then convert to real Go.
- Use pseudocode for library functions whose exact API you can't remember.
- Use real Go for everything else. Interviewers want to see that you can write actual code.

**Keeping the interviewer engaged while coding:**

Do not go silent for more than 30 seconds while coding. Narrate your work:

> "I'm initializing the map to track character frequencies..."

> "Now I need to handle the case where the window contains a duplicate..."

> "I'm going to write a helper function for this to keep the main logic clean..."

> "Let me think for a moment about this edge case..." (This buys you silence without the interviewer worrying.)

### Minutes 30--40: Testing and Optimization

**Walking through your code with an example:**

After you finish coding, do not say "I think that's right." Instead, trace through your code with a concrete example.

> "Let me walk through this with the example 'abcabcbb'. windowStart = 0, windowEnd = 0, ch = 'a'. Not in lastSeen, so maxLen = 1, lastSeen = {'a': 0}. windowEnd = 1, ch = 'b'..."

Walk through at least one normal case and one edge case. This catches bugs before the interviewer does, and it demonstrates testing discipline.

**Finding bugs before the interviewer does:**

Common bugs to check for:

```
BUG CHECKLIST (run through this mentally after coding)

[ ] Off-by-one errors
    - Are my loop bounds correct? (< vs <=)
    - Is my window/range inclusive or exclusive?
    - Am I returning length or index?

[ ] Base cases
    - Empty input?
    - Single element input?
    - All elements the same?

[ ] Initialization
    - Did I initialize my map? (Go: make(map[K]V))
    - Did I set the right initial value for min/max?
      (Use math.MaxInt for min, math.MinInt for max, not 0)

[ ] Nil/zero value handling
    - What if the input slice is nil?
    - What if a map lookup returns the zero value?

[ ] Integer overflow
    - Could any multiplication or addition overflow?
    - Should I use int64 instead of int?

[ ] Return value
    - Am I returning the right thing?
    - Am I returning at all code paths?
```

**Time and space complexity analysis:**

Always state complexity before being asked. It shows you think about performance automatically.

> "The time complexity is O(n) because we visit each character at most twice --- once when expanding the window and once when contracting it. The space complexity is O(min(n, k)) where k is the size of the character set, since the map stores at most one entry per unique character."

**Handling follow-up questions:**

Common follow-ups and how to handle them:

| Follow-up | How to Respond |
|---|---|
| "Can you optimize this?" | "Currently it's O(n log n). To do better, I'd consider..." |
| "What if the input is very large?" | "If it doesn't fit in memory, I'd use a streaming approach..." |
| "What if there are concurrent readers?" | "I'd protect the shared state with a sync.RWMutex..." |
| "Handle this edge case" | "Good catch. I'd add a check at line X for that condition." |
| "Explain your choice of data structure" | "I chose a map over a slice because lookup is O(1) vs O(n)..." |

### Minutes 40--45: Wrap-Up

If you finish early (rare but possible):
- Review your code one more time for bugs
- Mention improvements you would make with more time
- Ask the interviewer if they would like you to handle any additional cases
- Ask your prepared questions about the team/role

If you are still coding at minute 40:
- Prioritize getting a working solution over optimizing
- If you cannot finish, explain what the remaining code would do
- Write pseudocode for unfinished parts
- State the complexity of your approach


### Junior → FAANG: Coding Interview Minute-by-Minute Playbook

A coding interview playbook gives you a reliable structure for the 45-60 minute round. Minutes 0-5: understand the problem (read aloud, ask clarifying questions, confirm the input/output format and constraints). Minutes 5-10: discuss the approach (brute force first, then optimize, explain your reasoning). Minutes 10-35: implement the solution (narrate as you code, handle edge cases as you think of them). Minutes 35-45: test and debug (trace through your code with a specific example, identify edge cases). Minutes 45-50: discuss complexity and follow-up questions. Following this structure prevents the most common time management failure: spending 40 minutes on implementation and running out of time for testing.

### Senior @ FAANG: Coding Interview Playbook at the Senior Level: Proactive Optimization and Code Quality

At the senior level, the coding interview playbook has two additional elements: proactive optimization discussion and code quality signals. Proactive optimization: after stating the brute force approach, immediately identify its bottleneck and propose the optimization before the interviewer asks. 'The brute force is O(n^2) because we're doing a linear search for each element. We can reduce this to O(n) by using a hash map for O(1) lookups.' This proactivity signals that you think about performance naturally, not reactively. Code quality at the senior level includes meaningful variable names (not 'i', 'j', 'k' unless they are conventional for the context), function decomposition for complex logic, and explicit error handling (what does your function return if the input is nil, empty, or malformed). These quality signals are not tested in coding competitions but are evaluated in senior FAANG interviews.

---
