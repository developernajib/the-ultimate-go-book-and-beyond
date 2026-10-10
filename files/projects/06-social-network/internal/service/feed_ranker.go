// internal/service/feed_ranker.go
package service

import (
	"math"
	"time"

	"github.com/example/social-network/internal/domain"
	"github.com/google/uuid"
)

// FeedRanker calculates relevance scores for posts
type FeedRanker struct{}

func NewFeedRanker() *FeedRanker {
	return &FeedRanker{}
}

// CalculateScore uses a hybrid of engagement and recency
// Similar to Twitter's ranking algorithm
func (r *FeedRanker) CalculateScore(post *domain.Post, viewerID uuid.UUID) float64 {
	// Time decay (older posts score lower)
	age := time.Since(post.CreatedAt).Hours()
	timeDecay := 1.0 / math.Pow(age+2, 1.5)

	// Engagement score
	engagementScore := float64(post.LikeCount)*1.0 +
		float64(post.CommentCount)*2.0 + // Comments worth more than likes
		float64(post.RepostCount)*3.0 + // Reposts worth most
		float64(post.ViewCount)*0.01 // Views worth least

	// Combine scores
	// Weight: 70% engagement, 30% recency
	finalScore := (engagementScore * 0.7) + (timeDecay * 100 * 0.3)

	return finalScore
}

// RankPosts sorts posts by relevance
func (r *FeedRanker) RankPosts(posts []*domain.Post, viewerID uuid.UUID) []*domain.Post {
	// Calculate scores
	type scoredPost struct {
		post  *domain.Post
		score float64
	}

	scored := make([]scoredPost, len(posts))
	for i, post := range posts {
		scored[i] = scoredPost{
			post:  post,
			score: r.CalculateScore(post, viewerID),
		}
	}

	// Sort by score (descending)
	for i := range scored {
		for j := i + 1; j < len(scored); j++ {
			if scored[j].score > scored[i].score {
				scored[i], scored[j] = scored[j], scored[i]
			}
		}
	}

	// Extract sorted posts
	ranked := make([]*domain.Post, len(posts))
	for i, sp := range scored {
		ranked[i] = sp.post
	}

	return ranked
}
