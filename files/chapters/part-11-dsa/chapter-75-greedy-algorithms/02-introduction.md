## Overview

Greedy algorithms make locally optimal choices at each step, hoping to find a global optimum. While they don't always produce optimal solutions, when they do, they're often simpler and more efficient than dynamic programming.

To understand the core idea, consider making change for a dollar amount using the fewest coins. If you always pick the largest coin that fits, you are using a greedy strategy. This works for standard US coin denominations because each coin value is a multiple of the smaller ones, but it does not work for every set of coin values. The diagram below walks through this example and highlights the two properties every greedy problem must satisfy: the greedy choice property (picking the locally best option is safe) and optimal substructure (solving the remaining subproblem optimally still gives the overall optimum).

```
┌─────────────────────────────────────────────────────────────────┐
│                    GREEDY ALGORITHM CONCEPT                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Problem: Make change for 67 cents with minimum coins           │
│  Coins: 25, 10, 5, 1                                            │
│                                                                 │
│  Greedy approach: Always pick largest coin that fits            │
│                                                                 │
│  67 cents remaining → pick 25 → 42 remaining                    │
│  42 cents remaining → pick 25 → 17 remaining                    │
│  17 cents remaining → pick 10 → 7 remaining                     │
│  7 cents remaining  → pick 5  → 2 remaining                     │
│  2 cents remaining  → pick 1  → 1 remaining                     │
│  1 cent remaining   → pick 1  → 0 remaining                     │
│                                                                 │
│  Result: 25 + 25 + 10 + 5 + 1 + 1 = 6 coins ✓                   │
│                                                                 │
│  Two Key Properties for Greedy to Work:                         │
│                                                                 │
│  1. GREEDY CHOICE PROPERTY                                      │
│     Making locally optimal choice leads to global optimum       │
│                                                                 │
│  2. OPTIMAL SUBSTRUCTURE                                        │
│     Optimal solution contains optimal solutions to subproblems  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Internalizing the Two Properties Before Writing Code

The coin-change diagram is the canonical teaching example because the failure mode is concrete. Most junior engineers stop at "greedy sometimes works" without building intuition for when it does not. A productive exercise: before every new greedy problem, write two sentences on paper. First, state the greedy choice. Second, state why making that choice cannot prevent a better overall solution. If you cannot write the second sentence confidently, you do not yet have a greedy solution. You have a guess.

For the coin-change example specifically, the second sentence is: "Picking the largest coin that fits cannot hurt me because every remaining amount is still achievable with smaller coins, and the denominations are structured so no smaller combination can ever do better than the largest coin I could take." That structure breaks for arbitrary denominations, which is exactly when to switch to DP.

In interviews, demonstrating this two-sentence check before coding signals disciplined thinking. Most candidates jump straight to code. Pausing to state the greedy invariant aloud takes 15 seconds and dramatically reduces the chance of coding the wrong algorithm.

### Senior @ FAANG: Optimal Substructure as a System Design Requirement

The two properties in this diagram are not just algorithm theory. They are requirements that a greedy system component imposes on the rest of the system. In a production environment, the "greedy choice property" is a claim about the input distribution, and "optimal substructure" is a claim about problem decomposition. Both claims need to be validated, not assumed.

Mature infrastructure scheduling systems document the input invariants that make their greedy schedulers correct. For example, a bin-packing scheduler that greedily places the largest job first (First Fit Decreasing) assumes that job sizes are known up front and stay fixed for the cycle. If a product team introduces dynamically resizing jobs, that assumption breaks, and the greedy placement is no longer within its proven bound. The staff engineer's responsibility is to enforce the invariant at the API boundary, reject inputs that violate it, and have a tested fallback.

The maturity gap between junior and senior on this concept: juniors verify the greedy property on the problem statement. Seniors verify it on the actual data distribution in production, using histograms of input characteristics, and re-verify it when the input distribution shifts (new traffic patterns, new product features, new client types). The coin-change example illustrates this well. US denominations happen to be canonical, so greedy is safe, but that is a property of the specific value set and not something greedy earns for free. Add a 20-cent coin to the set and greedy silently starts returning wrong answers: for 40 cents it takes 25 + 10 + 5 for three coins, while 20 + 20 needs only two. Nothing fails to compile and no existing test necessarily notices, because the code still returns a valid way to make change. It just is not the minimal one. Worth checking by hand: adding a 3-cent coin instead leaves the system canonical, so intuition about which additions are dangerous is unreliable. Verify with a brute force over the reachable amount range rather than by eye.
