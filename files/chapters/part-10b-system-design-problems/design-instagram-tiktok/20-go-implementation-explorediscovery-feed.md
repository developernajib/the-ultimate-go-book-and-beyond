## Go Implementation: Explore/Discovery Feed

The Explore feed (Instagram) or For You Page (TikTok) is an algorithmically curated feed of content from users you do not follow. It works in three stages: candidate generation pulls posts from multiple sources (trending, similar users, preferred categories, high-engagement), an ML model scores each candidate based on predicted user interest, and diversity rules ensure the feed does not become repetitive. The 10% exploration slot for new creators prevents a "rich get richer" effect where only established accounts get visibility.

```go
package feed

import (
	"context"
	"sort"
	"time"
)

// ExploreFeedService generates the algorithmic discovery feed (TikTok-style)
type ExploreFeedService struct {
	postStore PostStore
	userStore UserStore
	mlScorer  MLFeedScorer
	rdb       RedisClient
}

// GetExploreFeed returns algorithmically curated content
func (s *ExploreFeedService) GetExploreFeed(ctx context.Context, userID string, limit int) ([]Post, error) {
	// 1. Generate candidate pool (1000 posts)
	candidates, err := s.generateCandidates(ctx, userID, 1000)
	if err != nil {
		return nil, err
	}

	// 2. Score candidates with ML model
	scored := s.mlScorer.ScoreBatch(ctx, userID, candidates)

	// 3. Apply diversity rules
	diverse := s.applyDiversity(scored, limit)

	// 4. Add exploration slots (10% from cold-start creators, best-effort)
	explorationCount := max(1, limit/10)
	coldStart, _ := s.getColdStartContent(ctx, explorationCount)
	if keep := limit - explorationCount; len(diverse) > keep {
		diverse = diverse[:keep]
	}
	diverse = append(diverse, coldStart...)

	return diverse, nil
}

// generateCandidates collects posts from multiple sources. Each source is
// best-effort: one failing source degrades the pool instead of failing the feed
func (s *ExploreFeedService) generateCandidates(ctx context.Context, userID string, count int) ([]Post, error) {
	var allPosts []Post

	// Source 1: Trending posts (30%)
	trending, _ := s.postStore.GetTrending(ctx, int(float64(count)*0.3))
	allPosts = append(allPosts, trending...)

	// Source 2: Posts from users similar to user's following (30%)
	similar, _ := s.getSimilarUserPosts(ctx, userID, int(float64(count)*0.3))
	allPosts = append(allPosts, similar...)

	// Source 3: Posts in user's preferred categories (20%)
	categories, _ := s.getUserPreferredCategories(ctx, userID)
	categoryPosts, _ := s.postStore.GetByCategories(ctx, categories, int(float64(count)*0.2))
	allPosts = append(allPosts, categoryPosts...)

	// Source 4: High-engagement recent posts (20%)
	highEng, _ := s.postStore.GetHighEngagement(ctx, 24*time.Hour, int(float64(count)*0.2))
	allPosts = append(allPosts, highEng...)

	// Deduplicate
	seen := make(map[string]bool)
	var unique []Post
	for _, p := range allPosts {
		if !seen[p.ID] {
			seen[p.ID] = true
			unique = append(unique, p)
		}
	}

	return unique, nil
}

// applyDiversity ensures mix of categories, creators, and content types
func (s *ExploreFeedService) applyDiversity(scored []Post, limit int) []Post {
	sort.Slice(scored, func(i, j int) bool {
		return scored[i].Score > scored[j].Score
	})

	var result []Post
	creatorSeen := make(map[string]int)
	categorySeen := make(map[string]int)

	for _, p := range scored {
		if len(result) >= limit {
			break
		}

		// Max 2 posts per creator
		if creatorSeen[p.UserID] >= 2 {
			continue
		}

		// Max 30% from any single category
		maxPerCategory := max(1, limit*30/100)
		if categorySeen[p.Category] >= maxPerCategory {
			continue
		}

		result = append(result, p)
		creatorSeen[p.UserID]++
		categorySeen[p.Category]++
	}

	return result
}

// getColdStartContent returns posts from new creators (< 30 days, < 1000 followers)
func (s *ExploreFeedService) getColdStartContent(ctx context.Context, limit int) ([]Post, error) {
	return s.postStore.GetFromNewCreators(ctx, 30*24*time.Hour, 1000, limit)
}
```

---
