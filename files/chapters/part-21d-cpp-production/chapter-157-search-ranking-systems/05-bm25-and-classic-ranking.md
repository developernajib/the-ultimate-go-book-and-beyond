## BM25 and Classic Ranking

BM25 (Okapi BM25, Robertson and Walker 1994) is the default lexical ranking function in every production search engine: Lucene, Elasticsearch, OpenSearch, Vespa, Solr, Manticore, MeiliSearch, Tantivy. It is the function the dense-retrieval community quietly tries to beat. After thirty years it remains the strong baseline.

### The Formula

For a document d and query q with terms t in q:

```
BM25(d, q) = sum over t in q of:
    IDF(t) * (tf(t,d) * (k1 + 1)) / (tf(t,d) + k1 * (1 - b + b * |d| / avgdl))
```

Where:
- `tf(t,d)` = term frequency of t in d.
- `|d|` = length of d in tokens.
- `avgdl` = average document length in the corpus.
- `IDF(t) = log((N - df(t) + 0.5) / (df(t) + 0.5) + 1)`.
- `k1` controls TF saturation, typically 1.2 to 2.0.
- `b` controls length normalization strength, 0.0 to 1.0, typically 0.75.

### Where Each Term Comes From

BM25 is not a hack. It is the limit of a probabilistic relevance model (the Binary Independence Model) when you replace the binary "term present / absent" assumption with a 2-Poisson mixture for term frequency. Robertson's papers walk through this, the short version is that the saturation term `tf / (tf + constant)` is the analytic form you get from assuming term occurrences in relevant documents follow a Poisson process and the constant absorbs document length.

Three components, each independently justifiable:

**IDF.** Rare terms are more discriminating. The `log` is the information-theoretic shape, the `+0.5` smoothing avoids singularities for `df=0` or `df=N`. The Lucene IDF formulation `log(1 + (N - df + 0.5)/(df + 0.5))` is always non-negative, which avoids issues with very common terms producing negative scores (a bug the original formula has).

**TF saturation.** A document mentioning "java" 100 times is not 100x more relevant than one mentioning it once. The saturation curve `tf*(k1+1)/(tf+k1)` rises quickly then plateaus. Higher `k1` means slower saturation (more reward for repetition).

**Length normalization.** A long document trivially has higher tf for any term. Normalizing by `|d|/avgdl` corrects for this. The parameter `b` interpolates between no normalization (`b=0`, useful for headlines or titles) and full normalization (`b=1`, aggressive penalty for length).

### Tuning k1 and b

Defaults `k1=1.2, b=0.75` come from TREC experiments on news. For other corpora the optima shift:

- Long technical documents (papers, manuals): `k1` lower (1.0), `b` lower (0.5). Repetition is more meaningful, length less so.
- Short documents (tweets, titles, product names): `b=0` is sometimes optimal, length normalization punishes natural variation. Vespa and Elastic both ship "BM25 without length normalization" for product search.
- Code search: `k1` higher (2.0), repetition is meaningful. `b` low.

Tuning method: hold out a labeled relevance set, grid search `(k1, b)` over `{0.5, 0.75, 1.0, 1.2, 1.5, 2.0} x {0.0, 0.25, 0.5, 0.75, 1.0}`, pick by NDCG@10. The optimum is usually a flat plateau, so any "close" point is fine.

### C++ Implementation

```cpp
struct Bm25 {
    double k1 = 1.2;
    double b  = 0.75;
    double avgdl = 0.0;
    std::uint32_t N = 0;

    double idf(std::uint32_t df) const {
        return std::log((static_cast<double>(N - df) + 0.5)
                       / (static_cast<double>(df) + 0.5) + 1.0);
    }

    double score_term(std::uint32_t tf, std::uint32_t dl, double idf_) const {
        double norm = 1.0 - b + b * static_cast<double>(dl) / avgdl;
        double tfn  = static_cast<double>(tf) * (k1 + 1.0)
                    / (static_cast<double>(tf) + k1 * norm);
        return idf_ * tfn;
    }
};
```

This is 14 lines. Production code adds:

- Per-term cached IDF.
- Per-document cached `1 / norm_dl(d)` if `dl` is fixed at index time.
- Per-block precomputed score upper bounds for BMW.
- SIMD scoring of 8 documents at a time when iterating a block.

### TF-IDF, BM25+, BM25F, BM25L

**TF-IDF** is the original lexical scorer: `tf(t,d) * log(N/df(t))`. No saturation, no length normalization. It loses to BM25 by 5-15 percent NDCG on most tasks. Still useful as a teaching baseline.

**BM25+** (Lv and Zhai 2011) adds a constant `delta` (typically 1.0) to the TF term, fixing the "long-document penalty" for rare terms in long relevant documents. Often half a percent NDCG over BM25. Lucene supports it via `BM25PlusSimilarity` and Elastic exposes it.

**BM25F** (Robertson, Zaragoza, Taylor 2004) is BM25 over a document made of weighted fields (title weight 4, body weight 1, etc). Used for structured documents (web pages with title/body/anchor, product cards, papers with abstract/body). The trick is to compute TF and length on a virtual concatenated document with field-weighted occurrences, not to score fields independently and sum.

**BM25L** (Lv and Zhai 2011, again) adjusts length normalization to be more lenient on short documents. Useful for query-document length asymmetry.

### Divergence From Randomness

DFR (Amati and van Rijsbergen 2002) is a different probabilistic family. The intuition: a term's informativeness is the divergence between its actual distribution in the document and what a random distribution would produce. DFR has multiple instantiations (PL2, BB2, IFB2). On TREC datasets, the best DFR variant typically ties or slightly beats BM25. In production it is rarely worth the additional complexity. Vespa supports it, few teams use it.

### Language Models for IR

The query likelihood model (Ponte and Croft 1998) treats each document as a unigram language model and scores by `P(query | document)`. With Dirichlet smoothing, the result is competitive with BM25. Theoretically cleaner, in practice almost equivalent. Worth knowing for interviews, not a default choice for production.

### Phrase, Proximity, and Span Queries

BM25 ignores word order. Phrase queries ("machine learning") need positional postings. Proximity queries score higher when query terms are nearby. The standard approach: compute BM25 on each term independently, then add a proximity boost based on the minimum span of the query terms in the document, or the average pairwise distance.

Lucene's `SpanNearQuery` and Vespa's `near`, `onear` operators implement this. Cost: positional postings are 2-5x larger than docID-only postings, and proximity scoring is roughly 3x slower per match. Most production systems index positions for the body field only, not metadata fields.

### What BM25 Does Not Capture

It does not capture synonyms ("auto" and "car"), spelling variants ("color" and "color"), morphology beyond stemming, semantic similarity, intent, or context. Every weakness of BM25 is a reason for the rest of the chapter (query expansion, dense retrieval, learning to rank, neural rerankers).

### Junior to FAANG

A junior writes BM25 with the textbook constants and ships. A senior runs `(k1, b)` tuning per locale (English news has a different optimum from French news from Japanese product titles), per field type (title vs body), and per-document-class (short vs long). A staff engineer at Bing or Google understands that BM25 is the fast-but-not-final stage in a multi-stage ranker, builds the BM25 implementation around BMW so the top-k is computed without scoring most of the corpus, and treats the BM25 score itself as a feature for downstream learning-to-rank rather than as a final ranking. The interview question to expect: "your search engine returns BM25 top-100 in 5ms. The reranker adds 50ms. What features besides the BM25 score does the reranker take?"

---
