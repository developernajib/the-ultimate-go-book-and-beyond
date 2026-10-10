## 80.11 Common Technical Interview Pitfalls

### Pitfall 1: Starting to Code Without Clarifying Requirements

**Real Incident**: A candidate at Google immediately started coding a LRU cache without asking about capacity limits, eviction policy, or thread safety requirements. 15 minutes in, the interviewer mentioned concurrent access was needed, forcing a complete rewrite.

**The Wrong Approach:**
- Jump straight into coding after hearing the problem
- Assume requirements based on past experience
- Start with implementation details

**The Right Approach:**
```
Before writing ANY code:

1. Clarify input/output
   - "What type of keys/values?"
   - "What's the expected input size?"
   - "Any constraints on time/space?"

2. Confirm edge cases
   - "What should happen with empty input?"
   - "How do we handle duplicates?"
   - "Should this be thread-safe?"

3. Discuss approach
   - "I'm thinking of using X approach, does that sound right?"
   - "Should I optimize for time or space?"

4. THEN start coding
```

### Pitfall 2: Not Thinking Out Loud

**Real Incident**: A Meta candidate silently stared at the screen for 3 minutes during a coding interview. The interviewer had no idea if they were thinking, stuck, or confused. Result: awkward silence and a "weak hire" rating for communication.

**The Wrong Approach:**
- Work silently, hoping the code speaks for itself
- Only talk when you have the complete solution
- Assume interviewers can follow your thought process

**The Right Approach:**
```
Narrate continuously:

"Let me think about this... I see we need to find duplicates,
so my first instinct is to use a hash map for O(1) lookups.

For each element, I'll check if it's in the map. If yes,
that's a duplicate. If no, I'll add it.

Let me start with the function signature... I'll call it
findDuplicates, taking a slice of ints and returning a slice.

Now implementing the map... I'll use make to initialize it..."
```

### Pitfall 3: Ignoring Time/Space Complexity Until Asked

**Real Incident**: An Amazon candidate wrote a working solution but couldn't explain why it was O(n²). When the interviewer asked about optimization, they panicked and couldn't improve it because they hadn't analyzed complexity during design.

**The Wrong Approach:**
```go
// Just gets the answer, ignores complexity
func twoSum(nums []int, target int) []int {
    for i := 0; i < len(nums); i++ {
        for j := i + 1; j < len(nums); j++ {
            if nums[i]+nums[j] == target {
                return []int{i, j}
            }
        }
    }
    return nil
}
// Works! But O(n²)... didn't realize until asked
```

**The Right Approach:**
```go
// Analyze before coding
// "This is O(n²) nested loops. Can we do better?"
// "Using a map gives O(n) time, O(n) space. Trade-off accepted."

func twoSum(nums []int, target int) []int {
    seen := make(map[int]int) // Space: O(n)

    for i, num := range nums { // Time: O(n)
        complement := target - num
        if j, ok := seen[complement]; ok {
            return []int{j, i}
        }
        seen[num] = i
    }
    return nil
}
// State complexity BEFORE they ask: "This is O(n) time, O(n) space"
```

### Pitfall 4: Not Testing Your Own Code

**Real Incident**: A Netflix candidate finished coding 5 minutes early and said "Done!" without running any tests. The interviewer found an off-by-one error in the first test case, and asked why they didn't catch it. Major red flag.

**The Wrong Approach:**
- Finish coding and say "that should work"
- Rely on interviewer to find bugs
- Only test when forced to

**The Right Approach:**
```go
// After writing code, ALWAYS trace through manually:

// Test case: [1, 2, 3, 4], target = 5
// i=0: num=1, complement=4, seen={}, not found, seen={1:0}
// i=1: num=2, complement=3, seen={1:0}, not found, seen={1:0, 2:1}
// i=2: num=3, complement=2, seen has 2 at index 1!
// Return [1, 2] ✓

// Also test edge cases:
// - Empty array: []
// - No solution: [1,2,3], target=10
// - Duplicate values: [3,3], target=6
```

### Pitfall 5: Panicking When Stuck

**Real Incident**: A Stripe candidate hit a wall on a graph problem and visibly shut down - stopped talking, looked stressed, and made no progress for 5 minutes. The interviewer couldn't help because they didn't know what the candidate was struggling with.

**The Wrong Approach:**
- Freeze and go silent
- Assume you've failed
- Give up on communication

**The Right Approach:**
```
When stuck, verbalize:

"I'm a bit stuck here. Let me think through what I know:
- The input is a graph represented as an adjacency list
- I need to find the shortest path
- BFS would give shortest path, but I'm not sure how to
  track the path itself...

Could I use a parent pointer map to reconstruct the path?
Let me try that approach..."

If still stuck:
"I'm not certain about X, could you give me a hint
on the direction to take?"
```

### Interview Pitfalls Quick Reference

| Pitfall | Red Flag Signal | What Interviewers Want |
|---------|-----------------|------------------------|
| No clarification | "Let me code this" | "What's the expected input size?" |
| Silent coding | 2+ minutes of silence | Continuous narration |
| Complexity ignorance | "Let me check... O(n?)..." | "This is O(n log n) because..." |
| No self-testing | "I think that works" | "Let me trace through test case..." |
| Panicking silently | Frozen, no communication | "I'm stuck on X, let me try Y" |
| Over-engineering | Complex patterns for simple problems | Clean, simple solutions first |

### Junior → FAANG: Pitfall Prevention Through Pre-Interview Rituals

Pitfalls are predictable, which means they are preventable with the right pre-interview habits. Before every practice session and before every real interview round, run through a mental checklist: will I clarify constraints before coding, will I state my algorithm before implementing, will I test with examples before claiming done, will I verbalize when stuck rather than going silent?

The clarification pitfall is the most costly for junior candidates because it costs time at both ends: time wasted solving the wrong problem, plus time spent backtracking when the interviewer reveals the constraint you missed. The solution is a standard set of clarification questions that takes 90 seconds to run through: "What are the input constraints? Can I assume the input is valid? Should I optimize for time or space? Is this a single-threaded context?"

First-job connection: these pitfalls also appear in sprint planning and code review. The engineer who starts coding before understanding requirements, or who submits a PR without testing, is applying interview-level habits to production work. Treating pitfall prevention as a career-long discipline rather than an interview-specific hack builds better engineering habits overall.

### Senior @ FAANG: Pitfall Awareness as Rubric Design Input

Senior candidates should internalize the pitfall table not as a self-help checklist but as a rubric. When you are sitting across the table as an interviewer (which senior engineers at FAANG do regularly), these pitfalls are exactly what you are grading for. Understanding the rubric from the interviewer's perspective makes you a better candidate and a better interviewer.

For L6 targets: the pitfall of "over-engineering" is particularly relevant because it becomes more tempting as you gain experience. A senior engineer knows many patterns and wants to apply them. The discipline is knowing when not to apply them. A bar-raiser interviewer explicitly looks for whether a senior candidate chooses the simplest correct solution rather than the most impressive one.

Governance implication: pitfall tables like the one in this section are the raw material of interview training for new interviewers at FAANG companies. If you can take this table, extend it with three pitfalls you have observed in real interviews, and explain the correct rubric response for each, you have demonstrated the kind of interview process ownership that is a direct signal of L7-level organizational contribution.

---
