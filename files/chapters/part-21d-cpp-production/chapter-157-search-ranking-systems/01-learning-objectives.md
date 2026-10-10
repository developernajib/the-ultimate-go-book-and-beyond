## Learning Objectives

By the end of this chapter, you will be able to:

### Lexical Retrieval Core

- Implement an inverted index in modern C++ with a dictionary, term-frequency table, and document-frequency table, and explain the memory layout choices that make decompression cache-friendly.
- Compare posting list compression schemes (VarByte, Group VarInt, Simple9, Simple16, PFOR, FastPFOR128, BitMagic, Roaring, Elias-Fano) on three axes: compression ratio, decode throughput, and random-access cost.
- Implement skip pointers over a posting list and explain when skip lookup wins over linear scan.
- Implement WAND, Block-Max WAND (BMW), and MaxScore for top-k disjunctive query evaluation, and reason about which one wins on which query length.
- Derive BM25 from the probabilistic relevance framework, tune k1 and b for a given corpus, and explain why TF saturation matters.

### Learning to Rank and Neural Ranking

- Distinguish pointwise, pairwise, and listwise losses, and pick the right one given the labeling protocol (graded relevance vs binary, click data vs editorial).
- Train a LambdaMART model with XGBoost ranker, set the right `eval_metric`, and avoid the common mistakes (broken `group` ordering, leakage from impression features, NDCG truncation mismatch).
- Implement a cross-encoder BERT re-ranker behind a first-stage retriever and reason about its latency / quality trade-off.

### Dense Retrieval and ANN

- Build a two-tower (dual encoder) model for retrieval, set up in-batch negatives correctly, and explain when hard negative mining is required.
- Compare exact KNN against ANN families (LSH, IVF, IVFPQ, HNSW, ScaNN's anisotropic) and pick the right family given (corpus size, recall target, memory budget, update rate).
- Implement HNSW from the paper, tune M, ef_construction, ef_search, and explain the level distribution and the greedy graph search invariant.
- Use FAISS (CPU and GPU) and hnswlib from C++, and reason about the trade-offs of IndexHNSWFlat vs IndexIVFPQ vs IndexIVFScalarQuantizer.
- Reproduce the ScaNN anisotropic quantization loss intuitively and explain why it beats symmetric PQ on inner-product search.

### Production System Design

- Architect a multi-stage ranker (retrieval, first-stage scoring, second-stage rerank, diversification, personalization) and assign a latency budget to each stage that adds to a 100 millisecond p99.
- Design shard topology for a search cluster, decide between document partitioning and term partitioning, and reason about tail-at-scale mitigations (hedged requests, request reservation, backup requests).
- Build a query processing pipeline (parse, rewrite, expand, correct, retrieve, score, rerank, paginate) and explain where each component sits and what it costs.
- Run an indexing pipeline (offline batch, online incremental, near-real-time) including tokenization (UAX-29), stemming, stopword handling, language detection, content extraction, and dedup (MinHash, SimHash).
- Implement Lucene-style segment merging and immutable-segment + delete-mask updates in C++, and reason about NRT (near-real-time) latency.

### Evaluation and Quality

- Compute NDCG@k, MRR, MAP, and recall@k correctly (including the easy mistakes: gains vs labels, ideal DCG normalization, ties).
- Run an A/B experiment for ranking, including interleaving (TDI, balanced) when sample size is constrained.
- Detect search quality regressions (spam, generative content, duplicates, stale results) and design a defense pipeline.

### Vector Databases and Hybrid Search

- Compare Pinecone, Weaviate, Milvus, Qdrant, Vespa, Vald, ChromaDB on architecture, indexing model, replication, and where each one's design choices break down.
- Implement hybrid retrieval (lexical + dense) using Reciprocal Rank Fusion, weighted sum, and learned fusion, and explain why ColBERT-style late interaction sits between cross-encoder and dual-encoder.

### Cost and Scaling

- Estimate cost per query (CPU cycles, memory pages touched, disk IOs) for a given index design and decide where caching pays off.
- Decide between CPU and GPU vector search given (vector dimension, index size, QPS, latency target).
- Design an end-to-end small C++23 vector search engine with HNSW for similarity, posting lists for filters, a thread-per-shard model, and a build pipeline that produces immutable segments.

If you cannot do these things at the end of this chapter, treat the chapter as failed and re-read the relevant section. The exercises at the end are calibrated to be the minimum bar.

---
