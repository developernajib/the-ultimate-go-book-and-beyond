## Fractional vs 0/1 (30 seconds)
"In fractional knapsack, we can take portions of items.
Greedy works: take highest value/weight ratio first.

In 0/1 knapsack, we take entire items or nothing.
Greedy fails because we might need to leave high-ratio
items to fit multiple lower-ratio items."

### Junior → FAANG: Making the Fractional vs. 0/1 Distinction Automatic

The distinction between fractional and 0/1 knapsack is the canonical example of the greedy choice property in action. Make it automatic by practicing the one-sentence contrast: "In fractional knapsack, I can always adjust how much of each item I take, so the greedy ratio choice is reversible. In 0/1 knapsack, taking an item is irreversible, so the greedy choice can foreclose a better combination."

Apply this reasoning to new problems: whenever items or resources can be taken in partial amounts, consider greedy with a ratio-based sort. Whenever items must be taken entirely or not at all, suspect DP.

The same hinge, divisibility, shows up under other names. Cutting a rod into pieces to maximize value is all-or-nothing at each cut point and needs DP. Subset sum and partition are 0/1 choices over items and need DP. Scheduling a set of jobs where each is taken whole is discrete, while allocating a continuously divisible budget across projects with linear returns is the fractional case and yields to a ratio sort.

Be wary of stretching the analogy past the point where it holds. Divisibility is not the only thing that can break greedy, and not every hard problem is hard for this reason. Coin change is a counterexample worth keeping in mind: nothing there is indivisible, and greedy still fails on non-canonical denominations. Diagnose the specific reason the exchange argument breaks rather than reaching for divisibility as a universal explanation.

### Senior @ FAANG: The Fractional-vs-Discrete Spectrum in Resource Allocation

The fractional/0-1 dichotomy is not binary in production systems. Real resource allocation problems exist on a spectrum between fully fractional (can take any amount) and fully discrete (must take the full item or nothing). Many production scenarios fall in between: can allocate CPU in increments of 0.1 cores (not truly fractional but not strictly discrete either), can assign tasks in batches of 10 (partially discrete), or must allocate network bandwidth in fixed channel sizes (discrete but multi-valued).

For resources that are nearly fractional (fine-grained allocation), greedy is a good approximation. For resources that are coarsely discrete (a small number of distinct sizes), DP or branch-and-bound is warranted. The staff engineer designing a resource allocator must determine where on this spectrum the resource falls, document the decision, and choose the algorithm accordingly.

The spectrum also changes over time. A system that started with coarsely discrete resource allocation (physical servers: you add or remove entire servers) may transition to fine-grained allocation (virtual machines, containers, pods) as virtualization matures. The algorithm selection must be revisited at each transition. An ADR documents these transitions, and the useful ADR names the measurement rather than asserting a number: "Switched from DP bin-packing to greedy ratio allocation when we moved from physical servers to containers, because container sizes are fine-grained enough that the greedy approximation error measured against our offline optimal solver stayed within the budget agreed with the platform team. See the linked benchmark for the observed distribution and the threshold at which we revisit this."
