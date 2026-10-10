## 102Q.8 Mid-Chapter Synthesis: Edge & Serverless Anti-Patterns

| Mistake | Problem | Solution |
|---------|---------|----------|
| Opening DB connections in `init()` | Slows every cold start | Use lazy initialization with `sync.Once` |
| Not setting `GOMAXPROCS=1` | Scheduler overhead on single-vCPU Lambda | Set `GOMAXPROCS` based on Lambda memory tier |
| Large WASM binaries | Slow browser download | Use TinyGo or strip with `-ldflags="-s -w"` |
| Not handling SQS partial failures | All-or-nothing retry storms | Return `BatchItemFailures` |
| Blocking forever in WASM | Browser tab freezes | Use goroutines for async, never block main goroutine |
| Global state in serverless | Stale state between invocations | Design stateless or use lazy-init with verification |
| Not using provisioned concurrency | P99 latency spikes on cold starts | Enable for latency-sensitive endpoints |
| CGO in Lambda | Linux compilation issues, larger binary | `CGO_ENABLED=0` always for Lambda |

---

### Junior → FAANG: Mistakes Checklist as Pre-Deployment Gate

The mistakes table is a pre-deployment checklist. Before shipping any Lambda function to production, verify each row: are SDK clients initialized outside the handler? Is `GOMAXPROCS` set? Is `CGO_ENABLED=0` in the build command? Is `BatchItemFailures` returned for SQS partial failures? These are mechanical checks that take five minutes and prevent the most common categories of production incidents in Lambda-based services.

The GOMAXPROCS mistake deserves elaboration. Lambda allocates CPU proportionally to memory: 128MB gets 1/8th of a vCPU, 1769MB gets 1 full vCPU. The Go runtime defaults GOMAXPROCS to the number of logical CPUs reported by the kernel, which in a Lambda container may be 2 (the full host's CPU count), not 1/8. Setting GOMAXPROCS higher than the actual available CPU fraction causes goroutine scheduler contention that increases latency. The `automaxprocs` package from Uber reads Linux cgroup CPU quotas and sets GOMAXPROCS correctly for the container's actual CPU allocation.

### Senior @ FAANG: Mistakes as Platform Guardrails

At staff level, the mistakes table is the input to a platform linting and policy enforcement system. Each mistake has a programmatically detectable signal: CGO_ENABLED presence can be checked in CI. Global state patterns can be detected with static analysis. GOMAXPROCS misconfiguration can be detected by checking whether the binary imports `automaxprocs`. BatchItemFailures handling can be checked by inspecting the SQS handler return type.

The organizational posture should be: enforce the top three highest-impact mistakes (CGO in Lambda, missing BatchItemFailures, SDK client in handler) as CI failures using custom linters or policy-as-code checks. Document the remaining mistakes as policy and include them in the Lambda platform onboarding checklist. This two-tier approach avoids the overhead of enforcing every guideline programmatically while ensuring the highest-impact mistakes never reach production.

The CGO_ENABLED=0 enforcement deserves particular attention at the platform level because its violation is silent: the binary compiles successfully, it just fails at Lambda runtime with a dynamic library linking error that appears as a generic crash. A CI check that verifies all Lambda binaries are statically linked (using `file` output or `ldd` output) catches this class of mistake before deployment and eliminates an entire category of production incidents.
