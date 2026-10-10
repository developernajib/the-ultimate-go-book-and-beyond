# Chapter 157: Search and Ranking Systems in C++

> "The best search engine is the one that finishes before you finish typing.", anonymous Google SRE

Search systems sit at the intersection of three of the hardest constraints in software. Latency, because users abandon a query at around 200 milliseconds. Throughput, because a single Google data center fields tens of thousands of queries per second. Memory budget, because an inverted index over the public web is measured in petabytes and the working set per shard can be hundreds of gigabytes. No single one of these constraints forces C++. All three together do.

This chapter is for engineers who already know how to write a `std::vector`-style structure in their sleep and now want to understand how Vespa, ScaNN, FAISS, hnswlib, and the C++ guts of OpenSearch and Elastic actually work. We assume you have seen BM25 in slides and posting lists in a textbook. We will not stop to define what an `std::span` is.

## Why C++ Owns the Core of Search Infrastructure

Lucene is Java and powers Elasticsearch and Solr, and it is the most visible counterexample to "search is C++". But look one layer down and the picture shifts. Vespa.ai (Yahoo, then Verizon, then independent) is C++ from the index core through the tensor evaluation engine. ScaNN, the library behind Google's vector search at YouTube and Search, is C++ with Python bindings. FAISS from Meta is C++ with CUDA kernels. hnswlib, the reference HNSW implementation that nearly every vector database vendored at some point, is a single header of C++. Milvus's `knowhere` engine is C++. ClickHouse, increasingly used as a search backend through its inverted index and full-text features, is C++. Even projects written in newer languages (Qdrant in Rust, Weaviate in Go, Tantivy in Rust) deliberately mirror C++ data layouts because that is what the academic and industrial benchmarks were designed against.

The reason is straightforward. A query plan in a search engine is a tight loop over compressed integer streams (posting lists), or a tight loop over float vectors (ANN). Both loops live or die on three things the JVM and Go runtime cannot fully give you: predictable cache behavior, SIMD intrinsics with no autoboxing, and explicit control over memory residency. When your p99 budget is 30 milliseconds and a single L3 miss costs 80 nanoseconds, you cannot afford a stop-the-world GC pause measured in tens of milliseconds, no matter how well-tuned the collector. ZGC and Shenandoah closed this gap dramatically, but they did not close it to zero, and at search scale "almost zero" is the difference between a healthy fleet and a brownout.

There is a second reason that gets less attention. Search systems are co-designed with their hardware. Vespa runs custom NUMA pinning. ScaNN's anisotropic quantization was designed around AVX-512 VPDPBUSD. FAISS GPU kernels are written against specific tensor core capabilities. The level of hardware fluency required to write these systems makes C++ (or sometimes Rust) the only realistic choice. A Java implementation of ScaNN's `score_aware_quantization` does exist, and it is roughly three times slower at the same recall.

## What This Chapter Covers

We start with the lexical retrieval stack: inverted indexes, posting list compression (VarByte through Elias-Fano), and skip-list / block-max algorithms (WAND, BMW, MaxScore) that make top-k retrieval over billions of documents feasible. Then we cover ranking, from BM25 through learning-to-rank (LambdaMART, RankNet) to neural cross-encoders.

The second half is dense retrieval: two-tower embedding models, ANN fundamentals, HNSW deep dive, IVF / Product Quantization / OPQ / ScaNN's anisotropic quantization, and the architecture of modern vector databases. We then bring lexical and dense together with hybrid retrieval and multi-stage ranking, and step out to look at distributed search, sharding, query processing pipelines, document processing, and real-time indexing.

The chapter closes with relevance evaluation (NDCG, MRR, interleaving), personalization, search quality defense (spam, duplicates, freshness), an end-to-end small C++23 vector search engine, and cost engineering at query level.

## The Standard You Are Being Held To

At Google Search infrastructure, a senior engineer is expected to read the BM25 paper, the WAND paper, the original HNSW paper, and ScaNN's anisotropic quantization paper, and be able to argue about which trick applies in which regime. At Meta's AI infra org (the team that owns FAISS), the bar adds CUDA fluency. At Vespa.ai, expect to be asked about lock-free concurrent index updates and tensor compilation. At Pinecone or Weaviate, expect questions about cost per million queries and how memory residency interacts with the embedding model release cadence.

This chapter is built to that bar.

---
