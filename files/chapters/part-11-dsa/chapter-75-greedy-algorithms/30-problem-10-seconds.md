## Problem (10 seconds)
"Find minimum conference rooms needed to hold all meetings."

### Junior → FAANG: The 10-Second Frame Is Not Just Speed

Stating the problem in 10 seconds forces you to identify the one-sentence essence of what the problem is asking. For Meeting Rooms II, the essence is "minimize concurrent resources needed to handle a set of intervals." This framing immediately generalizes: the same algorithm applies to any resource-constraint problem where the resource pool size must match the maximum concurrent demand.

Practice this reframing exercise for all problems you study: reduce the problem to a one-sentence "find [objective] given [input] subject to [constraint]." For gas station: "find a starting index such that a circular traversal with cumulative resources never goes negative." For candy: "find the minimum total candies such that the ordering constraint is satisfied in both directions." These one-sentence frames are both interview signals and thinking tools.

The 10-second budget is a discipline: if you cannot state the problem in 10 seconds, you have not understood it yet. Spend more time on problem understanding before moving to strategy.

### Senior @ FAANG: Problem Statement Clarity as a Team Communication Standard

At the staff level, the 10-second problem statement is the executive summary of a design document. It must be precise enough to reject incorrect solutions and broad enough to admit all valid ones. "Minimize the number of conference rooms needed" is precise (minimize, not reduce or limit) and broad (does not prescribe the algorithm).

In architecture reviews, the problem statement section is the first thing a senior reviewer checks. If it is ambiguous, the review stops there. Common ambiguities: does "minimize" mean globally optimal or approximately optimal? Does "meetings" include meetings with zero duration? Does "rooms" have any type constraint (e.g., some rooms accommodate 10 people, others 100)? Each ambiguity is a potential source of implementation mismatch, and resolving it before design begins is always cheaper than after.

The practice of writing a clean, one-sentence problem statement is a staff-level communication discipline that transfers to meeting agendas, incident summaries, and product requirement documents. Engineers who can state a problem crisply in one sentence are universally valued across technical and non-technical contexts.
