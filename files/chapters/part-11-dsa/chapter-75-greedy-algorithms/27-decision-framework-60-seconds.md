## Decision Framework (60 seconds)
"I ask these questions:

1. **Does local optimum guarantee global optimum?**
   If yes → Greedy might work
   If no → Need DP

2. **Do I need to explore multiple choices?**
   If I can commit to one choice without regret → Greedy
   If I might need to backtrack conceptually → DP

3. **Can I prove greedy choice property?**
   If I can construct exchange argument → Greedy
   If counterexample exists → DP"

### Junior → FAANG: Applying the Decision Framework in Real Time

The three-question framework in this section is powerful, but it requires practice to apply in under 60 seconds. Run through it on 10 different problems until it becomes automatic. For each problem, write down your answers before looking at the solution. Track your success rate. If you are getting the third question wrong (claiming greedy works when it does not), focus on generating counterexamples: pick three inputs where greedy makes a locally suboptimal choice and trace the outcome.

The exchange argument in question 3 is the hardest to construct quickly. A shortcut: the exchange argument for greedy always has the form "if optimal solution O uses choice B at this step instead of greedy choice A, we can swap B for A and the solution does not get worse." If you cannot see why "does not get worse" is true, the greedy choice property probably does not hold and you should consider DP.

For interview practice, work through the decision framework on these pairs: (activity selection, weighted interval scheduling), (fractional knapsack, 0/1 knapsack), (Dijkstra on non-negative weights, Bellman-Ford on negative weights). Each pair isolates exactly one condition that makes the easier version greedy-solvable and the harder version not.

### Senior @ FAANG: Decision Frameworks as Organizational Knowledge

This three-question decision framework is a compact decision tree for individual problem solving. At the organizational level, it scales into a more elaborate algorithm selection process that is documented, versioned, and shared across teams.

A well-run team's guidelines for scheduling systems will encode the same structure as a selection checklist: does the problem have optimal substructure? Is the input distribution known to satisfy the greedy choice property, and known by what evidence? Are there counterexamples in our historical data? The useful version of such a checklist attaches a tool to each question rather than leaving it as a prompt for reflection, so the exchange-argument question comes with a template and the counterexample question comes with a script that fuzzes small inputs against a brute force. A question with no tool attached gets answered from memory, which is the failure mode the checklist was supposed to prevent.

Building this organizational knowledge is a staff-level investment. The payoff is not just avoiding algorithm selection errors on new systems: it is creating a shared vocabulary that makes cross-team design reviews more efficient. When two teams use the same framework to evaluate a proposal, they can communicate about its correctness in minutes rather than reconstructing the analysis from scratch.

The framework also enables post-incident analysis. When a production system produces suboptimal results, the first question is: "Is the greedy choice property still satisfied for the current input distribution?" If the answer is no (because the traffic pattern shifted), the fix is to re-evaluate the algorithm selection decision, not just to patch the implementation. Framing the incident this way (algorithm selection failure rather than implementation bug) leads to more durable fixes.
