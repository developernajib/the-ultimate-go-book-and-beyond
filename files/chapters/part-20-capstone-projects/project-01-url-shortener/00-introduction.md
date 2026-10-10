# Capstone Project 1: Production URL Shortener

**Difficulty**: Intermediate
**Estimated Time**: 2-3 weeks
**Target**: Production-ready bit.ly/TinyURL clone
**Tech Stack**: Go 1.27+, PostgreSQL, Redis, Docker, Kubernetes, Prometheus

---

### Junior → FAANG: Building Your First Production-Grade Go Service

A URL shortener is the "hello world" of system design interviews and one of the best first projects for a junior engineer. The scope is well-defined, the tradeoffs are learnable, and the finished system covers all the fundamentals: HTTP servers, database persistence, caching, and basic deployment.

Common beginner gaps on this project: not handling hash collisions explicitly, using in-memory maps instead of a real data store, skipping error handling on database calls, and deploying only with `go run` rather than a proper Docker build. Work through each of these gaps deliberately before moving on.

For entry-level FAANG interviews, being able to walk through "how your URL shortener handles 10x traffic" demonstrates you understand caching layers and stateless scaling. That conversation matters more than perfectly optimized code.

### Senior @ FAANG: What the URL Shortener Reveals About Platform Maturity

Senior engineers use the URL shortener as a lens to probe operational readiness, not just functionality. The naive version works. The production version survives traffic spikes, handles data-plane and control-plane failures independently, and exposes the right observability signals for on-call engineers.

Key ADR questions for a senior implementation: should the short code be generated at write time or on demand? Write-time generation is simpler but requires collision handling under concurrent writes. Demand generation with a counter avoids collisions but introduces a single-sequence bottleneck. At FAANG scale, the answer often involves pre-generating pools of codes distributed across shards.

At the L6 bar, interviewers expect you to reason about multi-region deployment. The read path for URL resolution can be served from any region with eventual consistency. The write path needs strong consistency to avoid duplicate short codes. That asymmetry drives the architecture: use a distributed write coordinator or a globally ordered sequence service for writes, and push read replicas aggressively close to users.

Governance signals include analytics data retention policy (GDPR compliance for click data), abuse prevention (malicious URL blocking integrated at write time, not redirect time), and SLA definition (p99 redirect latency commitment and how it is monitored). A bar-raiser interviewer will ask who owns the abuse queue, how an on-call engineer is alerted when redirect error rates spike, and what the runbook says. If you can answer those questions from your own implementation experience, you stand out.

---
