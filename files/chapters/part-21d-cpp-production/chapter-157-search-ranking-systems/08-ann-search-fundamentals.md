## ANN Search Fundamentals

Approximate nearest neighbor (ANN) search trades a small recall loss for a massive speedup over exact KNN. At billion-vector scale, exact KNN is impossible: scanning a billion 768-dim float32 vectors is 3 TB of memory traffic per query. Modern ANN indexes return 95-99 percent recall@10 in under 10 milliseconds per query, often single-digit milliseconds. This chapter covers the fundamentals. HNSW, IVF/PQ, and ScaNN follow in their own chapters.

### Distance Metrics

Three matter in practice:

**L2 (Euclidean).** `||q - d||_2 = sqrt(sum (q_i - d_i)^2)`. Image embeddings (CNN features) usually live in L2 space.

**Cosine.** `1 - (q . d) / (||q|| ||d||)`. Almost all text embedding models output L2-normalized vectors and use cosine. After normalization, cosine and inner product are equivalent.

**Inner Product (IP).** `q . d`. The natural metric for some embedding models (specifically those trained with dot product loss), and the metric the recommendation literature uses for matrix factorization. IP search is harder than L2 because the "nearest" in IP can be a vector with large norm, breaking the triangle inequality and many ANN heuristics.

In production, normalize embeddings to unit norm at training time and use cosine (or equivalently IP). It avoids most of the IP-specific algorithm complexity.

### Why High Dimensions Break Trees

KD-trees, ball trees, and cover trees work in low dimension (under 30). They split space recursively along axis-aligned hyperplanes. The query descends the tree to a leaf, then backtracks to check sibling nodes whose distance bound is below the current best.

In high dimension, this backtracking eats the speedup. The "curse of dimensionality" is precise: in d dimensions, the volume near the surface of a ball of radius r grows as r^d, so most of the volume of any ball is near its surface. Translated: nearly every leaf of a KD-tree has neighbors that **could** contain a closer point, so backtracking visits almost every leaf. KD-tree on 768-dim vectors degrades to brute-force scan.

Above d=30 or so, partitioning trees lose to graph-based methods (HNSW, NSG) and to quantization-based methods (PQ, OPQ, ScaNN).

### Locality-Sensitive Hashing

LSH (Indyk and Motwani 1998) hashes vectors so that close vectors collide with high probability and far vectors collide with low probability. For cosine similarity, the canonical hash is **random hyperplane**: pick a random unit vector r, hash the input as `sign(x . r)`. Two vectors agree on this hash with probability `1 - theta/pi`, where theta is the angle between them.

Use multiple hash functions concatenated to form a bucket key. Use multiple independent hash tables to ensure recall.

```cpp
// Cosine LSH with K hyperplanes per table, L tables.
struct CosineLsh {
    std::vector<std::vector<std::vector<float>>> hyperplanes; // [L][K][d]
    std::vector<std::unordered_map<std::uint64_t, std::vector<DocId>>> tables;

    std::uint64_t hash(const float* v, std::size_t d, int t) const {
        std::uint64_t h = 0;
        for (int i = 0; i < K; ++i) {
            float dot = 0;
            for (std::size_t j = 0; j < d; ++j) dot += v[j] * hyperplanes[t][i][j];
            h |= (dot >= 0 ? 1ULL : 0ULL) << i;
        }
        return h;
    }
};
```

LSH was the dominant ANN method in the 2010s and is still the right answer for some workloads (very high dimension > 4000, streaming inserts where graph methods are expensive). For typical 384-1536 dim text embeddings, LSH loses to HNSW and IVFPQ on both recall and speed. LSH lives on in academic papers and in `falconn` library, production systems rarely use it as the primary index.

### Quantization Families

If you cannot afford to store full-precision vectors, quantize. Three levels:

**Scalar quantization (SQ).** Each float dimension stored as 8-bit (or 4-bit). Roughly 4x memory reduction with under 1 percent recall loss. FAISS's `IndexScalarQuantizer` and most production engines support this.

**Product quantization (PQ).** Split the vector into M subvectors, run k-means with k=256 on each subspace, store each subvector as one byte (the centroid index). A 768-dim float32 vector (3072 bytes) becomes 96 bytes. Compression ratio ~32x. Quality loss varies but is typically 5-10 percent recall@10 in raw form, recoverable with rerank.

**Binary quantization.** Each dimension to one bit (sign). 32x compression. Hamming distance (`popcount(a XOR b)`) is brutal-fast. Quality loss is large, useful only for very-high-dimensional embeddings (1024+) where the loss is partly absorbed by dimensionality redundancy.

PQ details, including OPQ and ScaNN's anisotropic variant, are in chapter 10.

### Graph-Based Search

The high-dimensional answer that beats trees and competes with quantization. Idea: build a graph where each vector has K outgoing edges to nearby vectors. Query: start at a random node, greedily walk to the neighbor closest to query, repeat until no neighbor is closer. Visited nodes form the candidate pool, return the top-k by distance.

The classical version is Navigable Small World (NSW). HNSW (Malkov and Yashunin 2018) adds a hierarchy of layers so that the search starts at a coarse layer and zooms in, achieving log-scale search. HNSW gets its own chapter (09).

Trade-offs of graph methods: high recall, fast query, but expensive to build (build is many small ANN queries each), and updates are complex (adding a vector means stitching it into the graph). Memory cost is dominant: full-precision vectors plus graph edges. A 100M-vector HNSW index at 768 dim with M=32 is roughly 350 GB.

### SIFT, GIST, and the Standard Benchmarks

Three datasets dominate ANN benchmarking:

- **SIFT1M, SIFT1B.** 128-dim float vectors from SIFT image descriptors. Easy by modern standards, recall@1 of 99 percent is achievable with very tight latency budgets.
- **GIST1M.** 960-dim vectors. More representative of modern embedding dimensions.
- **Deep1B (Deep1M, Deep10M).** 96-dim image embeddings from a deep CNN. The first benchmark with "deep" in the name.

Modern benchmarks add:

- **MS MARCO passages.** Text retrieval with 8.8M passages and a query set with judgments. Real text-retrieval task.
- **BEIR.** A benchmark suite of 18 retrieval tasks across domains. The standard for embedding model evaluation.
- **MTEB.** The Massive Text Embedding Benchmark from HuggingFace, broader than BEIR.

ann-benchmarks.com runs reproducible benchmarks for FAISS, HNSWlib, ScaNN, NGT, Annoy, Vald, and others on SIFT, GIST, and a few text datasets. Treat its numbers as a starting point, production behavior on your corpus may differ by 30 percent in either direction.

### Recall vs Latency Curves

Every ANN index has a parameter that trades recall for latency. HNSW: `ef_search`. IVF: `nprobe`. The right way to compare indexes is to plot recall@10 vs queries-per-second on the same data and pick the index that dominates at your target recall.

A general shape:

- IVF flat (no quantization) wins at recall > 99 percent if you have enough RAM.
- HNSW wins at recall 95-99 percent.
- IVFPQ wins at memory-constrained operating points (1-10 GB for a billion vectors).
- ScaNN wins at recall 90-99 percent on inner-product workloads, especially at large scale.

### Junior to FAANG

A junior picks HNSW because someone said HNSW. A senior at Pinecone or Weaviate picks the index by reading the recall-vs-latency curves on their actual corpus, knows that the choice changes if the embedding model changes, and knows that rerank with full-precision vectors after PQ recall is the way to recover quality. A staff engineer at FAISS or ScaNN can draw the math of L2 vs IP and explain why anisotropic quantization is targeted at IP and is not relevant to L2-normalized cosine workloads. The interview question: "you have 10 billion 1024-dim vectors, recall@100 target 95 percent, p99 query latency budget 30 ms, fleet budget 100 servers. Design the index." There is no single right answer, senior candidates discuss IVFPQ + rerank, HNSW with PQ-compressed neighbors, ScaNN with reorder, and pick among them based on the embedding distribution.

---
