export default `## 7D.15 CGO Decision Flowchart

CGO carries a non-trivial cost: each C call crosses a runtime boundary, pinning the calling goroutine to its OS thread and incurring roughly 100ns of overhead. That makes CGO a poor fit for high-frequency, short-duration calls, and it disables cross-compilation unless you supply the target's C toolchain. Work through the following decision tree before committing to a CGO dependency, the subprocess and pure-Go alternatives are often faster to ship and far cheaper to maintain.

\`\`\`
┌──────────────────────────────────────────────────────────────────────┐
│              Should You Use CGO?                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Does a pure-Go implementation of the required functionality exist?  │
│  YES → Use it. NO → Continue.                                        │
│                                                                       │
│  Can you call the C library as a subprocess (os/exec)?               │
│  YES (batch/offline use case) → Use subprocess. NO → Continue.       │
│                                                                       │
│  Does the C code do > 1μs of work per call?                         │
│  NO → CGO overhead (~100ns) dominates; find another approach.       │
│  YES → Continue.                                                      │
│                                                                       │
│  Do you need cross-compilation support?                              │
│  YES → Plan for zig cc or Docker cross-compilation toolchain.        │
│                                                                       │
│  Does the C library require thread-local state?                      │
│  YES → Use runtime.LockOSThread + single-goroutine event loop.       │
│                                                                       │
│  Will this be deployed to platforms without CGO support?             │
│  (WASM, some embedded, CGO_ENABLED=0 Docker builds)                 │
│  YES → Provide a pure-Go fallback with build constraints.            │
│                                                                       │
│  → Proceed with CGO, following the memory ownership rules.           │
└──────────────────────────────────────────────────────────────────────┘
\`\`\`

### Senior-Track Summary

The flowchart is the team's CGO decision process. Print it, put it in the design review doc, require proposals to walk through it. A CGO adoption that skips the flowchart is an unvetted architectural commitment.

---
`;
