## Summary

- **Greedy algorithms** make locally optimal choices hoping for global optimum
- **Key properties**: greedy choice property + optimal substructure
- **Interval problems**: usually sort by end time
- **Two-pass technique**: left-to-right then right-to-left (candy, water)
- **Greedy fails** when local optimum doesn't lead to global optimum
- Always **verify greedy works** by checking properties or counterexamples
- When greedy fails, consider **dynamic programming**

Greedy algorithms are elegant when they work. The key skill is recognizing when greedy is applicable and proving (or disproving) correctness.

### Junior → FAANG: Consolidating Greedy into Interview-Ready Mental Models

After completing this chapter, the consolidation exercise is to pick five canonical problems (Activity Selection, Jump Game, Candy, Gas Station, Task Scheduler) and, for each one, write down in one sentence the greedy choice and why the exchange argument holds. Being able to articulate the proof sketch verbally, without code, is what separates candidates who can pattern-match from candidates who understand. Interviewers notice the difference within the first 3 minutes of problem discussion. Knowing the two-pass trick (left-to-right then right-to-left) for problems with bidirectional constraints is worth a separate mental note: Candy and the elevation-trap-water problems use this pattern.

### Senior @ FAANG: Greedy Algorithms as the Foundation for Approximation Algorithms in Production

The summary captures the conceptual divide between greedy and DP, but the senior-level extension is understanding how greedy algorithms form the basis of approximation algorithms with provable bounds. Unweighted interval scheduling's greedy is exactly optimal, a ratio of 1. Greedy set cover achieves a ln(n) approximation, and that is essentially the best any polynomial algorithm can do unless complexity theory collapses, so the gap is not an artifact of the algorithm being lazy.

One claim in this family deserves care, because the names collide and the chapter has already contradicted the careless version. Job sequencing with deadlines, where every job takes unit time and carries a profit, *is* solved optimally by greedy: sort by profit descending and schedule each job in the latest free slot before its deadline. That is not luck. The feasible job sets form a matroid, and greedy is provably optimal on any matroid, which is the deepest available answer to "why does greedy work here." Weighted *interval* scheduling, where jobs occupy fixed intervals and carry weights, is a different problem and greedy is simply wrong on it. Section 75.16 gives the counterexample. Same word, "weighted", opposite conclusions. When you catch yourself about to say "the greedy for weighted scheduling is optimal", stop and name which problem you mean.

These results matter in production because they determine how much headroom exists between what the heuristic delivers and the theoretical best, which informs SLO setting, capacity planning, and the decision to invest engineering time in a better solver. At L6/L7, the ownership question is: "Who is responsible for the approximation ratio of the optimizer powering this business metric?" If no one owns that number, the system is running an unmonitored approximation with unknown drift. Staff engineers close this gap by defining the approximation quality metric, adding it to the team's observability dashboard, and setting an alert threshold that triggers an engineering review when the empirical gap degrades. This turns "greedy algorithm" from a textbook concept into a live production accountability.
