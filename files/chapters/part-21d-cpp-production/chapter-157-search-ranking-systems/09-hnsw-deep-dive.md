## HNSW Deep Dive

Hierarchical Navigable Small World (Malkov and Yashunin 2018) is the most widely deployed ANN algorithm in production. hnswlib (the reference C++ implementation), FAISS's IndexHNSWFlat, NMSLIB, USearch, Qdrant, Weaviate, Milvus, and Vespa all ship HNSW. The paper's experimental superiority on most benchmarks held up for years and HNSW remains the default choice for "I want decent recall with low latency, no extreme constraints".

### The Core Idea

Build a multi-layer graph. Layer 0 contains every vector. Layer 1 contains a random subset (e.g. 1/16 of layer 0). Layer 2 a subset of layer 1, and so on. Each layer is a navigable small-world graph: nodes have edges to nearby neighbors with a few "long-range" links that make the graph diameter logarithmic.

Search starts at the entry point (a node in the topmost layer). Greedy walk to the closest neighbor at this layer. When no neighbor is closer, descend one layer, repeat. At layer 0, do a beam search (with width `ef_search`) to collect the top-k results.

The hierarchy gives logarithmic search complexity. The small-world property gives high recall.

### Parameters

**M.** Number of bidirectional links per node at each layer (above layer 0). Layer 0 typically has 2M links. Higher M improves recall but costs memory and build time. Production defaults: M = 16 (good general default), M = 32 (higher recall), M = 64 (very high recall, large memory).

**ef_construction.** Beam width during build. Higher means better-quality graph at higher build cost. Defaults: 100-200. Diminishing returns above 400.

**ef_search.** Beam width at query time. The single knob to trade latency for recall. Defaults: 50-100 for 95 percent recall@10, 200-500 for 99 percent recall.

**M_max0.** Max links per node at layer 0. Usually 2M (the paper's recommendation).

**Level distribution.** Each new node is assigned a random level `floor(-log(uniform()) * mL)`, where `mL = 1 / log(M)`. This gives an exponential distribution with mean `1 / log(M)`, so most nodes are at layer 0, and very few at high layers.

### Insertion Algorithm

```
insert(q):
    L_q = sample_level()           // exponential, capped
    enter = entry_point
    for L = top_layer down to L_q+1:
        enter = greedy_search_one_layer(q, enter, L)
    for L = min(L_q, top_layer) down to 0:
        candidates = beam_search(q, enter, L, ef_construction)
        neighbors = select_neighbors(q, candidates, M)
        for n in neighbors:
            connect(q, n, L)
            if degree(n, L) > M_max(L):
                shrink_neighbors(n, L)
        enter = candidates[0]
    if L_q > top_layer:
        top_layer = L_q
        entry_point = q
```

`select_neighbors` is where most implementations differ. The paper suggests a heuristic: starting from the candidate set, pick neighbors greedily, but skip a candidate if it is closer to an already-picked neighbor than to the query. This produces a more navigable graph than simple top-M.

`shrink_neighbors` is the same heuristic applied to a node that has too many connections after insertion.

### Search Algorithm

```
search(q, k, ef):
    enter = entry_point
    for L = top_layer down to 1:
        enter = greedy_search_one_layer(q, enter, L)
    candidates = beam_search(q, enter, 0, max(ef, k))
    return top_k(candidates)

beam_search(q, enter, L, ef):
    visited = {enter}
    candidates = priority_queue_min_dist({enter})
    results   = priority_queue_max_dist({enter})  // capped at ef
    while !candidates.empty():
        c = candidates.pop_min()
        if dist(c, q) > results.top().dist: break
        for n in neighbors(c, L):
            if n in visited: continue
            visited.insert(n)
            d = dist(n, q)
            if results.size() < ef or d < results.top().dist:
                candidates.push(n, d)
                results.push(n, d)
                if results.size() > ef: results.pop_max()
    return results
```

The two heaps (min-heap of unvisited candidates, max-heap of best-so-far results) are the standard structure. Termination condition `dist(c, q) > results.top().dist` means: the closest unvisited candidate is farther than the current k-th best result, so further search cannot improve.

### Memory Layout

A naive HNSW lays out node data, neighbor lists, and vectors separately. hnswlib uses a single contiguous arena per node where layer 0 is laid out as:

```
[ node_metadata | neighbors_layer_0 | vector | external_id | upper_layers_offset ]
```

This is cache-friendly: when the search visits a node, neighbor list and vector are likely on the same cache line.

USearch (Unum) takes this further with custom allocators for NUMA awareness. FAISS uses its own simpler layout.

### C++ With hnswlib

The reference implementation:

```cpp
#include "hnswlib/hnswlib.h"

int dim = 768;
size_t max_elements = 1'000'000;
int M = 16;
int ef_construction = 200;

hnswlib::InnerProductSpace space(dim);
auto index = std::make_unique<hnswlib::HierarchicalNSW<float>>(
    &space, max_elements, M, ef_construction);

// Index. Vectors must be L2-normalized for cosine via inner product.
for (size_t i = 0; i < num_vectors; ++i) {
    index->addPoint(vectors[i].data(), i);
}

// Search.
index->setEf(100);
auto result = index->searchKnn(query.data(), 10);
while (!result.empty()) {
    auto [dist, label] = result.top();
    result.pop();
    // ...
}

// Persist.
index->saveIndex("index.hnsw");
```

The hnswlib `addPoint` is thread-safe under a per-instance mutex, concurrent insert + search works via a different `searchKnn` path with reader-writer semantics. Memory cost: roughly `(M * 8 bytes) * num_layers + dim * 4 bytes + 8 bytes` per vector. For 1M vectors at dim=768, M=16: about 3.5 GB.

### FAISS HNSW

FAISS wraps HNSW with a different memory model and offers IVF-HNSW (HNSW used as the coarse quantizer for IVF). The standard call:

```cpp
faiss::IndexHNSWFlat index(dim, M, faiss::METRIC_INNER_PRODUCT);
index.hnsw.efConstruction = 200;
index.add(num_vectors, vectors_flat.data());
index.hnsw.efSearch = 100;
index.search(num_queries, queries.data(), k, distances.data(), labels.data());
```

FAISS HNSW is more permissive about composition (IndexHNSWPQ for PQ-compressed vectors plus HNSW graph) and easier to use within FAISS pipelines. Pure-HNSW performance on simple workloads is comparable to hnswlib.

### USearch

USearch (Unum) is a more modern HNSW implementation in C++ with attention to SIMD distance kernels (AVX-512, NEON, RISC-V V), reduced precision (bf16, f8, i1), and disk-resident indexes. On AVX-512 hardware, USearch typically beats hnswlib by 1.5-3x on distance-bound workloads. USearch is the basis of the upcoming MongoDB Atlas vector search backend.

### Updates and Deletes

HNSW does not natively support delete. Three approaches:

1. **Tombstone bitmap.** Mark deleted nodes and filter them at the result-collection step. Graph degrades over time, rebuild periodically. hnswlib added `markDelete` for this in 2022.

2. **Replacement insert.** Replace a deleted slot with a newly inserted vector at the same node-id. hnswlib's `addPoint(vec, replace_id)` does this. Graph quality degrades less, but an inserted vector's local neighborhood does not match the prior neighborhood, so a few stale links remain.

3. **Rebuild.** Build a new index in the background, swap. Most production systems with stable corpora do this nightly.

For high update-rate workloads (recommendation systems, real-time content), HNSW is the wrong choice. IVF or DiskANN with explicit support for deletes is better.

### When HNSW is Wrong

- **Memory-constrained.** Full-precision vectors plus graph is large. Use IVFPQ or HNSW with PQ-compressed vectors.
- **Disk-resident.** HNSW's random-access graph traversal is brutal on SSDs. DiskANN (Microsoft Research, 2019) is purpose-built for this case.
- **High update rate.** See above.
- **Filtered search at scale.** HNSW post-filtering (search then filter) loses recall when filters are restrictive (1 percent of corpus matches the filter). Vespa, Weaviate, and Pinecone implement various forms of in-graph filtering.
- **Tiny corpora (under 100k vectors).** Brute force scan with SIMD is faster than HNSW search and trivially supports updates and deletes. FAISS's `IndexFlatIP` is the right answer.

### Junior to FAANG

A junior calls `addPoint` and ships. A senior at Weaviate or Qdrant tunes `M` and `ef_construction` per workload, runs ann-benchmarks-style sweeps, and knows that HNSW recall depends on the **distribution** of vectors and not just their dimension. A staff engineer can derive the level distribution from the geometric distribution proof in the paper, explain why the heuristic neighbor selection beats top-M, and discuss the open research problems (filtered HNSW, dynamic updates, multi-vector retrieval). The hardest interview question: "the build is too slow, what would you change?" Senior answer: profile to see if it is distance computation (SIMD it), neighbor selection (the heuristic is O(M^2) per insert), or memory allocation (arena it). Then attack the dominant cost.

---
