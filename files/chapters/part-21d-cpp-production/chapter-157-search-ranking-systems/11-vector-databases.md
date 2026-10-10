## Vector Databases: Architecture Compared

A vector database is a system that wraps an ANN index with persistence, replication, filtering, multi-tenancy, and an API. The line between "vector database" and "search engine with vector support" has blurred since 2022. Elasticsearch and OpenSearch ship dense_vector with HNSW, Vespa has had tensors since 2017, and ClickHouse added vector indexes in 2024. This chapter compares the architectures.

### Pinecone

Closed-source, fully managed. Pinecone's serverless architecture (rebuilt in 2023) decouples storage from compute. Vectors live in object storage (S3) compressed, queries fetch the relevant slabs into memory on demand. The original Pinecone (pre-serverless) was a pod-based system using HNSW-IVF hybrid indexes.

Strengths: hosted, scales horizontally, supports filtering and namespaces (multi-tenancy). Weaknesses: closed source means architectural details are inferred from blog posts and patents. Pricing is per-pod or per-namespace.

Architecturally interesting: Pinecone serverless caches per-tenant data with adaptive eviction, so tenants with steady traffic stay hot. Cold tenants pay a first-query latency penalty (up to seconds) when slabs are fetched. This is a genuinely different design from "always-resident" vector databases.

### Weaviate

Go-based, open source. Storage is per-collection, indexes are HNSW (with optional flat for tiny collections), persistence is via per-collection files. Multi-tenancy via "tenants" (separate index per tenant, resilient but heavyweight). Filtering: post-filter on small filter sets, integrated filtering on large ones via a graph-aware ACL filter inside HNSW.

Notable: Weaviate ships modules for embedding generation (text2vec-* modules), making it a turnkey option for teams that do not want to manage a separate embedding service. The cost is coupling: changing embedding model means re-encoding, which requires a Weaviate-side migration.

The HNSW implementation is in pure Go. Performance is roughly 30-50 percent slower than hnswlib on the same hardware, which the team has narrowed over time with SIMD assembly stubs.

### Milvus

Go API and orchestration, C++ engine (Knowhere). Knowhere wraps FAISS, hnswlib, and a few in-house indexes (DiskANN, RaBitQ). Designed for very large indexes (billions of vectors) with separation of compute and storage. Indexes can be built offline and loaded into search workers.

Architecture has more moving parts than Weaviate or Qdrant: separate proxy, query node, data node, index node, plus a metadata service (etcd) and an object store (MinIO/S3). The complexity buys horizontal scalability. Milvus is used at scale at companies like ByteDance and ShopBack. The complexity also means a small Milvus is overkill, for less than a billion vectors, simpler systems are easier to operate.

### Qdrant

Rust core, gRPC and HTTP APIs. HNSW with custom features for filtered search (the "filterable HNSW" extension that integrates filter checks into the graph traversal, avoiding the post-filter recall collapse). Strong support for payload filtering, multi-vector queries, and quantization (scalar and PQ).

The Rust core mirrors the C++ design philosophy of FAISS and hnswlib: zero-copy memory layout, explicit allocators, SIMD distance kernels. Qdrant beats hnswlib on filtered queries by 5-50x depending on filter selectivity, due to in-graph filter integration.

Qdrant is the most "C++-philosophy" non-C++ vector database in the market.

### Vespa.ai

C++ from the index core through the tensor evaluation layer. The most production-hardened search engine that supports dense vectors as a first-class feature. Vespa's tensor model is more general than the ANN-index model: a document field can be a tensor of arbitrary rank, and ranking expressions can do arbitrary linear algebra on these tensors.

Architecturally, Vespa is built around a content cluster (where documents and indexes live) and a stateless container cluster (where ranking and query logic runs). The content cluster shards by document, replicates with a Paxos-like consistency protocol, and supports real-time updates (writes are visible to queries within milliseconds). The HNSW implementation is in-house, supports concurrent updates, and integrates filtering at the graph traversal level (similar to Qdrant).

Vespa is the answer when "real-time updates", "complex ranking", and "billions of vectors" are all required simultaneously. The complexity cost is high: Vespa has a steep operational learning curve.

### Vald

CNCF graduated project from Yahoo Japan. Goes hard on the Kubernetes-native angle: agents are pods, indexes are pods, distribution is via Kubernetes-native scheduling. Backend index is NGT (Yahoo Japan's in-house ANN library, similar in performance to HNSW). Used at scale at Yahoo Japan for image search.

Vald's distinguishing feature: backup-and-recovery is native. Indexes can be snapshotted to object storage and restored on a new pod. Operationally clean for teams already running on Kubernetes.

### ChromaDB

Python-first vector database designed for prototyping and small-to-medium workloads. Embedded mode runs in-process, persistent mode uses SQLite for metadata and a separate file for vectors. HNSW via the hnswlib bindings.

ChromaDB's strength is developer ergonomics. The cost is that the architecture does not scale beyond a few million vectors per instance, for production at scale, teams typically migrate off Chroma.

### OpenSearch / Elasticsearch

Lucene-based, with the dense_vector field and HNSW (since Lucene 9.0, ~2022). Full-text and vector in the same index, queried with the same query DSL. The HNSW is a Java port of hnswlib's algorithm, with Lucene's segment-merge model on top.

The strong fit: hybrid retrieval (BM25 + vector) in a single query. The weak point: Java HNSW is slower than C++ HNSW (roughly 1.5-2x), and Lucene's segment-merge means HNSW graphs are rebuilt during merges, which is expensive.

OpenSearch added FAISS as an alternative engine (via JNI) for IVFPQ-style indexes. This makes OpenSearch competitive on memory-constrained workloads where HNSW is too large.

### Comparison Matrix

| System | Core lang | Index | Updates | Filtering | Scale |
|-------------|-----------|-------|----------|--------------|-------------|
| Pinecone | (closed) | HNSW+IVF| good | good | unlimited |
| Weaviate | Go | HNSW | good | good | 1B per inst |
| Milvus | Go+C++ | many | good | good | 10B+ |
| Qdrant | Rust | HNSW | good | excellent | 1B per inst |
| Vespa | C++ | HNSW+ | excellent| excellent | 100B+ |
| Vald | Go+C++ | NGT | medium | medium | 1B per inst |
| Chroma | Python+ | HNSW | medium | basic | 10M |
| OpenSearch | Java | HNSW+ | good | good | 1B per inst |

"Updates" is steady-state insert rate while serving queries. "Filtering" is how cleanly metadata filters integrate with the ANN search.

### When to Use Which

- **Prototype to production, hosted, "I just want it to work":** Pinecone or Weaviate Cloud.
- **Self-hosted, single-region, simple:** Qdrant.
- **Self-hosted, billions of vectors, strong filtering:** Milvus or Qdrant.
- **Complex ranking and tensor expressions, real-time updates:** Vespa.
- **Hybrid lexical + dense, existing Elastic deployment:** OpenSearch / Elasticsearch.
- **Inside an existing Kubernetes mesh, GitOps everything:** Vald.
- **Notebook to small app:** Chroma.

### Architectural Patterns Common to All

Every modern vector database has converged on the same shape:

- Immutable segments + delete bitmap. Lucene-style.
- HNSW as the default ANN, with IVFPQ or DiskANN for memory-bound or disk-bound workloads.
- Filtered search with various integration strategies.
- Multi-tenant via namespaces or per-tenant indexes.
- Distance metrics: cosine, L2, IP. Cosine is the most common in deployment.
- Some form of reranking with full-precision vectors.

The differences are in how each system shards, replicates, and scales horizontally. None of these are vector-search-specific problems, so each system inherits the strengths and weaknesses of its underlying distributed systems story.

### Junior to FAANG

A junior picks a vector database based on documentation quality. A senior infrastructure engineer benchmarks recall, p99 latency, build time, and memory cost on their actual data, then picks. A staff engineer designing a vector search platform asks the harder questions: what is the embedding model release cadence and how does that interact with the index lifecycle, what is the multi-tenancy isolation model, what happens during shard splits, what is the cost per million queries amortized over a year. The answers are often boring (Vespa wins on durability and ranking complexity, Qdrant wins on cost-per-QPS, Pinecone wins on operational simplicity), but the question matters more than the answer.

---
