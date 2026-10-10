## Chapter Summary

Search and ranking systems combine three of the hardest constraints in software (latency, throughput, memory budget) and are one of the small set of domains where C++ remains dominant. The full search ranking stack spans lexical retrieval, learning to rank, dense retrieval and ANN, hybrid systems, distributed serving, evaluation, quality defense, and cost engineering.

### Core Practical Capabilities

**Lexical retrieval.** Build an inverted index in modern C++. Compress posting lists with VByte, Simple9, FastPFOR, Roaring, or Elias-Fano, and choose between them based on workload. Implement WAND and Block-Max WAND for top-k retrieval. Tune BM25's k1 and b for a given corpus.

**Learning to rank.** Train a LambdaMART model with XGBoost or LightGBM, avoiding the common pitfalls (group ordering, leakage, eval-metric mismatch). Distinguish pointwise, pairwise, listwise losses, and pick the right one. Wire a cross-encoder reranker behind a first-stage retriever.

**Dense retrieval.** Train a two-tower model with InfoNCE and hard negatives. Run query-time encoding in C++ via ONNX. Build an HNSW index from the paper or from hnswlib. Build an IVFPQ index from scratch and tune nprobe and PQ parameters.

**Production systems.** Reason about multi-stage ranking with explicit per-stage latency budgets. Design shard topology with awareness of tail-at-scale. Build a query processing pipeline with parsing, normalization, expansion, and rewriting. Run a document indexing pipeline with extraction, dedup, and incremental segment building.

**Evaluation.** Compute NDCG, MRR, MAP, recall@k correctly. Run A/B tests with sample-size awareness. Use interleaving when sample size is constrained. Detect Goodhart drift in metric optimization.

**Cost.** Estimate cost per query and find the dominant component. Choose between CPU and GPU for vector search. Right-size the fleet with tail-latency awareness. Use spot/preemptible compute for stateless layers.

### The C++ Story

Every algorithm in this chapter has a working C++ implementation: hnswlib, FAISS, Vespa, ScaNN, FastPFOR, Roaring, BitMagic, Folly's EliasFano, Lucene's C++ ports, USearch. The reason is the same in every case: predictable cache behavior, SIMD intrinsics with no autoboxing, and explicit control over memory residency. When p99 budgets are 30 milliseconds and a single L3 miss costs 80 nanoseconds, GC-managed languages cannot consistently hit the bar at scale. C++ is not the only acceptable choice (Rust is rising, especially in Qdrant), but it remains the default at the largest scales.

### What Was Out of Scope

- Image, video, and audio search. The retrieval and ANN parts apply, but feature extraction is a separate field.
- Federated search across heterogeneous sources.
- Question answering and RAG (retrieval is the first stage, the answer-generation stage is in the LLM literature).
- Specialized verticals (legal, medical, code) where domain features dominate.
- Internationalization beyond tokenization basics.
- Compliance and content moderation requirements that vary by jurisdiction.

Each of these is its own subsystem and would double the chapter length.

### Where the Field Is Going

Three trends as of 2026:

**Generative content.** LLM-generated text and images are filling the public web. Detection accuracy is mediocre. The defense pipeline (chapter 20) is becoming the most active research area in production search.

**Multi-modal embedding.** A single embedding for text, image, audio, and video unlocks unified retrieval. CLIP, OpenAI's embeddings, and Cohere multimodal are leading. Vector databases now support multi-modal indexes natively.

**On-device search.** Mobile and edge devices want local search to avoid latency and privacy issues. ANN libraries with small memory footprints (USearch, MNN) are growing. Vector databases with offline-first modes are emerging.

The fundamentals (inverted indexes, BMW, HNSW, BM25, NDCG) will not change. The implementation details and the model components surrounding them will.

### Final Word

The senior search-infrastructure engineer is rare because the role demands fluency across algorithms, systems, machine learning, and product. This chapter is the textbook for that role. The labs in Section 23 are the entrance exam.

If you can implement BMW, HNSW, IVFPQ, and a multi-stage ranker, and reason about tail latency at the shard fan-out, you are at the senior bar. If you can also debate ScaNN's anisotropic quantization derivation, defend the choice of immutable segments over in-place updates, and design a quality defense pipeline, you are at the staff bar at any major search company.

The next step is to build something. Pick a lab, ship it, then ship the next.

---

### Chapter 158 Preview

Chapter 158 covers production reliability: what happens after the search system is built, when it has to survive datacenter failures, hostile traffic, dependency outages, and the slow grind of operational debt. The skills there are different (chaos engineering, capacity planning, on-call rotations, postmortem culture) but build on everything in this chapter. A search system that is fast and accurate but unreliable is a search system that loses users.

---

| [◀ Chapter 156: Query Optimizers and Execution Engines in C++](../chapter-156-query-optimizers/00-introduction.md) | [Chapter 157: Search and Ranking Systems in C++](00-introduction.md) | [Chapter 158: Production Reliability for C++ Services](../chapter-158-production-reliability/00-introduction.md) ▶ |
