## Relevance Evaluation

If you cannot measure whether your search is good, you cannot improve it. Evaluation is the unsexy half of search, it is also the half that distinguishes shipping teams from research projects.

### Judgment Data

The starting point is judged (query, document, label) tuples. Three kinds:

**Editorial judgments.** Trained raters score each (q, d) pair on a 1-5 scale (or binary). Quality: high if rater guidelines are clear, low if not. Cost: high. Volume: limited.

**Click-derived labels.** A click is a weak positive signal. Long dwell time (no immediate back-click) is a stronger signal. Click models (chapter 06) debias raw click data into per-document relevance estimates.

**Synthetic / LLM-generated.** Use an LLM to generate (query, document) pairs with relevance labels. Useful for bootstrapping and for evaluation in domains without click data. Less reliable for absolute calibration.

Production teams blend all three. The largest companies have judgment programs of millions of (q, d) pairs.

### Metrics

**Precision@k (P@k).** Fraction of top-k that are relevant. Simple, ignores rank order within top-k.

**Recall@k (R@k).** Fraction of relevant docs that appear in top-k. The retrieval-stage metric. NDCG cares about top of list, recall cares about whether the relevant doc is in the candidate set at all.

**MAP (Mean Average Precision).** Average over queries of "precision at each rank where a relevant doc appears". Penalizes putting relevant docs late.

**MRR (Mean Reciprocal Rank).** Average over queries of `1 / rank_of_first_relevant`. Used when there is one "correct" answer (Q&A, navigational queries).

**NDCG@k (Normalized Discounted Cumulative Gain).** The dominant metric.

```
DCG@k = sum from i=1 to k of (2^rel_i - 1) / log2(i + 1)
NDCG@k = DCG@k / IDCG@k
```

`rel_i` is the graded relevance of the document at rank i (typically 0-4). IDCG is the DCG of the ideal ranking. NDCG is a fraction in [0, 1]. It rewards both retrieving relevant docs and putting highly relevant ones first.

The discount `1 / log2(i + 1)` reflects empirical user attention curves: position 1 is much more important than position 10.

```cpp
double ndcg_at_k(const std::vector<int>& labels, int k) {
    double dcg = 0;
    for (int i = 0; i < std::min<int>(labels.size(), k); ++i) {
        dcg += (std::pow(2.0, labels[i]) - 1.0) / std::log2(i + 2.0);
    }
    auto sorted_labels = labels;
    std::sort(sorted_labels.begin(), sorted_labels.end(), std::greater<>());
    double idcg = 0;
    for (int i = 0; i < std::min<int>(sorted_labels.size(), k); ++i) {
        idcg += (std::pow(2.0, sorted_labels[i]) - 1.0) / std::log2(i + 2.0);
    }
    return idcg > 0 ? dcg / idcg : 0;
}
```

Pitfalls:

- **Truncation mismatch.** Computing `NDCG@10` but the system returns 5 results. Decide: is the missing slot 0 (impute) or undefined (drop the query)? Standard is impute zero.
- **Tied labels.** Multiple documents with the same label can be ordered arbitrarily. NDCG is the same. Use a tie-breaking metric for sensitivity.
- **NDCG@10 vs NDCG@1.** They measure different things. NDCG@1 is whether the top result is the best. NDCG@10 is whether the top-10 is good. Optimizing one does not always improve the other.

### A/B Testing

Run two ranking variants in parallel, randomly assign users to one or the other, measure outcome metrics (clicks, dwell time, conversions, satisfaction). Standard A/B testing applies, with three search-specific issues:

1. **Dependent observations.** A user's clicks within a session are not independent. Standard t-tests overestimate significance. Use bootstrap or session-level aggregation.
2. **Position bias contamination.** If the new system shows different documents at position 1, the click metric reflects both relevance change and position-driven attention. Use IPS reweighting or click-model-debiased metrics.
3. **Network effects.** A change to one user's results can affect other users (e.g., personalization effects, content trending). Usually small but real.

Sample size: ranking changes are often small effects (0.5-2 percent NDCG, 0.1-1 percent CTR). To detect them at 95 percent confidence, need millions of impressions. Long experiment durations (1-4 weeks) are typical at FAANG.

### Interleaving

When sample size is constrained, interleaving compares two rankers per-query rather than across-users. For each query, blend ranker A's results and ranker B's results into a single list, present to the user, attribute clicks to the originating ranker.

**Team-Draft Interleaving (TDI, Radlinski et al. 2008).** Alternate teams, each team picks its top unpicked document. Click on team A's pick is a vote for A.

**Balanced Interleaving (Joachims 2003).** Older. Less robust.

**Probabilistic Interleaving (Hofmann et al. 2011).** Uses a softmax over the ranker outputs. Better statistical properties.

Interleaving has roughly 100x lower sample-size requirement than A/B testing for detecting the same effect. Used heavily at Bing and Yandex. Less common at Google (which has the sample size).

### pSafe and Risk Metrics

For ranking changes, the average NDCG might improve while some queries get much worse. The "loser" queries are user-visible regressions. pSafe-ROC and similar metrics quantify the risk: what fraction of queries lose more than X NDCG.

Production launches almost always require both NDCG up and per-query risk acceptable. A ship gate of "NDCG +1 percent and no query loses more than 5 percent NDCG" is typical.

### Online vs Offline Metrics

Offline NDCG is a proxy for online satisfaction. They correlate but do not match. A model with better offline NDCG can have lower online click-through rate due to:

- **Click-bait penalty.** The offline labels do not capture the user's click-then-back behavior.
- **Diversity penalty.** Optimizing NDCG@10 without diversity can produce 10 similar documents and lose users who want variety.
- **Personalization mismatch.** Offline labels assume an average user, online users have personal preferences.

Production teams ship based on online metrics, with offline NDCG as a quick guardrail.

### Long-Tail Evaluation

Head queries (the 1000 most common) dominate volume but not behavior. Tail queries (millions of one-off queries) collectively matter more. NDCG averages can hide tail regressions because head queries dominate the average.

Mitigation: stratify by query frequency (head, torso, tail) and report metrics per stratum. Many teams set ship gates per stratum.

### Per-Locale, Per-Vertical

A global metric hides per-segment regressions. Report NDCG broken down by:

- Locale (en-US, ja-JP, ...).
- Vertical (web, news, images, products, ...).
- Query intent (navigational, transactional, informational).
- User segment (logged-in vs anonymous, premium vs free).

Production dashboards have dozens of slices. The complexity is real but unavoidable.

### C++ Evaluation Harness

```cpp
struct JudgmentSet {
    struct Entry { std::string query; std::string doc_id; int label; };
    std::vector<Entry> entries;
    std::unordered_map<std::string, std::vector<Entry>> by_query;
};

double evaluate_ndcg(const JudgmentSet& js, RankingFn rank_fn, int k) {
    double total = 0;
    int n = 0;
    for (auto& [query, judged] : js.by_query) {
        auto results = rank_fn(query, k);
        std::vector<int> labels;
        labels.reserve(results.size());
        for (auto& r : results) {
            auto it = std::find_if(judged.begin(), judged.end(),
                [&](auto& j) { return j.doc_id == r.doc_id; });
            labels.push_back(it == judged.end() ? 0 : it->label);
        }
        total += ndcg_at_k(labels, k);
        ++n;
    }
    return n > 0 ? total / n : 0;
}
```

Production evaluation runs this against a judgment set of millions of queries, and against a held-out set after every ranking model retrain.

### Junior to FAANG

A junior reports NDCG and ships. A senior at Bing or Google designs the offline-online metric stack with explicit ship gates, runs A/B tests with proper sample sizes, and uses interleaving for low-volume tests. A staff engineer is paranoid about Goodhart's law (the metric becoming the target instead of relevance) and rotates judgment programs to catch drift, keeps a "freshly-judged" holdout set untouched by training, and pushes back on launches that improve NDCG by gaming a known label-distribution quirk. The interview question: "your NDCG@10 went up 2 percent but A/B test showed CTR dropped 0.5 percent. Ship?" Senior answer: investigate, do not ship blindly. Possibilities: position bias, label drift, diversity loss, click-bait substitution. The right diagnosis determines the right action.

---
