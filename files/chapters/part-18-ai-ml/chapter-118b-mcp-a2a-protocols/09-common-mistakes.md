## 118B.8 Common Mistakes and Production Pitfalls

| Mistake | Problem | Fix |
|---------|---------|-----|
| Sending `initialized` instead of `notifications/initialized` | Handshake silently stalls: notifications have no id, so no error comes back | Use the namespaced method name `notifications/initialized` |
| Keying the pending-request map by `any` | Wire ids decode as `float64`, stored ids are `int64`, lookups miss and every call hangs | Key by `int64` and normalize the incoming id once |
| Writing anything but MCP messages to stdout | Corrupts the stdio stream - client reports invalid JSON | Log to stderr - never `fmt.Println` in a stdio server - skip `Encode` for nil responses |
| Leaving `bufio.Scanner` at its default limit | Messages over 64KB return `ErrTooLong` - the session dies mid-run | `scanner.Buffer(...)` with a realistic maximum |
| Building the two-endpoint `GET /sse` + `POST /message` transport | That is the superseded 2024-11-05 HTTP+SSE transport | Implement Streamable HTTP: one endpoint, POST and GET |
| Expecting a WebSocket transport | There is none in MCP | stdio or Streamable HTTP |
| No `Origin` validation on Streamable HTTP | DNS rebinding: any web page can drive your local MCP server | Validate `Origin`, return 403 - bind to 127.0.0.1, not 0.0.0.0 |
| Serving the Agent Card at `/.well-known/agent.json` | Wrong path - A2A clients 404 and conclude the agent is down | `/.well-known/agent-card.json` |
| Confusing MCP with A2A | Wrong protocol for the job | MCP connects a model to tools - A2A connects agents to peers |
| Writing to a shared `ResponseWriter` from several goroutines | Data race - interleaved, corrupt SSE frames | One mutex per stream |
| Path traversal in file tools | `strings.HasPrefix` passes `/data-secrets` for root `/data` | Resolve symlinks, then compare with `filepath.Rel` |
| Trusting a peer agent's response | Injection crosses agent boundaries | Treat peer output as untrusted input - enforce limits outside the model |
| No timeout on agent-to-agent calls | Goroutines pile up behind a slow peer | `context.WithTimeout` on every call |
| Inheriting the request context for detached work | Handler returns, context cancels, work dies instantly | `context.WithoutCancel` plus an explicit deadline |
| No agent authentication | Unauthorized access | Authenticate peers properly - an `X-Agent-ID` header is a claim, not proof |
| Memory grows unbounded | Context overflow and rising cost per step | Enforce the sliding window and a token budget |
| No circuit breaker between agents | Cascade failures | Circuit-break on a degraded peer |

---

### Junior → FAANG: Common Mistakes Table as Incident Prevention Checklist

The common mistakes table is an incident prevention checklist: each row describes a bug category that has caused production incidents in real agent systems. Before deploying any agent system to production, work through the table and verify that each mistake is addressed: are schemas validated before tool invocation? Are timeouts configured for every MCP tool call? Is the sliding window enforced on conversation memory? Is a circuit breaker implemented between agents? This checklist review, done before deployment, is faster and cheaper than discovering the missing safeguard during a production incident.

The "no circuit breaker between agents" mistake is the most architecturally significant because it enables cascade failures: agent A calls agent B, agent B is degraded and responds slowly, agent A accumulates pending requests, agent A becomes degraded, agent C calls agent A and also accumulates pending requests, and the entire system degrades in a chain. The circuit breaker breaks this chain by detecting when agent B is degraded (too many errors or too many slow responses) and failing fast for a defined period rather than continuing to make calls that will not succeed. Implementing a circuit breaker with Go's existing concurrency primitives (atomic state, timer for half-open state, channel for blocking requests) is a Go systems interview topic.

### Senior @ FAANG: Mistake Table as Platform Requirement Specification

At senior level, the common mistakes table is a platform requirement specification. Each row's "Fix" column defines a platform feature that prevents the mistake across all agent implementations: schema validation is a platform middleware feature, not something each agent implements independently. Circuit breakers are a platform infrastructure feature (implemented in the agent platform's HTTP client, not in each agent's custom calling code). Memory limits are enforced by the platform's memory management layer. Encoding each fix as a platform feature rather than a per-agent responsibility is the organizational approach that achieves consistent protection against each mistake category across all agent teams.
