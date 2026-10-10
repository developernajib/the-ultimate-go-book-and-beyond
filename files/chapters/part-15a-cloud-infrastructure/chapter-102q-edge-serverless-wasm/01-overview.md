## Overview

The compute landscape has shifted dramatically. Serverless functions run code without managing servers. Edge runtimes execute code milliseconds from users. WebAssembly enables near-native performance in browsers and servers alike. Go's small binaries, fast startup, and excellent toolchain make it uniquely suited for all three paradigms.

After this chapter you will be able to:
- Deploy Go code to AWS Lambda, Google Cloud Functions, and Azure Functions
- Build edge functions for Cloudflare Workers and Fastly Compute
- Compile Go to WebAssembly for both browser and WASI targets
- Optimize cold-start time, binary size, and memory footprint
- Design serverless architectures that handle scale and failure gracefully
- Use TinyGo for ultra-small deployments (50KB binaries)

---

### Junior → FAANG: Building the Serverless and Edge Mental Map Early

The overview lays out three paradigms: serverless, edge, and WASM. Each has a different operational contract, and confusing them is a common interview mistake. Serverless (Lambda, Cloud Run) means you provide the binary and the cloud manages the host, the scaling, and the lifecycle. Edge (Cloudflare Workers, Fastly Compute) means your code runs in a V8 isolate or WASM sandbox at a geographically distributed PoP with strict CPU time limits (typically 10-50ms). WASM means your Go binary compiles to a portable format that runs inside a host runtime, with no network access unless the host provides it. Each of these is a different execution model with different constraints.

First-job habit: before deploying any workload to one of these targets, confirm three things: the memory limit (Lambda default is 128MB to 10GB, Cloudflare Workers is 128MB), the CPU time limit (Workers has a 10ms CPU time limit per request on the free tier), and the cold start latency requirement. These three constraints together determine whether the workload fits the platform.

### Senior @ FAANG: Execution Model Selection as Platform Policy

At staff level, the overview is a starting point for a platform decision matrix. The matrix defines which execution model is appropriate for which workload class, and it is enforced organizationally rather than left to individual team judgment. A defensible matrix looks like this: background batch processing belongs in container workloads where CPU and memory limits can be tuned without cold start constraints. Event-driven, bursty, stateless request handling belongs in Lambda or Cloud Run. Globally distributed, latency-critical, lightweight request transformation belongs at the edge. Portable compute that must run in environments the platform does not control (third-party plugins, sandboxed user code) belongs in WASM.

The matrix drives organizational efficiency in two ways. First, teams do not independently evaluate all three paradigms for every workload, which wastes engineering time and produces inconsistent infrastructure. Second, the platform team can build shared tooling (a standard Lambda base handler with tracing and structured logging, a standard Cloudflare Worker scaffold with rate limiting and error reporting) that works across all teams using the same execution model. The organizational leverage is in the standardization, not in the individual function deployments.

Go's position in this matrix is stronger than many engineers assume. Its binary size after careful selection of included packages is competitive with Rust for Lambda and WASM workloads. Its startup latency for a minimal Lambda handler is under 10ms. Its standard library's HTTP server is appropriate for Cloud Run workloads without additional framework overhead. The platform team's job is to document these properties with measured benchmarks so teams can make execution model decisions with evidence rather than folklore.
