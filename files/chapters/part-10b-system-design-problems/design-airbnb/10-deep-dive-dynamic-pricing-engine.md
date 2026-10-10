## Deep Dive: Dynamic Pricing Engine

Dynamic pricing is what separates a basic booking platform from a competitive marketplace. This engine helps hosts maximize revenue by suggesting nightly prices based on multiple real-world factors: weekend demand, seasonality, nearby events, competitor pricing, and booking lead time. Each factor produces a percentage adjustment that is applied multiplicatively to the host's base price, with a floor at 50% and a ceiling at 300% of the base to prevent extreme outliers. The key insight is that pricing is advisory, hosts always have final control, but data-driven suggestions significantly increase booking rates.

Two representation choices carry the whole engine. Prices are integer cents, and factor impacts are basis points rather than percentages, because a 15% weekend premium is `1500` bps exactly while `0.15` is not a number a `float64` can hold. Percent as a float is where multiplicative pricing usually goes wrong: multiply a base price by five of them and the result is off in the last digits before you have even rounded.

The second choice matters more than it looks. The factors are combined by accumulating an exact rational product and rounding **once**, at the end. Rounding after each factor would compound: a $200 base with a weekend premium, a season bump, and a lead-time discount would round three times, and each rounding is a fresh chance to drift a cent in a direction that nobody chose. Round once and the suggestion is the correctly rounded value of the exact product, which is a claim you can actually test.



```go
package pricing

import (
	"context"
	"fmt"
	"math/big"
	"time"
)

type Listing struct {
	ID                 string
	PricePerNightCents int64
	PropertyType       string
	Lat                float64
	Lng                float64
}

type ListingStore interface {
	Get(ctx context.Context, listingID string) (*Listing, error)
}

type BookingStore interface {
}

type MarketDataService interface {
	GetSeasonalMultiplierBps(ctx context.Context, lat, lng float64, date time.Time) int64
	GetNearbyEvents(ctx context.Context, lat, lng float64, date time.Time, radiusKm float64) []string
	GetCompetitorAvgPriceCents(ctx context.Context, lat, lng float64, propertyType string, date time.Time) int64
}

// DynamicPricingService suggests optimal nightly prices for hosts
type DynamicPricingService struct {
	listingDB  ListingStore
	bookingDB  BookingStore
	marketData MarketDataService
}

type PriceSuggestion struct {
	Date                time.Time     `json:"date"`
	SuggestedPriceCents int64         `json:"suggested_price_cents"`
	MinPriceCents       int64         `json:"min_price_cents"`
	MaxPriceCents       int64         `json:"max_price_cents"`
	Factors             []PriceFactor `json:"factors"`
	Confidence          float64       `json:"confidence"` // a score, not money
}

type PriceFactor struct {
	Name string `json:"name"`
	// ImpactBps is the adjustment in basis points: 1500 is +15%, -2000 is
	// -20%. Basis points hold these exactly, which "0.15" does not.
	ImpactBps int64  `json:"impact_bps"`
	Reasoning string `json:"reasoning"`
}

// bpsScale is one whole multiplier in basis points, so a factor of ImpactBps
// scales a price by (bpsScale + ImpactBps) / bpsScale.
const bpsScale = 10000

// SuggestPrices generates dynamic pricing recommendations
func (s *DynamicPricingService) SuggestPrices(ctx context.Context, listingID string, startDate, endDate time.Time) ([]PriceSuggestion, error) {
	listing, err := s.listingDB.Get(ctx, listingID)
	if err != nil {
		return nil, err
	}

	baseCents := listing.PricePerNightCents
	var suggestions []PriceSuggestion

	// Floor at 50% and ceiling at 300% of base. The floor rounds half-up so
	// an odd base price cannot round the host's own floor down below half.
	minCents := (baseCents + 1) / 2
	maxCents := baseCents * 3

	for date := startDate; date.Before(endDate); date = date.AddDate(0, 0, 1) {
		factors := s.calculateFactors(ctx, listing, date)

		adjusted := applyFactors(baseCents, factors)

		// Clamp into the band. min and max are builtins for ordered types.
		adjusted = max(minCents, min(maxCents, adjusted))

		suggestions = append(suggestions, PriceSuggestion{
			Date:                date,
			SuggestedPriceCents: adjusted,
			MinPriceCents:       minCents,
			MaxPriceCents:       maxCents,
			Factors:             factors,
			Confidence:          0.85,
		})
	}

	return suggestions, nil
}

// applyFactors scales baseCents by every factor and rounds exactly once.
//
// The product is accumulated as an exact rational: the numerator collects
// (10000 + bps) per factor and the denominator collects 10000 per factor.
// Rounding inside the loop instead would compound one rounding error per
// factor into the final suggestion.
//
// This uses math/big rather than int64 because the denominator alone is
// 10000^n, and five factors is 10^20, which overflows an int64 well before
// the numerator has finished growing. Overflow here would not error, it
// would silently produce a negative price.
func applyFactors(baseCents int64, factors []PriceFactor) int64 {
	num := big.NewInt(baseCents)
	den := big.NewInt(1)
	for _, f := range factors {
		num.Mul(num, big.NewInt(bpsScale+f.ImpactBps))
		den.Mul(den, big.NewInt(bpsScale))
	}
	return divRoundHalfUp(num, den)
}

// divRoundHalfUp returns num/den rounded half-up, via floor((2n + d) / 2d).
//
// Both arguments are non-negative here: a base price is positive, and no
// factor may cut more than 100%, so every multiplier stays above zero. That
// precondition is what lets this skip the sign handling that rounding half
// away from zero would otherwise need.
func divRoundHalfUp(num, den *big.Int) int64 {
	n := new(big.Int).Lsh(num, 1)  // 2n
	n.Add(n, den)                  // 2n + d
	d := new(big.Int).Lsh(den, 1)  // 2d
	return n.Div(n, d).Int64()
}

func (s *DynamicPricingService) calculateFactors(ctx context.Context, listing *Listing, date time.Time) []PriceFactor {
	var factors []PriceFactor

	// Weekend premium
	if date.Weekday() == time.Friday || date.Weekday() == time.Saturday {
		factors = append(factors, PriceFactor{
			Name: "weekend_premium", ImpactBps: 1500, // +15%
			Reasoning: "Weekend dates have 30% higher demand",
		})
	}

	// Seasonality. The market data service reports the multiplier already in
	// basis points (11500 is 1.15x), so no float ever enters the chain.
	seasonBps := s.marketData.GetSeasonalMultiplierBps(ctx, listing.Lat, listing.Lng, date)
	if seasonBps > bpsScale {
		factors = append(factors, PriceFactor{
			Name: "high_season", ImpactBps: seasonBps - bpsScale,
			Reasoning: "Peak season for this area",
		})
	}

	// Local events: +15% each, capped at +50%
	events := s.marketData.GetNearbyEvents(ctx, listing.Lat, listing.Lng, date, 10.0)
	if len(events) > 0 {
		factors = append(factors, PriceFactor{
			Name: "local_events", ImpactBps: min(5000, int64(len(events))*1500),
			Reasoning: fmt.Sprintf("%d events nearby", len(events)),
		})
	}

	// Competitor pricing. Comparing 80% of the market average stays in
	// integers: x < y*0.8 becomes x*10 < y*8, with no division to round.
	compCents := s.marketData.GetCompetitorAvgPriceCents(ctx, listing.Lat, listing.Lng, listing.PropertyType, date)
	if compCents > 0 && listing.PricePerNightCents*10 < compCents*8 {
		factors = append(factors, PriceFactor{
			Name: "below_market", ImpactBps: 1000, // +10%
			// Display rounds to whole dollars, and only for display. The
			// comparison above used the exact cents.
			Reasoning: fmt.Sprintf("Similar listings average $%d/night", (compCents+50)/100),
		})
	}

	// Lead time. This is a duration, not money, so float hours are fine.
	daysOut := time.Until(date).Hours() / 24
	if daysOut < 3 {
		factors = append(factors, PriceFactor{
			Name: "last_minute_discount", ImpactBps: -2000, // -20%
			Reasoning: "Last-minute discounts fill empty nights",
		})
	}

	return factors
}
```

---
