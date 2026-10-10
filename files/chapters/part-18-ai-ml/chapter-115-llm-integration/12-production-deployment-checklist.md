## 115.11 Production Deployment Checklist

Before deploying LLM-powered services to production:

1. **API Key Security**
   - Never commit API keys to version control
   - Use environment variables or secret managers (AWS Secrets Manager, HashiCorp Vault)
   - Rotate keys regularly

2. **Rate Limiting**
   - Implement both client-side and server-side rate limiting
   - Monitor API quota usage
   - Set up alerts for rate limit violations

3. **Cost Controls**
   - Set hard budget limits
   - Monitor costs in real-time
   - Implement tiered service levels (free users get fewer tokens)

4. **Error Handling**
   - Retry transient failures with exponential backoff
   - Use circuit breakers to prevent cascading failures
   - Provide meaningful error messages to users

5. **Monitoring**
   - Track latency, token usage, and costs
   - Set up alerts for anomalies
   - Log all LLM interactions for debugging

6. **Performance**
   - Cache common responses
   - Use streaming for long responses
   - Consider using smaller/faster models for simple tasks

7. **Content Safety**
   - Implement content filtering
   - Monitor for prompt injection attempts
   - Use moderation APIs where available

### Junior → FAANG: Checklists as Production Readiness Gates

Work through every item on this checklist for your LLM integration projects before claiming they are production-ready. Most junior engineers miss the security section: prompt injection monitoring, input validation, and PII scrubbing are not optional features for any LLM application that handles user-provided text. A prompt injection attack that causes the model to reveal system prompt contents, fabricate facts, or take unintended actions is a security incident that damages user trust and can have regulatory consequences. Treating security as a checklist item rather than an afterthought is the professional standard.

The performance section of this checklist introduces concepts that many juniors have not applied to LLM systems specifically: connection pooling for API HTTP clients, request batching for embedding calls (batch multiple texts into a single API call rather than one call per text), and response caching (cache responses for repeated or similar prompts). Each of these optimizations is straightforward in Go and can reduce both latency and cost.

Connection pooling deserves a Go-specific warning, because the language makes it look automatic and then quietly stops doing it for you. Reusing a connection saves a fresh TCP handshake plus a TLS negotiation, which is a real saving on every call and a large one when the provider is geographically distant. Go gives you this by default: `http.Client` keeps connections alive as long as you reuse the same client. Two mistakes throw it away. Constructing a new `http.Client` per request creates a new `Transport` with its own private pool, so nothing is ever reused. And failing to fully read and close each response body prevents that connection from returning to the pool at all: `defer resp.Body.Close()` alone is not sufficient if you abandon the body unread, so drain it (`io.Copy(io.Discard, resp.Body)`) before closing when you do not intend to consume it. In a streaming LLM client, where bodies are long-lived and abandoning them early is routine, this is the difference between a stable pool and one that bleeds connections until the process wedges.

Make the checklist part of your personal pre-launch review for every LLM feature you build. Check off each item explicitly, document any items you intentionally deferred (with a date by which they will be completed), and get a teammate to review the checklist before deployment. This practice, applied consistently, will prevent most of the common LLM production failures described in the pitfalls section.

### Senior @ FAANG: Deployment Checklist as Organizational Gate

At senior level, this checklist becomes an automated gate in the deployment pipeline. Items in the security section can be enforced by security scanning tools that check for hardcoded API keys, validate that all inputs pass through a sanitization function, and verify that PII scrubbing is configured. Items in the observability section can be validated by checking that the required Prometheus metrics are registered and that Grafana dashboards include the required panels. Items in the reliability section can be validated by integration tests that simulate API failures and verify circuit breaker behavior.

Converting the manual checklist to automated enforcement eliminates the human error of skipping checklist items under deadline pressure. The goal is a deployment pipeline where any LLM service that does not satisfy the checklist items fails to deploy automatically, making the safe path the easy path. This requires investment in tooling but pays for itself the first time it catches a production-bound security flaw or missing observability configuration.

At L6, you own the evolution of this checklist. Each production incident that could have been prevented by a checklist item that was missing or insufficiently specific becomes a candidate for a checklist update. The checklist is a living document that reflects the accumulated operational wisdom of the team, and keeping it current and actionable is a staff-level responsibility. Sharing the updated checklist with peer teams across the organization through internal tech talks and design reviews multiplies its impact.

---
