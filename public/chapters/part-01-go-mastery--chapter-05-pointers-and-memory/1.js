export default `## Learning Objectives

By the end of this chapter, you will be able to:

- Use pointers safely, including nil checks and zero-value behavior
- Distinguish stack and heap allocation and optimize accordingly
- Use escape analysis to minimize garbage collection pressure
- Apply memory optimization patterns used in large-scale Go deployments
- Handle nil semantics correctly across pointers, slices, maps, channels, and interfaces
- Choose between value and pointer receivers based on struct size and mutation needs
- Order struct fields to minimize padding and improve cache locality
- Profile memory usage with pprof in running services
- Reduce allocation pressure with sync.Pool in high-throughput code paths
- Answer common interview questions about Go's memory model

### Detailed Outcomes

**Junior to FAANG-entry track**

- Explain what \`&x\` and \`*p\` do without hesitation, and predict the output of a small program that passes pointers around.
- Recognise the nil-pointer dereference panic on sight and name the fix.
- Articulate the difference between nil interface and nil pointer wrapped in an interface, the way a phone-screen interviewer expects.
- Pick value or pointer receiver correctly for a new method on a new type, with a justification the interviewer accepts.
- Read a simple \`go build -gcflags="-m"\` output and identify which variables escape to the heap.

**Mid-level engineer moving performance-sensitive code**

- Capture a heap profile with pprof, open it in the browser, and identify the top three allocation sites.
- Replace an unintentional heap allocation (a local variable that escapes) with a stack-allocated equivalent by changing the function signature or data flow.
- Write a \`sync.Pool\` that correctly recycles byte buffers, with \`Get\` returning a usable zero-state and \`Put\` resetting before returning to the pool.
- Measure the before-and-after impact of a memory optimisation with \`benchstat\` and defend the change as a PR.
- Identify the three or four allocation patterns (interface boxing, unnecessary pointer returns, map-of-slices growth, defer-in-a-loop) that account for the majority of avoidable heap pressure in typical Go services.

**Senior at FAANG track**

- Diagnose a service with elevated GC CPU overhead (visible in \`go tool trace\`) and propose a type-design change that reduces the workload, with a measurable improvement to prove the fix.
- Explain the Green Tea GC (Go 1.26) changes at a level that lets you answer "why did our GC CPU drop 30% on the 1.26 upgrade?" with specifics, not folklore.
- Identify when \`weak.Pointer[T]\` (Go 1.24) is the right tool (caches, memoisation tables that should release under GC pressure) and when it is the wrong tool (everywhere else).
- Specify the team's \`sync.Pool\` discipline: which types get pooled, what the \`Get\`/\`Put\` contract is, what tests exist to verify the pool does not leak state between uses. Wire the discipline into code review.
- Identify the two or three allocation sites in a hot service that would move the needle most if optimised, and sequence the optimisation work so that each step is individually shippable.
- Push back in code review on premature optimisation (escape-analysis micro-tuning on cold paths) and on missed optimisation (allocation in a hot path that pprof has flagged). The senior-track judgment is knowing which is which.

---
`;
