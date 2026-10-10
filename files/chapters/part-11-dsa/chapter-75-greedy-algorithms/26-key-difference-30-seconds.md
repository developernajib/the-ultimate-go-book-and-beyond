## Key Difference (30 seconds)
"Both require optimal substructure, but greedy also needs
the greedy choice property: a locally optimal choice can
always be extended to a global optimum.

DP is needed when current choices affect future choices
in ways that can't be predicted locally."

### Junior → FAANG: Memorizing the Key Difference With a Concrete Anchor

The abstract definition of the greedy choice property is hard to recall under interview pressure. Anchor it to a concrete contrast: fractional knapsack (greedy works) versus 0/1 knapsack (DP required). In fractional knapsack, taking part of an item now does not prevent you from taking any other item later (you can always take less of a lower-ratio item to fit). In 0/1 knapsack, taking an item now consumes capacity that might have been better used for a combination of smaller items you cannot foresee locally.

Say this contrast in one sentence when asked to distinguish greedy from DP: "In fractional knapsack, my choice of how much item to take does not foreclose better future choices because I can always adjust. In 0/1 knapsack, my choice to take or skip an item is irreversible and can foreclose the optimal combination." That is the greedy choice property failure in plain English.

The "affects future choices in ways that can't be predicted locally" phrasing is the definition you should use in interviews. It is more precise than "greedy sometimes works" and more memorable than the formal definition.

### Senior @ FAANG: Greedy Choice Property as a System Invariant

In distributed system design, the greedy choice property is a system invariant, not just an algorithm property. A greedy scheduling decision (assign this task to this server) affects future scheduling decisions (that server now has less capacity). The greedy choice property holds if and only if this capacity reduction never causes the system to make a globally suboptimal assignment.

The invariant fails in several production scenarios: resource pools with non-linear scaling costs (assigning a large task that fills a server to 90% capacity prevents three small tasks that would have collectively used less power), correlated demand patterns (assigning all tasks of type A to the same server creates a hot spot when type A demand spikes), and cross-resource dependencies (a task requires both CPU and network bandwidth, greedy on CPU may produce a network bottleneck).

Staff engineers identify these failure modes during design review by asking: "Is the greedy choice here based on complete local information, or does it ignore future demand patterns that are predictable from historical data?" If the latter, a look-ahead heuristic or DP-based online algorithm is warranted. The decision between greedy and look-ahead is documented in the ADR with a reference to the load tests or production data that motivated the choice.
