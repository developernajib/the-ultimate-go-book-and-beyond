## Part 7: Search Quality Metrics

Building a search engine is only half the job, you also need to measure whether it returns good results. Search quality metrics give you a numerical score that tells you how well your ranking algorithm is performing. The most important metric is NDCG (Normalized Discounted Cumulative Gain), which measures how close your ranked results are to the ideal ordering based on human relevance judgments. Other metrics like MRR (Mean Reciprocal Rank) tell you how quickly the first relevant result appears, and Precision@K tells you what fraction of the top K results are actually relevant. The code below implements all of these metrics so you can evaluate and compare different ranking approaches.

```go
package metrics

import (
	"fmt"
	"math"
	"sort"
)

// RelevanceJudgment is a human-labeled relevance score for a query-document pair
type RelevanceJudgment struct {
	Query    string
	DocID    DocID
	Relevant int // 0 = not relevant, 1 = relevant, 2 = highly relevant
}

// RankedResult is a search result with its rank position
type RankedResult struct {
	DocID    DocID
	Score    float64
	Rank     int
	Relevant int // filled in from judgments
}

// EvalResults evaluates search quality for a set of queries
type EvalResults struct {
	Query     string
	Precision float64 // P@10
	Recall    float64 // R@10
	NDCG      float64 // NDCG@10
	MRR       float64 // Mean Reciprocal Rank
	AP        float64 // Average Precision
}

// NDCG computes Normalized Discounted Cumulative Gain at K
// NDCG@K = DCG@K / IDCG@K
// DCG@K = Σ (2^rel - 1) / log2(rank + 1)
func NDCG(results []RankedResult, k int) float64 {
	if len(results) == 0 {
		return 0
	}
	if k > len(results) {
		k = len(results)
	}

	// Compute DCG@K
	dcg := 0.0
	for i := 0; i < k; i++ {
		rel := float64(results[i].Relevant)
		rank := float64(i + 2) // rank is 1-indexed; log2(1+1) = 1
		dcg += (math.Pow(2, rel) - 1) / math.Log2(rank)
	}

	// Compute ideal DCG (sorted by relevance)
	ideal := make([]RankedResult, len(results))
	copy(ideal, results)
	sort.Slice(ideal, func(i, j int) bool {
		return ideal[i].Relevant > ideal[j].Relevant
	})

	idcg := 0.0
	for i := 0; i < k; i++ {
		rel := float64(ideal[i].Relevant)
		rank := float64(i + 2)
		idcg += (math.Pow(2, rel) - 1) / math.Log2(rank)
	}

	if idcg == 0 {
		return 0
	}
	return dcg / idcg
}

// MRR computes Mean Reciprocal Rank
// MRR = 1/rank of first relevant result
func MRR(results []RankedResult) float64 {
	for i, r := range results {
		if r.Relevant > 0 {
			return 1.0 / float64(i+1)
		}
	}
	return 0
}

// PrecisionAtK computes Precision@K
func PrecisionAtK(results []RankedResult, k int) float64 {
	if k == 0 || len(results) == 0 {
		return 0
	}
	if k > len(results) {
		k = len(results)
	}
	relevant := 0
	for i := 0; i < k; i++ {
		if results[i].Relevant > 0 {
			relevant++
		}
	}
	return float64(relevant) / float64(k)
}

// AveragePrecision computes AP (area under precision-recall curve)
func AveragePrecision(results []RankedResult) float64 {
	totalRelevant := 0
	for _, r := range results {
		if r.Relevant > 0 {
			totalRelevant++
		}
	}
	if totalRelevant == 0 {
		return 0
	}

	sum := 0.0
	relevantSeen := 0
	for i, r := range results {
		if r.Relevant > 0 {
			relevantSeen++
			precision := float64(relevantSeen) / float64(i+1)
			sum += precision
		}
	}
	return sum / float64(totalRelevant)
}

// EvaluateSystem evaluates search across multiple queries
func EvaluateSystem(queries []string, getResults func(string) []RankedResult) {
	var totalNDCG, totalMRR, totalAP float64
	n := float64(len(queries))

	fmt.Printf("%-30s %8s %8s %8s\n", "Query", "NDCG@10", "MRR", "AP")
	fmt.Println(strings.Repeat("-", 60))

	for _, q := range queries {
		results := getResults(q)
		ndcg := NDCG(results, 10)
		mrr := MRR(results)
		ap := AveragePrecision(results)

		totalNDCG += ndcg
		totalMRR += mrr
		totalAP += ap

		short := q
		if len(short) > 28 {
			short = short[:28] + ".."
		}
		fmt.Printf("%-30s %8.3f %8.3f %8.3f\n", short, ndcg, mrr, ap)
	}

	fmt.Println(strings.Repeat("-", 60))
	fmt.Printf("%-30s %8.3f %8.3f %8.3f\n", "AVERAGE",
		totalNDCG/n, totalMRR/n, totalAP/n)
}
```

---
