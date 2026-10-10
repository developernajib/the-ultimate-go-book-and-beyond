## Summary

- **Vector databases and semantic search**: Vector databases (pgvector, Qdrant, Weaviate, Pinecone) store high-dimensional embedding vectors and answer approximate nearest-neighbor queries, enabling semantic search that finds conceptually related content rather than keyword matches.
- **Embedding models for dense representations**: Text embedding models (OpenAI `text-embedding-3-small`, open-source `all-MiniLM-L6-v2`) convert text into fixed-dimension floating-point vectors. All documents and queries must use the same model to ensure comparable vector spaces.
- **RAG pipeline architecture**: Retrieval-Augmented Generation combines a vector retrieval step (fetch top-k semantically similar chunks) with a generative LLM step (synthesize an answer from the retrieved context), grounding responses in factual source documents.
- **Document chunking strategy**: Chunk size and overlap are the primary levers for retrieval quality. 1000-character chunks with 200-character overlap are a reliable default, but semantic chunking at paragraph or section boundaries consistently outperforms fixed-size splits.
- **HNSW index tuning**: Hierarchical Navigable Small World indices provide the best accuracy-latency trade-off for datasets up to tens of millions of vectors. Tuning `M` (graph connectivity) and `ef_construction` (search beam width) directly controls recall vs. build-time cost.
- **Hybrid search for recall**: Combining dense vector search with BM25 sparse keyword search (reciprocal rank fusion) improves recall for queries with rare terms or proper nouns that embeddings may not represent faithfully.
- **Metadata filtering for relevance**: Storing document metadata (source, date, category, author) alongside vectors and applying pre-filters before ANN search significantly improves result relevance and enables access-control-aware retrieval.
- **Embedding cache to reduce API costs**: Caching embedding vectors keyed by content hash eliminates redundant API calls for unchanged documents. Aggressive embedding caching typically reduces embedding API spend by 70-90% in production RAG systems.
- **Semantic response caching**: Caching LLM responses for queries whose embeddings are near a previously answered query reduces latency and cost for repeated or near-duplicate questions. Treat the threshold as a safety-critical parameter rather than a constant: unlike an exact-match cache, a semantic cache answers a question the user did not ask, so too loose a threshold serves confidently wrong answers ("enterprise refund policy" sits very close to "free tier refund policy" in embedding space). Calibrate it against labelled pairs, measure the false-hit rate, and prefer exact-match caching wherever it suffices.
- **RAG evaluation and monitoring**: Track retrieval recall (are the correct chunks in the top-k?), answer faithfulness (is the answer supported by retrieved context?), and end-to-end latency. Use LLM-as-judge scoring to automate regression testing of pipeline quality.

### Junior → FAANG: Summary as Self-Test

Read each bullet in this summary and ask: can I implement this from scratch in Go? For each one you cannot, add it to your practice list. The embedding cache bullet (cache by content hash, reduce API costs 70-90%) should produce this mental model: a map from SHA-256 hash to embedding vector, persisted to Redis with a TTL equal to the document's expected update frequency, populated on cache miss by calling the embedding API, and checked on every embedding request before calling the API. If that mental model is not immediately accessible, the embedding cache section of this chapter needs a second read and an implementation exercise.

### Senior @ FAANG: Summary as Platform Capability Statement

Each bullet in this summary represents a platform capability that either exists in your organization or is a gap. Map them to your current infrastructure: do you have a shared embedding service with content-hash caching? Do you have semantic response caching in the LLM gateway? Do you have an automated RAG evaluation pipeline with LLM-as-judge scoring? The gaps are investment opportunities. Prioritize by the number of teams that would benefit and the frequency of the quality degradation that the investment would prevent. This prioritization framework turns the summary into an actionable platform roadmap rather than an abstract wishlist.

---

### Navigation

- **Previous Chapter:** [Chapter 115: LLM Integration](../chapter-115-llm-integration/00-introduction.md)
- **Part Home:** [Part XVIII: AI Engineering and Machine Learning](../00-part-intro.md)
- **Next Chapter:** [Chapter 117: AI Agents](../chapter-117-ai-agents/00-introduction.md)

