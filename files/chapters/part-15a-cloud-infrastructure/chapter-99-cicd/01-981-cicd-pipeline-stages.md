## 99.1 CI/CD Pipeline Stages

A well-structured CI/CD pipeline enforces quality gates sequentially so that cheap, fast checks (formatting, linting) fail fast before expensive ones (Docker builds, deployments) are even attempted. For Go services the pipeline typically runs five ordered stages: code quality catches style and correctness issues without executing the program. Testing validates behavior and surfaces data races via `-race`. Security scanning detects known CVEs in dependencies and common coding mistakes. Build compiles a reproducible, signed artifact. And deploy progressively promotes that artifact through staging before production, with automated smoke tests at each boundary.

```
┌──────────────────────────────────────────────────────────────────┐
│                    CI/CD PIPELINE STAGES                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. CODE QUALITY                                                 │
│     ├── go fmt / goimports                                       │
│     ├── go vet                                                   │
│     ├── golangci-lint                                            │
│     └── staticcheck                                              │
│                                                                  │
│  2. TESTING                                                      │
│     ├── Unit tests                                               │
│     ├── Integration tests                                        │
│     ├── Coverage reporting                                       │
│     └── Benchmark tests                                          │
│                                                                  │
│  3. SECURITY                                                     │
│     ├── govulncheck                                              │
│     ├── gosec                                                    │
│     ├── Dependency scanning                                      │
│     └── Secret detection                                         │
│                                                                  │
│  4. BUILD                                                        │
│     ├── Compile binary                                           │
│     ├── Build Docker image                                       │
│     ├── Push to registry                                         │
│     └── Sign artifacts                                           │
│                                                                  │
│  5. DEPLOY                                                       │
│     ├── Deploy to staging                                        │
│     ├── Run smoke tests                                          │
│     ├── Deploy to production                                     │
│     └── Monitor rollout                                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Understanding Why Pipeline Stage Order Matters

The pipeline stage ordering principle is fail fast and fail cheap. Static analysis and formatting checks are nearly instantaneous and run with no infrastructure. Run them first. Test execution is slower and requires dependencies. Run it second. Docker build is expensive and has external dependencies. Run it only after tests pass. Deployment is irreversible (or at least complex to reverse). Run it last, gated on everything before it.

This ordering means that a formatting error fails in 10 seconds rather than after 8 minutes of test execution and 3 minutes of Docker build. Over many PRs per day across many engineers, the aggregate time saved is significant. More importantly, fast failure on the first stage gives fast feedback, which keeps developers in a short iteration loop rather than waiting for long pipelines.

First-job habit: benchmark your pipeline stages. Know how long each stage takes. Any stage over 5 minutes is a candidate for optimization. A pipeline over 15 minutes end-to-end is slow enough to meaningfully impact developer flow.

### Senior @ FAANG: Pipeline Architecture and the DORA Metrics Connection

At staff level, pipeline stage design connects directly to DORA (DevOps Research and Assessment) metrics: deployment frequency, lead time for changes, change failure rate, and time to restore service. These four metrics measure the organizational health of the delivery system, and the pipeline is the primary lever for improving them.

Lead time for changes (the time from code commit to production deployment) is dominated by pipeline duration plus any human approval gates. A 30-minute pipeline with a mandatory manual approval step produces a minimum lead time of 30 minutes plus the approval wait time (which can be hours or days if not monitored). Removing manual approval gates and replacing them with automated quality gates (test pass, security scan clean, staged canary with SLO monitoring) is the architectural change that moves lead time from hours to minutes.

Change failure rate is the fraction of deployments that result in a production incident. The pipeline design choices that reduce this metric: comprehensive test coverage with fast execution (so the test suite is actually run, not skipped to speed up the pipeline), staged deployment with automatic SLO-based rollback (so bad changes are caught before reaching full traffic), and feature flags that allow code deployment to be separated from feature activation. The staff engineer who can demonstrate that these pipeline investments reduced the change failure rate by a measurable percentage is making an L6-level impact argument.
