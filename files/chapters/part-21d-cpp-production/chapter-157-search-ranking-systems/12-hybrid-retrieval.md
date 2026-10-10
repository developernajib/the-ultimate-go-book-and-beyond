## Hybrid Retrieval

Lexical (BM25) and dense (embedding) retrieval are complementary, not competitive. Lexical wins on rare terms, exact-match queries, and adversarial / typo-rich queries. Dense wins on semantic queries, paraphrases, and concept-level questions. Production search systems run both and fuse the results. This chapter covers fusion methods and the hybrid query patterns shipped by Vespa, Elastic, OpenSearch, Pinecone, and Weaviate.

### Why Hybrid Beats Either

On BEIR (Thakur et al. 2021), the gap between BM25 and the best dense retriever is task-dependent. On NQ (Natural Questions), dense beats BM25 by 5-10 percent NDCG. On TREC-COVID, BM25 beats dense by 3-5 percent. The right answer is to run both and combine.

The MS MARCO leaderboard tracks hybrid systems separately because every top-10 entry is hybrid. SPLADE (Formal et al. 2021) is a "lexical-style" model trained with a transformer, and it competes with dense retrievers while preserving sparse retrieval's strengths.

### Reciprocal Rank Fusion (RRF)

The simplest, most reliable fusion method. Cormack, Clarke, Buettcher (2009). Given multiple ranked lists, score each document by `sum over lists L of 1 / (k + rank_L(d))`, where k is a constant (typically 60).

```cpp
struct RrfFusion {
    double k = 60.0;

    std::vector<Hit> fuse(const std::vector<std::vector<DocId>>& lists, std::size_t topk) {
        std::unordered_map<DocId, double> scores;
        for (auto& list : lists) {
            for (std::size_t r = 0; r < list.size(); ++r) {
                scores[list[r]] += 1.0 / (k + r + 1);
            }
        }
        std::vector<Hit> out;
        out.reserve(scores.size());
        for (auto [d, s] : scores) out.push_back({d, s});
        std::partial_sort(out.begin(),
                          out.begin() + std::min(topk, out.size()),
                          out.end(),
                          [](auto& a, auto& b) { return a.score > b.score; });
        out.resize(std::min(topk, out.size()));
        return out;
    }
};
```

RRF requires no calibration. It treats each input list as a black box that produces ranks. It works because the reciprocal rank captures both rank and the diminishing importance of lower positions. RRF is the default fusion in Elasticsearch's `rank` query and in OpenSearch's hybrid query.

### Weighted Sum

Normalize scores from each list (min-max, z-score, or per-list reciprocal rank), then weighted sum with learned weights:

```
final(d) = w1 * normalize(score_lex(d)) + w2 * normalize(score_dense(d))
```

`w1, w2` are tuned on a labeled set. Typical values: `w1 = 0.5, w2 = 0.5` if both retrievers are well-calibrated, lopsided if one is much stronger.

The pitfall: BM25 scores are unbounded above, dense cosine scores are in [-1, 1]. Without normalization, weighted sum is dominated by whichever side has larger raw scores. Min-max normalization within the candidate set is the simplest fix. Better: per-query temperature normalization, or sigmoid calibration.

### Learned Fusion

Train a model that takes the BM25 score, the dense score, and possibly per-result features, and outputs a final score. This is just LTR (chapter 6) with retrieval scores as features. Production at Bing and Google is some variant of this: the LambdaMART reranker takes both BM25 and dense as input features alongside the rest.

A simple version: train a logistic regression on `(bm25_score, dense_score, query_length, ...)` to predict relevance. Adds 1-2 percent NDCG over RRF when the training data is good.

### Vespa Hybrid Query

Vespa's ranking expression can mix any features in arithmetic. Hybrid query in Vespa:

```
yql: select * from documents where userQuery() or ({targetHits: 100}nearestNeighbor(embedding, query_embedding));

ranking: hybrid

rank-profile hybrid {
    function bm25_score() {
        return bm25(body) + bm25(title)
    }
    function dense_score() {
        return closeness(field, embedding)
    }
    first-phase {
        expression: 0.4 * bm25_score + 0.6 * dense_score
    }
}
```

Vespa runs both retrievers natively, fuses inside the ranker. The query is a single `or` of a userQuery (lexical) and a nearestNeighbor (dense) operator. Both contribute candidates. Documents matching both get scored once with the combined expression.

### Elastic / OpenSearch Dense + BM25

Elastic 8.x supports the `rank` query with `rrf` rank method:

```json
{
  "query": { "match": { "body": "query terms" } },
  "knn": { "field": "embedding", "query_vector": [...], "k": 50, "num_candidates": 100 },
  "rank": { "rrf": { "window_size": 100, "rank_constant": 60 } }
}
```

OpenSearch has a similar `hybrid` query that supports min-max normalization and weighted sum.

The implementation: each retriever is run in parallel, each returns a top-K (typically K = 50 or 100), the two lists are fused, the fused top-N is returned.

### ColBERT and Late Interaction

ColBERT (Khattab and Zaharia 2020) is structurally similar to a dense retriever but produces a per-token embedding matrix per document. The query is encoded into a per-token matrix. Similarity is `MaxSim`: for each query token, find the document token with highest cosine, then sum across query tokens.

```
score(q, d) = sum over q_i in q of  max over d_j in d of  cosine(q_i, d_j)
```

Quality is between dense bi-encoder and cross-encoder, closer to cross-encoder. Storage cost: per-token embeddings means a typical 512-token document needs 512 * 128 = 64 KB at fp16, vs ~1.5 KB for a single-vector embedding. ColBERTv2 addresses storage with PQ-compression and centroid pruning.

ColBERT can be hybridized with BM25 the same way bi-encoder dense can. In production, ColBERT is more often used as a re-ranker (retrieve with BM25 or dense, rerank top-100 with ColBERT) than as a primary retriever, because the storage and ANN cost of multi-vector retrieval is high.

Vespa ships native ColBERT support via tensor expressions. Pinecone added it in 2024. Tantivy and Lucene have community plugins.

### Sparse Lexical from Transformers

SPLADE (Formal et al. 2021) and uniCOIL (Lin and Ma 2021) are transformer models trained to produce **sparse** vectors (one weight per vocabulary token). The output is a sparse vector that can be scored with the same posting-list machinery as BM25, but the weights are learned from data instead of computed by the BM25 formula.

This is a "lexical model with neural training". On BEIR, SPLADE matches or beats most dense retrievers and is fully compatible with inverted index infrastructure. Vespa, Elastic, and Pinecone all support SPLADE-style sparse vectors.

The trick: a vocabulary of 30k tokens means each document is a 30k-dim sparse vector with maybe 100 non-zero entries. Posting lists work as usual. Scoring is the inner product of the query's sparse vector with the document's sparse vector. Compatible with WAND, BMW, and other top-k disjunctive algorithms.

### Multi-Vector and Multi-Field Hybrid

Real production search has more than two retrievers:

- BM25 over title.
- BM25 over body.
- Dense embedding of title.
- Dense embedding of body.
- ColBERT or SPLADE.
- Recency or popularity score.

Fusion is RRF or weighted sum across all of them, with weights learned per-vertical (web vs product vs paper). Pinecone, Vespa, and Elastic all support this, the user-facing complexity is high.

### C++ Implementation Notes

Hybrid retrieval is two parallel queries followed by a merge. In a search engine like Vespa, the parallelism is at the shard level: each shard runs both retrievers, returns local top-K, the broker fuses across shards.

```cpp
// Per-shard hybrid query.
auto bm25_future = std::async([&] { return bm25_top_k(query, 100); });
auto dense_future = std::async([&] { return dense_top_k(query_embedding, 100); });
auto bm25_results = bm25_future.get();
auto dense_results = dense_future.get();

return rrf_fuse({bm25_results, dense_results}, 100);
```

The `std::async` in production is a thread pool task. Each retriever is itself parallelized internally (per-segment parallelism in Lucene-like systems).

### Junior to FAANG

A junior picks RRF and ships. A senior at Vespa or Elastic tunes per-vertical weights, profiles RRF vs weighted sum vs learned fusion on labeled data, and knows that hybrid wins by a few percent NDCG on average but loses by more than that on poorly tuned dense models. A staff engineer at Pinecone or Weaviate thinks about the hybrid query at the system level: how many calls, what the latency budget is, whether the fusion stage itself is a measurable cost (it is, at scale), and how the answer changes when ColBERT or SPLADE enters the mix. The design question to expect: "your system runs BM25 and dense in parallel, fuses with RRF. The dense model is 2x more expensive than BM25 and contributes 1 percent NDCG. Keep it or cut it?" The answer depends on whether the 1 percent is on head queries (probably cut) or tail queries (probably keep), and what the cost model is per query.

---
