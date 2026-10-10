## 75.16 Interview Questions: Greedy Algorithms

### Question 1: "Walk me through how you would solve the activity selection problem."

**What Interviewers Look For:**
- Understanding of greedy strategy
- Ability to prove correctness
- Clean implementation
- Handling of edge cases

**Strong Answer Framework:**

A strong answer to this question has five parts, delivered in this order and roughly to this budget. The sections that follow work through each one for activity selection.

| Part | Budget | What you are demonstrating |
|------|--------|----------------------------|
| Problem understanding | 30 seconds | You are solving the problem asked, and you surfaced the ambiguities |
| Greedy strategy | 45 seconds | You can name the greedy choice and the sort key |
| Proof of correctness | 45 seconds | The exchange argument, stated plainly |
| Implementation | 30 seconds | Clean code, correct boundary conditions |
| Edge cases | 30 seconds | Empty, single, all overlapping, none overlapping |

The budgets add up to about three minutes, which leaves the rest of the slot for follow-ups. Nothing here rewards rushing. The point of the budget is that each part is short enough to say out loud, so skipping one is a choice rather than an accident.

### Junior → FAANG: Delivering a Structured Answer Under Time Pressure

The framework structure in this section (problem understanding, greedy strategy, proof of correctness, implementation, edge cases) is the optimal interview answer template for greedy problems. Each section has a time budget, and staying within the budget is part of the signal. Interviewers at FAANG are evaluating not just correctness but communication efficiency.

The hardest part for most junior candidates is the proof of correctness section. Many skip it or give a vague hand-wave ("it's obvious that finishing earliest is best"). A concrete exchange argument is not hard to deliver: "If the optimal solution does not start with the earliest-ending activity, we can swap the first activity for the earliest-ending one. Since the earliest-ending activity ends no later than the swapped one, all subsequent activities that were compatible before are still compatible. So the swap does not reduce the solution size." Practice saying this in under 30 seconds.

Building the habit of stating this framework before coding is a first-job skill. Many junior engineers code first and explain later, which leads to debugging in an interview rather than communicating. Flip the order: state the framework, confirm with the interviewer, then code.

### Senior @ FAANG: The Framework as an Interview Calibration Tool

This framework is also useful as a calibration rubric for bar-raisers. An L4 candidate delivers all five sections correctly. An L5 candidate delivers all five sections, handles ambiguous edge cases unprompted, and proposes an alternative approach. An L6 candidate does all of the above and extends the problem to a harder variant before the interviewer asks.

For activity selection, the L6 extension is: "This gives the maximum count of non-overlapping activities. What if activities have weights and you want maximum weight?" Now greedy fails, and the candidate transitions cleanly to weighted interval scheduling DP. Sort by end time, then for each activity choose between taking it and skipping it:

`dp[i] = max(dp[i-1], w[i] + dp[p(i)])`

where `p(i)` is the last activity ending at or before activity `i` starts. Both branches matter. Drop the `dp[i-1]` term and the recurrence forces every activity into the solution, which is a different and wrong problem. Finding `p(i)` by binary search over the sorted end times keeps the whole thing at O(n log n), the same complexity as the greedy version, which is a satisfying note to land on: the DP costs no more asymptotically, and it is correct for weights where greedy is not.

A concrete counterexample is worth having ready, since it takes ten seconds and settles the question. Activities [0,10] with weight 100, [0,3] with weight 1, and [4,10] with weight 1: earliest-finish-time greedy takes the two cheap ones for a total of 2, while the single heavy activity is worth 100.

The bar-raiser is also evaluating whether the candidate's proof of correctness is rigorous or performative. A performative proof ("it's greedy, it obviously works") is a yellow flag. A rigorous proof with the exchange argument is green. A proof that includes discussion of when the exchange argument fails (if activities had arbitrary weights) is blue: it shows the candidate understands the limits of the argument, not just the argument itself.
