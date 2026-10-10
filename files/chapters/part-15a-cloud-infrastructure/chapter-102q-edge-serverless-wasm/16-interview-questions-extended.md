## 102Q.14 Advanced Serverless & WASM Interview Questions

**Q: What is the cold start problem in serverless and how do you mitigate it?**

A: A cold start occurs when the platform must provision a new execution environment from scratch, including loading the runtime and running initialization code, before your handler can execute. This adds latency ranging from ~50ms (Go) to >1s (JVM) to the first request on a new instance. Mitigations: (1) Use a fast-starting runtime like Go or .NET NativeAOT. (2) Defer initialization (DB connections, config loading) to the first invocation using `sync.Once` rather than `init()`. (3) Strip binaries with `-ldflags="-s -w" -trimpath` to reduce load time. (4) Enable provisioned concurrency to keep N instances pre-initialized. (5) Avoid VPC attachment unless required. If needed, use RDS Proxy to stay outside the VPC. (6) For JVM, use Lambda SnapStart (Go does not benefit as it already starts fast).

**Q: When would you use edge computing vs a traditional CDN?**

A: A traditional CDN caches static or semi-static content and cannot execute custom logic. Use edge computing when you need to: run code at low latency without involving the origin (auth, routing, A/B testing, personalization, rate limiting, request transformation). Choose edge computing when the logic is CPU-light and latency-sensitive, the result is user-specific so it cannot be cached, and global coverage with sub-10ms response is required. Traditional CDN is sufficient for static assets, large media files, and content that can be cached by URL or Vary headers.

**Q: How does WebAssembly enable portable serverless functions?**

A: A WASM binary is a platform-neutral bytecode - the same `.wasm` file runs on Fastly Compute, Cloudflare Workers (via WASM import), Fermyon Spin, and any server with a WASI-compliant runtime (wasmtime, wazero). It has a defined, sandboxed execution model with no OS dependencies, so the serverless platform does not need to provision a container or VM. Startup is near-instant (<1ms) because the JIT-compiled module is cached. The Component Model extends this by adding typed interfaces, enabling composition of functions written in different languages without ABI negotiation.

**Q: What are the limitations of serverless for backend services?**

A: (1) **Cold starts**: Latency spikes on infrequent traffic. mitigated by provisioned concurrency at extra cost. (2) **Execution duration limits**: Lambda max 15 minutes. unsuitable for long-running jobs (use ECS/Batch/Step Functions instead). (3) **Statelessness**: No in-process state between invocations. Requires external state stores (DynamoDB, ElastiCache, S3). (4) **Concurrency limits**: Account-level concurrency quotas. Burst scaling throttles at high ramp rates. (5) **Observability complexity**: Distributed traces span many functions. Requires X-Ray or OpenTelemetry correlation. (6) **Vendor lock-in**: Lambda-specific event formats (SQS, SNS, ALB) couple code to AWS. (7) **Cost at scale**: Above ~50 req/s sustained, containers or EC2 are often cheaper. (8) **Local development friction**: Emulating Lambda/edge environments locally is complex.

**Q: How does AWS Lambda pricing compare to EC2 at different traffic levels?**

A: Lambda charges per invocation ($0.20/million) plus per GB-second of duration ($0.0000133334 on arm64). At low traffic (< ~5 req/s average), Lambda is almost free compared to an always-on EC2 instance. The break-even vs a t4g.small ($12/mo) at 128 MB / 50ms average duration is approximately 40-50 million invocations/month. For sustained workloads above ~50 req/s with sub-100ms durations, a single EC2 or Fargate task becomes cheaper. Lambda's economic advantage is highest for spiky, bursty, or near-zero baseline traffic - you pay nothing when idle.

**Q: What is the difference between Lambda@Edge and Cloudflare Workers?**

A: Lambda@Edge runs your code at CloudFront PoPs (Points of Presence) triggered by CloudFront events (viewer request/response, origin request/response). It uses standard Lambda runtimes (Node.js, Python, or container images), has cold starts of 100-500ms, a maximum 5s timeout on viewer events, and is deeply integrated with the AWS ecosystem. Cloudflare Workers runs in V8 isolates (not processes/VMs) at 300+ global PoPs with near-zero cold start (~0ms due to isolate reuse), a JavaScript/WASM runtime, up to 30s CPU time on the paid plan, and Durable Objects for consistent edge state. Workers are significantly faster at startup and cheaper for simple logic. Lambda@Edge is preferable when deep AWS integration (IAM, VPC, existing Lambda logic) is required.

**Q: How do you handle state in a serverless architecture?**

A: Serverless functions are stateless by design - never rely on in-process memory persisting between invocations. State strategies: (1) **External database** (DynamoDB, RDS via RDS Proxy): authoritative persistent state. Use optimistic locking for concurrency. (2) **Distributed cache** (ElastiCache/Redis): low-latency ephemeral state. Session data, computed aggregates. (3) **Object storage** (S3): large blobs, event sourcing logs, audit trails. (4) **Workflow state** (Step Functions): long-running saga state managed by the orchestrator, not the function. (5) **Edge state** (Cloudflare Durable Objects): strongly consistent state at the edge for rate limiting, session coordination. (6) **Event sourcing**: append-only event log (Kinesis, Kafka) as the source of truth. Functions are projections. The key principle: functions read from and write to external state stores. They never own state themselves.

**Q: What is the WebAssembly Component Model and why does it matter for Go?**

A: The Component Model is a WASM standard that adds typed, high-level interfaces (strings, records, variants, resource handles) on top of WASM's numeric-only core, defined in WIT (WebAssembly Interface Types) IDL files. Components can import and export these typed interfaces. The `wasm-tools compose` utility links components at build time without manual ABI glue. For Go, this matters because: (1) TinyGo (≥0.33, experimental) can emit Component Model-compatible WASM for the `wasip2` target. (2) Go functions can be exposed as typed WIT interfaces, callable from Rust or Python components without any FFI boilerplate. (3) Go host applications can use wasmtime-go to load untrusted WASM components as sandboxed plugins with CPU budgeting via fuel metering. This enables a plugin architecture where third-party logic runs safely inside the Go server process.

---

### Junior → FAANG: Extended Interview Questions as Practice for System Design Rounds

The extended interview questions in this section are system design prompts disguised as Q&A. "How do you manage state in serverless functions?" is not a factual question. It is a design question with a correct structure (enumerate the options, give the tradeoffs for each, recommend based on the specific requirements). Practice answering these questions with the structure: (1) clarify the requirements (what consistency guarantee is needed? what is the access pattern?), (2) enumerate the options with one-sentence tradeoffs for each, (3) recommend based on the stated requirements.

The Component Model question is a high-signal differentiator at mid-level interviews for cloud platform roles. Most candidates cannot explain WIT, `wasm-tools compose`, or fuel metering. Being able to explain these concepts fluently, with a concrete example of why the Component Model matters (typed interfaces eliminate manual ABI negotiation, fuel metering enables per-invocation CPU budgeting for untrusted plugins), signals that you follow the evolution of the ecosystem, not just its current state.

### Senior @ FAANG: Interview Question Design as a Hiring Signal

At staff level, interview questions are as important as interview answers. The ability to design interview questions that reliably distinguish principal engineers from senior engineers is a hiring contribution. A question like "how do you manage state in serverless functions?" has a ceiling: a strong senior engineer can answer it completely. A better question for distinguishing principal-level thinking: "You have 500 Lambda functions across 40 teams. Describe the organizational system you would build to ensure every function is idempotent, has appropriate observability, and has a tested disaster recovery procedure." This question has no ceiling because it requires organizational design, not just technical knowledge.

The Component Model question is appropriate for a principal-level architecture interview because it requires knowing where the ecosystem is going, not just where it is. A principal engineer is expected to make architectural decisions whose implications play out over 3-5 years. The Component Model's current state (experimental TinyGo support, production Wasmtime support) and its trajectory (WASI 2.0 standardization, growing language toolchain support) are the inputs to a 2026-2028 edge architecture decision. A principal candidate who can articulate this trajectory and connect it to a specific organizational use case (reducing the cost of polyglot plugin systems) is demonstrating the forward-looking thinking that separates principal-level from senior-level judgment.
