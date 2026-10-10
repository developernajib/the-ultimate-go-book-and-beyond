## Production Go Implementation: Ranking Service

The ranking service is the Phase 2 re-ranker that takes candidate documents from the index shards and scores them using a richer set of features than BM25 alone. It combines signals like PageRank, freshness, click-through rate, dwell time, mobile readiness, and HTTPS support into a single relevance score. In production, Google uses deep learning models for this step, but this simplified linear model illustrates the principle: each feature gets a learned weight, and the final score is a weighted sum.

```go
package ranking

import (
	"context"
	"math"
	"sort"
)

// RankingService applies ML-based re-ranking to candidate documents
// Two-phase: Phase 1 (in-shard BM25), Phase 2 (this service, ML model)
type RankingService struct {
	featureExtractor FeatureExtractor
	model            RankingModel
}

type RankingFeatures struct {
	BM25Score      float64 // from Phase 1
	PageRank       float64 // pre-computed graph authority
	Freshness      float64 // days since last crawl (lower = better)
	TitleMatch     float64 // fraction of query terms in title
	URLMatch       float64 // query terms in URL path
	DomainAuth     float64 // domain-level trust score
	ClickThroughRate float64 // historical CTR for this URL
	DwellTime      float64 // avg time users spend on this page from search
	MobileReady    float64 // mobile-friendly score (0 or 1)
	HTTPSBonus     float64 // HTTPS = 1, HTTP = 0
	ContentLength  float64 // normalized document length
	ReadingLevel   float64 // readability score
}

// Rerank applies the full ranking model to Phase 1 candidates
func (s *RankingService) Rerank(ctx context.Context, candidates []ScoredDoc, query string) []ScoredDoc {
	for i := range candidates {
		features := s.featureExtractor.Extract(ctx, candidates[i], query)
		candidates[i].Score = s.model.Score(features)
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Score > candidates[j].Score
	})

	return candidates
}

// SimpleLinearModel is a simplified ranking model
// Production Google uses LambdaMART or deep learning
type SimpleLinearModel struct {
	weights map[string]float64
}

func NewSimpleLinearModel() *SimpleLinearModel {
	return &SimpleLinearModel{
		weights: map[string]float64{
			"bm25":       0.25,
			"pagerank":   0.15,
			"freshness":  0.10,
			"title":      0.15,
			"ctr":        0.10,
			"dwell":      0.08,
			"domain":     0.07,
			"https":      0.03,
			"mobile":     0.04,
			"url":        0.03,
		},
	}
}

func (m *SimpleLinearModel) Score(f RankingFeatures) float64 {
	score := 0.0
	score += m.weights["bm25"] * f.BM25Score
	score += m.weights["pagerank"] * math.Log1p(f.PageRank*1e6)
	score += m.weights["freshness"] * (1.0 / (1.0 + f.Freshness/30.0))
	score += m.weights["title"] * f.TitleMatch
	score += m.weights["ctr"] * f.ClickThroughRate
	score += m.weights["dwell"] * math.Log1p(f.DwellTime/60.0)
	score += m.weights["domain"] * f.DomainAuth
	score += m.weights["https"] * f.HTTPSBonus
	score += m.weights["mobile"] * f.MobileReady
	score += m.weights["url"] * f.URLMatch
	return score
}
```

---
