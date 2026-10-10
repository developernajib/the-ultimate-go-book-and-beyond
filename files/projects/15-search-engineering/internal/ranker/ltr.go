// Package ranker implements Learning-to-Rank (LTR) reranking using a pre-trained GBDT model.
// In production, use github.com/dmitryikh/leaves for LightGBM/XGBoost inference.
package ranker

import (
	"fmt"
	"sort"
)

// RankingFeatures holds the feature vector for a (query, document) pair.
type RankingFeatures struct {
	BM25Title         float64
	BM25Body          float64
	CTR               float64
	RecencyDays       float64
	ExactTitleMatch   float64
	DomainAuthority   float64
	UserAffinityScore float64
}

// RankedResult pairs a document ID with its predicted relevance score.
type RankedResult struct {
	DocID    string
	Score    float64
	Features RankingFeatures
}

// Model is an interface for ranking model inference.
type Model interface {
	PredictSingle(features []float64) float64
}

// GBDTRanker reranks search results using a pre-trained LambdaMART model.
type GBDTRanker struct {
	model Model
}

// NewGBDTRanker creates a GBDTRanker with the given model.
func NewGBDTRanker(model Model) *GBDTRanker {
	return &GBDTRanker{model: model}
}

// NewGBDTRankerFromFile loads a LightGBM model from disk.
// Stub: returns an error because the leaves library is not included.
func NewGBDTRankerFromFile(modelPath string) (*GBDTRanker, error) {
	return nil, fmt.Errorf("LightGBM model loading not implemented: install github.com/dmitryikh/leaves")
}

// Rerank scores each result using the GBDT model and returns results sorted
// by descending predicted relevance.
func (r *GBDTRanker) Rerank(results []RankedResult) []RankedResult {
	for i := range results {
		fv := featureVector(results[i].Features)
		score := r.model.PredictSingle(fv)
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
