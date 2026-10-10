## 115.15 FAANG Interview Questions

**Q: How would you build a resilient LLM client in Go that survives provider outages?**

A: Wrap each provider in a small client that implements a common `Completer` interface. In front of the clients, put a failover router with ordered priority and health scoring. Each client wraps its HTTP calls in a retry policy (exponential backoff with jitter, idempotency keys on POSTs) and a circuit breaker that opens on error rate or latency. On breaker open, the router moves to the next provider without waking the caller. Every call emits a structured log with request ID, provider, model, latency, token counts, and error class so incident review is fast.

**Q: A chat feature is burning budget. Walk through how you would cut LLM spend by half without losing quality.**

A: Attack cost along four axes. One, route simple queries to a smaller and cheaper model using a classifier on the prompt. Two, add a semantic cache keyed on the prompt embedding so frequent queries return without an LLM call. Three, compress context using summarization of older turns and retrieval-based selection rather than stuffing the entire history. Four, cap output tokens per route with stop sequences and structured output schemas. Report cost per user, per feature, and per model in a dashboard and set alerts on budget burn rate so regressions surface in minutes.

**Q: How do you test LLM integration code given non-deterministic model output?**

A: Test in layers. Unit test the client code with recorded HTTP fixtures so retries, parsing, streaming, and error classification are deterministic. Use contract tests against the provider sandbox to catch API drift. Add prompt regression tests that assert properties of the output (JSON validity, length bounds, presence of required fields, absence of forbidden content) rather than exact strings. Keep a golden set of end-to-end conversations scored by an LLM judge or by human raters, and run it before release.

**Q: Design a streaming chat endpoint in Go that handles 50,000 concurrent SSE connections.**

A: Serve SSE through `net/http` with a per-connection goroutine that reads from a per-session token channel and writes framed events. Use a single upstream LLM client per session, and fan tokens in through a buffered channel. Keep connection state small, off-heap when possible, and avoid per-token allocations by pooling buffers. Heartbeat every 15 seconds to detect dead peers. Scale horizontally behind a sticky load balancer (consistent hashing on session ID) so reconnects land on the same instance. Shed load by closing the lowest-priority sessions when the instance approaches its file descriptor limit.

**Q: How do you secure a public API that proxies LLM calls from end users?**

A: Never trust the client. Enforce authentication, per-user rate limits, and per-user cost quotas at the edge. Validate and sanitize prompts against a list of forbidden patterns before forwarding. Run a prompt injection filter and a PII scrubber on inputs. Log the full request and response under a short retention for abuse triage, and redact PII before longer-term storage. Set system prompts and tool allowlists server-side so a user cannot elevate privileges by rewriting the system message. Audit every tool call for authorization on the user, not on the model.

### Junior → FAANG: Interview Question Practice Strategy

For each question in this set, practice the answer in the following format: one sentence describing the core challenge, one sentence describing the solution approach, one sentence describing the key implementation detail, one sentence describing the failure mode that the approach prevents. This four-sentence structure produces answers that are concise enough for a 45-minute interview while demonstrating depth on each topic.

The cost question ("cut LLM spend by half without losing quality") is the highest-frequency question in this set, and it usually opens onto the multi-tenant gateway as a follow-up, so prepare that as one continuous answer. Practice until you can deliver the gateway portion in four minutes: describe the gateway architecture (single service, per-service API keys, rate limiting by service and user, cost attribution by service and feature), the key design decision (the gateway is an aggregating proxy, not a routing proxy, so it enforces all policies centrally before forwarding), and the failure mode it prevents (without the gateway, each service implements its own rate limiting inconsistently, creating cost management and compliance gaps).

### Senior @ FAANG: Interview Questions as Bar-Raiser Calibration Tools

The security question (how do you secure an LLM API that is exposed to users?) is one of the best bar-raiser questions in this set because it differentiates L4 (describes individual security measures) from L5 (describes a defense-in-depth approach with multiple layers) from L6 (describes a platform-level enforcement mechanism with per-feature customization and organizational governance). An L6 answer to this question covers: authentication and authorization at the API gateway level, prompt injection detection and filtering at the LLM gateway level, output validation and content moderation at the application level, and organizational policy governance at the security review level. The four-layer answer demonstrates the systems thinking and organizational awareness expected at staff level.

The cost management question (how do you prevent runaway LLM API costs?) is a quantitative reasoning question in disguise. A strong answer states its price assumption, then runs the arithmetic live: "Call it $30 per million output tokens for a frontier model, and check the current pricing page before committing to anything. A user generating 100,000 tokens a day costs $3 a day, so $90 a month. Ten thousand such users is $30,000 a day, which is $900,000 a month. A per-user daily budget of 10,000 tokens brings that to $3,000 a day. The 10x reduction is what justifies the engineering investment in budget enforcement."

Two things make this answer strong, and neither is the multiplication. Naming the price as an assumption rather than a fact signals that you know these numbers move monthly, which is exactly what an interviewer working on this stuff wants to hear. And the conclusion connects the engineering to the money, which is the actual question being asked.

---
