## Recommendation Engine

The recommendation engine uses a two-stage pipeline, the architecture described in Covington, Adams, and Sargin's 2016 paper "Deep Neural Networks for YouTube Recommendations". The first stage, candidate generation, narrows millions of videos to roughly 500 using cheap methods: collaborative filtering and approximate nearest neighbor search in an embedding space. The second stage, ranking, applies a much more expensive model to just those 500 and picks the top 20. The split exists because a rich model over hundreds of millions of videos per request at 11,574 queries per second is not affordable, and a cheap model alone is not good enough to order the final list.

The two stages must not use the same scoring function, and this is the detail most people get wrong when they reproduce this design. Candidate generation asks "which videos are plausibly relevant?", which embedding similarity answers well and cheaply. Ranking asks a harder question, and the paper's answer is specific: the ranking network predicts **expected watch time**, trained with weighted logistic regression where positive examples are weighted by how long the video was actually watched. That target choice is deliberate. Ranking on click probability optimizes for thumbnails that trick people into clicking, and the paper is explicit that watch time is used to avoid exactly that. If your ranker just re-runs cosine similarity, you have not built a second stage at all, you have run candidate generation twice and paid for it.

```go
package recommendation

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
)

// RecommendationEngine implements the two-stage funnel: candidate generation,
// then ranking. See Covington et al., RecSys 2016.
type RecommendationEngine struct {
	embeddings   EmbeddingStore
	watchHistory WatchHistoryStore
	videoStore   VideoStore
	ranker       WatchTimeRanker
}

// GenerateCandidates produces ~500 candidates from three independent sources.
// Each source may fail on its own without sinking the request, but if every
// source fails we must say so. Returning an empty slice and a nil error here
// would render an empty homepage that looks like a user with no interests
// rather than an outage, and no alert would ever fire.
func (r *RecommendationEngine) GenerateCandidates(ctx context.Context, userID string) ([]string, error) {
	cf, cfErr := r.collaborativeFilter(ctx, userID, 200)      // "users like you watched..."
	cb, cbErr := r.contentBased(ctx, userID, 200)             // similar to recently watched
	trending, trErr := r.trendingByCategory(ctx, userID, 100) // trending in preferred categories

	if cfErr != nil && cbErr != nil && trErr != nil {
		return nil, fmt.Errorf("all candidate sources failed: %w",
			errors.Join(cfErr, cbErr, trErr))
	}

	// Merge and deduplicate into a fresh slice. Chaining append() onto cf would
	// write through cf's backing array and corrupt the caller's slice.
	seen := make(map[string]bool, len(cf)+len(cb)+len(trending))
	candidates := make([]string, 0, len(cf)+len(cb)+len(trending))
	for _, src := range [][]string{cf, cb, trending} {
		for _, id := range src {
			if !seen[id] {
				seen[id] = true
				candidates = append(candidates, id)
			}
		}
	}
	return candidates, nil
}

// Rank scores the candidates and returns the top 20. The score is predicted
// watch time in seconds, not similarity: this is the second stage, and it is
// supposed to answer a different question than the first one did.
func (r *RecommendationEngine) Rank(ctx context.Context, userID string, candidates []string) ([]VideoScore, error) {
	if len(candidates) == 0 {
		return nil, nil
	}

	// One batched call, not one call per candidate. At 500 candidates and
	// 11,574 QPS, per-candidate round trips would mean ~5.8M embedding fetches
	// per second, and the p99 of the request becomes the p99 of the slowest of
	// 500 sequential calls.
	feats, err := r.ranker.BatchFeatures(ctx, userID, candidates)
	if err != nil {
		return nil, fmt.Errorf("rank features: %w", err)
	}

	scores := make([]VideoScore, 0, len(candidates))
	for _, videoID := range candidates {
		f, ok := feats[videoID]
		if !ok {
			continue // no features, cannot score honestly, leave it out
		}
		watchSecs, err := r.ranker.PredictWatchSeconds(ctx, f)
		if err != nil {
			continue
		}
		scores = append(scores, VideoScore{VideoID: videoID, PredictedWatchSeconds: watchSecs})
	}

	sort.Slice(scores, func(i, j int) bool {
		return scores[i].PredictedWatchSeconds > scores[j].PredictedWatchSeconds
	})

	if len(scores) > 20 {
		scores = scores[:20]
	}
	return scores, nil
}

// VideoScore carries the ranker's output. The unit is seconds of expected watch
// time, which is what makes the ordering meaningful and comparable.
type VideoScore struct {
	VideoID               string
	PredictedWatchSeconds float64
}

// cosineSimilarity is the metric behind stage one, not stage two. The ANN index
// backing GetSimilarToWatched ranks by this. It is shown here because it is worth
// seeing how cheap the first stage is compared to the ranker: a dot product and
// two norms, against a full model evaluation per candidate.
func cosineSimilarity(a, b []float64) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	dot, normA, normB := 0.0, 0.0, 0.0
	for i := range a {
		dot += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}

func (r *RecommendationEngine) collaborativeFilter(ctx context.Context, userID string, n int) ([]string, error) {
	// Matrix factorization (ALS) or neural CF
	// "Users who watched the same X videos as you also watched..."
	return r.watchHistory.GetCFCandidates(ctx, userID, n)
}

func (r *RecommendationEngine) contentBased(ctx context.Context, userID string, n int) ([]string, error) {
	// User's last 50 watched videos → approximate nearest neighbors in the
	// shared embedding space, ranked by cosineSimilarity below.
	return r.embeddings.GetSimilarToWatched(ctx, userID, n)
}

func (r *RecommendationEngine) trendingByCategory(ctx context.Context, userID string, n int) ([]string, error) {
	// Get user's top 3 categories → trending videos in those categories
	return r.videoStore.GetTrendingByUserCategories(ctx, userID, n)
}
```

---
