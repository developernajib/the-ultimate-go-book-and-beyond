package metrics

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// RankedResult is a search result with its rank position
type RankedResult struct {
	DocID    string
	Score    float64
	Rank     int
	Relevant int // filled in from relevance judgments
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

// MRRResults computes Mean Reciprocal Rank for a list of RankedResult
func MRRResults(results []RankedResult) float64 {
	for i, r := range results {
		if r.Relevant > 0 {
			return 1.0 / float64(i+1)
		}
	}
	return 0
}

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

// PrecisionAtK computes Precision@K for RankedResult slice
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

// PrecisionAtKInt computes P@K for binary relevance slice.
func PrecisionAtKInt(relevances []int, k int) float64 {
	limit := min(k, len(relevances))
	var hits int
	for i := 0; i < limit; i++ {
		if relevances[i] == 1 {
			hits++
		}
	}
	return float64(hits) / float64(limit)
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
		mrr := MRRResults(results)
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
	limit := min(k, len(relevances))
	var dcg float64
	for i := 0; i < limit; i++ {
		gain := math.Pow(2, relevances[i]) - 1
		discount := math.Log2(float64(i + 2)) // log2(rank+1), rank is 1-indexed
		dcg += gain / discount
	}
	return dcg
}

// MeanNDCGAtK computes mean NDCG@K across multiple queries.
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
