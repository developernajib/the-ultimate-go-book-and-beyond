## 102Q.9 Core Serverless & Edge Interview Questions

**Q: How do you minimize Lambda cold start time in Go?**

A: (1) Minimize init() work - defer DB connections to first invocation using `sync.Once`. (2) Build with `-ldflags="-s -w"` to reduce binary size. (3) Use arm64/Graviton which has better cold start performance. (4) Enable provisioned concurrency for latency-sensitive functions. (5) Set `GOMAXPROCS=1` for single-vCPU tiers. Typical Go Lambda cold start: 100-200ms.

**Q: What is the difference between WASM and WASI?**

A: WASM (WebAssembly) is a binary instruction format that runs in browser sandboxes with JS interop via the host's imported functions. WASI (WebAssembly System Interface) is a standard API for WASM modules to access OS-level features (files, network, environment) outside the browser. Go 1.21+ supports `GOOS=wasip1` for WASI targets. browsers use `GOOS=js GOARCH=wasm`.

**Q: How do you share memory between Go WASM and JavaScript?**

A: Use `js.CopyBytesToGo` and `js.CopyBytesToJS` for byte slices. For structured data, pass JSON strings. For high-performance cases with TinyGo, use exported `allocBuffer` to allocate shared memory and pass a pointer + length. The `WebAssembly.Memory` object is directly accessible from JS.

---

### Junior → FAANG: Interview Question Patterns for Serverless and Edge

The interview questions in this section fall into three categories. The first category is knowledge questions with a definitive correct answer: how do you minimize cold start, what is the difference between WASM and WASI? These have specific technical answers and you should be able to answer them precisely, not approximately. "Use smaller binaries and initialize SDK clients outside the handler" is a precise answer. "Optimize the function" is not.

The second category is design questions that require tradeoff reasoning: when would you choose Cloud Run over Lambda? These expect you to name the specific tradeoffs (concurrency model, billing, cold start, maximum execution duration, VPC integration complexity) and justify a choice given a hypothetical workload. Prepare three or four specific workload scenarios and know which platform you would choose for each and why.

The third category is debugging questions: a Lambda function has high p99 latency. These expect a systematic diagnosis: first check cold start frequency (is the high latency correlated with cold starts?), then check downstream call latency via X-Ray (is one downstream service slow?), then check Lambda duration metrics (is the business logic slow?). Knowing the diagnostic sequence demonstrates production experience.

### Senior @ FAANG: Bar-Raiser Signals for Serverless and Edge Architecture Interviews

Bar-raiser interviewers evaluate whether a candidate operates at a level above the role being hired. For a senior engineer role evaluating serverless and edge topics, bar-raiser signals include: framing cold start not as a per-function tuning problem but as a fleet-wide policy decision with tiered provisioned concurrency. Identifying that the WASM linear memory model creates a serialization tax that makes WASM inappropriate for chatty interfaces. And recognizing that SQS BatchItemFailures is not just an optimization but a correctness requirement for idempotent processing.

For a staff or principal role, bar-raiser signals include: proposing an organizational observability contract for Lambda rather than per-function configuration. Framing the Cloudflare Workers CPU time limit as a workload classification boundary rather than a per-function optimization constraint. And identifying that the WASM Component Model changes the edge architecture decision matrix by enabling language-agnostic composition without shared memory, which eliminates a class of WASM security concerns (shared memory race conditions) at the cost of increased interface design complexity.

The highest-signal answer to "how does your organization manage 200 Lambda functions?" is not a tooling answer (we use Terraform, we use CDK) but a governance answer: we have a platform team that owns the Lambda base construct, every function uses the construct, the construct enforces our observability contract and IAM baseline, and teams cannot deploy Lambda functions outside the construct. That answer signals that the candidate thinks at organizational scale, not function scale.
