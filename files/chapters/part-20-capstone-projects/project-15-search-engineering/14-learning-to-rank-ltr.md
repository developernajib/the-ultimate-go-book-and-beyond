## Learning to Rank (LTR)

Learning to Rank (LTR) replaces hand-tuned scoring formulas with a machine-learned ranker trained on implicit or explicit relevance signals. Instead of manually adjusting BM25 weights and field boosts, you extract a feature vector for each (query, document) pair and train a model to predict relevance.

### Ranking Features

A well-designed feature set covers multiple relevance dimensions:

| Feature Category | Examples |
|-----------------|---------|
| **Text match** | BM25 score (title), BM25 score (body), TF-IDF cosine similarity, exact title match, query coverage |
| **Behavioral** | Click-through rate (CTR), dwell time, skip rate, conversion rate per query |
| **Freshness** | Document age (days), recency decay factor, publish recency relative to query |
| **Authority** | PageRank score, domain authority, inbound link count, entity popularity |
| **User affinity** | Past user clicks on this doc, user's category preferences, personalization score |
| **Query-doc match** | Query length, document length, matched field count, phrase match boolean |

### Pointwise vs Pairwise vs Listwise

**Pointwise** approaches treat ranking as regression or classification. For each (query, doc) pair, predict a relevance score independently. Simple to implement but ignores inter-document relationships within a result list.

```go
// Pointwise: predict relevance score for a single (query, doc) pair
type RankingFeatures struct {
    BM25Title        float64
    BM25Body         float64
    CTR              float64
    RecencyDays      float64
    ExactTitleMatch  float64
    DomainAuthority  float64
    UserAffinityScore float64
}
```

**Pairwise** approaches (RankNet, LambdaRank) learn from pairs of documents: given doc A and doc B for query Q, which should rank higher? The model minimizes pairwise misorderings. More effective than pointwise because it explicitly optimizes ordering.

**Listwise** approaches (LambdaMART, ListNet) optimize a list-level metric like NDCG directly. LambdaMART combines gradient boosted decision trees (GBDT) with the LambdaRank loss function and is the industry standard for LTR. XGBoost and LightGBM both support LambdaRank (`rank:pairwise`, `rank:ndcg`).

### Training Data from Click Logs

Click logs provide implicit relevance labels at scale. A click on position 3 with no click on position 1 implies doc-3 is more relevant than doc-1 for that query. Common approaches:
1. **Click-over-skip**: A clicked result at rank k is preferred over all skipped results above it.
2. **Last click**: The last clicked result receives the highest implicit relevance.
3. **Dwell time**: Results with dwell time > 30s receive higher labels than quick-back clicks.
4. **Conversion signals**: Purchases, sign-ups, and form submissions are strong positive signals.

Position bias must be corrected before training - users naturally click higher results regardless of relevance. Use Inverse Propensity Scoring (IPS) or a two-tower neural model with position as a feature to debias.

### Go Integration with GBDT via `leaves`

The `github.com/dmitryikh/leaves` library provides GBDT inference in Go with zero Python dependencies. It loads models trained by LightGBM, XGBoost, or scikit-learn and runs predictions at microsecond latency.

```go
package ranker

import (
    "fmt"
    "sort"

    "github.com/dmitryikh/leaves"
)

// GBDTRanker reranks search results using a pre-trained LambdaMART model.
type GBDTRanker struct {
    model *leaves.Ensemble
}

// NewGBDTRanker loads a LightGBM model from disk.
func NewGBDTRanker(modelPath string) (*GBDTRanker, error) {
    model, err := leaves.LGEnsembleFromFile(modelPath, true)
    if err != nil {
        return nil, fmt.Errorf("loading LTR model: %w", err)
    }
    return &GBDTRanker{model: model}, nil
}

// RankedResult pairs a document ID with its predicted relevance score.
type RankedResult struct {
    DocID string
    Score float64
    Features RankingFeatures
}

// Rerank scores each result using the GBDT model and returns results sorted
// by descending predicted relevance.
func (r *GBDTRanker) Rerank(results []RankedResult) []RankedResult {
    for i := range results {
        fv := featureVector(results[i].Features)
        score := r.model.PredictSingle(fv, 0)
        results[i].Score = score
    }
    sort.Slice(results, func(i, j int) bool {
        return results[i].Score > results[j].Score
    })
    return results
}

// featureVector converts RankingFeatures to a flat float64 slice.
// Feature order must match the training feature order exactly.
func featureVector(f RankingFeatures) []float64 {
    return []float64{
        f.BM25Title,
        f.BM25Body,
        f.CTR,
        f.RecencyDays,
        f.ExactTitleMatch,
        f.DomainAuthority,
        f.UserAffinityScore,
    }
}
```

### NDCG Metric Calculation in Go

NDCG (Normalized Discounted Cumulative Gain) is the primary offline evaluation metric for LTR models. It accounts for graded relevance (0=irrelevant, 1=fair, 2=good, 3=excellent) and penalizes relevant results appearing lower in the ranked list.

```go
package metrics

import "math"

// NDCGAtK computes Normalized Discounted Cumulative Gain at rank K.
// relevances[i] is the graded relevance label (0-3) of result at rank i+1.
// idealRelevances is the list sorted by descending relevance (perfect ordering).
func NDCGAtK(relevances []float64, idealRelevances []float64, k int) float64 {
    dcg := dcgAtK(relevances, k)
    idcg := dcgAtK(idealRelevances, k)
    if idcg == 0 {
        return 0
    }
    return dcg / idcg
}

// dcgAtK computes DCG@K using the standard formula: sum of (2^rel - 1) / log2(rank+1).
func dcgAtK(relevances []float64, k int) float64 {
    limit := k
    if limit > len(relevances) {
        limit = len(relevances)
    }
    var dcg float64
    for i := 0; i < limit; i++ {
        gain := math.Pow(2, relevances[i]) - 1
        discount := math.Log2(float64(i+2)) // log2(rank+1), rank is 1-indexed
        dcg += gain / discount
    }
    return dcg
}

// MeanNDCGAtK computes mean NDCG@K across multiple queries.
// queriesRelevances[q] is the list of relevance labels for query q.
// queriesIdeal[q] is the ideal ordering for query q.
func MeanNDCGAtK(queriesRelevances, queriesIdeal [][]float64, k int) float64 {
    if len(queriesRelevances) == 0 {
        return 0
    }
    var sum float64
    for i, rel := range queriesRelevances {
        sum += NDCGAtK(rel, queriesIdeal[i], k)
    }
    return sum / float64(len(queriesRelevances))
}
```

### A/B Testing Ranking Changes

Rank changes must be validated online before full rollout. Standard protocol:
1. **Traffic split**: Route 10% of users to the new ranker (treatment), 90% to the existing ranker (control).
2. **Guard metrics**: Ensure CTR, session success rate, and revenue do not regress in treatment.
3. **Target metrics**: NDCG@10 improvement, reduced zero-click sessions, higher dwell time.
4. **Statistical significance**: Run for at least 1, 2 weeks, and require p < 0.05 with power ≥ 80%.
5. **Segment analysis**: Check impact on tail queries, non-English queries, and mobile vs desktop.

**Interleaving** is a more sensitive alternative to A/B testing. The ranker merges results from both algorithms into a single list (team-draft interleaving) and attributes each click to the algorithm that contributed that result. Requires 5, 10× less traffic to reach the same statistical power.

---
