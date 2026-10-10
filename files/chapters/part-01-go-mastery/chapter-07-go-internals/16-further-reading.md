## Further Reading

**Primary Sources**:
- The `runtime/` package source code in the Go repository, where `proc.go` (scheduler), `mgc.go` (garbage collector), `malloc.go` (allocator), and `chan.go` (channels) are the authoritative references
- Go Blog: "Getting to Go: The Journey of Go's Garbage Collector", a detailed history of GC design decisions
- Go Blog: "Go GC: Prioritizing Low Latency and Simplicity", the design rationale for the concurrent collector
- Go Design Documents: "Go 1.5 Concurrent Garbage Collector Pacing", "Proposal: Soft Memory Limit" (GOMEMLIMIT)

**Talks and Articles**:
- "An Introduction to go tool trace" by Rhys Hiltner (GopherCon 2017), covering trace-based diagnosis with production examples
- "Allocation Efficiency in High-Performance Go Services" by Achille Roussel and Rick Branson (Segment engineering blog), covering escape analysis and allocation reduction techniques

**Tools and Diagnostics**:
- `go tool trace` documentation: https://pkg.go.dev/cmd/trace
- `runtime/pprof` and `net/http/pprof` package documentation
- `GODEBUG` environment variable reference in the `runtime` package docs

**Books**:
- "The Go Programming Language" by Donovan and Kernighan, whose Chapter 13 covers low-level programming and `unsafe`
- "100 Go Mistakes and How to Avoid Them" by Teiva Harsanyi, with practical coverage of runtime-related pitfalls

**Green Tea GC References (2026-current)**:
- Go 1.26 release notes for the Green Tea GC promotion to default
- Go 1.27 release notes (https://go.dev/doc/go1.27) for the size-specialized allocator and the GA goroutineleak profile
- The Green Tea GC proposal and design discussion by Michael Knyszek and the Go runtime team (golang/go issue 73581)
- The `runtime` package docs covering GC tuning in the Green Tea era

**Incident Diagnosis Workflows**:
- Google SRE book chapters on profiling at scale
- Cloudflare's engineering blog posts on production Go debugging
- Uber's engineering blog on goroutine leak detection and trace-based diagnosis

**Tooling to Wire Into CI and On-Call**:
- `goleak` from `uber-go/goleak` for test-time goroutine leak detection
- `pprof` scraping via Pyroscope or Parca for continuous profiling
- `go tool trace` as part of the on-call runbook for latency incidents
- `benchstat` for comparing benchmark runs statistically
