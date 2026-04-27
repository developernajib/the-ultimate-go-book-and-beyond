export default `## Exercises

### Exercise 1: Industry Research
Pick one company from this chapter (Google, Uber, Netflix, Cloudflare, Stripe, or Twitch) and find their engineering blog. Read at least two articles about how they use Go. Write a summary of:
- What problems Go solved for them
- What patterns they developed
- Any challenges they encountered

### Exercise 2: Language Comparison
If you have experience with another language (Python, Java, Rust, Node.js):
1. Write a simple HTTP server that returns JSON in both languages
2. Compare: lines of code, dependencies required, startup time, memory usage
3. Document your findings

### Exercise 3: Tool Exploration
Run the following commands and understand their output:
\`\`\`bash
go help
go doc fmt
go doc net/http
go env
go mod graph  # (in a project with dependencies)
\`\`\`

### Exercise 4: Production Hello World
Extend the Hello World application to:
1. Add a \`/metrics\` endpoint that returns request counts
2. Add a configuration file loader
3. Add request ID tracking in logs
4. Write tests for each handler

### Exercise 5: Docker Optimization
Using the Dockerfile template:
1. Build the image and measure its size
2. Research ways to reduce the image size further
3. Implement scratch-based image with all dependencies
4. Compare startup times between different base images

### Exercise 6: Benchmark Practice
Create benchmarks for:
1. JSON serialization with encoding/json vs third-party libraries
2. String concatenation methods
3. Map vs slice lookup for small collections

\`\`\`go
func BenchmarkJSONMarshal(b *testing.B) {
    data := Response{Message: "test", Timestamp: time.Now()}
    for b.Loop() {
        json.Marshal(data)
    }
}
\`\`\`

### Exercise 7 (Senior Track): Read a Real Go Proposal

Pick one accepted Go proposal from [github.com/golang/proposal](https://github.com/golang/proposal) that shipped in Go 1.21-1.26. Good candidates: \`log/slog\`, range-over-func iterators, \`testing/synctest\`, self-referential generic types, container-aware \`GOMAXPROCS\`, Green Tea GC.

For the proposal you choose, write a one-page summary covering:
1. The problem the proposal solves and the prior workarounds teams used
2. The design tradeoffs called out in the discussion (performance, backwards compatibility, ecosystem churn)
3. At least one alternative design that was rejected, and why
4. A concrete change in your current codebase (or a hypothetical one) where this proposal would let you delete code or remove a workaround

The goal is to train the muscle of reading language-design prose and reasoning about language-level tradeoffs. This is the reading pattern that separates senior engineers who shape their org's stack from engineers who consume whatever ships.

### Exercise 8 (Senior Track): Write a Go Migration ADR

Pick a service you know well (current employer, prior employer, or a realistic hypothetical). Write a one-page Architecture Decision Record proposing its migration to Go (or explicitly arguing against the migration).

Required sections:
- **Context**: what the service does, its current language and runtime, its scale (RPS, memory, team size), and the pain points driving the ADR
- **Decision**: the proposed language choice (Go or stay)
- **Consequences**: three positive and three negative outcomes, including at least one operational outcome (deployment, observability, on-call), one team outcome (hiring, ramp-up, knowledge transfer), and one performance outcome (CPU, memory, latency)
- **Alternatives Considered**: at least two other languages with one-sentence reasons they were rejected
- **Rollout Plan**: strangler-fig or big-bang, with a concrete cutover milestone

This is the document format FAANG staff engineers write when they propose language-level changes. Practicing the form in this exercise lets you skip the "what is an ADR" conversation on the job.

### Exercise 9 (Senior Track): Benchmark Go 1.26 Green Tea GC

If you have access to Go 1.25 and Go 1.26 toolchains (or install both via \`go install golang.org/dl/go1.25@latest\` and \`go1.26@latest\`), pick a GC-heavy benchmark (allocation-heavy JSON workload, in-memory cache with high churn) and run it under both.

Measure:
- GC wall-time (from \`GODEBUG=gctrace=1\`)
- p99 request latency
- CPU utilization
- Allocated bytes per operation (from benchmark output)

Write up what you observed and where the 10-40% overhead reduction claimed by the Go team did or did not show up on your workload. The point of the exercise is not to reproduce a marketing number, it is to develop the instinct that a GC claim is a distribution, not a scalar.

### Exercise 10 (Junior → FAANG): Time-Boxed Phone-Screen Simulation

Set a 45-minute timer. Without using the internet or notes, do the following in sequence:

1. (2 minutes) Verbally answer "Why did Google create Go?" to a voice recorder or an empty room. Replay it. Is it under 90 seconds? Does it name the three pain points (compile time, concurrency safety, team readability)? Does it avoid hand-waving?
2. (10 minutes) On a blank terminal on your laptop, from memory: \`go mod init example.com/screen\`, write a \`main.go\` that starts an HTTP server on \`:8080\` with a \`/hello\` endpoint returning JSON, add graceful shutdown, and \`go run main.go\`. No copying from anywhere. Curl the endpoint from another terminal to verify.
3. (8 minutes) Add a \`main_test.go\` with at least two tests for the handler, using \`httptest\`, and run \`go test -race ./...\`. All green.
4. (10 minutes) Answer verbally: "Walk me through goroutines vs OS threads." Hit the M:N scheduler, the 2KB stack, goroutine creation cost, and one failure mode (goroutine leaks without cancellation). Under three minutes.
5. (5 minutes) Answer verbally: "When would you not use Go?" Name at least three categories (ML training, hard real-time, frontend).
6. (10 minutes) Implement a rate limiter that allows at most N requests per second, tested, using either \`golang.org/x/time/rate\` or a hand-rolled token bucket.

If you finish all six within the 45 minutes with passing tests, you are at the floor of a FAANG Go phone screen. If you cannot, identify which step stalled you and drill that step specifically before your real interview. The single most common stall is step 2 (muscle memory of \`go mod init\` through \`go run\`) which is fixable with a weekend of practice.

### Exercise 11 (Senior Track): Stdlib Code Reading

Pick one small package from the Go standard library and read it end to end. Good candidates for a one-evening read: \`errors\` (200 lines), \`sync/errgroup\` (\`golang.org/x/sync/errgroup\`, 100 lines), \`container/heap\` (200 lines), \`log/slog/internal/buffer\` (small, surprisingly instructive), \`encoding/hex\` (300 lines).

As you read, take notes on:
1. What idioms the stdlib authors use that differ from typical application code (you will find a lot of table-driven tests, very few interfaces at the producer, aggressive use of \`//go:build\` tags, and near-total absence of third-party dependencies).
2. What the public API surface is vs. the internal helper surface: how do they decide what to export?
3. What error handling looks like in a package designed to be used by millions of projects.
4. How tests are structured for a package with high reliability requirements.

Write a two-page summary. The exercise is training data for your own library design: the Go standard library is the canonical style guide, and no amount of third-party blog reading substitutes for reading the actual source.

### Exercise 12 (Staff / Principal Track): Deliver a Ten-Minute Tech Talk

Prepare and record a ten-minute internal-tech-talk titled "Should we use Go for [specific project at your org]?" The audience is your engineering leadership (directors and VPs who may not write Go themselves).

Required structure:
1. (1 minute) Problem framing: what specific project are we evaluating, what are the current pain points in concrete numbers.
2. (3 minutes) Candidate languages: Go, plus two others, with one slide each on the honest tradeoffs.
3. (3 minutes) Recommendation with rationale: which language, why, and what you are giving up.
4. (2 minutes) Risks and mitigations: the three largest risks of your recommendation and how you propose to manage them.
5. (1 minute) Ask: what decision you need from leadership and by when.

Record yourself giving the talk. Watch it back. This is the specific performance pattern that separates senior engineers from staff engineers in most FAANG-equivalents: the ability to compress a technical recommendation into a ten-minute narrative that a director can defend upward without rewriting. If you cannot do it in ten minutes, you are not ready to advocate for a language decision at that altitude; practice until you can.

---
`;
