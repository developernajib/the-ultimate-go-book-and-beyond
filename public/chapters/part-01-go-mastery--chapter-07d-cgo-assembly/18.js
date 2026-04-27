export default `# Interview Questions

These questions mirror patterns from FAANG and top-tier Go interviews. Work through them after reading the chapter.

### Q1: Quantify cgo call overhead and explain where it comes from.

**What FAANG expects**: A concrete cost figure, the list of steps a cgo call performs, and guidance on batching.

**Answer**: A cgo call costs roughly 40 to 200 nanoseconds on current x86_64 hardware depending on argument count and whether the call ends up blocking. A pure Go function call is around 1 to 5 nanoseconds. The gap is two orders of magnitude, so naive cgo in hot loops destroys throughput.

The overhead comes from several steps the runtime performs around every cgo call. The goroutine switches from the small Go stack to a full-sized system stack because C code assumes large contiguous stacks. The scheduler transitions the goroutine into \`_Gsyscall\` state so the sysmon thread can preempt the M if the C call blocks. Arguments are marshalled across the boundary with type conversions, and any Go pointers passed in must be pinned under the cgo pointer-passing rules. On return, the reverse sequence runs and the goroutine resumes on its Go stack.

The mitigation is batching. If you must cross the boundary a million times, cross it once with a million items. Libraries like \`mattn/go-sqlite3\` and the GPU bindings in \`gonum\` use this pattern. If you cannot batch, consider whether a pure Go port is viable, because even a 3x slower pure Go implementation often wins once cgo overhead is counted.

**Follow-ups**:
- Why does cgo need a separate system stack at all?
- How does \`//go:nosplit\` interact with cgo-adjacent code?

### Q2: How does cgo interact with goroutine scheduling and OS threads?

**What FAANG expects**: Clear description of M handoff, \`runtime.LockOSThread\`, and blocking C calls.

**Answer**: A goroutine performing a cgo call holds the M (operating-system thread) it is running on for the duration of the C call. The Go scheduler cannot preempt a thread that is executing foreign code, so if the C call blocks for a long time, the scheduler starts a new M to keep other goroutines making progress. This is why heavy cgo workloads can spawn far more threads than \`GOMAXPROCS\` suggests. You can observe thread count in \`/proc/<pid>/status\` or via \`pprof\` goroutine and threadcreate profiles.

Some C libraries require that all calls come from the same OS thread. GUI toolkits like GTK and OpenGL contexts are the classic examples. \`runtime.LockOSThread\` binds the calling goroutine to its current M for the rest of its lifetime, and \`UnlockOSThread\` reverses it. Main-thread-only libraries need a dedicated locked goroutine that owns all calls, with work dispatched over a channel.

Signal handling is another pitfall. Go installs signal handlers for its own use, and C libraries that install their own handlers can break the Go runtime. The \`os/signal.Notify\` mechanism and the \`SIGPIPE\`, \`SIGCHLD\` defaults need careful thought when mixing with C code that does the same.

**Follow-ups**:
- What happens if a goroutine with \`LockOSThread\` exits without unlocking?
- How do you detect thread leakage caused by a cgo call that never returns?

### Q3: Describe the calling convention differences between Go and C, and how cgo bridges them.

**What FAANG expects**: Register vs stack arguments, caller vs callee saved registers, and the role of the generated C shim.

**Answer**: Go uses its own calling convention. Since Go 1.17 the runtime has a register-based ABI on amd64, arm64, ppc64, and riscv64, passing the first several integer and floating-point arguments in registers and the rest on the stack. Return values follow the same scheme. The set of callee-saved registers differs from the System V AMD64 ABI that C uses on Linux and macOS. On Windows, C uses the Microsoft x64 ABI, which differs again.

Because the conventions do not match, cgo cannot call C functions directly from Go code. The \`cgo\` tool generates C shims and Go stubs for every \`C.foo\` reference. The Go stub uses Go's ABI to reach the cgo entry point, switches to the system stack, and calls the generated C shim using the platform C ABI. The shim calls the actual C function. Returns flow back through the reverse path, with the runtime converting types and restoring state.

The shim layer is also where cgo enforces pointer-passing rules. Go pointers passed to C are recorded so the GC does not move them, and the cgo checker (\`GODEBUG=cgocheck=1\` or \`2\`) verifies that C code does not stash Go pointers into Go memory it should not.

**Follow-ups**:
- Why does cgo disable inlining across the boundary?
- How would you call a C function from hand-written Go assembly without going through cgo?

### Q4: When should you reach for assembly instead of pure Go?

**What FAANG expects**: A narrow, concrete list of reasons and a bias toward not writing assembly.

**Answer**: Assembly is justified in four cases. First, when you need CPU instructions that the Go compiler does not emit, such as AES-NI, AVX-512, CLMUL, or the ARMv8 crypto extensions. The \`crypto/aes\`, \`crypto/sha256\`, and \`math/big\` packages all carry assembly for this reason. Second, when the Go compiler cannot express a performance-critical pattern, for example the specific register allocation a hash function needs to hit peak throughput. Third, when you need to inspect or manipulate processor state directly, such as reading the TSC or issuing memory barriers that \`sync/atomic\` does not cover. Fourth, when interoperating with specific ABIs that neither cgo nor Go can handle cleanly.

Every other case is a mistake waiting to happen. Assembly is not portable across architectures, is unreadable for most reviewers, bypasses escape analysis and the race detector, and changes meaning when the Go team revises the internal ABI between releases. Benchmarks should precede any assembly work, and the benchmarks should show the Go compiler leaving meaningful performance on the table after PGO (profile-guided optimization), inlining directives, and intrinsics have been tried.

When you do write assembly, use Go's Plan 9 syntax, keep one architecture per file with the right build tag (\`//go:build amd64\`), provide a pure-Go fallback, and document the invariants. The \`avo\` tool for generating amd64 assembly from Go code is the current standard because it catches most errors at generation time.

**Follow-ups**:
- How does Go 1.21+ PGO change the calculus of when to write assembly?
- Why does Go use Plan 9 syntax instead of AT&T or Intel?

### Q (Senior track): A teammate proposes adding a CGO binding to a C library. How do you evaluate the proposal?

**What FAANG expects**: a structured evaluation with concrete criteria, not "CGO is bad".

**Answer**: Five criteria. First, is there a pure-Go alternative? Most of the time there is (\`modernc.org/sqlite\` for SQLite, \`crypto/tls\` for TLS). Second, is the performance gap material? CGO's per-call overhead (100-200ns) means batched operations may beat per-call CGO. Third, what is the build and deployment impact? Cross-compile story, container size, CI complexity. Fourth, who owns the wrapper? CGO bindings need updating with the upstream C library, and without an owner they rot. Fifth, what is the migration path out? If CGO is later rejected, is there a plan?

If the pure-Go alternative exists and is within the performance budget, the answer is "use it". If CGO is genuinely necessary (SQLite with specific extensions, proprietary hardware drivers), the proposal needs all five questions answered before approval.

### Q (Senior track): Your team wants to write SIMD assembly for a hot path. How do you guide the decision?

**What FAANG expects**: a profile-first answer, not "go for it" or "never".

**Answer**: First, profile. \`go tool pprof\` identifies the hot path. If the hot path is not what the team thinks it is, the assembly is wasted effort.

Second, exhaust compiler optimisations. PGO, inlining hints, structural refactoring. Modern Go emits SIMD for many patterns without explicit assembly. Check \`go build -gcflags="-S"\` to see what the compiler already does.

Third, if the compiler truly leaves performance on the table and the hot path is hot enough to justify, write the assembly. Require: per-architecture file, pure-Go fallback, benchmark proving the gain, test suite that verifies behavioural parity.

Fourth, document. The next engineer needs to know why. Without documentation, the assembly becomes dead weight that the team is afraid to remove.
`;
