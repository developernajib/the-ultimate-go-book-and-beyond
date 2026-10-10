## Exercises

### Exercise 83C.1: Solo Coding Mock (45 minutes)

Set a timer for 45 minutes. Solve this problem without looking ahead:

**Problem:** Given a stream of integers, design a data structure that supports:
- `Add(num int)` - adds a number to the data structure
- `FindMedian() float64` - returns the median of all numbers added so far

Implement in Go using `container/heap`. After completing (or when time expires), score yourself using the Coding Scorecard.

### Exercise 83C.2: Peer System Design Mock (45 minutes)

Find a practice partner. One person plays interviewer with this prompt: "Design a distributed file storage system like Google Drive. Focus on file upload/download, sharing, and conflict resolution for simultaneous edits." The other person drives the design. After 45 minutes, switch roles with a different problem. Score each other using the System Design Scorecard.

### Exercise 83C.3: Behavioral Story Bank

Write out 15 STAR-format stories from your career covering these themes:
1. Technical leadership
2. Conflict resolution
3. Failure and recovery
4. Cross-team collaboration
5. Mentoring
6. Delivering under pressure
7. Simplifying complexity
8. Disagreeing with leadership
9. Customer/user impact
10. Learning something new
11. Raising engineering quality
12. Making a difficult trade-off
13. Owning a mistake
14. Earning trust
15. Long-term thinking

Practice delivering each story in under 3 minutes. Record yourself and review for clarity, specificity, and conciseness.

### Exercise 83C.4: Go Concurrency Challenge (30 minutes)

Implement a pipeline pattern where three stages process data concurrently:
- Stage 1: Generate numbers 1 through 1000
- Stage 2: Square each number (use 4 worker goroutines)
- Stage 3: Filter to keep only numbers divisible by 7

Use channels to connect stages, a WaitGroup for the worker pool, and context for cancellation. Score yourself on correctness, race-condition safety, and idiomatic Go style.

### Exercise 83C.5: Full Loop Simulation (4 hours)

Block out 4 hours and simulate a complete onsite loop:
- Hour 1: Coding interview (use Mock Interview 1 or 3)
- Hour 2: System design interview (use Mock Interview 6 or 7)
- Hour 3: Behavioral interview (use questions from Sections 83C.9 and 83C.10)
- Hour 4: Go deep dive (use Section 83C.11)

Take a 10-minute break between each hour. Score yourself after each interview. Calculate your Overall Readiness Assessment at the end.

### Exercise 83C.6: Post-Interview Reflection

After your next real interview (or full mock loop), write a structured reflection:
1. What went well? (Be specific - which problems, which stories, which design choices)
2. What went poorly? (Be honest - where did you get stuck, what did you skip, what was unclear)
3. What surprised you? (Questions you didn't expect, areas where your preparation gaps showed)
4. What will you practice differently? (Specific changes to your preparation routine)

This reflection is more valuable than any additional LeetCode problem.


### Junior → FAANG: Mock Interview Practice Exercises

The most effective practice exercises for mock interviews are full-length simulations with a real interviewer rather than solo practice. If you cannot access a human mock interviewer, the next best option is to record yourself on video and review the recording: watch for filler phrases, long silences, mumbling, and answers that sound uncertain or rushed. The specific exercises in this section cover coding, system design, and behavioral dimensions. Complete them in the order listed, using a timer for each.

### Senior @ FAANG: Exercises as a Structured Gap-Closing Protocol

Senior candidates should use the exercises in this section as a gap-closing protocol rather than a general warm-up. Before starting, identify your lowest-scoring scorecard dimension from recent mocks, and set the specific objective that this exercise session will address. After completing the exercise, evaluate whether the objective was met and identify the next step. This iteration model is more efficient than repeatedly practicing the same type of exercise at which you are already proficient.

---
