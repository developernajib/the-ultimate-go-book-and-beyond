export default `# Chapter 7D: CGO and Go Assembly

*"CGO is not Go. Use it when you must, not because you can."* - Go Team

Go's standard library and toolchain provide two ways to step outside the Go runtime: **CGO** for calling C code (and any language with a C interface, C++, Rust, Python, CUDA), and **Plan 9 assembly** for writing hot-path functions at the machine instruction level. Both are real tools used in production: SQLite bindings, OpenSSL wrappers, SIMD-accelerated string processing, and low-level runtime functions all use one or both.

CGO gives you access to system libraries, hardware interfaces, and the vast ecosystem of C libraries that have no pure-Go equivalent. Go assembly lets you read the output of \`go tool compile -S\`, understand performance anomalies, and write the 0.1% of code that genuinely needs SIMD or direct CPU instruction access.

**What you will learn:**

- **CGO fundamentals** - importing C, calling C functions, type conversions, memory ownership
- **String and memory management in CGO** - C.CString/GoString, who frees what, double-free prevention
- **Callbacks: calling Go from C** - the \`//export\` directive and its restrictions
- **Build system integration** - \`#cgo\` directives, pkg-config, static vs dynamic linking
- **CGO performance overhead** - goroutine stack switching, the true cost of a CGO call
- **CGO pitfalls and restrictions** - what you cannot do across the Go/C boundary
- **Plan 9 assembly basics** - TEXT declarations, registers, calling convention
- **Writing a SIMD function** - sum a []int64 faster using AVX2
- **go:generate for assembly** - tools that generate assembly from Go
- **go:linkname** and internal symbol access

> **For readers new to programming:** skip this chapter. CGO and assembly are the narrow edges of the Go ecosystem. Come back when you have a concrete problem that cannot be solved in pure Go.
>
> **For readers already senior at a FAANG-equivalent company:** this is the chapter you use to evaluate CGO proposals. Most CGO PRs should be rejected in favour of pure-Go alternatives. This chapter gives you the criteria.

**Chapter navigation by career stage.**

- **Mid-level engineer:** read to understand what CGO costs and why you should avoid it most of the time. Skim the assembly material unless you have a specific performance problem that needs it.
- **Senior engineer:** the CGO-restriction and decision-flowchart sections are the reference material for evaluating proposals. The operational cost (no cross-compile, harder deployment, slower calls) is real and often underestimated by teams that do not track it.
- **Staff or Principal engineer:** CGO is a strategic decision. The team that depends on CGO for a core path loses Go's deployment simplicity forever. Evaluate the alternative paths first.

**What the senior track gets here.** The CGO-rejection framing: when is "rewrite in Go" the right answer, when is CGO genuinely necessary. The operational framing: what breaks when you add CGO to a service. The assembly framing: when is hand-written assembly worth it, and what are the alternatives.

---
`;
