## Deep Dive: Review System with Bayesian Averaging

Trust is the foundation of any two-sided marketplace, and the review system is how Airbnb builds that trust. This service implements two important design choices that go beyond a simple star-rating system. First, it uses a bidirectional blind review, both the host and guest submit reviews independently, and neither review becomes visible until both are submitted (or a 14-day deadline passes). This prevents retaliatory reviews and encourages honest feedback. Second, it applies Bayesian averaging to listing ratings, which prevents a listing with a single 5-star review from outranking one with hundreds of reviews averaging 4.9.

```go
package review

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type ContentModerator interface {
	IsClean(ctx context.Context, comment string) bool
}

type NotificationService interface {
	NotifyReviewSubmitted(ctx context.Context, bookingID string)
}

type ReviewRequest struct {
	BookingID     string `json:"booking_id"`
	OverallRating int    `json:"overall_rating"`
	Comment       string `json:"comment"`
}

type CompletedBooking struct {
	CheckOut  time.Time
	ListingID string
}

// ReviewService manages the bidirectional review system
type ReviewService struct {
	db        *pgxpool.Pool
	moderator ContentModerator
	notifier  NotificationService
}

// Both host and guest reviews are hidden until both submit (or 14-day deadline)
// This prevents retaliatory reviews

type Review struct {
	ID            string         `json:"id"`
	BookingID     string         `json:"booking_id"`
	ReviewerID    string         `json:"reviewer_id"`
	OverallRating int            `json:"overall_rating"`
	SubRatings    map[string]int `json:"sub_ratings"`
	Comment       string         `json:"comment"`
	Response      string         `json:"response,omitempty"` // host can respond
	IsVisible     bool           `json:"is_visible"`
	CreatedAt     time.Time      `json:"created_at"`
}

// SubmitReview handles a review submission with content moderation
func (s *ReviewService) SubmitReview(ctx context.Context, req ReviewRequest, reviewerID string) (*Review, error) {
	// 1. Verify booking is completed
	booking, err := s.getCompletedBooking(ctx, req.BookingID, reviewerID)
	if err != nil {
		return nil, err
	}

	// 2. Check 14-day review window
	if time.Since(booking.CheckOut) > 14*24*time.Hour {
		return nil, fmt.Errorf("review window closed")
	}

	// 3. Content moderation
	if !s.moderator.IsClean(ctx, req.Comment) {
		return nil, fmt.Errorf("inappropriate content detected")
	}

	// 4. Save review (hidden)
	review := &Review{
		ID:            generateID(),
		BookingID:     req.BookingID,
		ReviewerID:    reviewerID,
		OverallRating: req.OverallRating,
		Comment:       req.Comment,
		IsVisible:     false,
		CreatedAt:     time.Now(),
	}
	s.saveReview(ctx, review)

	// 5. Check if both reviews submitted -> make both visible
	s.checkAndRevealPair(ctx, req.BookingID)

	// 6. Update aggregate rating with Bayesian average
	go s.updateAggregateRating(context.Background(), booking.ListingID)

	return review, nil
}

// updateAggregateRating uses Bayesian average to prevent gaming
// A listing with one 5-star review should not rank above one with
// 200 reviews averaging 4.9
func (s *ReviewService) updateAggregateRating(ctx context.Context, listingID string) {
	var avgRating float64
	var count int
	s.db.QueryRow(ctx, `
		SELECT AVG(rating), COUNT(*)
		FROM reviews
		WHERE reviewee_id = $1 AND target_type = 'listing' AND is_visible = true`,
		listingID,
	).Scan(&avgRating, &count)

	// Bayesian average: pull toward global mean
	globalMean := 4.5
	minReviews := 5.0
	bayesianAvg := (minReviews*globalMean + float64(count)*avgRating) / (minReviews + float64(count))

	s.db.Exec(ctx,
		"UPDATE listings SET rating = $1, review_count = $2 WHERE id = $3",
		math.Round(bayesianAvg*100)/100, count, listingID)
}

func (s *ReviewService) getCompletedBooking(ctx context.Context, bookingID, reviewerID string) (*CompletedBooking, error) {
	return &CompletedBooking{CheckOut: time.Now().Add(-24 * time.Hour), ListingID: "listing-1"}, nil
}

func (s *ReviewService) saveReview(ctx context.Context, review *Review) error {
	return nil
}

func (s *ReviewService) checkAndRevealPair(ctx context.Context, bookingID string) {
}

func generateID() string {
	return "rev-1"
}
```

---
