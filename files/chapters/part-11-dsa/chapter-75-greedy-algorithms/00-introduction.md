# Chapter 75: Greedy Algorithms

> *"A greedy algorithm always makes the choice that looks best at the moment."*
> - Thomas H. Cormen, Introduction to Algorithms

Greedy algorithms are among the most elegant constructs in computer science: at each decision point, make the locally optimal choice and never look back. When a problem has the "greedy choice property", where a locally optimal choice can always be extended to a global optimum, greedy algorithms produce correct results in far less time than dynamic programming or backtracking. The challenge, and the skill that separates candidates at FAANG interviews, is knowing when the greedy property holds and being able to prove it, even informally, during a coding interview. Choosing greedy when it does not apply yields incorrect solutions, and missing it when it does apply yields unnecessarily complex ones.

Go's standard library and language features are well-suited to greedy implementations. `slices.SortFunc` lets you order data by any criterion in O(n log n), which is the foundation of most interval-based greedy problems. Go's value semantics encourage the clean, imperative style that greedy algorithms naturally inhabit: no complex recursive state, no memoization tables, just a sorted traversal with a running decision variable. This simplicity makes greedy solutions in Go easy to trace through in an interview setting, which matters when an interviewer asks you to walk through your code.

This chapter covers the canonical greedy problem families: interval scheduling (activity selection, meeting rooms, non-overlapping intervals), jump game variants, partition problems, gas station, task scheduling with cooldowns, candy and assignment problems, greedy string construction, Huffman encoding, and fractional knapsack. For each family, you will learn the greedy criterion, the correctness argument (exchange argument or inductive proof sketch), the Go implementation, and the complexity analysis. Critically, you will also study the counter-examples, problems that look greedy but require DP, building the judgment to choose the right approach quickly. The greedy graph algorithms (Dijkstra, Prim, Kruskal) are built in Chapter 72 and are referenced here only as examples of the same proof technique applied to graphs.

**What you'll learn in this chapter:**

- Identifying the greedy choice property and optimal substructure that make a problem greedy-solvable
- Implementing interval scheduling algorithms: activity selection, merge intervals, minimum meeting rooms
- Solving jump game I and II, gas station, and candy distribution with greedy proofs
- Applying greedy task scheduling with CPU cooldown constraints using frequency-based ordering
- Constructing Huffman trees for optimal prefix-free encoding
- Solving fractional knapsack by value density, and seeing why the same approach fails on 0/1 knapsack
- Distinguishing greedy-solvable problems from DP-required problems using exchange argument reasoning

**Why this matters in interviews:**

Greedy problems are a regular fixture in FAANG rounds, often as the "medium" problem in an onsite loop where the interviewer is checking fluency and speed. The trap is that greedy problems frequently look like DP problems at first glance, and candidates who default to DP for every optimization problem spend precious minutes on unnecessary complexity. Interval scheduling and jump-game variants are common enough across companies that you should be able to write them without hesitation. The ability to say "I think greedy works here because of the exchange argument: if we swap any locally suboptimal choice for the greedy choice, the solution only improves" is exactly the signal top-band interviewers are listening for.

**Prerequisites:** Chapter 66 (Arrays and Strings), Chapter 71 (Heaps and Priority Queues), Chapter 73 (Dynamic Programming, to understand when greedy does not suffice), and comfort with `slices.SortFunc` in Go.

---

### Junior → FAANG: Building the Greedy Mental Model From Scratch

Many early-career engineers treat algorithm selection as pattern matching: "this looks like a graph problem, use BFS." Greedy is especially dangerous with that mindset because it looks deceptively simple. The first habit to build is asking "why does the greedy choice not hurt me later?" before writing any code.

A useful exercise: take the coin-change example from this introduction and work through three different coin systems by hand. Standard US coins (1, 5, 10, 25) work. Coins (1, 3, 4) fail for amount 6. Coins (1, 6, 9) fail for amount 12. Writing these counterexamples in a notebook and articulating exactly where greedy breaks teaches the greedy choice property faster than reading definitions.

For entry-level interviews, the bar is: identify the problem family (interval, assignment, sequence), state the sort criterion, code it cleanly, and name one edge case. Saying "I sort by end time because finishing earliest leaves maximum room for future activities" is the signal interviewers want. That is the exchange argument in plain English, and it is enough at the L3-L4 bar.

Go-specific habit: prefer `slices.SortFunc` over `sort.Slice`. It is generic and type-safe, so the comparator receives real element values instead of indices, and it avoids the reflection-based swapping that `sort.Slice` performs internally. Use `cmp.Compare` inside the comparator rather than returning `a - b`, which overflows on extreme values. Knowing this preference signals Go fluency in an interview.

### Senior @ FAANG: Greedy as an Engineering Discipline, Not Just an Interview Trick

At the staff and senior principal level, the conversation around greedy algorithms shifts from "can I prove this works on a whiteboard" to "is the greedy assumption still valid as the system evolves, and who owns the proof."

**Correctness ownership and ADRs.** A greedy scheduling algorithm embedded in a distributed system is a correctness claim, and that claim needs documentation. The failure mode is well known in cluster scheduling: a scheduler is written against an assumption about its inputs (say, that task resource requests are fixed at admission time), a different team later relaxes the policy that guaranteed the assumption, and the scheduler keeps running while quietly no longer being optimal. Nothing crashes, so nothing pages. An Architecture Decision Record that names the invariant gives the second team something to trip over. Build this habit: whenever you ship a greedy algorithm, write down the invariant that makes it correct in a comment block or ADR.

**Maturity model for greedy in production.** Level 1 is "greedy works in testing." Level 2 is "greedy has a proof sketch in the code review." Level 3 is "greedy has a counterexample test that would catch future regressions if the input distribution changes." Level 4 is "the system monitors the metric that the greedy optimizes and alerts if observed outcomes diverge from theoretical bounds." Most production greedy code lives at level 1. Senior engineers push to level 3. Staff engineers build the level 4 feedback loop.

**Platform thinking.** When greedy is embedded in a shared platform (a scheduling service, a load balancer, a data placement system), the input assumptions that make greedy correct are often violated by upstream teams without realizing it. The senior engineer's job is to make those assumptions explicit at the API boundary. For example, a job scheduler that greedily assigns tasks by earliest deadline first is only optimal if all tasks have independent deadlines. If two tasks share a deadline dependency, the greedy property breaks. Encoding that constraint as a type (a `DependencyGraph` that cannot be nil) rather than documentation makes the assumption machine-checkable.

**Bar-raiser signals at L6/L7.** The bar-raiser question is not "does greedy work here?" It is "how do you know greedy is still correct six months from now when the product requirements change?" A strong L6 answer addresses: what invariant is assumed, how is that invariant verified in CI, what monitoring detects when it is violated in production, and what the fallback is when it is violated (switch to DP, alert on-call, or reject the input). The ability to frame a greedy algorithm as a contract between the algorithm and its input distribution is the L7 signal.
