## Search Cost Engineering

A search query at FAANG costs a fraction of a cent to serve. That fraction times billions of queries per day is real money: a 10 percent reduction in cost-per-query saves tens of millions of dollars annually for a major search property. This chapter is about where the costs go and how to reduce them without losing quality.

### Cost Model

Cost per query has four components:

1. **CPU.** Cycles spent in retrieval, scoring, ranking, post-processing.
2. **Memory.** RAM held resident for the index. Amortized over QPS.
3. **Disk / network.** I/O for cold data, network for fan-out RPCs.
4. **GPU (optional).** Inference for embedding, cross-encoder, reranking.

For a typical web search at 100 QPS per host:

```
CPU:    ~10 ms x 64 cores at $0.05/core-hour  = ~$2.50 per million queries
Memory: 256 GB at $0.005/GB-hour              = ~$3.50 per million queries
Disk:   negligible (NVMe local, amortized)
GPU:    1 GPU per 10 hosts at $1/GPU-hour     = ~$0.30 per million queries
Total: ~$6 per million queries (~$0.000006 per query)
```

These numbers move 2-5x in either direction depending on workload. The dominant cost in most systems is memory, followed by CPU.

### Memory Cost

The index is the biggest memory line item. For a 1B-document inverted index:

- Posting lists (compressed FastPFOR): ~150 GB.
- Dictionary (FST): ~50 GB.
- Skip structures: ~5 GB.
- Doc store: ~100 GB (depends on payload).
- Caches (filter, query result): ~20 GB.

Total: ~325 GB. Sharded across 4 hosts: ~80 GB each, fits a 96 GB host with overhead.

For a 1B-vector ANN index:

- HNSW: ~3.5 KB per vector at d=768, M=32. 3.5 TB total. Typically sharded 32x to 110 GB per host.
- IVFPQ at 96 bytes per vector: 96 GB total. Single-host feasible.
- Centroids and metadata: another 10-50 GB.

Vector indexes are memory-hungrier than inverted indexes because they store full or near-full precision vectors. Quantization (PQ) brings the cost down by 30x but with a recall hit.

### CPU Cost

Per-query CPU time is dominated by:

1. Posting list decompression and intersection (BMW or MaxScore loop).
2. Scoring (BM25 or LTR feature eval).
3. ANN distance computation (SIMD inner products).
4. Tree ensemble inference (LambdaMART scoring).

For lexical retrieval, decompression is typically 30-50 percent of CPU time. SIMD codecs (FastPFOR with AVX-512) cut this by 2-4x compared to byte-level VByte. Switching codecs is one of the highest-ROI single optimizations.

For ANN, distance computation dominates. SIMD-optimized kernels (FAISS's, USearch's) get 2-3x over naive code. For PQ, the table-lookup inner loop benefits from AVX-512 gather.

Tree ensemble inference is fast (microseconds) but accumulates: a 1000-tree LambdaMART scoring 100 documents is 0.1 ms. Compiling trees to native code (treelite) gives another 2-3x.

### Cache Hit Ratio

Caches save CPU and memory bandwidth. Three caches in a typical system:

- **Query result cache.** Hit rate 30-50 percent for non-personalized search, near zero for personalized. Saves all downstream compute.
- **Posting list cache.** Hit rate 80-95 percent (a small set of common terms covers most queries). Saves I/O.
- **Filter cache.** Hit rate 70-90 percent for repeated filter combinations. Saves bitmap construction.

Each cache has memory cost. The break-even for a query result cache is roughly: if the hit rate times the per-query compute saved exceeds the per-byte memory cost amortized, it pays. For typical numbers, a query result cache of 10 GB pays for itself many times over.

### GPU vs CPU for Vector Search

The hottest cost question in 2024-2026.

**GPU wins:**
- Very large indexes (>1B vectors) where CPU memory is a bottleneck.
- High dimensions (>1024) where SIMD on CPU is bandwidth-bound.
- Cross-encoder reranking (the model is the bottleneck).
- Embedding generation at index time.

**CPU wins:**
- Small indexes (<10M vectors) where GPU is overkill.
- High QPS at moderate latency where GPU batching is expensive.
- Cost-sensitive workloads where memory cost dominates.
- Workloads with frequent updates (GPU index update is harder).

FAISS supports both with `IndexFlatIP` (CPU brute force), `IndexHNSWFlat` (CPU HNSW), `IndexIVFPQ` (CPU PQ), and `GpuIndex*` variants. GPU performance scales with HBM bandwidth: A100 (1.5 TB/s) is roughly 3x H100 (3 TB/s) in practice for distance-bound kernels.

For inner-product search at d=1024 on 1B vectors with PQ-compression, an H100 hits ~50000 QPS at 95 percent recall@10. Achieving the same on CPU takes roughly 8 high-end servers. Cost-per-QPS roughly favors GPU by 2-3x at this scale.

### Cold Tier and Disk

Not every document is queried with the same frequency. The "cold tier" is documents queried rarely (long-tail content, archival). Storing them in RAM is wasteful. Approaches:

- **Tiered storage.** Hot tier in RAM, warm in NVMe, cold in object storage. Query first hits hot, falls back to warm, falls back to cold with progressive latency.
- **DiskANN.** A graph-based ANN index designed for SSD-resident vectors. Used at Bing.
- **Pinecone serverless.** Slabs of data fetched on demand from object storage, with a hot cache.

Disk-resident designs trade latency for cost. A query that hits cold tier might take 200 ms instead of 20 ms, but cold tier costs 1/100 of RAM. The break-even depends on how often the query path is hit.

### Query Budget Enforcement

The backend exposes a budget knob: max latency, max compute, max documents scanned. The query stops when the budget is exhausted, returning best-effort results.

```cpp
struct QueryBudget {
    std::chrono::milliseconds latency{100};
    std::size_t max_docs_scanned{1'000'000};
    std::size_t max_features_computed{100'000};
};
```

Each stage checks the budget and degrades gracefully. The retrieval might return only 500 candidates instead of 1000, the second-stage might score 50 instead of 100. The user gets a slightly worse result but on time.

### Batching for Throughput

Single-query latency vs throughput is a constant tradeoff. Batching multiple queries together amortizes overhead (model loading, kernel launch on GPU). For embedding inference, batched queries get 5-10x QPS at slightly higher per-query latency.

Production: a small batching window (1-5 ms) collects queries, then runs them as a batch. Latency cost is the batching window plus possibly some queue time, throughput gain is the batch efficiency.

For cross-encoder reranking on GPU, batching is essential. A batch of 100 (q, d) pairs at 50 ms is 0.5 ms per pair effective, one at a time is 50 ms.

### Right-Sizing the Fleet

Auto-scaling based on QPS is standard. The harder question is per-host capacity: how many QPS can one host serve at the latency target?

Run a load test that ramps QPS until p99 hits the target. The QPS at that point is the per-host capacity, with safety margin (typically 70 percent). Fleet size is total QPS divided by per-host capacity divided by safety factor.

Tail-at-scale (chapter 14) means per-host capacity drops with cluster size: more shards means more chances of slow shards. The fleet size grows superlinearly. Mitigations (hedged requests) cost more per query but reduce the fleet sizing penalty.

### Spot and Preemptible Hosts

Major cost lever. Spot/preemptible compute is 50-80 percent cheaper than on-demand. Cost: hosts can be reclaimed at short notice. Search workloads tolerate this poorly because preemption disrupts the index.

Production: stateless components (brokers, query rewriters, embedding services) on preemptible. Stateful components (content nodes holding the index) on on-demand.

Some teams build replicated stateful nodes on preemptible: the loss of one replica is recoverable from the others. Done well, this saves 30-40 percent on the largest cost line item.

### A C++ Profiling Note

C++ search code is often profiled with `perf` (Linux), VTune, or Instruments (macOS). The signals to look for:

- High cache miss rate in the inner posting list scan (codec issue).
- High branch mispredict rate in the WAND loop (sort cost).
- Memory bandwidth saturation in HNSW search (vector access pattern).
- TLB misses in scattered HNSW graph access.

Each has a known fix. The skill is recognizing the signature in a flame graph and reading the assembly to confirm.

### Junior to FAANG

A junior runs the system as configured. A senior at Bing or Google profiles every release for cost-per-query regression and uses budget knobs to enforce SLOs even when models grow. A staff engineer treats cost as a first-class metric on every dashboard, runs proactive shrinkage projects (smaller models with same quality, better caches, bigger shards), and quantifies the marginal cost of new features. The interview question: "your search service costs \$1M/month. Where would you look for 20 percent savings?" Senior answer covers: profile first, look at the dominant cost line, evaluate spot/preemptible options, look at index compression, evaluate quantization for ANN. Great answer adds: also look at quality-cost tradeoffs (a 0.5 percent NDCG loss might unlock 15 percent cost reduction, ask the product team if that is acceptable).

---
