## 75.18 Core Concepts Recap

### Greedy Algorithm Checklist

Before committing to a greedy approach, it is essential to verify two formal properties: the *greedy choice property* (a globally optimal solution can always be assembled from locally optimal choices) and *optimal substructure* (an optimal solution to the whole problem contains optimal solutions to its sub-problems). Using an exchange argument (assuming a non-greedy optimal solution exists and showing you can swap it toward the greedy solution without loss) is the standard proof technique.

```
┌──────────────────────────────────────────────────────────────────┐
│              GREEDY ALGORITHM CHECKLIST                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  IDENTIFICATION:                                                 │
│  □ Problem asks for "maximum/minimum" of something               │
│  □ Making local choice doesn't foreclose better options          │
│  □ Problem has optimal substructure                              │
│                                                                  │
│  VERIFICATION:                                                   │
│  □ Prove greedy choice property (exchange argument)              │
│  □ Test with counterexamples                                     │
│  □ Compare with DP if unsure                                     │
│                                                                  │
│  IMPLEMENTATION:                                                 │
│  □ Choose correct sorting criteria                               │
│  □ Handle edge cases (empty, single element)                     │
│  □ Consider two-pass if bidirectional constraints                │
│                                                                  │
│  COMMON PATTERNS:                                                │
│  □ Interval: Sort by end time                                    │
│  □ Optimization: Sort by ratio (value/cost)                      │
│  □ Assignment: Sort both arrays, match greedily                  │
│  □ Two-pointer: Process from both ends                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Quick Reference: Common Greedy Problems

| Problem | Sorting Criteria | Time Complexity |
|---------|------------------|-----------------|
| Activity Selection | End time ascending | O(n log n) |
| Meeting Rooms II | Start time + heap | O(n log n) |
| Jump Game | Track max reach | O(n) |
| Candy | Two-pass (L→R, R→L) | O(n) |
| Gas Station | One pass with reset | O(n) |
| Task Scheduler | Frequency counting | O(n) |
| Non-overlapping Intervals | End time ascending | O(n log n) |
| Boats to Save People | Sort + two pointers | O(n log n) |
| Queue Reconstruction | Height desc, k asc | O(n²) |

### Greedy vs DP Decision Tree

The fundamental distinction is whether a local choice can be made irrevocably without regret. Be careful with the word "independent" here, because it is the wrong word and it obscures the idea. Greedy choices are not independent: selecting the activity that finishes earliest absolutely does constrain what you can select next, since everything overlapping it is now unavailable. The property that matters is weaker and more subtle. The greedy choice must be *safe*, meaning some optimal solution contains it, so committing to it never puts the optimum out of reach. Earliest finish time qualifies not because it constrains nothing, but because whatever it rules out, an exchange argument shows an optimal solution containing it still exists.

Dynamic programming is required when no such safe choice is available, and the best decision at step `i` depends on which states were reachable at steps `1..i-1`. Then you must keep those states around, which is what the table is for.

```
Does the problem have optimal substructure?
├── No → Neither greedy nor DP applies
└── Yes → Continue

Can you prove greedy choice property?
├── Yes → Use GREEDY
└── No/Unsure → Continue

Can you find a counterexample to greedy?
├── Yes → Use DP
└── No → Try to prove greedy; if can't, use DP
```

### Junior → FAANG: Using the Checklist as an Interview Scaffold

The checklist and decision tree in this summary are your interview defense against the most common failure mode: jumping to implementation before verifying that greedy is correct. In a 45-minute slot, spend the first 5 minutes asking the checklist questions aloud. Does the problem have optimal substructure? Can you sketch an exchange argument or produce a counterexample in under 2 minutes? State your conclusions to the interviewer before writing code. This signals algorithmic maturity even if your initial approach turns out to be wrong, because it shows you have a framework for reasoning rather than guessing.

### Senior @ FAANG: Embedding Greedy Verification Into Team Practice

At the senior level, the checklist becomes a code-review and design-review artifact. When a teammate proposes a greedy shortcut in a pull request or design document, the senior engineer applies the same two-question test: greedy choice property and optimal substructure. If neither is formally verified, the checklist is added as a comment with a request for either a proof sketch or an empirical validation on representative data. At the staff level, the concern broadens to algorithmic governance: which categories of optimization problems appear in this team's codebase, and do engineers have the background to distinguish greedy, DP, and LP regimes? Staff engineers may run internal training sessions, maintain a library of canonical problem-to-algorithm mappings, and flag any production heuristic that lacks a documented approximation guarantee. The summary table and decision tree in this file are exactly the kind of artifact a staff engineer would maintain in an internal wiki and reference during incident reviews when a production optimizer produces suboptimal output.
