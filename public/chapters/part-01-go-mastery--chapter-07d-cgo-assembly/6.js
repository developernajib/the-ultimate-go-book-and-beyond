export default `## 7D.5 CGO Restrictions Checklist

CGO operates at the boundary between two entirely different runtime models: Go's garbage-collected, goroutine-scheduled world and C's unmanaged, thread-based execution model. The restrictions below exist because Go's GC can move objects in memory, making raw Go pointers unsafe to hold in C-allocated memory beyond the duration of a single call. Violations are not always caught at compile time, the \`GOEXPERIMENT=cgocheck2\` flag enables runtime pointer checking during development to surface these bugs early.

\`\`\`
┌────────────────────────────────────────────────────────────────────────┐
│              CGO Restrictions - Things You Cannot Do                   │
├────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  CANNOT:                                                               │
│  ✗ Store a Go pointer in C memory past the duration of the CGO call   │
│  ✗ Call Go functions from C unless they are marked //export            │
│  ✗ Use goroutines in C code (C doesn't know about Go's scheduler)     │
│  ✗ Panic across the C boundary (panic doesn't unwind C stack)         │
│  ✗ Use defer, goroutine, or channels inside //export functions safely  │
│    without explicit goroutine creation                                 │
│  ✗ Cross-compile CGO without the target's C toolchain installed       │
│  ✗ Build with CGO_ENABLED=0 if your package uses CGO                 │
│  ✗ Use CGO in WASM (CGO_ENABLED=0 is forced)                         │
│                                                                         │
│  CAN:                                                                  │
│  ✓ Call any C function that doesn't use longjmp across Go frames      │
│  ✓ Use C structs, enums, and typedefs directly                        │
│  ✓ Link against static (.a) or dynamic (.so/.dll) libraries           │
│  ✓ Use cgo.Handle to safely pass Go values to C                       │
│  ✓ Use //export to make specific Go functions callable from C         │
│  ✓ Override the C allocator (malloc/free) with replacements           │
│                                                                         │
│  ALTERNATIVES TO CGO:                                                  │
│  • Pure Go reimplementation (preferred when feasible)                 │
│  • gRPC/RPC sidecar: run C code in a separate process, call via IPC  │
│  • WASM modules for browser-sandboxed C execution                     │
│  • Subprocess via os/exec for heavy C tools (ffmpeg, ImageMagick)    │
└────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Evaluating a CGO Proposal

For a senior engineer reviewing a proposal to add CGO:

1. **Can this be done in pure Go?** The vast majority of cases have pure-Go alternatives. \`modernc.org/sqlite\` for SQLite, \`crypto/tls\` for TLS. Check first.
2. **What is the build and deployment impact?** Cross-compilation story, binary size, container base image requirements.
3. **What is the on-call impact?** Debugging crosses the boundary. Who owns the C dependency's updates?
4. **What is the migration path if CGO is later rejected?** Is there an escape?

If any of these is uncomfortable, reject the proposal or require the alternatives-explored document before approval.

---
`;
