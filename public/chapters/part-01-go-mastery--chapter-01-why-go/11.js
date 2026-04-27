export default `## Why Go Quick Reference Card

This card distills Go's core value proposition into the dimensions that matter most when choosing a language for production systems: design philosophy, performance characteristics, ecosystem fit, and honest trade-offs. The language comparison figures are derived from real benchmark data. Go's order-of-magnitude throughput advantage over CPython on CPU-bound workloads comes from native compilation and the absence of a GIL, while its memory advantage over the JVM stems from a value-oriented type system where structs are stack-allocated by default. Use the "when not to use Go" section to demonstrate architectural maturity in technical interviews.

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        WHY GO QUICK REFERENCE                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  CORE DESIGN PRINCIPLES:                                                        │
│  ├── Simplicity over complexity (one way to do things)                         │
│  ├── Readability over cleverness (code is read more than written)              │
│  ├── Composition over inheritance (interfaces, not class hierarchies)          │
│  ├── Explicitness over magic (no hidden control flow)                          │
│  └── Fast compilation (fast feedback loop)                                     │
│                                                                                 │
│  GO VS OTHER LANGUAGES:                                                         │
│  ┌──────────────┬──────────────────────────────────────────────────────────┐   │
│  │ Language     │ Go Advantage                                             │   │
│  ├──────────────┼──────────────────────────────────────────────────────────┤   │
│  │ Python       │ 10-100x faster on CPU work, static types, single binary │   │
│  │ Java         │ Simpler, faster startup, smaller memory footprint       │   │
│  │ Rust         │ Easier learning curve, faster compilation, GC           │   │
│  │ Node.js      │ True parallelism, lower memory, no callback hell        │   │
│  │ C++          │ Safe memory management, fast builds, simpler syntax     │   │
│  └──────────────┴──────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  IDEAL USE CASES:                                                               │
│  ├── Cloud infrastructure (Kubernetes, Docker, Terraform)                     │
│  ├── Microservices and APIs                                                    │
│  ├── CLI tools and DevOps automation                                          │
│  ├── Network services and proxies                                             │
│  ├── Observability tools (Prometheus, Grafana agents)                         │
│  └── High-concurrency systems                                                  │
│                                                                                 │
│  WHEN NOT TO USE GO:                                                            │
│  ├── GUI desktop applications (use Electron, Qt, Swift)                        │
│  ├── Mobile apps (use Kotlin/Swift, though Go can work)                       │
│  ├── Data science/ML (use Python for ecosystem)                               │
│  ├── Real-time systems requiring no GC pauses                                 │
│  └── Heavy numeric computing (use Julia, C++, Fortran)                        │
│                                                                                 │
│  COMPANY ADOPTION (WHY THEY CHOSE GO):                                          │
│  ┌──────────────┬──────────────────────────────────────────────────────────┐   │
│  │ Company      │ Reason                                                    │   │
│  ├──────────────┼──────────────────────────────────────────────────────────┤   │
│  │ Google       │ Fast builds, concurrency for network services            │   │
│  │ Uber         │ Geofence service: 40μs P99 latency                       │   │
│  │ Netflix      │ Chaos engineering (simian army in Go)                     │   │
│  │ Cloudflare   │ Edge proxies handling 81M+ RPS (Q1 2026)                 │   │
│  │ Stripe       │ API infrastructure, type safety                          │   │
│  │ Docker       │ Container runtime, portability                           │   │
│  │ Kubernetes   │ Orchestration, plugin architecture                       │   │
│  └──────────────┴──────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  KEY GO FEATURES:                                                               │
│  ├── Goroutines:    Lightweight threads (2KB stack, millions concurrent)      │
│  ├── Channels:      Type-safe communication between goroutines                │
│  ├── Interfaces:    Implicit satisfaction (duck typing with safety)           │
│  ├── defer:         Guaranteed cleanup, runs in LIFO order                    │
│  ├── Error values:  Explicit error handling, no exceptions                    │
│  └── Single binary: No runtime dependencies needed                            │
│                                                                                 │
│  ESSENTIAL COMMANDS (2026):                                                     │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  go mod init <module>    # Initialize new module                         │   │
│  │  go mod tidy             # Reconcile go.mod with imports                 │   │
│  │  go build                # Compile current package                       │   │
│  │  go run main.go          # Compile and run                               │   │
│  │  go test -race ./...     # Run all tests with race detector              │   │
│  │  go fmt ./...            # Format all Go files                           │   │
│  │  go vet ./...            # Built-in static analysis                      │   │
│  │  go doc <package>        # View documentation                            │   │
│  │  go get <package>@latest # Add/update dependency                         │   │
│  │  go work init            # Multi-module workspace (Go 1.18+)             │   │
│  │  govulncheck ./...       # Vulnerability scan (install separately)       │   │
│  │  golangci-lint run       # Aggregate linter (install separately)         │   │
│  │  dlv debug               # Debugger                                      │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  PROJECT LAYOUT (STANDARD):                                                     │
│  ├── cmd/           Main applications (cmd/myapp/main.go)                      │
│  ├── internal/      Private code (not importable by others)                   │
│  ├── pkg/           Public library code                                        │
│  ├── api/           OpenAPI specs, protobuf definitions                        │
│  ├── go.mod         Module definition and dependencies                         │
│  └── go.sum         Dependency checksums                                       │
│                                                                                 │
│  INTERVIEW TIPS FOR "WHY GO":                                                   │
│  ├── Mention concrete benefits: compilation speed, deployment simplicity       │
│  ├── Reference company case studies relevant to interviewer                   │
│  ├── Acknowledge trade-offs honestly: error verbosity, generics arrived late │
│  ├── Show understanding of goroutines vs threads (M:N scheduler)              │
│  ├── Name one thing Go doesn't do well (signals maturity)                     │
│  └── Commit to a position: "it depends" is the worst answer                   │
│                                                                                 │
│  2026 TOOLCHAIN FACTS:                                                          │
│  ├── Current stable: Go 1.26 (Feb 2026), self-referential generics            │
│  ├── Go 1.25: container-aware GOMAXPROCS, testing/synctest stable             │
│  ├── Go 1.23: range-over-func iterators, stdlib timer/ticker fixes            │
│  ├── Go 1.22: stdlib HTTP router with method matching + path params           │
│  ├── Go 1.21: slog, slices, maps, cmp packages in stdlib                      │
│  ├── Go 1.18: generics, workspaces (go work)                                  │
│  └── Go 1 compatibility: 2012 code still compiles with 2026 toolchain         │
│                                                                                 │
│  PERFORMANCE BENCHMARKS (APPROXIMATE):                                          │
│  ├── HTTP server throughput:  100,000+ RPS per core                            │
│  ├── JSON marshal/unmarshal:  ~1μs per small struct                           │
│  ├── Goroutine creation:      ~1μs                                             │
│  ├── Channel send/receive:    ~50ns                                            │
│  └── Memory per goroutine:    ~2KB (vs ~1MB per OS thread)                    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
\`\`\`

---
`;
