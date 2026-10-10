## Learning Objectives

By the end of this chapter, you will:
- Understand the serverless execution model - stateless function invocation, managed scaling, and the lifecycle from cold start through handler execution to teardown
- Be able to optimize Lambda cold start latency in Go through binary size reduction, init() minimization, connection pre-warming, and Provisioned Concurrency configuration
- Know how to compile Go to WebAssembly (WASM) for browser targets and to WASI for server-side runtimes such as Wasmtime and WasmEdge
- Understand edge computing patterns including request colocated computation, geo-routing, cache personalization at the edge, and the constraints of edge runtime sandboxes
- Be able to build and deploy Go-based edge functions to Cloudflare Workers using the WASM compilation target and the Workers KV/Durable Objects storage primitives
- Understand the serverless cost model - per-invocation pricing, memory/duration billing, data transfer costs - and design functions to minimize spend at scale
- Know how to design stateless serverless functions, externalizing all state to managed services (DynamoDB, S3, Redis) and handling idempotency for at-least-once invocation semantics
- Be able to compare serverless vendor offerings (AWS Lambda, GCP Cloud Run, Azure Functions, Cloudflare Workers, Fastly Compute) across cold start, pricing, runtime support, and operational complexity

---

### Junior → FAANG: Using Learning Objectives as an Interview Gap Checklist

The objectives in this chapter map directly to interview topics at mid-level engineering roles. "Implement Lambda function handling" is table stakes. "Optimize binary size for cold start" is a differentiator. "Design idempotent handlers for at-least-once semantics" signals that you have thought about production failure modes, not just happy-path functionality. Review each objective and honestly assess: can I explain this concept out loud, and can I write the code to demonstrate it? The gap between those two answers is where focused study time should go.

The vendor comparison objective deserves specific attention. Interviewers at FAANG and post-Series-B companies will ask "why Lambda vs Cloud Run?" and expect a structured answer: cold start characteristics, billing model, maximum execution duration, concurrency model, and operational complexity. Preparing a comparison table across at least three vendors (Lambda, Cloud Run, Cloudflare Workers) before an interview covers the vast majority of follow-up questions.

### Senior @ FAANG: Learning Objectives as Platform Competency Standards

At staff level, these objectives are the baseline competency checklist for any engineer contributing to serverless platform work, not just the author's personal learning agenda. If the team owns a Lambda-based service in production, every engineer on the team should be able to explain at-least-once semantics and idempotency, not just the engineer who originally wrote the function. The staff engineer's job is to ensure the team collectively meets the baseline.

The vendor comparison objective scales into an architectural responsibility: maintaining a live ADR that tracks the organization's serverless platform choices, the rationale, and the criteria that would trigger a re-evaluation. Cold start benchmarks change with runtime versions (Lambda SnapStart, Cloud Run min instances). Pricing models change with provider competition. The ADR should have a review cadence (annually at minimum) so the platform choice remains evidence-based rather than historical inertia. An organization that chose Lambda in 2020 without re-evaluating Cloud Run's autoscaling model improvements in 2022-2024 may be leaving both performance and cost improvements on the table.
