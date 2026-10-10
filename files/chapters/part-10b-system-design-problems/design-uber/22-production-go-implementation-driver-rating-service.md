## Production Go Implementation: Driver Rating Service

The Rating Service manages the feedback loop between riders and drivers after each trip. Instead of using a simple average (which would make early ratings too volatile and late ratings nearly meaningless), it uses an exponentially weighted moving average. This means recent ratings have more influence than older ones, so a driver who improves their service will see their rating rise faster. New drivers with fewer than 50 trips get a higher weight on each rating so their score converges to their true quality level more quickly.

The EWMA is the interesting part of this service, and it is also where a read-modify-write race hides. Reading the driver's current rating, blending the new score in application code, and writing the result back is only correct if nobody else rates that driver in between. A busy driver finishing several trips at an airport queue gets exactly that concurrency, and the losing update vanishes without a trace: no error, no conflict, just a rating that quietly ignores a rider. The blend has to happen in the write itself, so the database serializes it.

```go
package rating

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// RatingService manages rider and driver ratings
type RatingService struct {
	ratingDB RatingStore
	driverDB DriverStore
	riderDB  RiderStore
}

type Rating struct {
	ID        string    `json:"id"`
	TripID    string    `json:"trip_id"`
	RaterID   string    `json:"rater_id"`
	RateeID   string    `json:"ratee_id"`
	Score     int       `json:"score"` // 1-5
	Comment   string    `json:"comment,omitempty"`
	Tags      []string  `json:"tags,omitempty"` // "clean_car", "great_music", "safe_driver"
	CreatedAt time.Time `json:"created_at"`
}

// SubmitDriverRating records a rider's rating of the driver.
func (s *RatingService) SubmitDriverRating(ctx context.Context, tripID, riderID, driverID string, score int, comment string, tags []string) error {
	if score < 1 || score > 5 {
		return fmt.Errorf("score must be 1-5, got %d", score)
	}

	// Authorization is not optional here. Without it, anyone who can guess a
	// trip ID can rate any driver, which turns the rating that gates a person's
	// livelihood into an open endpoint. Verify this rider actually took this
	// trip with this driver.
	ok, err := s.ratingDB.RiderTookTrip(ctx, tripID, riderID, driverID)
	if err != nil {
		return fmt.Errorf("verify trip participation: %w", err)
	}
	if !ok {
		return fmt.Errorf("rider %s did not take trip %s", riderID, tripID)
	}

	rating := &Rating{
		ID:        uuid.NewString(),
		TripID:    tripID,
		RaterID:   riderID,
		RateeID:   driverID,
		Score:     score,
		Comment:   comment,
		Tags:      tags,
		CreatedAt: time.Now(),
	}

	// Create enforces UNIQUE (trip_id, rater_id), so a double submit from a
	// retrying client is rejected rather than counted twice. Ratings are not
	// naturally idempotent, and a rider tapping twice on a flaky connection
	// should not weigh double.
	if err := s.ratingDB.Create(ctx, rating); err != nil {
		return fmt.Errorf("create rating: %w", err)
	}

	return s.applyRating(ctx, driverID, score)
}

// applyRating folds a new score into the driver's exponentially weighted
// moving average.
//
// The blend runs inside the UPDATE rather than in Go, because Get-then-Update
// loses concurrent ratings. Two riders rating the same driver at once both read
// the same starting value, and whichever writes second overwrites the first,
// silently discarding a rating. The equivalent SQL is roughly:
//
//	UPDATE drivers
//	   SET rating = $alpha * $score + (1 - $alpha) * rating
//	 WHERE id = $id
//
// where `rating` on the right is read by the database under the row lock it
// already holds for the write, so the two updates compose instead of racing.
func (s *RatingService) applyRating(ctx context.Context, driverID string, newScore int) error {
	// alpha is chosen from the trip count, so it is read rather than assumed.
	// A stale read here only mis-weights one rating slightly, unlike a stale
	// read of the rating itself, which would destroy one.
	trips, err := s.driverDB.TotalTrips(ctx, driverID)
	if err != nil {
		return fmt.Errorf("driver trip count: %w", err)
	}

	alpha := 0.1 // weight for new rating
	if trips < 50 {
		alpha = 0.3 // higher weight early on, so the rating converges faster
	}

	return s.driverDB.BlendRating(ctx, driverID, alpha, float64(newScore))
}
```

Notice what this service no longer does: increment the driver's trip count. Trips are counted when trips complete, not when they are rated, and most trips are never rated. Incrementing `total_trips` from the rating path makes the count wrong for everyone and, worse, makes it wrong in a way that feeds back into `alpha`, so a driver whose riders rarely rate them stays on the high-volatility weighting long past 50 real trips. Keep a derived field owned by exactly one writer, and let it be the one whose event actually means what the field says.

Low ratings must gate a review queue, never an automatic suspension. A rating is a person's income, the sample is small, and the signal is noisy and measurably biased in ways that correlate with protected characteristics. A threshold that deactivates an account on a moving average of a handful of scores will be wrong often, and each time it is wrong it takes someone's earnings away with no explanation and no human in the loop. Route the driver to review, show the reviewer the underlying ratings, and let a person decide.

---
