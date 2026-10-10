## 102Q.10 Mid-Chapter Synthesis: Core Architecture Recap

| Topic | Key Command/Pattern |
|-------|---------------------|
| AWS Lambda | `lambda.Start(handler)`, arm64, `-ldflags="-s -w"` |
| Cloud Run | Standard HTTP server, graceful shutdown on SIGTERM |
| Cloudflare Workers | `GOOS=js GOARCH=wasm`, JS glue code |
| Browser WASM | `syscall/js`, `js.FuncOf`, `select{}` to block |
| WASI | `GOOS=wasip1 GOARCH=wasm`, wasmtime/wazero |
| TinyGo | `tinygo build -target=wasm`, ~50KB output |
| Embedded WASM | `wazero.NewRuntime`, `CompileModule`, `InstantiateModule` |
| Idempotency | Conditional DynamoDB put, store result for dedup |
| Saga pattern | Forward + compensating transactions |
| Cold start | `sync.Once` init, small binary, arm64 |


---

### Junior → FAANG: Converting the Summary Table to Durable Habits

The summary table is a review tool, not a reference document. Every row should map to a habit or a checklist item, not just a fact. "Small binary, arm64" means: add `-ldflags="-s -w"` to every Lambda build command, add `GOARCH=arm64` to every Lambda Makefile target, and measure the binary size before and after to confirm the optimization was applied. "Idempotency key" means: before writing any Lambda SQS handler, design the idempotency key derivation and the DynamoDB check pattern, not just the business logic.

The three most important habits from this chapter: always build with `CGO_ENABLED=0 GOARCH=arm64`, always initialize SDK clients outside the handler function, and always return `BatchItemFailures` for SQS handlers. These three habits prevent the three most common categories of Lambda production incidents. Everything else in the summary table is valuable, but these three are the ones that matter most in the first six months of working with Lambda in production.

### Senior @ FAANG: Serverless Platform Maturity Model

At staff level, the summary table is a checklist for evaluating an organization's serverless platform maturity. A level 1 organization has Lambda functions deployed manually or with basic Terraform, no standard IAM role baseline, no observability contract, and no cold start measurement. A level 2 organization has IaC for Lambda deployments, a shared IAM role template, and basic CloudWatch dashboards. A level 3 organization has a platform-owned CDK or Terraform module that enforces the IAM baseline, observability contract, and cold start measurement for every function, with organizational metrics tracking cold start frequency and p99 latency across the Lambda fleet. A level 4 organization adds automated cold start budgeting (functions that exceed the cold start budget trigger automated alerts and provisioned concurrency recommendations), fleet-wide cost optimization (rightsizing memory based on CloudWatch metrics), and a canary deployment standard for all Lambda function updates.

The staff engineer's contribution is advancing the organization from its current level to the next level with a concrete plan and measurable outcomes. Level 1 to 2: standardize IaC for Lambda deployments, measurable by percentage of Lambda functions managed by IaC. Level 2 to 3: build and adopt the platform module, measurable by percentage of functions using the module. Level 3 to 4: implement automated rightsizing and canary deployment, measurable by reduction in Lambda-related incidents and cost per invocation. Each transition has a defined deliverable, a measurable outcome, and a timeline, which is how platform improvements get funded and prioritized at organizations that make decisions based on evidence.
