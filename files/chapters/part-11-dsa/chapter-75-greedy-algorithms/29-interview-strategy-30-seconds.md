## Interview Strategy (30 seconds)
"When given a problem, I first try to think of a greedy
solution. If I can't prove it works or find a counterexample,
I move to DP. Sometimes I mention both approaches to show
I understand the tradeoffs."

---

### Junior → FAANG: Executing the Strategy Under Interview Conditions

The strategy stated here is correct. The challenge is executing it under time pressure. Build a time budget: 30-60 seconds to attempt the greedy approach and test it with one counterexample, then commit to greedy or pivot to DP. Do not spend more than 60 seconds on the greedy-or-DP decision. If you cannot decide in 60 seconds, default to DP and optimize later if the interviewer asks.

Be careful with the reasoning behind that default, though, because the tempting version of it is false. DP is not "always correct." A DP is correct when the problem has optimal substructure and you write the recurrence properly, and neither is automatic. What makes DP the safer default is narrower and worth stating accurately: it explores choices you would otherwise have to prove unnecessary, so it fails safe where greedy fails silently. Being wrong about a recurrence usually produces an obviously wrong answer. Being wrong about the greedy choice property produces a plausible one.

"Sometimes I mention both approaches" is a good habit that requires discipline. Mention both in one sentence, state the trade-off honestly (greedy is O(n log n) and simpler *if* the exchange argument holds, DP costs more time and space but does not depend on that argument), and ask the interviewer which to code. Resist assigning DP a fixed complexity like O(n^2): it depends entirely on the recurrence, and weighted interval scheduling is O(n log n) DP, no worse than the greedy it replaces. Coding both approaches unprompted wastes time.

One underrated skill: knowing when to ask the interviewer for a hint. If you have spent 60 seconds on the greedy-or-DP decision and are genuinely stuck, saying "I am trying to find a counterexample for the greedy approach but cannot. Can you tell me whether greedy is applicable here, or should I proceed with DP?" is not a weakness. It is efficient communication and respects the interviewer's time.

### Senior @ FAANG: Algorithm Strategy as an Engineering Decision Process

The interview strategy described here (try greedy, prove or disprove, fall back to DP) is a compressed version of the algorithm selection process that staff engineers run on production problems. The production version has more steps and a longer time horizon, but the core logic is identical: attempt the simplest correct algorithm, verify its correctness on your specific problem instance, and upgrade to a more complex algorithm only if necessary.

Simplicity first is the working rule at every serious engineering organization: prefer the algorithm with the fewest moving parts that meets the correctness and performance requirements. Greedy algorithms have fewer moving parts than DP (no table, no memoization, no state explosion), so they are preferred when both are correct.

The staff-level extension of "sometimes mention both approaches" is "document the algorithm selection decision in the design doc, including the alternatives considered and why the chosen approach dominates." This documentation becomes the team's shared memory of the decision and prevents re-litigating it every time a new engineer reviews the code. The decision should include: the performance requirements that guided the choice, the proof sketch that validates the choice, the counterexamples that were tested, and the conditions under which the choice should be revisited (e.g., if n grows beyond 10^6, switch to the approximate greedy instead of exact DP).

### Question 3: "Solve the meeting rooms II problem and explain your approach."

**What Interviewers Look For:**
- Problem decomposition
- Multiple solution approaches
- Time/space tradeoff analysis
- Clean code

**Strong Answer Framework:**

Meeting Rooms II rewards showing two solutions, because the two are genuinely different ideas that land on the same complexity. Restate the problem, present the two-array sweep, present the min-heap, then compare them honestly. The sections that follow do exactly that.

| Move | Budget | The point |
|------|--------|-----------|
| Problem | 10 seconds | The answer is the maximum number of meetings concurrent at any instant |
| Approach 1: two arrays | 45 seconds | Sort starts and ends separately, sweep with two pointers |
| Approach 2: min-heap | 45 seconds | Heap of end times, its size is the room count |
| Complexity comparison | 30 seconds | Both O(n log n). Say which you would ship and why |

The reframing in the first move is what unlocks the problem. Candidates who keep thinking in terms of "assigning meetings to rooms" write far more code than candidates who notice that no assignment is required, only a count of overlaps.
