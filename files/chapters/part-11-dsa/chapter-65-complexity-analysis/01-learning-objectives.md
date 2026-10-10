## Learning Objectives

By the end of this chapter, you will be able to:
- Analyze time and space complexity of algorithms
- Apply Big O, Big Omega, and Big Theta notations
- Understand amortized analysis
- Analyze complexity of Go built-in operations
- Make informed trade-offs between time and space

### Junior → FAANG: Making Learning Objectives Actionable

Each objective in this list is an interview checkpoint. "Analyze time and space complexity" means you can read any function and produce a justified Big-O claim within two minutes. "Apply Big O, Omega, and Theta" means you know when to distinguish best from worst case, and you do not use "O(n log n)" when you actually mean "Theta(n log n)." "Understand amortized analysis" means you can explain why repeated `append` calls on a Go slice cost O(1) per call on average without hand-waving.

For your first job, translate these objectives into habits rather than facts. After every code change, add a comment with the complexity. Before every pull request, verify that no loop nest has silently become O(n²). These practices protect you and build the muscle memory that makes the FAANG interview feel natural.

### Senior @ FAANG: Using Learning Objectives as a Team Standard

A senior engineer takes this list and asks: "Which of these does my team apply inconsistently, and what is the cost?" If engineers cannot distinguish amortized from worst-case, on-call rotations fill with latency spikes that happen only at peak load. If engineers do not understand Go built-in complexities, code reviews miss O(n²) bugs that are invisible until production scale.

The corrective action is not a lecture. It is a lightweight process change: add a "complexity analysis" section to the PR template, require benchmark evidence for any code on a hot path, and block merges when a benchmark shows regression beyond a defined threshold. That is how a senior engineer turns individual learning objectives into team-wide engineering maturity.

---
