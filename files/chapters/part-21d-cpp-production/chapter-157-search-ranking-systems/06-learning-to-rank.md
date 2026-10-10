## Learning to Rank

Learning to Rank (LTR) is what runs after BM25 narrows the corpus to a few hundred candidates and before they are returned to the user. It is the layer where structured features (BM25 score, document age, click-through rate, host quality, query-document semantic similarity) are combined into a single relevance score, learned from labeled or implicit-feedback data.

### Pointwise, Pairwise, Listwise

**Pointwise** treats ranking as regression or classification: predict a relevance label for each (query, document) pair independently. Loss = MSE or cross-entropy. Easiest to train, but ignores that ranking is an ordinal problem, getting the absolute label slightly wrong is fine if the order is right.

**Pairwise** loss compares pairs of documents for the same query. For documents `i` and `j` with relevance labels `y_i > y_j`, train so that `score(i) > score(j)`. RankNet (Burges et al. 2005) uses cross-entropy on the pair: `L = log(1 + exp(-(s_i - s_j)))`. Pairwise dominated LTR for years.

**Listwise** loss operates on the entire ranked list per query. ListNet, ListMLE, and more importantly LambdaRank / LambdaMART, which is the dominant production algorithm.

### RankNet to LambdaRank

RankNet trains a function `f(x)` (originally a neural net) so that for relevant documents, `f` produces higher scores. The gradient of the pairwise loss for a pair `(i, j)` is well-defined: `dL/ds_i = -sigmoid(-(s_i - s_j))`. The problem is that pairwise loss does not match NDCG, you can decrease pairwise loss while NDCG worsens.

LambdaRank (Burges 2010) keeps the pairwise gradient form but multiplies it by `|delta NDCG|`, the change in NDCG that swapping `i` and `j` would cause:

```
lambda_ij = -sigmoid(-(s_i - s_j)) * |delta NDCG(i, j)|
```

This is a "fake gradient" with no closed-form loss but excellent empirical NDCG. It is the trick that took LTR from research to production in Bing's web ranker (2010-2015).

### LambdaMART

LambdaMART (Burges 2010, Wu et al. 2010) is LambdaRank's gradient applied to gradient-boosted decision trees (MART = Multiple Additive Regression Trees). At each iteration, fit a regression tree to the lambda gradients, add it to the ensemble, repeat. LambdaMART won the Yahoo Learning to Rank Challenge (2010), and remains the production ranker at Bing, Yandex (with their own variant CatBoost), and many others.

XGBoost and LightGBM both ship LambdaMART:

```python
# XGBoost ranker, set group= per query group, evaluation by NDCG.
import xgboost as xgb
dtrain = xgb.DMatrix(X_train, label=y_train)
dtrain.set_group(group_train)  # group sizes summing to len(X_train)

params = {
    "objective": "rank:ndcg",
    "eta": 0.05,
    "max_depth": 6,
    "min_child_weight": 1.0,
    "eval_metric": "ndcg@10",
}
model = xgb.train(params, dtrain, num_boost_round=2000,
                  early_stopping_rounds=50, evals=[(dvalid, "valid")])
```

The two failure modes that ruin LambdaMART training in practice:

1. **Group ordering mismatch.** XGBoost expects rows ordered such that all rows for a query group are contiguous. If the input is shuffled across queries, training silently produces nonsense. Always sort by query_id then group.
2. **Leaky features.** Click-through rate computed over the full dataset includes the test set. Build features with strict time-based splits.

LightGBM's `lambdarank` objective is functionally equivalent. LightGBM trains roughly 3-5x faster than XGBoost on the same data and tends to win when the feature count is large (more than 200).

### LambdaLoss

LambdaLoss (Wang et al. 2018) showed that LambdaRank's heuristic gradient is the gradient of a real loss function (a bound on the NDCG-like target), unifying the family with proper statistical learning theory. In practice it produces a small NDCG bump (0.5-1 percent) and is now the default in TensorFlow Ranking.

### Features That Matter

A typical web LTR has 200-1000 features. The categories and rough shape:

- **Lexical match.** BM25, BM25F per field, term coverage, exact-phrase match indicators, position-of-first-match.
- **Semantic match.** Cosine similarity from a dual-encoder, ColBERT MaxSim, cross-encoder logit.
- **Document quality.** Static rank (PageRank for web, in-house variants for other domains), spam score, language model perplexity, content length, age.
- **Query-document interaction.** Click-through rate (CTR) of (q, d) historical, dwell-time conditional CTR, abandon rate.
- **Personalization.** User location match, user language match, user historical preferences.
- **Freshness.** Document age, recent edit timestamp, recency-of-click.

Production ranking teams at Google and Bing spend most of their time on feature engineering, not on the model. The model class has been LambdaMART or "LambdaMART plus a small transformer for re-ranking" for the last decade.

### Neural Rankers and Cross-Encoders

A cross-encoder takes (query, document) as a single input to a transformer, producing one relevance score. For document length up to 512 tokens, this is the highest-quality reranker available. Cost: 50-200 ms per (query, document) pair on GPU, much more on CPU.

Production deployment: cross-encoder reranks the top 50-200 candidates from BM25/dense retrieval. At 10 ms per pair on a fast GPU, 50 candidates is 500 ms, which is too slow for interactive search. Solutions:

- Distill the cross-encoder into a smaller model (TinyBERT, MiniLM, DistilBERT).
- Use batched inference and tensor parallelism.
- Cache scores keyed on (query_hash, doc_hash) for repeat queries.

Microsoft's M3 (RankT5, monoT5, monoBERT) and Google's variants drove cross-encoder rerankers into production for some verticals starting around 2020.

### ColBERT and Late Interaction

ColBERT (Khattab and Zaharia 2020) sits between dual-encoder (fast, low quality) and cross-encoder (slow, high quality). It encodes the document into a per-token embedding matrix at index time, encodes the query into a per-token matrix at query time, then computes `MaxSim`: for each query token, find the document token with highest cosine, sum across query tokens. Quality close to cross-encoder, latency closer to dual-encoder. Storage cost is high (per-token vectors), which ColBERTv2 addresses with PQ.

Vespa supports ColBERT natively via tensor expressions. Pinecone supports it as of 2024. Tantivy and Lucene have community plugins.

### Click Models

When labels are not available, click-through is the next best thing, but raw CTR is biased: position bias (top results get clicked more regardless of relevance), trust bias, presentation bias. Click models infer relevance from clicks while accounting for biases.

- **Position-Based Model (PBM).** `P(click) = P(examined | position) * P(relevant | q, d)`. Examination probability per position is learned globally.
- **Cascade Model.** User examines top-down, clicks the first relevant result, stops.
- **Dynamic Bayesian Network (DBN, Chapelle and Zhang 2009).** Generalizes cascade with multi-click.
- **Position-Aware Inverse Propensity Scoring.** Reweights training examples by `1 / P(examined)` to debias.

Bing and Google publish papers on click models annually, the area has converged to "use IPS reweighting plus a learned position-bias estimator".

### Production Architecture

The LTR layer typically runs as a separate service.

```
   query
     |
     v
 [retrieval shards] -----> top-K candidates with feature vectors
     |
     v
  [LTR scorer]    (LambdaMART model, GBDT)
     |
     v
  [reranker]      (cross-encoder, optional)
     |
     v
  [diversification, personalization, business rules]
     |
     v
  results
```

In C++, the LambdaMART model is loaded as a tree ensemble (XGBoost's binary format or LightGBM's). Inference is a sum over decision trees, ~1-2 microseconds per (query, document, 200-feature) at production tree depths (6-8) and ensemble sizes (1000-5000 trees). LightGBM's `predict` API in C++ is the most common path, some shops compile the trees to native C++ via `treelite` for another 2-3x speedup.

### Junior to FAANG

A junior trains an XGBoost ranker, looks at NDCG, ships. A senior at Bing or Google has a feature engineering pipeline with strict time splits, an offline / online evaluation loop with interleaving (chapter 18), and a click model for unbiased training data. They know that the LambdaMART gradient is the LambdaRank trick and can derive `|delta NDCG|` for a pair swap. A staff engineer is cynical about benchmark NDCG numbers and asks the harder question: "we improved NDCG@10 by 1 percent but session-level satisfaction dropped, why?". The answer is usually that NDCG@10 misses position bias in the labels, or that the new model improves head queries but hurts tail.

---
