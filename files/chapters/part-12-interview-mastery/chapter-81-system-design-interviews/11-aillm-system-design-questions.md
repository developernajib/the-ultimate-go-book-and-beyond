## AI/LLM System Design Questions

By 2026, asking a senior-level candidate to design an AI chatbot or an LLM-powered search feature is as standard as asking them to design a URL shortener was in 2018. The "ChatGPT effect" - a period of rapid public familiarity with large language model products - created an expectation at every technology company that engineers understand how these systems are built and operated. You do not need to have trained a model to answer these questions well. You do need a solid architectural framework.

For deep implementation details on LLM serving infrastructure, see the dedicated `design-llm-serving.md` chapter. This section focuses on interview-specific framing and the decisions interviewers want to hear you reason through.

### Why Every Company Now Asks LLM System Design

The shift is driven by product reality, not interview fashion. Companies are shipping features built on LLMs: internal knowledge bases, customer support bots, code review assistants, document summarization pipelines, and semantic search. Engineers working on these systems encounter infrastructure problems - latency, cost, reliability, accuracy - that require architectural thinking, not just prompt engineering. Interviewers are screening for candidates who can operate at that layer.

Even if the role you are interviewing for does not involve ML infrastructure directly, demonstrating fluency in this space signals that you can contribute to cross-functional AI product work - a high-value signal in 2026.

### RAG Pipeline Design

Retrieval-Augmented Generation (RAG) is the dominant architecture for LLM-powered applications that need to answer questions about private or recent data. The pipeline has five distinct stages, each with its own engineering trade-offs:

```
Document Corpus
      │
      ▼
┌─────────────────┐
│  1. Ingestion   │  Parse PDFs, HTML, databases, APIs into raw text
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  2. Chunking    │  Split text into overlapping segments (~512 tokens)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  3. Embedding   │  Encode each chunk as a dense vector (e.g., 1536 dims)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  4. Vector DB   │  Store vectors, indexed for approximate nearest-neighbor search
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│  5. Query-time: Retrieve → Rerank → Generate│
│                                             │
│  User query → embed → ANN search            │
│  → top-K chunks → reranker → LLM prompt     │
│  → streamed response                        │
└─────────────────────────────────────────────┘
```

**Key design decisions at each stage:**

| Stage | Decision | Trade-off |
|-------|----------|-----------|
| Chunking | Fixed-size vs. semantic chunking | Fixed is simpler, semantic preserves meaning boundaries |
| Chunk size | 256 vs. 512 vs. 1024 tokens | Smaller = more precise retrieval, larger = more context per chunk |
| Embedding model | Hosted (OpenAI) vs. self-hosted (sentence-transformers) | Hosted = operational simplicity, self-hosted = cost at scale, data privacy |
| Vector store | Pinecone vs. pgvector vs. Weaviate vs. Faiss | See vector search section below |
| Retrieval count | Top-3 vs. Top-10 | More chunks = more context but higher latency and token cost |
| Reranking | Cross-encoder reranker pass | Improves relevance at cost of added latency |

### LLM Serving Infrastructure

When asked about LLM serving, interviewers are testing whether you understand the hardware and systems constraints that make LLM inference fundamentally different from typical web service serving.

**Core constraints:**

- **GPU memory (VRAM)**: Model weights occupy GPU memory. A 7B parameter model in FP16 requires ~14 GB VRAM. A 70B model requires ~140 GB, spanning multiple GPUs. This is a hard ceiling - you cannot burst beyond available VRAM.
- **KV cache**: During autoregressive generation, the attention key-value tensors for all previous tokens must be held in GPU memory. This grows with sequence length and batch size, creating a second VRAM pressure independent of model size.
- **Batching**: GPU utilization is maximized by processing multiple requests simultaneously. Dynamic batching (continuous batching) processes requests of different lengths together, achieving much higher throughput than naive batching.
- **Prefill vs. decode phases**: Prefill (processing the input prompt) is compute-bound and fast. Decode (generating output tokens one by one) is memory-bandwidth-bound and slow. These have different optimization strategies.

**Serving architecture at scale:**

```
Clients
   │
   ▼
Load Balancer (route by model, session affinity for streaming)
   │
   ├──► Inference Workers (GPU fleet)
   │         │
   │         ├── Model sharding (tensor parallel across GPUs for large models)
   │         ├── Continuous batching scheduler (vLLM, TensorRT-LLM)
   │         └── KV cache manager (PagedAttention)
   │
   └──► Request Queue (handle burst, decouple clients from GPU availability)
```

**Key tools to know by name:**
- **vLLM**: Open-source LLM serving engine. implements PagedAttention for efficient KV cache management
- **TensorRT-LLM**: NVIDIA's optimized inference runtime. used in high-throughput production deployments
- **Triton Inference Server**: NVIDIA model serving infrastructure supporting multiple backends

### Embedding and Vector Search at Scale

Vector search is the retrieval backbone for RAG systems and semantic search. The problem: given a query vector of dimension D, find the K most similar vectors from a corpus of N vectors, where N may be hundreds of millions.

**Approximate Nearest Neighbor (ANN) search:**

Exact nearest-neighbor search scales as O(N·D), which is infeasible at large N. ANN algorithms trade a small accuracy loss for orders-of-magnitude speed improvement.

**HNSW (Hierarchical Navigable Small World):**
- Graph-based index. Nodes connect to nearby neighbors at multiple resolution levels
- Query time: O(log N) on average
- High recall (typically >95% at 10× speedup over exact search)
- In-memory index: requires RAM proportional to N (roughly 100 bytes per vector)
- Used by: Pinecone, Weaviate, Qdrant, pgvector (as an index type)

**Faiss (Facebook AI Similarity Search):**
- Library, not a service. runs in-process
- Supports IVF (Inverted File Index) + PQ (Product Quantization) for billion-scale search with compressed vectors
- Best for: batch offline search, research, embedding in custom pipelines
- Requires operational work: no built-in persistence, replication, or HTTP API

**Managed vector databases:**

| Option | Best For | Trade-offs |
|--------|----------|------------|
| **Pinecone** | Fully managed, production RAG | Vendor lock-in, cost at scale |
| **pgvector** | Existing PostgreSQL deployment | SQL-native, simpler ops, lower throughput than dedicated stores |
| **Weaviate** | Multi-modal, schema-rich corpora | More operational complexity, rich filtering |
| **Qdrant** | Open-source, self-hosted, high perf | Requires infrastructure management |

**Interview framing:** When asked which vector store to choose, anchor your answer to operational context - team size, data volume, existing infrastructure, and query pattern - rather than claiming one is universally superior.

### Sample Interview Walkthrough: "Design an AI Chatbot at Scale"

This is the most common LLM system design prompt in 2026 interviews. Below is a structured Q&A walkthrough modeled on real interview dynamics.

---

**Interviewer:** Design an AI-powered customer support chatbot for an e-commerce platform. It should answer questions about orders, products, and policies. The company has 10 million customers and handles 500,000 support queries per day.

**Candidate:** Before diving into components, I want to clarify a few things. First, are responses grounded in company data - order status, product catalog, policy documents - or is this a general-knowledge bot? Second, what's the latency expectation: are we targeting under 2 seconds for a first token, or is 5-10 seconds acceptable? Third, is there a requirement to hand off to a human agent?

*[Clarifications establish: grounded in company data, target under 3 seconds for first token, yes to human handoff.]*

**Candidate:** Good. This is a RAG architecture with a real-time serving layer. Let me walk through the major components.

**Offline pipeline (data preparation):**
- Ingest product catalog, policy documents, and FAQ content nightly
- Chunk documents into 512-token segments with 50-token overlap
- Embed each chunk using a hosted embedding model (e.g., `text-embedding-3-small`)
- Store vectors in a managed vector database (pgvector if we want to minimize new infrastructure. Pinecone or Qdrant for dedicated performance)
- For order status: this is dynamic data - we do not embed it. We retrieve it live from the orders database at query time using the customer's session context

**Online query path:**

```
User message
    │
    ▼
Session Manager (maintains conversation history, user auth token)
    │
    ▼
Intent Classifier (is this an order query? policy query? out-of-scope?)
    │
    ├──[order query]──► Orders DB lookup (by order ID from session context)
    │
    └──[knowledge query]──► Embedding → Vector Search → Top-5 chunks
                                │
                                ▼
                         Prompt Assembly
                         (system prompt + retrieved context + conversation history)
                                │
                                ▼
                         LLM Inference (streaming)
                                │
                                ▼
                         Response + Confidence Score
                                │
                         [low confidence]──► Human Handoff Queue
```

**Interviewer:** How do you manage the context window as conversations get longer?

**Candidate:** Conversation history grows unboundedly, but context windows are finite and token-expensive. I'd implement a sliding window with summarization: keep the last N turns verbatim, and for older turns, run a summarization call periodically to compress them into a brief summary that stays in context. The summary costs one LLM call but saves many tokens on every subsequent turn. Alternatively, for high-volume production, I'd use a retrieval-based memory: embed each turn, store it, and retrieve relevant prior turns rather than including all history.

**Interviewer:** What are your hallucination mitigation strategies?

**Candidate:** Three layers. First, grounding: the system prompt explicitly instructs the model to answer only from provided context and say "I don't know" when context is insufficient - no fabrication permitted. Second, confidence scoring: I'd track whether the top retrieved chunks have high cosine similarity to the query. Low similarity signals the question is outside the knowledge base, triggering a fallback or human handoff rather than generation. Third, post-generation validation: for structured facts (order status, prices), validate the generated answer against the source record before returning it.

**Interviewer:** How does the system scale to 500,000 queries per day?

**Candidate:** 500,000 queries per day is roughly 6 queries per second average, with probable peaks of 30-50 QPS during business hours. That is well within a single well-provisioned LLM inference deployment, but I would not design for average - I'd design for peak. The serving layer should be stateless and horizontally scalable behind a load balancer. Inference workers scale with GPU availability. I'd use an async request queue to absorb bursts without dropping requests. Embedding for retrieval is cheap and can run on CPU or a smaller GPU. The vector search step is sub-millisecond at this scale. The bottleneck is LLM decode time. Streaming responses mitigates perceived latency even if total generation time is 2-3 seconds.

---

### Key Decisions to Discuss in Every LLM Design Interview

| Decision | What to Say |
|----------|-------------|
| **Context window management** | Sliding window + periodic summarization, retrieval-based memory for long sessions |
| **Hallucination mitigation** | Grounded prompting + retrieval confidence gating + post-generation validation |
| **Latency vs. quality** | Streaming reduces perceived latency, smaller models reduce actual latency at quality cost, reranking adds latency for precision gain |
| **Embedding model choice** | Hosted = simpler ops, data leaves your infrastructure, self-hosted = data privacy, lower marginal cost at scale |
| **Vector store choice** | Anchor to operational context: existing stack, team expertise, data volume, query pattern |
| **Cost control** | Cache frequent query embeddings, cache LLM responses for identical prompts, use smaller models for intent classification |


### Junior → FAANG: Approaching AI/LLM System Design

AI and LLM system design questions are newer territory and interviewers often accept less polished answers here. Start by clarifying: is this a RAG pipeline, a fine-tuning workflow, or a real-time inference API? Each path has distinct bottlenecks. For a RAG system, sketch the retrieval layer (embedding model, vector store, ANN index), the generation layer (LLM endpoint), and the caching layer (embedding cache, response cache for repeated queries). Know that vector similarity search at scale requires approximate methods like HNSW or IVF. Exact search does not scale past a few million vectors. Demonstrate you understand the token economy: long prompts cost money and add latency, so chunk and retrieve only what is needed.

### Senior @ FAANG: Governance, Cost Control, and Platform Maturity for AI Systems

At the senior level, LLM system design is as much about cost governance and model lifecycle management as it is about architecture. Key concerns at L6/L7 include: model version pinning and rollout strategy (a silent model upgrade by an upstream provider can break evals and SLOs overnight), embedding drift (embeddings generated by model-v1 are not compatible with model-v2 without re-indexing the entire corpus, which can be a multi-day operation at scale), and budget attribution (which team or product surface is consuming how many tokens per day, and how is that tied back to value delivered). For bar-raiser interviews, expect to discuss the difference between online and offline evaluation: online A/B metrics like click-through or task completion versus offline evals like RAGAS scores or human preference ratings, and how you decide when an offline improvement justifies a production rollout. Governance ADRs for LLM systems should capture: data-residency constraints on which provider you can use, PII scrubbing before context is sent to an external model, audit logging of all prompts and completions for compliance, and rate-limit budgets per caller. Platform thinking means designing a shared inference gateway that enforces these policies centrally so product teams do not each bolt on their own solutions.

---
