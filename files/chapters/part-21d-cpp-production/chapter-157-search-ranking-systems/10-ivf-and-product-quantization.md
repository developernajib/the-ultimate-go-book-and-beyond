## IVF, Product Quantization, and ScaNN

When a billion vectors at full precision is too much memory, the answer is usually IVFPQ or one of its descendants (OPQ, ScaNN's anisotropic). These methods combine a coarse partitioning (IVF) with a residual quantization (PQ) and have been the workhorse of large-scale ANN since Jegou, Douze, and Schmid published PQ in 2010.

### Inverted File (IVF)

Run k-means on the corpus with k = `nlist` cluster centroids. Each vector is assigned to its nearest centroid, forming `nlist` posting lists (the inverted file). At query time, find the `nprobe` centroids nearest the query and scan only those posting lists.

```
nlist  = 4 * sqrt(N)  is a reasonable starting point
nprobe = 16 to 64     trades recall for latency
```

Pure IVF (with full-precision vectors stored in each cell) gives a `nlist / nprobe` speedup over brute force. For N=1B, `nlist=64k`, `nprobe=64`, that is 1000x speedup. Memory cost: full vectors plus cluster assignments.

The trick: IVF alone is not the win. The win is IVF combined with quantization (PQ) so that the per-cell scan is over compressed vectors.

### Product Quantization

Split a d-dimensional vector into M subvectors of dimension d/M. Run k-means with k=256 on each subspace independently. Each subvector is now represented by a one-byte centroid index. The full vector is M bytes.

```
d = 768, M = 96    ->  per-vector storage: 96 bytes  (32x smaller than float32)
d = 128, M = 16    ->  per-vector storage: 16 bytes  (32x smaller)
```

Distance between query q and PQ-compressed vector x:

- **Asymmetric distance computation (ADC).** Decompose q into the same M subspaces. For each subspace, precompute distances from q's subvector to all 256 centroids in that subspace (`256 x M` floats = 96 KB for M=96). Then `dist(q, x) = sum over m of dist_table[m][x_code[m]]`. M lookups, M sums per vector. The look-up table is tiny and stays in L1.

- **Symmetric distance computation (SDC).** Quantize q too, then look up centroid-to-centroid distances precomputed at index time. Faster but less accurate. Rarely used in production.

ADC is what FAISS implements. The inner loop is M dependent table lookups (gather instructions), summed. With M=16-32 it fits SIMD nicely.

```cpp
// ADC scoring sketch (M=16 case).
alignas(64) float lut[16][256];   // dist tables, query-dependent
// ... compute lut from q ...

float adc_distance(const std::uint8_t* code) {
    float d = 0;
    for (int m = 0; m < 16; ++m) {
        d += lut[m][code[m]];
    }
    return d;
}
```

FAISS implements this with AVX-512 gather + reduce, achieving ~1 GB/s of code scanning per core.

### IVFPQ

IVF + PQ. Each cell contains PQ-compressed vectors. To improve quantization quality, store the **residual** after subtracting the cell centroid: `x_residual = x - centroid(cell(x))`. Quantize the residual instead of the raw vector. Residuals have lower variance (the centroid absorbed most of the magnitude), so PQ codes the residuals better.

```cpp
// FAISS IVFPQ.
int d = 768;
int nlist = 16384;
int M = 96;       // PQ subquantizers
int nbits = 8;    // bits per subquantizer (8 = 256 centroids)

faiss::IndexFlatIP coarse(d);
faiss::IndexIVFPQ index(&coarse, d, nlist, M, nbits);
index.train(nb_train, training_vectors);
index.add(nb, vectors);

index.nprobe = 32;
index.search(nq, queries, k, distances, labels);
```

Memory: 96 bytes per vector (PQ) + 4 bytes (cell id) + cluster centroids (16384 * 768 * 4 bytes ≈ 50 MB). For 1B vectors: ~100 GB total, easily fits a single large server.

### OPQ: Optimized Product Quantization

Ge, He, Ke, Sun (2013). PQ assumes subspaces are decorrelated. Real embeddings have strong inter-dimension correlations. OPQ learns a rotation matrix R that decorrelates subspaces before PQ.

```
x' = R * x
quantize x' with PQ
distance(q, x) = ||R*q - PQ_decode(code)||^2
```

R is learned by alternating minimization: fix PQ, update R, fix R, update PQ. Quality: 1-3 percent recall improvement over plain PQ. FAISS's `IndexPreTransform` with `OPQMatrix` is the standard usage.

### Residual / Multi-Stage Quantization

Quantize x with PQ to get a primary code. Compute the residual `x - PQ_decode(code)`. Quantize the residual with another PQ. Two-stage PQ. Recursive: third stage on the second residual, etc. Each stage doubles the storage but adds quality. Used in FAISS's `IndexResidualQuantizer` (added 2021).

### Anisotropic Quantization (ScaNN)

Guo, Sun, Lindgren et al. 2020 (the ScaNN paper). PQ minimizes `||x - x_quantized||^2` (reconstruction error). For inner-product search, the quantization error in the **direction of likely queries** matters more than in orthogonal directions. ScaNN's anisotropic loss reweights the quantization to favor accuracy in the high-norm direction:

```
L = ||x_par - x_par_quantized||^2 * h_parallel
  + ||x_perp - x_perp_quantized||^2 * h_perpendicular
```

Where `x_par` is the component of x parallel to its own direction (rough proxy for "where queries are likely to look"), `x_perp` is orthogonal, and `h_parallel >> h_perpendicular`. The result: at the same compression, ScaNN improves recall@10 over PQ by 5-15 percent on inner-product workloads.

ScaNN's C++ implementation lives in google-research/scann. It is used at scale at Google for YouTube recommendations and Search candidate generation.

```cpp
// ScaNN via its Python wrapper, the most common path.
// In C++ via the google-research/scann library, the API is similar but verbose.
// scann_searcher = scann.scann_ops_pybind.builder(db, 10, "dot_product")
//                       .tree(num_leaves=2000, num_leaves_to_search=100,
//                             training_sample_size=250000)
//                       .score_ah(2, anisotropic_quantization_threshold=0.2)
//                       .reorder(100).build()
```

Three stages: tree (coarse partitioning, like IVF), score_ah (asymmetric hashing, ScaNN's PQ variant), reorder (rerank top-100 with full-precision vectors).

### ScaNN's Reorder

The final reorder stage is critical. ScaNN's anisotropic PQ produces approximate inner-product scores, the top 100 (or top 1000) by approximate score are reranked with the exact (or higher-precision) inner product. This recovers most of the quantization loss for the top-k. Almost every PQ-based system in production does some form of reorder.

### When IVFPQ Beats HNSW

- **Memory budget tight.** IVFPQ at 96 bytes/vector vs HNSW at ~3.5 KB/vector for d=768.
- **Disk-resident.** IVF posting lists scan sequentially, friendly to SSDs. HNSW random-traverses, slow on disk.
- **Updateable.** Adding a vector is `assign to cell, append PQ code`. HNSW insert is many distance computations.
- **Simple to shard.** Distribute cells across machines. HNSW does not shard cleanly.

When HNSW beats IVFPQ:

- **Recall target very high (>99 percent).** PQ has a quality ceiling.
- **Latency target very tight.** HNSW visits 100-1000 vectors. IVFPQ scans 100k+.
- **Memory plentiful.** No reason to compress.

Production systems often combine both. FAISS's `IndexHNSWFlat` uses HNSW as the coarse quantizer for IVF, replacing the k-means centroids, this gives IVF the speed of HNSW for the cell lookup.

### DiskANN

Microsoft Research's DiskANN (NeurIPS 2019) addresses the disk-resident case directly. A single-pass graph search that touches O(log N) disk pages, with an in-memory PQ-quantized representation for distance computation and a disk-resident full-precision vector for final reranking. Used in production at Bing and Microsoft Vector Search.

### Junior to FAANG

A junior trains IVFPQ with FAISS defaults and ships. A senior at Pinecone or Milvus profiles the assignment quality (residual variance), tunes nlist and M jointly, runs OPQ to gain another percent, and reranks with full-precision vectors. A staff engineer at Google or FAISS understands ScaNN's anisotropic loss derivation, can argue when it applies (IP-trained models, large corpora) and when it does not (cosine-normalized embeddings where it reduces to standard PQ), and can write the SIMD inner kernel for ADC scoring. Interview question to expect: "your IVFPQ has 92 percent recall@10. The product team wants 97. What do you change?" Good answer covers: increase nprobe, switch to OPQ, add reorder stage, increase M, switch to anisotropic PQ. Great answer adds: profile to see whether the loss is at coarse-quantization (more nlist) or PQ stage (more bits) and act accordingly.

---
