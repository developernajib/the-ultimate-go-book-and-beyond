## Multi-Stage Ranking

Production search runs ranking in stages, each stage cheaper and broader than the next. The first stage prunes a billion documents to ten thousand candidates with BM25 or dense retrieval. The next narrows to a thousand with a fast feature-based ranker. The next narrows to a hundred with a stronger model. The final stage applies diversity, personalization, and business rules to produce the top ten. The latency budget is allocated across these stages so the total stays under the user-perceptible threshold (usually 100-200 ms p99).

### Why Multi-Stage

A cross-encoder produces excellent quality but takes 50 ms per (query, document) pair. Running it on a billion documents is impossible. Running it on the top 100 from a fast retriever is feasible (5 seconds, still too slow, but distillable). The multi-stage design is the only way to combine quality models with billion-document corpora.

The economics also point this way. A cross-encoder evaluation costs about 1000x more compute than a BM25 score. If 0.1 percent of documents reach the cross-encoder stage, total compute matches BM25-only on the full corpus. The constant 1000 happens to map to "a billion-document index reranks the top one thousand", which is approximately what production systems do.

### Canonical Pipeline

```
        query
          |
          v
    [retrieval stage]            (BM25 + dense, hybrid, top 1000-10000)
          |
          v
    [first-stage ranker]         (LambdaMART with cheap features, top 100-500)
          |
          v
    [second-stage ranker]        (cross-encoder or larger LambdaMART, top 10-50)
          |
          v
    [diversification + personalization + business rules]
          |
          v
       results (top 10)
```

Each stage is a function `(query, top-K candidates with features) -> top-K' < K`.

### Latency Budget

A 100 ms p99 budget might allocate as:

| Stage | Budget | Notes |
|-------------------|--------|----------------------------------------|
| Query parsing | 1 ms | Tokenize, expand, embed |
| Retrieval | 20 ms | BM25 with BMW + dense ANN in parallel |
| Feature fetching | 10 ms | Per-doc features from feature store |
| First-stage rank | 5 ms | LambdaMART, 1000 docs, 200 features |
| Second-stage rank | 40 ms | Cross-encoder, top-50, batched on GPU |
| Diversification | 5 ms | MMR or determinantal point process |
| Personalization | 10 ms | User-context fetch + small model |
| Snippet / format | 5 ms | Highlight, snippet selection |
| Network + slack | 4 ms | Inter-service RPC overhead |

The exact split varies, but the total must hit the budget at p99, which is the constraint that drives most architectural decisions.

### Retrieval Stage

This is where chapters 02-12 apply. The stage produces a candidate set with cheap signals (BM25 score, dense similarity, basic doc features). The set size is typically 1000-10000.

The trick: retrieval and first-stage ranking can overlap. As soon as the retrieval stage produces partial results, the feature fetcher begins fetching features for the early arrivers. This pipelining shaves 5-10 ms off the total.

### First-Stage Ranker

A fast LambdaMART model (chapter 6) with cheap features. "Cheap" means features that can be computed from the index alone or from a fast feature store: BM25 score, document age, static rank (PageRank for web), quality score, language match, query-doc lexical overlap, dense similarity if dense was used in retrieval.

Inference cost: a 1000-tree LambdaMART with depth-6 trees scores a (query, doc, 200-feature) tuple in ~1 microsecond. 1000 documents in ~1 millisecond. This stage is essentially free relative to the budget.

The output is the top 100-500 by first-stage score. K shrinks by 10x at this stage.

### Second-Stage Ranker

This is where the heavy model runs. Two patterns:

**Cross-encoder.** Concatenate (query, document_text) and feed through a transformer. One score per pair. Cost: 10-100 ms per pair on GPU, depending on model size and document length. Batch across 50-200 pairs. Top-100 in 50-200 ms total. Often distilled to a smaller model (TinyBERT, MiniLM) to fit a 50 ms budget.

**Large LambdaMART with expensive features.** Some features are too expensive to compute in the first stage (e.g., per-result personalization vector dot products, per-result freshness signals from a freshness service). Compute them only for the top 100, then re-rank with a more expensive but still tree-based model. Lower quality than cross-encoder, much lower latency.

Production systems often use both: a stronger LambdaMART as second-stage and a cross-encoder as third-stage on the top-20.

### Diversification

The top-10 should not be ten almost-identical documents. Two algorithmic approaches:

**MMR (Maximal Marginal Relevance, Carbonell and Goldstein 1998).**
```
score(d) = lambda * relevance(d) - (1 - lambda) * max similarity(d, already_picked)
```
Greedy: pick the document with the highest MMR score, repeat. lambda controls the relevance/diversity trade-off, typically 0.5-0.7.

**Determinantal Point Processes (DPP).** A probabilistic model that picks subsets to maximize a kernel-based diversity measure. Stronger theoretically, harder to integrate. Used at YouTube and Netflix for content selection.

In search results, MMR is usually enough. Document similarity for MMR can be the dense embedding cosine, or a cheaper Jaccard on n-grams.

### Personalization

User signals enter at the second stage or as a separate stage. Common signals:

- User location.
- User language.
- Click history (recent queries with their click patterns).
- User profile vector (an embedding learned from past interactions).

Personalization features are added to the LambdaMART feature set. A small per-user vector dotted with each candidate's vector gives a personalization score. The user vector is fetched from a feature store at request time.

The personalization stage can also be a separate model that takes the second-stage's top-N and reranks with personalization features. Splitting it out lets the second stage be query-cached without per-user state.

### Business Rules

The final layer. Examples: pin a result for promoted content, suppress results from blocked publishers, apply geo restrictions, enforce safe-search filters. Implemented as a rule engine (Drools, custom DSL, or hard-coded). Latency negligible if the rule set is small, with thousands of rules, this becomes a measurable cost.

### Fan-Out and Fan-In

The retrieval stage runs across shards: a coordinator (broker) sends the query to N shards, each shard returns local top-K, the coordinator merges. This is the **fan-out / fan-in** pattern.

```
                    broker
                     /|\
                    / | \
                   /  |  \
              shard0 shard1 ... shardN
```

Each shard runs the retrieval and possibly first-stage ranking locally. The broker collects top-K per shard, merges to a global top-K' (where K' < K * N because of overlap), then runs second-stage ranking centrally (or with a separate fan-out to scoring nodes if the model is large).

The broker is a tail-latency multiplier. If each shard's p50 is 5 ms but p99 is 30 ms, the broker's p99 is closer to 50 ms because the broker waits for the slowest shard. This is tail-at-scale, covered in chapter 14, and it dominates real production latency.

### Caching

Three caches help:

**Query result cache.** Whole results for a (query, user_segment) tuple. Hit rate is low for personalized search (different per user), high for non-personalized (search for "weather" always returns similar things).

**First-stage cache.** Top-K from first stage for a (query) tuple. Hit rate moderate, the second stage can rerank a cached candidate set with a fresh user state.

**Feature cache.** Per-document features cached by docID. Hit rate high, features change slowly.

Each cache adds memory cost and a stale-ness window. The caching policy (LRU vs TinyLFU vs Caffeine) matters less than the hit rate, which is determined by the workload.

### A C++ Stage Sketch

```cpp
struct PipelineContext {
    Query query;
    std::vector<float> query_embedding;
    UserContext user;
    std::chrono::steady_clock::time_point deadline;
};

class RankingPipeline {
public:
    std::vector<Hit> run(PipelineContext& ctx) {
        auto retrieval_results = retrieval_stage_.run(ctx);
        if (past_deadline(ctx)) return early_return(retrieval_results);

        auto first_stage = first_stage_ranker_.run(ctx, retrieval_results, 200);
        if (past_deadline(ctx)) return early_return(first_stage);

        auto second_stage = second_stage_ranker_.run(ctx, first_stage, 50);
        if (past_deadline(ctx)) return early_return(second_stage);

        auto diversified = diversifier_.run(ctx, second_stage, 10);
        return business_rules_.apply(ctx, diversified);
    }

private:
    bool past_deadline(const PipelineContext& ctx) const {
        return std::chrono::steady_clock::now() > ctx.deadline;
    }
    // ...
};
```

The deadline check between stages is the safety net: if the prior stage took too long, the pipeline degrades gracefully rather than blowing the latency budget.

### Junior to FAANG

A junior runs one model and ships. A senior at Bing or Google designs the pipeline with explicit budgets per stage and instruments each stage's contribution to NDCG and latency. A staff engineer asks how to **shrink** the pipeline: can the second-stage cross-encoder be distilled into a feature for the first-stage LambdaMART, can the personalization stage be merged into the second-stage model, can the diversification be done at retrieval time instead. Pipeline complexity is a debt, the best teams continuously try to pay it down. The interview question: "your second-stage cross-encoder takes 60 ms, blowing the budget. Three options." Senior answer: distill, batch better, drop fewer candidates. Great answer adds: profile to find the actual bottleneck (is it model inference, batch packing, or feature lookup), and reduce K to the second stage if first-stage quality is high enough that the cross-encoder is only confirming the top-20.

---
