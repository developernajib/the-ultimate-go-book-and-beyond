export default `## Summary

| Feature | CGO | Assembly |
|---------|-----|----------|
| Use case | Calling C/system libraries | Micro-optimizing hot paths, SIMD |
| Overhead | ~50-100ns per call | None (replaces Go function directly) |
| Portability | Requires C compiler per target | Platform-specific (.s files per GOARCH) |
| Debugging | Delve + GDB. more complex | Very difficult |
| Testing | \`go test\` + \`CGO_ENABLED=0 go test\` | Standard \`go test\` |
| Cross-compilation | zig cc or Docker toolchain | Easier (just assembler for target) |
| When to use | SQLite, OpenSSL, hardware drivers | SIMD, crypto primitives, time.Now() |
| When NOT to use | < 100ns C work per call | Without first measuring with pprof |

**CGO rules to remember:**
1. \`C.CString()\` allocates C memory, always \`defer C.free(unsafe.Pointer(...))\`
2. Use the two-return-value form \`result, err := C.func(args)\` to capture errno automatically
3. Go pointers must not be stored in C past the CGO call, use \`cgo.Handle\` for callbacks
4. Batch small C operations to amortize the ~100ns per-call overhead
5. \`CGO_ENABLED=0\` must still produce a working binary, always provide build-constrained fallbacks
6. Use \`runtime.LockOSThread()\` for thread-local C libraries (OpenGL, Python, curl)
7. Use \`zig cc\` for cross-compilation without installing full cross-toolchains

**Assembly rules to remember:**
1. Go uses Plan 9 assembly syntax, different from Intel (nasm) and AT&T (gas)
2. Function arguments and returns are on the stack at deterministic offsets from \`FP\`
3. Always call \`VZEROUPPER\` after AVX/AVX2 code on x86 to prevent SSE slowdowns
4. Provide an \`_generic.go\` fallback for every \`.s\` file using \`//go:build !amd64\`
5. ARM64 NEON is always available, no runtime \`cpu.ARM64.HasNEON\` check needed
6. \`go:linkname\` breaks on Go version upgrades, use sparingly and document the version constraint

---

*Next chapter: Chapter 24B, Advanced Go Tooling: go generate, Plugins, embed, DI, and Serialization*

### Senior-Track Institutional Artifact

The central lesson from this chapter for a senior engineer is the team's "when do we use CGO or assembly" policy. Default to pure Go. Exceptions require evidence: benchmarks, alternatives-explored document, and an owner who commits to the maintenance. The policy is the artifact. The team's operational simplicity is the payoff.

---
`;
