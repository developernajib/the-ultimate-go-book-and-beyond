## Counterexample (45 seconds)
"Capacity: 50 kg
Items:
- Item A: weight 10, value 60 (ratio 6)
- Item B: weight 20, value 100 (ratio 5)
- Item C: weight 30, value 120 (ratio 4)

Greedy by ratio: A (10kg, value 60) + B (20kg, value 100) = total value 160
Optimal: B + C (50kg, total value 220)

Greedy fails because taking A prevents taking both B and C,
even though A has best ratio."

### Junior → FAANG: Reading Counterexamples as Proof of Incorrectness

Recognizing that a single counterexample is enough to disprove a greedy algorithm is a core interview skill. When an interviewer asks "does greedy work here?", the fastest path to correctness is to construct one small example where the greedy choice leads to a suboptimal outcome. For the 0/1 knapsack problem, the ratio-based counterexample above (items A, B, C with capacity 50) is worth memorizing because it covers the most common misconception: that fractional knapsack logic transfers to the discrete version. In your first job, you will encounter colleagues proposing greedy shortcuts for combinatorial problems. Your job is to think of a small break-case before the code ships.

### Senior @ FAANG: Counterexamples as Design Documentation and ADR Input

At the senior level, a counterexample is not just an interview technique but a form of design documentation. When a team proposes a heuristic for a scheduling, binpacking, or resource allocation problem, the senior engineer's responsibility is to produce a concrete adversarial instance and quantify the worst-case approximation ratio. For the 0/1 knapsack, greedy by ratio has an unbounded approximation gap in the worst case (a single high-ratio low-value item versus one high-value heavy item), which is relevant when the heuristic is being considered for a real system. Staff-level engineers write Architecture Decision Records that include a "failure modes" section containing exactly this kind of adversarial example, the input size at which the heuristic is acceptable, and the conditions under which the exact DP solution is warranted. At L6/L7, the bar-raiser question is: "What is the distribution of inputs this system will actually see, and does the greedy failure mode appear in that distribution?" If yes, the heuristic must be replaced or its output must be bounded by a post-processing exact solver on small subproblems.
