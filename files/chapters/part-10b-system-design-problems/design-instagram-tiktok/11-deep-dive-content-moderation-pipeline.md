## Deep Dive: Content Moderation Pipeline

Content moderation is not optional: it is a legal and ethical requirement for any user-generated content platform. This pipeline runs automatically on every upload before the content becomes visible to other users. It checks for CSAM (child sexual abuse material) using PhotoDNA hash matching as the highest priority, then runs ML classifiers for NSFW content and violence, and finally analyzes caption text for hate speech. Posts that score above a high-confidence threshold are auto-rejected, while borderline cases go to a human review queue.

```go
package moderation

import (
	"context"
	"time"
)

// ContentModerationService screens uploaded content
type ContentModerationService struct {
	imageClassifier ImageClassifier  // NSFW/violence detection
	textAnalyzer    TextAnalyzer     // hate speech/harassment
	hashMatcher     PhotoDNAMatcher  // CSAM detection (highest priority)
	reviewQueue     ReviewQueue
}

type ModerationResult struct {
	PostID     string             `json:"post_id"`
	Status     string             `json:"status"` // approved, rejected, pending_review
	Scores     map[string]float64 `json:"scores"`
	Violations []string           `json:"violations"`
	ReviewedAt time.Time          `json:"reviewed_at"`
}

func (s *ContentModerationService) ModerateContent(ctx context.Context, post *Post) (*ModerationResult, error) {
	result := &ModerationResult{PostID: post.ID, Scores: make(map[string]float64)}

	// 1. PhotoDNA (CSAM): immediate block + report to NCMEC
	if match := s.hashMatcher.Check(ctx, post.MediaURL); match {
		result.Status = "rejected"
		result.Violations = append(result.Violations, "csam_detected")
		s.reportToNCMEC(ctx, post)
		return result, nil
	}

	// 2. Image classification (NSFW, violence, drugs)
	// Fail closed: a classifier outage must not let content skip screening
	imageScores, err := s.imageClassifier.Classify(ctx, post.MediaURL)
	if err != nil {
		result.Status = "pending_review"
		s.reviewQueue.Enqueue(ctx, post, result)
		return result, nil
	}
	for category, score := range imageScores {
		result.Scores[category] = score
		if score > 0.9 {
			result.Violations = append(result.Violations, category)
		}
	}

	// 3. Text analysis (caption)
	if post.Caption != "" {
		textScores, err := s.textAnalyzer.Analyze(ctx, post.Caption)
		if err != nil {
			result.Status = "pending_review"
			s.reviewQueue.Enqueue(ctx, post, result)
			return result, nil
		}
		for cat, score := range textScores {
			result.Scores["text_"+cat] = score
			if score > 0.85 {
				result.Violations = append(result.Violations, "text_"+cat)
			}
		}
	}

	// 4. Decision
	if len(result.Violations) == 0 {
		result.Status = "approved"
	} else {
		maxScore := 0.0
		for _, v := range result.Violations {
			if result.Scores[v] > maxScore {
				maxScore = result.Scores[v]
			}
		}
		if maxScore > 0.95 {
			result.Status = "rejected"
		} else {
			result.Status = "pending_review"
			s.reviewQueue.Enqueue(ctx, post, result)
		}
	}

	result.ReviewedAt = time.Now()
	return result, nil
}

// Moderation happens BEFORE post is visible:
// Upload -> Processing -> Moderation -> (if approved) -> Index -> Fan-out
// SLA: 30 seconds. Human review SLA: 4 hours.
```

---
