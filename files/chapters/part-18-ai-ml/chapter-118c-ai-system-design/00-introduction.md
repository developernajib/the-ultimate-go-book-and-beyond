# Chapter 118C: AI System Design

> *"Designing for AI is designing for probabilistic latency, non-deterministic outputs, and cost curves that can surprise you at any order of magnitude."*

Building a single LLM-powered feature is an integration problem. Building a production AI platform that serves dozens of features to millions of users is a systems design problem of a different order. The challenges compound: you must manage multiple LLM providers with different latency profiles, token limits, and pricing models. You must route requests intelligently based on complexity and cost, cache semantically similar prompts to reduce spend, load balance across model instances that are not stateless in the traditional sense, and stream token output under a latency budget, all while maintaining the observability (traces, logs, cost attribution) needed to debug the edge cases that emerge when non-determinism is a first-class property of your system.

RAG (Retrieval-Augmented Generation) has become the dominant architecture for grounding LLM outputs in real data: instead of fine-tuning a model on your proprietary corpus (expensive, slow, requires retraining when data changes), you retrieve the most relevant documents at query time and inject them into the LLM's context window. At production scale, a RAG system is a distributed pipeline: embedding generation (GPU-accelerated, batched), vector index updates (incremental, consistent with the document store), retrieval (sub-10ms ANN search), re-ranking (a second, smaller model that scores retrieved documents for relevance), and context assembly (fitting documents into the token budget while preserving the most important information). Each stage has its own performance characteristics and failure modes.

This chapter synthesizes the AI/ML section into a coherent architectural framework: how to design an LLM gateway with intelligent routing, semantic caching, and multi-provider fallback, how to build a production RAG system with a chunking strategy, hybrid search, and a re-ranking stage, how to design for latency versus quality tradeoffs (smaller, faster models for simple queries, and larger, slower models for complex reasoning), how to stream responses to clients, and how to evaluate AI system quality systematically with automated benchmarks and regression detection. The chapter closes with rate limiting and quota management, the controls that keep an AI platform's cost curve inside its budget.

**What you'll learn in this chapter:**

- LLM serving infrastructure design: multi-model routing by complexity and cost, load balancing strategies for long-lived streaming connections, and horizontal scaling of inference endpoints
- Semantic caching: using embedding similarity to serve cached responses for semantically equivalent prompts, with cache invalidation strategies for time-sensitive content
- Production RAG architecture: document ingestion pipelines, chunking strategies (fixed-size, sentence-boundary, semantic), embedding generation at scale, and retrieval with hybrid ANN+BM25 search
- Re-ranking and relevance scoring: implementing a cross-encoder re-ranking stage that improves RAG precision at the cost of latency, and when the tradeoff is worth it
- Latency versus quality tradeoffs: model tiering, query complexity classification, and dynamic routing to balance response time against answer quality
- Streaming responses: forwarding a provider's token stream to the browser over Server-Sent Events without buffering the whole answer
- AI system evaluation: automated metric tracking (answer faithfulness, context precision), scoring harness design, and regression detection in CI
- Rate limiting and quota management: per-tenant token budgets and the cost controls that keep an AI platform predictable

**Why this matters at scale:**

Every commercial LLM API is a multi-tenant serving platform behind the same set of problems this chapter covers: routing requests across a pool of accelerators, caching what can be cached, degrading gracefully when a model tier is saturated, and attributing cost per tenant. Every AI search product that answers with citations is a production RAG system: it chunks a corpus, embeds it, retrieves, re-ranks, and assembles a context under a token budget. You do not need any one company's internal design docs to learn the patterns, because the constraints that force them are public and physical: accelerators are expensive, context windows are finite, embeddings are approximate, and models are non-deterministic. Building fluency with these patterns now means you can design AI infrastructure for your organization rather than rediscovering the same constraints under deadline.

**Prerequisites:** Chapters 113-118B (the AI/ML section), Go distributed systems patterns (Chapters 55-70), LLM integration (Chapter 115), and vector databases (Chapter 116).

---

### Junior → FAANG: AI System Design as a New Interview Category

The opening quote captures three properties of AI system design that distinguish it from traditional distributed systems design: probabilistic latency (LLM response times vary widely based on output length and model load, not just network conditions), non-deterministic outputs (the same prompt produces different outputs on each call, which breaks traditional idempotency assumptions), and cost curves that scale with usage volume in non-linear ways (context window size, model tier selection, and caching hit rates all affect cost dramatically). Understanding these three properties is the conceptual foundation for every design decision in this chapter.

For FAANG system design interviews specifically focused on AI infrastructure, you should expect to discuss: LLM gateway design (unified API layer over multiple providers with fallback), RAG pipeline architecture (document ingestion, chunking, embedding, retrieval, generation), streaming response handling (SSE from LLM to client), evaluation frameworks (how do you measure quality regressions?), and cost management (token budgets, semantic caching, model tier selection). These five topics together constitute the AI system design interview curriculum for L5 and above roles at AI-forward companies.

### Senior @ FAANG: AI System Design as Infrastructure Engineering Domain

At senior level, AI system design is an infrastructure engineering domain with its own SRE practices. The probabilistic latency property means that P99 latency for LLM-dependent services is an order of magnitude worse than P50, which requires different SLO definitions and different capacity planning approaches. The non-deterministic output property means that traditional end-to-end testing is insufficient. Evaluation frameworks that measure output quality statistically are required. The cost curve property means that cost management is not an afterthought but a core architectural concern that affects every design decision from context window size to caching strategy. Staff engineers who understand these infrastructure implications of AI properties are the architects that FAANG AI platform teams need to build reliable, cost-predictable AI systems at scale.
