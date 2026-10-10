## Exercises

Six labs, each calibrated to take a focused engineer 4-8 hours. They build on the chapter material and produce working C++ code. Each lab has a deliverable, a reference performance bar, and a set of senior-bar extensions.

### Lab 1: Build a Posting List Codec Benchmark Harness

**Goal.** Implement and benchmark VByte, Group VarInt, Simple9, and FastPFOR128 (you may use the FastPFOR library for the latter) on synthetic and real-corpus posting lists.

**Steps.**

1. Generate synthetic posting lists from various distributions: uniform, Zipfian, clustered. Document length 100k entries.
2. Implement VByte and Group VarInt from scratch in C++. Use FastPFOR's library for the SIMD codec.
3. Build a harness that measures encode time, decode time, and compressed size.
4. Run on a real-corpus sample if you can find one (TREC, Common Crawl extract).

**Reference bars.**

- VByte: ~200 M ints/sec decode.
- Group VarInt: ~800 M ints/sec.
- Simple9: ~1.5 B ints/sec.
- FastPFOR128: ~4 B ints/sec on AVX2.

**Senior extensions.**

- Add Roaring bitmaps as a comparison, measure when Roaring beats PFOR (hint: density).
- Profile L1/L2/L3 miss rates per codec with `perf stat`.
- Implement a SIMD-aware decode buffer (alignas 64).

### Lab 2: BMW Top-K Retrieval

**Goal.** Implement Block-Max WAND on top of an in-memory inverted index for a corpus of at least 1 million documents.

**Steps.**

1. Build the inverted index using the InvertedIndex sketch from chapter 02. Use a small Wikipedia dump or arXiv abstracts.
2. Compute per-term upper bounds (max BM25 contribution across all docs containing the term).
3. Compute per-block max scores for blocks of 128 postings.
4. Implement WAND and BMW in the same code base, with a flag to switch.
5. Run a query trace and measure docs scored, time per query, and result quality (vs full scan).

**Reference bars.**

- WAND scores 5-15 percent of the union of posting lists for typical queries.
- BMW scores 1-5 percent.
- 100 ms median query time on 1M docs (room for improvement).

**Senior extensions.**

- Implement MaxScore. Compare on long queries (10+ terms).
- Add a quality check: BMW results match exhaustive scan top-10 on a sample of queries.
- Profile the pivot sort cost, replace with a partial sort and measure.

### Lab 3: HNSW from Scratch

**Goal.** Implement HNSW from the paper without using hnswlib. Validate against hnswlib for recall and speed.

**Steps.**

1. Read Malkov and Yashunin (2018).
2. Implement insertion: level sampling, beam search per layer, neighbor selection heuristic.
3. Implement search: greedy descent through upper layers, beam search at layer 0.
4. Add cosine distance with SIMD (AVX2 inner product).
5. Build an index of 100k SIFT vectors. Run 1k queries. Compare recall@10 and QPS to hnswlib.

**Reference bars.**

- 95 percent recall@10 at ef_search=50.
- Within 2x of hnswlib QPS (your code is unlikely to beat hnswlib).
- Index build time within 3x of hnswlib.

**Senior extensions.**

- Profile the SIMD distance kernel. How close to memory bandwidth limit can you get?
- Implement filtered search. Compare post-filter vs in-graph filter on a 10 percent selectivity filter.
- Add concurrent insert + search using a shared mutex.

### Lab 4: IVFPQ End-to-End

**Goal.** Implement IVFPQ from scratch (use FAISS for k-means but write the index and search yourself).

**Steps.**

1. Train coarse k-means with nlist=1024 centroids on SIFT1M vectors.
2. Compute residuals (vec - centroid).
3. Train PQ with M=8 subspaces of dim=16, k=256 per subspace, on residuals.
4. Build the IVF: assign each vector to its centroid's posting list, store its PQ code.
5. Implement search: find nprobe nearest centroids, scan their lists with ADC scoring.
6. Measure recall@10 and QPS at varying nprobe.

**Reference bars.**

- Recall@10 of 80-90 percent at nprobe=16.
- 1000+ QPS on a single core.
- Memory: 16 bytes per vector + centroids.

**Senior extensions.**

- Add residual reranking: rescore top-100 by ADC with full-precision vectors.
- Measure quality with and without rerank.
- Compare to FAISS's IVFPQ on the same data, explain any gap.

### Lab 5: Multi-Stage Ranker on a Real Dataset

**Goal.** Build a multi-stage ranking pipeline on MS MARCO passage retrieval (you can use the dev split, ~100k passages, ~7k queries).

**Steps.**

1. First stage: BM25 over the corpus using a Lucene-like inverted index (Tantivy or your own from Lab 2). Top-100.
2. Add dense retrieval: encode queries and passages with a public model (sentence-transformers/all-MiniLM-L6-v2 via ONNX). Use FAISS's IndexFlatIP. Top-100.
3. Fuse with RRF.
4. Add a learning-to-rank reranker: train an XGBoost ranker on a small held-out sample, using BM25 score, dense score, passage length, and query-passage word overlap as features.
5. Evaluate NDCG@10 and MRR@10 on the dev set.

**Reference bars.**

- BM25-only: ~20 percent MRR@10.
- BM25 + dense RRF: ~30 percent MRR@10.
- With LTR rerank: ~32 percent MRR@10.
- Total query latency under 50 ms on the dev set.

**Senior extensions.**

- Add a cross-encoder reranker (sentence-transformers cross-encoder) on the top-50.
- Quantify quality and latency cost.
- Profile and find the dominant cost, explain how you would reduce it.

### Lab 6: Build the Vector Search Engine from Chapter 21

**Goal.** Take the design in chapter 21 and turn it into running C++23 code. Add tests.

**Steps.**

1. Implement `WritableSegment`, `SealedSegment`, `Index`, `HnswIndex` (wrapping hnswlib), and `RoaringBitmaps` (using CRoaring).
2. Add an HTTP API (Boost.Beast or simple raw sockets) for `POST /docs`, `DELETE /docs/{id}`, `POST /search`.
3. Add background sealing when the writable segment hits 10k docs.
4. Add a simple merge policy: when there are 5+ segments smaller than 100k, merge them.
5. Persist segments to disk and restore on startup.
6. Write integration tests: insert 1M documents, run 1k queries, validate top-10 against a brute-force baseline.

**Reference bars.**

- 1M-document index ingestion in under 5 minutes.
- p99 query latency under 50 ms.
- 95 percent recall@10 vs brute-force ground truth.
- Crash recovery: kill the process mid-ingestion, restart, validate that committed segments are intact.

**Senior extensions.**

- Add filtered search by category and language.
- Implement a translog so that uncommitted writes survive a crash.
- Add a small load test that ramps QPS and finds the per-host capacity.
- Compare your engine to Qdrant or Weaviate on the same data, quantify the gap.

---

These labs are calibrated as "build something real". The reference bars are what an engineer with the chapter material under their belt should hit. The senior extensions are what FAANG search-infrastructure engineers do as the production version of these labs.

If you complete all six, you will have a portfolio that demonstrates senior-level search infrastructure capability. The labs together produce roughly 10-15k lines of working C++.

---
