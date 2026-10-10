## Go Implementation: Search Ranking Service

Search ranking determines the order in which listings appear in results, and it directly impacts both guest satisfaction and host revenue. The ranker below computes a weighted score from four signals: relevance (how well the listing matches the search query), quality (Bayesian rating and photo count), conversion rate (historical book-through rate over the last 30 days), and personalization (similarity to the guest's past bookings). Superhost status and fast response rates apply multiplicative boosts on top. This multi-signal approach ensures that the best listings for each individual guest rise to the top.

```go
package ranking

import (
	"context"
	"math"
	"sort"
)

type ListingResult struct {
	ID                 string
	PricePerNightCents int64
	Rating             float64
	ReviewCount        int
	PhotoCount         int
	DistanceKm         float64
	PropertyType       string
	Amenities          []string
	IsSuperhost        bool
	ResponseRate       float64
}

type SearchRequest struct {
	MinPriceCents int64
	MaxPriceCents int64
	Amenities     []string
}

type PastBooking struct {
	PropertyType       string
	PricePerNightCents int64
}

type InteractionStore interface {
	GetViewCount(ctx context.Context, listingID string, days int) (int, error)
}

type BookingStore interface {
	GetBookingCount(ctx context.Context, listingID string, days int) (int, error)
	GetUserBookings(ctx context.Context, userID string, limit int) ([]PastBooking, error)
}

// SearchRanker scores and ranks listings for search results
type SearchRanker struct {
	interactionDB InteractionStore
	bookingDB     BookingStore
}

// RankedListing extends a listing with ranking metadata
type RankedListing struct {
	ListingID        string
	RelevanceScore   float64
	QualityScore     float64
	ConversionScore  float64
	PersonalScore    float64
	FinalScore       float64
	BoostFactors     []string // reasons for boost
}

// RankListings scores and sorts search results
func (r *SearchRanker) RankListings(ctx context.Context, listings []ListingResult, userID string, searchParams SearchRequest) []ListingResult {
	scored := make([]RankedListing, len(listings))

	for i, l := range listings {
		scored[i] = RankedListing{ListingID: l.ID}

		// 1. Relevance: how well listing matches search criteria
		scored[i].RelevanceScore = r.computeRelevance(l, searchParams)

		// 2. Quality: Bayesian rating, review count, photos
		scored[i].QualityScore = r.computeQuality(l)

		// 3. Conversion: historical book-through rate
		scored[i].ConversionScore = r.getConversionRate(ctx, l.ID)

		// 4. Personalization: similarity to user's past bookings
		if userID != "" {
			scored[i].PersonalScore = r.computePersonalization(ctx, l, userID)
		}

		// Weighted combination
		scored[i].FinalScore = scored[i].RelevanceScore*0.3 +
			scored[i].QualityScore*0.3 +
			scored[i].ConversionScore*0.2 +
			scored[i].PersonalScore*0.2

		// Boost factors
		if l.IsSuperhost {
			scored[i].FinalScore *= 1.1
			scored[i].BoostFactors = append(scored[i].BoostFactors, "superhost")
		}
		if l.ResponseRate > 0.95 {
			scored[i].FinalScore *= 1.05
			scored[i].BoostFactors = append(scored[i].BoostFactors, "fast_responder")
		}
	}

	// Sort by final score descending. Sorting an index slice keeps each
	// listing attached to its score, sorting listings directly while the
	// comparator reads the parallel scored slice would break that pairing.
	idx := make([]int, len(listings))
	for i := range idx {
		idx[i] = i
	}
	sort.Slice(idx, func(a, b int) bool {
		return scored[idx[a]].FinalScore > scored[idx[b]].FinalScore
	})

	ranked := make([]ListingResult, len(listings))
	for out, in := range idx {
		ranked[out] = listings[in]
	}
	return ranked
}

func (r *SearchRanker) computeRelevance(l ListingResult, params SearchRequest) float64 {
	score := 1.0

	// Distance penalty: closer is better
	if l.DistanceKm > 0 {
		score *= 1.0 / (1.0 + l.DistanceKm*0.1)
	}

	// Price match: closer to search midpoint is better.
	//
	// Money stays integer, but the ratio it feeds is a relevance score, and a
	// score is not money. Floats are the right tool once the value can no
	// longer be paid to anyone: nothing downstream charges or refunds this
	// number, it only sorts.
	if params.MinPriceCents > 0 && params.MaxPriceCents > 0 {
		midCents := (params.MinPriceCents + params.MaxPriceCents) / 2
		if midCents > 0 {
			priceDiff := math.Abs(float64(l.PricePerNightCents-midCents)) / float64(midCents)
			score *= 1.0 / (1.0 + priceDiff)
		}
	}

	// Amenity match: more matching amenities = better
	matchCount := 0
	for _, wanted := range params.Amenities {
		for _, has := range l.Amenities {
			if wanted == has {
				matchCount++
			}
		}
	}
	if len(params.Amenities) > 0 {
		score *= float64(matchCount) / float64(len(params.Amenities))
	}

	return score
}

func (r *SearchRanker) computeQuality(l ListingResult) float64 {
	// Bayesian rating with photo quality signal
	globalMean := 4.5
	minReviews := 5.0
	bayesianRating := (minReviews*globalMean + float64(l.ReviewCount)*l.Rating) / (minReviews + float64(l.ReviewCount))

	// Photo count bonus (listings with 20+ photos convert better)
	photoBonus := math.Min(1.0, float64(l.PhotoCount)/20.0) * 0.1

	return bayesianRating/5.0 + photoBonus
}

func (r *SearchRanker) getConversionRate(ctx context.Context, listingID string) float64 {
	// Views to bookings ratio over last 30 days
	views, _ := r.interactionDB.GetViewCount(ctx, listingID, 30)
	bookings, _ := r.bookingDB.GetBookingCount(ctx, listingID, 30)
	if views == 0 {
		return 0.5 // default for new listings
	}
	return math.Min(1.0, float64(bookings)/float64(views)*10) // normalize
}

func (r *SearchRanker) computePersonalization(ctx context.Context, l ListingResult, userID string) float64 {
	// Compare listing to user's past bookings
	pastBookings, _ := r.bookingDB.GetUserBookings(ctx, userID, 10)
	if len(pastBookings) == 0 {
		return 0.5
	}

	score := 0.0
	for _, past := range pastBookings {
		// Same property type preference
		if past.PropertyType == l.PropertyType {
			score += 0.3
		}
		// Similar price range: within $50, which is 5000 cents
		diff := past.PricePerNightCents - l.PricePerNightCents
		if diff < 0 {
			diff = -diff
		}
		if diff < 5000 {
			score += 0.2
		}
	}
	return math.Min(1.0, score/float64(len(pastBookings)))
}
```

---
