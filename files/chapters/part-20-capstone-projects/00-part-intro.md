# Part XX: Capstone Projects

*"I hear and I forget. I see and I remember. I do and I understand."* - Confucius

---

Reading about system design, concurrency patterns, and distributed architectures builds knowledge. Building real systems from scratch builds skill. There is no substitute for the experience of wrestling with a database schema that does not scale, debugging a race condition in a concurrent pipeline, or redesigning an API after discovering that your initial model cannot support a critical use case. These are the moments where theoretical knowledge transforms into engineering intuition - and that intuition is exactly what FAANG interviewers and hiring managers are looking for.

This part contains fifteen capstone projects that span the full spectrum of backend engineering complexity. Each project is designed to exercise multiple skills from earlier parts of this book simultaneously. A URL shortener requires database design, caching, and API development. A distributed cache demands concurrency, consistent hashing, and failure handling. A trading system pushes you to the limits of low-latency design, reliability engineering, and domain modeling. By the time you complete several of these projects, you will have a portfolio of production-quality Go systems and the confidence that comes from building them yourself.

The projects progress from beginner to expert difficulty, and each is scoped to be completable by a single developer. They are not toy examples - they are simplified versions of real systems running at FAANG companies today. The architectural decisions you make in these projects mirror the decisions you will face in system design interviews and on the job.

**What this part covers:**
- Project 1: URL Shortener (Beginner) - databases, REST APIs, caching, and analytics
- Project 2: Real-Time Chat Application (Intermediate) - WebSockets, real-time messaging, concurrency, and presence
- Project 3: E-Commerce Platform (Intermediate) - microservices, payments, inventory management, and order processing
- Project 4: Distributed Cache (Intermediate) - consistent hashing, replication, eviction policies, and cluster management
- Project 5: Search Engine (Advanced) - indexing, ranking algorithms, query parsing, and performance optimization
- Project 6: Social Network Backend (Advanced) - feed generation, graph queries, notifications, and scale challenges
- Project 7: CI/CD Platform (Advanced) - container orchestration, pipeline execution, artifact management, and automation
- Project 8: Kubernetes Controller (Advanced) - custom operators, reconciliation loops, and Kubernetes API integration
- Project 9: Observability Platform (Advanced) - metrics ingestion, trace collection, log aggregation, and alerting
- Project 10: API Gateway (Advanced) - routing, authentication, rate limiting, and request transformation
- Project 11: Data Pipeline (Advanced) - streaming, batch processing, orchestration, and exactly-once semantics
- Project 12: ML Platform (Expert) - model serving, feature stores, experiment tracking, and inference optimization
- Project 13: Trading System (Expert) - order matching, low-latency design, market data, and compliance
- Project 14: SaaS Platform (Expert) - multi-tenancy, billing, usage metering, and tenant isolation
- Project 15: Search Engineering (Expert) - inverted indexes, BM25 ranking, autocomplete, and search quality measurement

### How to Use This Part

Start with Project 1 (URL Shortener) regardless of your experience level - it serves as a warm-up that validates your Go fundamentals. Then choose projects based on your target role and interview preparation needs. If you are preparing for system design interviews, prioritize the distributed cache, search engine, and API gateway projects. If you are targeting a specific domain, choose the corresponding project. Aim to complete at least four to five projects across different difficulty levels.

### FAANG Relevance

Many FAANG system design interview questions map directly to these projects. "Design a URL shortener" is a classic warm-up question. "Design a distributed cache" tests your distributed systems knowledge. "Design a trading system" evaluates your ability to handle low-latency and reliability requirements. Completing these projects gives you first-hand experience with the exact systems you will be asked to design in interviews, and the resulting code serves as a portfolio that demonstrates your engineering capabilities to potential employers.

### Junior → FAANG: How Capstone Projects Change the Interview Conversation

Many junior candidates show up to system design interviews with theoretical knowledge but no first-hand experience building the systems they are asked to design. Working through these projects closes that gap. When an interviewer asks "design a URL shortener," someone who has built one can discuss real tradeoffs rather than reciting memorized answers.

Start with Project 1 even if it seems too easy. The discipline of finishing a project and making deliberate architectural choices carries over to every subsequent project. Document your decisions as you build: why you picked PostgreSQL over SQLite, why you chose Redis for the cache tier, what you would change under 10x traffic. Interviewers notice candidates who can speak to their own code's weaknesses.

For entry-level interviews, having two or three completed projects from this list is a strong differentiator. Pick projects that align with your target team: distributed systems roles benefit from Projects 4 and 5, platform engineering roles from Projects 7 and 8, product-focused roles from Projects 2 and 3.

### Senior @ FAANG: Using Capstone Work to Demonstrate L6/L7 Thinking

Senior engineers at FAANG are evaluated not only on what they build but on whether their architectural instincts scale to ambiguous problems and large organizations. Capstone projects are an opportunity to practice and demonstrate exactly that kind of thinking.

When working through these projects, resist the temptation to reach for the most sophisticated solution immediately. The real senior signal is knowing when a simple approach is sufficient and articulating the precise conditions under which you would escalate to something more complex. For example: a single-node Redis with read replicas may serve a URL shortener at 100k RPS with acceptable SLAs. The decision to move to a distributed cache tier should be driven by data, not instinct.

Treat each project as an Architecture Decision Record exercise. For every significant choice, write a brief ADR: the context, the options considered, the decision, and the consequences. This habit directly maps to the staff-level expectation that architectural decisions are explicit, reviewable, and reversible.

At the L6 and L7 bar, interviewers probe for platform thinking. When you finish a project, ask yourself: if five teams needed to build something similar, what would I extract into a shared platform? That question surfaces the difference between writing good service code and designing the infrastructure that makes a whole engineering organization move faster. Projects 7, 8, 9, and 10 in particular are rich ground for this kind of thinking.

Governance matters at scale. Consider what operational contracts each project exposes: SLAs, API stability guarantees, data retention policies, security boundaries. Bar-raiser interviewers often ask about operational ownership, not just implementation. A senior candidate should be able to describe not only how a system works but who is responsible for each failure mode, how incidents are detected, and what the runbook looks like.

---

### Navigation & Cross-References

- **Previous Part:** [Part XIX: Blockchain and Web3](../part-19-blockchain/00-part-intro.md)
- **Previous Chapter:** [Chapter 123: Web3 Infrastructure with Go](../part-19-blockchain/chapter-123-web3-infrastructure/00-introduction.md)
- **Current Project:** [Project 1: URL Shortener](project-01-url-shortener/00-introduction.md)
- **Next Part:** [Part XXI: Systems Programming with C++](../part-21a-cpp/chapter-124-why-cpp/00-introduction.md)
