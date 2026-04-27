export default `## Further Reading

**Primary Sources**:
- The \`runtime/\` package source code in the Go repository, where \`proc.go\` (scheduler), \`mgc.go\` (garbage collector), \`malloc.go\` (allocator), and \`chan.go\` (channels) are the authoritative references
- Go Blog: "Getting to Go: The Journey of Go's Garbage Collector", a detailed history of GC design decisions
- Go Blog: "Go GC: Prioritizing Low Latency and Simplicity", the design rationale for the concurrent collector
- Go Design Documents: "Go 1.5 Concurrent Garbage Collector", "Proposal: Soft Memory Limit" (GOMEMLIMIT)

**Conference Talks**:
- "Understanding the Go Runtime" by Rhys Hiltner (GopherCon), covering scheduler internals with production examples
- "Allocation Efficiency in High-Performance Go Services" by Achille Roussel (GopherCon), covering escape analysis and allocation reduction techniques

**Tools and Diagnostics**:
- \`go tool trace\` documentation: https://pkg.go.dev/cmd/trace
- \`runtime/pprof\` and \`net/http/pprof\` package documentation
- \`GODEBUG\` environment variable reference in the \`runtime\` package docs

**Books**:
- "The Go Programming Language" by Donovan and Kernighan, whose Chapter 13 covers low-level programming and \`unsafe\`
- "100 Go Mistakes and How to Avoid Them" by Teiva Harsanyi, with practical coverage of runtime-related pitfalls

**Green Tea GC References (2026-current)**:
- Go 1.26 release notes for the Green Tea GC promotion to default
- Austin Clements's GopherCon 2025 talk on Green Tea design and implementation
- The \`runtime\` package docs covering GC tuning in the Green Tea era

**Incident Diagnosis Workflows**:
- Google SRE book chapters on profiling at scale
- Cloudflare's engineering blog posts on production Go debugging
- Uber's engineering blog on goroutine leak detection and trace-based diagnosis

**Tooling to Wire Into CI and On-Call**:
- \`goleak\` from \`uber-go/goleak\` for test-time goroutine leak detection
- \`pprof\` scraping via Pyroscope or Parca for continuous profiling
- \`go tool trace\` as part of the on-call runbook for latency incidents
- \`benchstat\` for comparing benchmark runs statistically
`;
