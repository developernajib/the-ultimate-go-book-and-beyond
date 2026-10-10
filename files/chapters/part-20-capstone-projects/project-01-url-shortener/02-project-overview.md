## Project Overview

We'll build **GoShort** - a production-ready URL shortener that can handle millions of requests. The system supports:

- **URL shortening** with custom aliases and expiration
- **Redirect service** with sub-millisecond latency
- **Analytics dashboard** (clicks, referrers, geographic data)
- **Rate limiting** (IP-based and user-based)
- **Custom domains** for enterprise users
- **API authentication** with API keys
- **Horizontal scaling** via stateless design
- **High availability** with Redis failover

### Why This Project Matters

URL shorteners are a classic system design interview question at FAANG:

- **Google**: Created goo.gl (now Firebase Dynamic Links)
- **Amazon**: Internal link shorteners for AWS Console
- **Meta**: fb.me and instagram.com/p/ for sharing
- **Twitter**: t.co for all shared links
- **LinkedIn**: lnkd.in for share tracking

This project teaches:
- **System design**: Sharding, caching, analytics at scale
- **API design**: RESTful endpoints, versioning, pagination
- **Data modeling**: Time-series data, efficient indexing
- **Performance**: Sub-5ms redirects, handling traffic spikes
- **DevOps**: Containerization, orchestration, monitoring

---

### Junior → FAANG: Scoping a Project to Match Interview Expectations

GoShort's feature list is exactly what appears in FAANG design interview prompts. Before your interview, be able to draw the system from memory: client, load balancer, application tier, cache tier, database, analytics sink. Know the request flow for both a write (shorten) and a read (redirect). Know what happens when Redis is unavailable.

Junior candidates often describe only the happy path. Practice narrating the failure path: Redis miss, database lookup, cache repopulation. That end-to-end fluency is what interviewers are testing, not whether you memorized the architecture diagram.

Custom domain support and enterprise features are not required for a passing interview. Mention them as scope you would add given more time. That signals product thinking without overcomplicating your answer.

### Senior @ FAANG: Feature Scope as a Product and Organizational Signal

Custom domain support for enterprise users seems like a feature, but it is an organizational commitment. It requires TLS certificate provisioning, DNS management, tenant isolation, and a support contract. A senior engineer evaluates whether the team has the operational capability to own that feature before agreeing to build it.

This is the platform thinking lens: every feature in the overview list should be evaluated against who owns it in production, what its failure modes are, and how it is monitored. "Rate limiting" as a bullet point becomes three distinct concerns at FAANG scale: rate limiting at the edge (CDN or load balancer), at the service layer (token bucket per user), and at the database layer (connection pool limits). Each layer is owned by a different team.

At L7, the project overview document is the artifact you would write before any code exists. It defines scope boundaries, identifies external dependencies, and establishes the success criteria. Reviewing this overview as a staff engineer, you would ask: what is explicitly out of scope, who are the dependent teams, and what are the acceptance criteria for "sub-5ms redirects" under what traffic conditions? Ambiguity in the overview propagates into every subsequent decision.

---
