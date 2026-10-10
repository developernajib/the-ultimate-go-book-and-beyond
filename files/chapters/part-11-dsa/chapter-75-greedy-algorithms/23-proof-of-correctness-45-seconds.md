## Proof of Correctness (45 seconds)
"Let me prove this works:

1. **Greedy choice property**: If we have an optimal solution
   that doesn't start with the earliest-ending activity A,
   we can replace its first activity with A without losing
   optimality (A ends earlier, so subsequent activities fit).

2. **Optimal substructure**: After choosing A, the remaining
   problem (activities starting after A ends) is a smaller
   instance of the same problem."

### Junior → FAANG: Delivering a Proof Under Pressure

The exchange argument proof in this section is the minimum viable correctness argument for a FAANG interview. Do not try to produce a formal mathematical proof. Aim for a rigorous informal argument. The structure is always: assume an optimal solution that differs from greedy, show that you can swap a greedy choice in without losing optimality, conclude that the greedy solution is therefore optimal.

Write this argument out for activity selection five times by hand until you can deliver it from memory in 45 seconds. Then practice delivering it verbally while looking at the interviewer, not at the whiteboard. The ability to prove correctness while maintaining eye contact signals deep understanding.

If the interviewer pushes back ("but what if the earliest-ending activity conflicts with a later one that would let us select two more?"), you need a second layer of the argument: "That cannot happen. If replacing my greedy choice with another activity allows two more selections, then those two extra activities must start after the replacement ends. But the replacement ends later than the greedy choice, so those two activities also start after the greedy choice ends, which means they were already available to us when we made the greedy choice." This is the key insight and is worth memorizing.

### Senior @ FAANG: Proof Culture as a Team Practice

On teams that take algorithm design seriously, a correctness argument is a standard component of the design document, playing much the same role as a threat model does in a security review. The proof does not need to be a formal mathematical derivation. It needs to be a rigorous informal argument that a peer engineer can verify in a code review.

The exchange argument is the most common proof technique for greedy algorithms, and training teams to write it correctly is a staff-level responsibility. A staff engineer running a tech talk on greedy algorithms at their company does not just show the code: they walk through the exchange argument, explain why it is sufficient (it shows that the greedy solution is at least as good as any other solution), and give examples of problems where the argument fails (0/1 knapsack), explaining exactly where the argument breaks down.

The argument for requiring correctness arguments is really an argument about where you would rather find out. A team that asks for the exchange argument in review finds the wrong algorithm at review time. A team that does not find it when the numbers look wrong months later, if anyone ever checks, because a suboptimal greedy raises no exception and fails no test that only asserts the output is well-formed. That is the whole case, and it does not need a statistic to be persuasive: the defect class is silent, so the only cheap place to catch it is before it ships.
