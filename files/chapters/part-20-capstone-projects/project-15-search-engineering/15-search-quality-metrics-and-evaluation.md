## Search Quality Metrics and Evaluation

Rigorous measurement is what separates search engineering from search guessing. Every ranking change must be evaluated against a fixed set of quality metrics computed on a held-out judgment set.

### Offline Metrics

**NDCG@K (Normalized Discounted Cumulative Gain)**
The standard metric for graded relevance evaluation. NDCG@10 measures how close the top-10 results are to an ideal ranked list. Values range from 0 to 1, and production systems typically target NDCG@10 > 0.75. See the Go implementation in the LTR section above.

**MRR (Mean Reciprocal Rank)**
MRR measures how quickly the first relevant result appears in the ranked list. It is best suited for navigational queries where users seek exactly one correct answer.

```go
package metrics

// MRR computes Mean Reciprocal Rank across a set of queries.
// For each query, rankedRelevances[q][i] is the binary relevance (0 or 1)
// of the result at rank i+1.
func MRR(rankedRelevances [][]int) float64 {
    if len(rankedRelevances) == 0 {
        return 0
    }
    var sum float64
    for _, rels := range rankedRelevances {
        for rank, rel := range rels {
            if rel == 1 {
                sum += 1.0 / float64(rank+1)
                break
            }
        }
    }
    return sum / float64(len(rankedRelevances))
}
```

**Precision@K and Recall@K** For binary relevance (relevant/not relevant), Precision@K is the fraction of the top-K results that are relevant. Recall@K is the fraction of all relevant documents that appear in the top-K.

```go
// PrecisionAtK computes P@K: fraction of top-K results that are relevant.
func PrecisionAtK(relevances []int, k int) float64 {
    limit := k
    if limit > len(relevances) {
        limit = len(relevances)
    }
    var hits int
    for i := 0; i < limit; i++ {
        if relevances[i] == 1 {
            hits++
        }
    }
    return float64(hits) / float64(limit)
}
```

### Online Metrics

| Metric | Definition | Target |
|--------|-----------|--------|
| **CTR** | Clicks / impressions on search results | Baseline dependent, track delta |
| **Zero-result rate** | Fraction of queries returning 0 results | < 5% for mature search products |
| **Search abandonment** | Sessions with search but no result click | < 30% |
| **Reformulation rate** | Fraction of queries followed by another query | < 40% |
| **Session success rate** | Fraction of sessions with a satisfied click signal | > 60% |
| **Time to first click** | Median time from SERP load to first click | < 3 seconds |

**Zero-result rate** is particularly actionable. A spike indicates vocabulary mismatch (users using terms your index doesn't contain) and triggers synonym expansion or spelling correction work.

**Search abandonment** and **reformulation rate** are leading indicators of relevance problems. Users who reformulate immediately after a SERP were not satisfied by the first set of results.

### Building a Search Quality Evaluation Pipeline

A complete evaluation pipeline has three stages:

**Stage 1: Judgment Collection**
Hire search quality raters (internal annotators or via services like Scale AI) to label (query, document) pairs on a relevance scale. Standard scale:

| Label | Definition |
|-------|-----------|
| 0 - Irrelevant | Document does not address the query at all |
| 1 - Slightly relevant | Tangentially related but not useful |
| 2 - Relevant | Addresses the query but not the best answer |
| 3 - Highly relevant | Excellent answer to the query |

Provide raters with a detailed annotation guideline covering edge cases, navigational vs informational queries, and examples. Google's Public Search Quality Rater Guidelines (170+ pages) are the gold standard.

**Stage 2: Offline Evaluation**

```go

package evaluation

import (
    "encoding/json"
    "os"
    "sort"
)

// JudgmentSet holds human relevance labels for a set of (query, doc) pairs.
type JudgmentSet struct {
    Queries []QueryJudgment `json:"queries"`
}

// QueryJudgment holds the judgment labels for one query.
type QueryJudgment struct {
    Query     string             `json:"query"`
    Judgments map[string]float64 `json:"judgments"` // docID -> relevance label
}

// EvaluationResult holds computed metrics for one query.
type EvaluationResult struct {
    Query   string
    NDCGAt10 float64
    MRR      float64
}

// EvaluateRanker runs the provided search function against all queries in the
// judgment set and returns per-query metrics plus aggregate means.
func EvaluateRanker(
    judgments JudgmentSet,
    searchFn func(query string) []string, // returns ranked doc IDs
) (results []EvaluationResult, meanNDCG, meanMRR float64) {
    for _, qj := range judgments.Queries {
        rankedDocs := searchFn(qj.Query)

        // Build relevance vector from judgment labels.
        rels := make([]float64, len(rankedDocs))
        binaryRels := make([]int, len(rankedDocs))
        for i, docID := range rankedDocs {
            rels[i] = qj.Judgments[docID] // 0 if not judged (treat as irrelevant)
            if rels[i] >= 2 {
                binaryRels[i] = 1
            }
        }

        // Build ideal ordering.
        ideal := make([]float64, 0, len(qj.Judgments))
        for _, v := range qj.Judgments {
            ideal = append(ideal, v)
        }
        sort.Sort(sort.Reverse(sort.Float64Slice(ideal)))

        ndcg := NDCGAtK(rels, ideal, 10)
        mrr := MRR([][]int{binaryRels})

        results = append(results, EvaluationResult{
            Query:    qj.Query,
            NDCGAt10: ndcg,
            MRR:      mrr,
        })
        meanNDCG += ndcg
        meanMRR += mrr
    }
    if len(results) > 0 {
        meanNDCG /= float64(len(results))
        meanMRR /= float64(len(results))
    }
    return results, meanNDCG, meanMRR
}

// LoadJudgmentSet loads a judgment set from a JSON file.
func LoadJudgmentSet(path string) (JudgmentSet, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return JudgmentSet{}, err
    }
    var js JudgmentSet
    return js, json.Unmarshal(data, &js)
}
```
**Stage 3: Regression Gate**

Before deploying any ranking change, run the offline evaluator and enforce: new NDCG@10 >= current NDCG@10 - 0.002. Integrate this check into your CI pipeline so ranking regressions never reach production undetected.

### Offline vs Online Evaluation

| Dimension | Offline (Judgment Lists) | Online (A/B Test) |
|-----------|------------------------|-------------------|
| Speed | Fast (minutes) | Slow (days to weeks) |
| Cost | Medium (rater cost) | Low (traffic split) |
| Coverage | Limited to judged queries | Full query distribution |
| Bias | Rater subjectivity | Position bias, novelty effects |
| Actionability | Immediate ranking debug | Requires live traffic |
| Risk | None (no user impact) | Impacts real users |

Best practice: use offline evaluation for development iterations and A/B testing for final validation before full rollout.

---
