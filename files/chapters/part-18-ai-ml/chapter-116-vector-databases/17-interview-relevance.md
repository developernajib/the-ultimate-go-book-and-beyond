## 116.16 Interview Relevance: Vector Infrastructure and RAG

Vector databases and RAG systems are increasingly common in FAANG interviews:

- **System Design**: "Design a semantic search system for millions of documents"
- **ML Systems**: "How would you build a chatbot with document retrieval?"
- **Architecture**: "Compare vector database options for different scale requirements"
- **Optimization**: "Your RAG system is slow. How do you debug and optimize?"
- **Quality**: "Your RAG system returns fluent, confident, wrong answers. Where do you look first?"

Understanding the trade-offs between accuracy, latency, and cost demonstrates senior/staff-level thinking. The quality question is the one most candidates fumble, and the expected instinct is to look at retrieval before touching the prompt or the model: if the right chunk was never retrieved, no amount of prompting can recover it.

### Junior → FAANG: Interview Relevance as Study Priority Map

The interview topics listed in this section should drive your study prioritization. System design questions about semantic search are the most frequently occurring and the highest weight in senior interviews. Practice designing a semantic search system out loud: "I would start with a document ingestion pipeline that chunks on semantic boundaries, generates embeddings in batches with a content-hash cache so re-ingests are cheap, normalizes the vectors, and writes them to pgvector with an HNSW index on `vector_cosine_ops` plus metadata for filtering. At query time I embed the query, retrieve a generous top-N, fuse with a BM25 branch via reciprocal rank fusion so exact identifiers are not lost, rerank with a cross-encoder, and return the top-5 with scores and provenance."

Two details in that answer do disproportionate work. Say **why** you fuse with BM25 (embeddings miss rare exact tokens), because that shows you know where vector search fails rather than just that it exists. And do **not** quote a similarity threshold as if it were a constant: raw scores are model-specific and compressed into a narrow band, so any hardcoded cutoff is a number someone made up. Say you would calibrate the threshold against a labelled set, or skip thresholding and rely on top-k plus the reranker. Candidates who confidently assert "cosine > 0.8 means relevant" are revealing that they have never measured it.

Implementation questions about embedding generation, RAG pipelines, and vector similarity are your opportunity to demonstrate Go-specific knowledge. Practice implementing cosine similarity, nearest-neighbor search with a linear scan, and HNSW-based approximate search in Go. These implementations are short (under 100 lines each) but demonstrate that you understand the algorithms at the implementation level, not just conceptually.

### Senior @ FAANG: Interview Relevance as Career Signal

The prevalence of vector database and RAG topics in FAANG interviews reflects the strategic importance of AI search to these companies. Google, Meta, Amazon, and Microsoft are all investing heavily in AI-powered search as a differentiating product capability. Engineers who can design, build, and operate this infrastructure at scale are in high demand and command significant compensation premiums.

At senior level, the interview goes beyond implementation to architecture and trade-offs. The bar-raiser question "how would you design a vector search platform for an organization with 200 model teams and 50 billion documents?" requires a complete architectural answer: multi-tenant index design (namespace isolation per team), distributed HNSW across many shards, asynchronous embedding generation pipeline, continuous quality evaluation per tenant, cost attribution and quota enforcement, and a self-service tooling layer that lets teams manage their own indexes without platform team involvement. This is the L6/L7-level answer that demonstrates both technical depth and organizational thinking.

---
