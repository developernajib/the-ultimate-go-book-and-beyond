## Summary

Production AI systems require careful engineering beyond just calling an LLM API:

- **LLM Gateway** provides unified access to multiple providers with load balancing, fallback in a fixed priority order, caching, and cost tracking
- **RAG pipelines** ground LLM responses in factual context, reducing hallucinations and enabling private knowledge bases
- **Retrieved documents and tool output are untrusted input.** This is the chapter's central security lesson. Prompt hardening is a mitigation, never a fix: bound the damage architecturally by authorising retrieval as the asking user, validating model output before it reaches anything that acts, and gating irreversible actions behind a human
- **Vector stores** (pgvector with HNSW index) enable efficient semantic retrieval at scale, approximately: match the index operator class to the query operator, and measure recall rather than assuming it
- **Streaming** is essential for user experience, so send tokens as they arrive rather than waiting for the complete response
- **Quota management** and rate limiting prevent runaway costs and ensure fair usage, and every limit must fail closed when it cannot evaluate itself
- **Evaluation frameworks** are non-negotiable, because without systematic evals you cannot detect regressions or compare models, and a gate that passes when it has no data is worse than no gate at all
- **Cost tracking** at every layer (tokens per request, per user, per model) is essential for sustainable AI product economics

### Junior → FAANG: Summary Bullets as Interview Preparation Flashcards

Each bullet in this summary is a flashcard for AI system design interview preparation. "Unified LLM gateway over multiple providers" maps to: "how would you design a system that can use OpenAI, Anthropic, and Google as LLM providers with automatic failover?" "RAG pipelines ground responses in factual context" maps to: "how would you build a document ingestion and retrieval pipeline, and where would you add concurrency as it grows?" "Retrieved documents are untrusted input" maps to: "an employee edits a wiki page your RAG system indexes. What can they make it do?" "Evaluation frameworks are non-negotiable" maps to: "how do you ensure AI system quality doesn't degrade over time?" Practice expanding each bullet into a two-minute verbal answer with a concrete implementation example and a specific failure mode that the pattern prevents.

The security bullet is the one to rehearse hardest, because it is the one that is easiest to nod along with and hardest to answer well. The failure mode is not that you cannot describe prompt injection. It is that you describe it and then propose a system prompt as the fix. The two-minute version has three beats: name the boundary (the corpus is input), concede that hardening is a mitigation and there is no escaping function, then spend most of the time on what actually bounds the damage.

The "cost tracking at every layer" bullet is the one most junior engineers undervalue because cost is often not their responsibility in early-career positions. At FAANG, where AI costs can reach millions of dollars per month for large-scale deployments, cost engineering is a first-class engineering concern. The engineer who can design a cost tracking system that attributes LLM token costs to specific features, users, and experiments is providing the data that business decisions require. Practicing this kind of cost-conscious engineering design, even before it is your responsibility, demonstrates the scope of thinking that L5 and above FAANG calibration requires.

### Senior @ FAANG: Summary as AI System Design Standard

At senior level, this summary is the minimum quality bar for any production AI system the organization deploys. A proposed AI system that does not have a unified gateway (uses provider-specific code), does not have evaluation framework integration (cannot detect quality regressions), and does not have cost tracking (cannot attribute costs to features or users) does not meet the production quality bar and should not be approved for deployment. A system that cannot say who is allowed to write to its corpus, or what its model is permitted to reach without a human, does not get a timeline: it gets a no. Senior engineers who enforce this standard through design review, and who build the platform infrastructure that makes it easy to meet the standard, are ensuring that the organization's AI investments produce reliable, maintainable, economically sustainable systems rather than expensive technical debt.

---

### Navigation

- **Previous Chapter:** [Chapter 118B: Model Context Protocol (MCP) & Agent-to-Agent (A2A) Communication](../chapter-118b-mcp-a2a-protocols/00-introduction.md)
- **Part Home:** [Part XVIII: AI Engineering and Machine Learning](../00-part-intro.md)
- **Next Chapter:** [Chapter 118D: AI Coding Companion](../chapter-118d-ai-coding-companion/00-introduction.md)
