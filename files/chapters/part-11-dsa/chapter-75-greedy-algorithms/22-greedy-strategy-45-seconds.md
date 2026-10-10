## Greedy Strategy (45 seconds)
"The key insight is: we should pick activities that finish
earliest. Why? An activity that ends early leaves maximum
time for remaining activities.

Greedy choice: Always select the activity with earliest end
time that doesn't conflict with already selected activities."

### Junior → FAANG: Stating the Greedy Choice With Precision

The greedy strategy section is where many candidates are imprecise. "Pick the one that finishes earliest" is correct but incomplete. The full statement must include both the choice and the constraint: "Pick the activity with the earliest end time that does not conflict with the previously selected activity." Without the constraint, the statement does not define a complete algorithm.

Practice stating greedy strategies as "pick [X] subject to [constraint]" for every greedy problem you study. For gas station: "advance to the next station, resetting the candidate start whenever the running tank drops below zero." For candy: "assign each child the minimum candies that satisfy the left-neighbor constraint in the first pass, then correct for the right-neighbor constraint in the second pass."

Do not mistake the "subject to" clause for the greedy choice property. They are different things, and conflating them is how candidates end up confidently wrong. The "subject to" clause is a feasibility condition: it says which choices are legal. The greedy choice property is a separate claim entirely: that taking the locally best legal choice never costs you the global optimum. Feasibility is cheap and mechanical. The property is the part that needs a proof. A wrong greedy algorithm usually has a perfectly correct "subject to" clause, which is exactly what makes it convincing. Sorting activities by shortest duration "subject to no conflict with the last selection" is a well-formed, entirely feasible, entirely wrong algorithm. State both, and know which one you still owe an argument for.

Interviewers notice when candidates state the greedy strategy precisely versus vaguely. Precision signals that you have worked through the algorithm, not just recalled a pattern.

### Senior @ FAANG: Greedy Strategy as a Design Principle in Architecture Documents

In architecture documents and design reviews, the greedy strategy statement is the equivalent of the algorithm's "key insight" in an interview. It is the one sentence that, if wrong, makes the entire design incorrect.

For a distributed task scheduler, the greedy strategy might be stated as: "Assign each incoming task to the server with the most available CPU capacity at assignment time, subject to the constraint that the task's memory requirement does not exceed the server's available memory." This statement must appear verbatim in the design document, in the code as a comment, and in the test case that validates the scheduler on adversarial inputs. If any of these three locations says something different, there is a gap.

Staff engineers review design documents specifically looking for the greedy choice statement. If it is absent, the design is incomplete. If it is present but unproven, the design is risky. If it is present, proven with an exchange argument or reference to prior art, and validated by a counterexample test, the design is sound. Building this review checklist into the team's design review template is a governance investment.
