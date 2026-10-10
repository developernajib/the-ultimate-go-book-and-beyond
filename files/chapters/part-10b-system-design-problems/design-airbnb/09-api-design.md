## API Design

### REST Endpoints

This section defines the contract between client applications and the backend services. The API is split into three groups: guest-facing endpoints for search and booking, host-facing endpoints for listing and calendar management, and messaging endpoints for host-guest communication. Each endpoint uses standard REST conventions, GET for reads, POST for creation, PUT for updates. Notice that the search endpoint accepts all filter criteria as query parameters for easy caching at the CDN layer, while write operations use JSON request bodies.

Money crosses this API as integer minor units with an explicit currency, never as a decimal. A JSON number is an IEEE 754 double in most clients, so a `"total": 150.00` is one bad round-trip away from `149.99999999999997`, and a client that hands that value back has committed the server to losing a cent. `15000` has no such ambiguity, and it survives any JSON parser unchanged.

```go
package api

import "time"

// ========== Guest-Facing APIs ==========

// GET /api/v1/listings/search?location=37.77,-122.41&check_in=2026-06-01&check_out=2026-06-05&guests=2&min_price_cents=5000&max_price_cents=30000&amenities=wifi,pool&property_type=entire_home&page=1&page_size=20
// Response: SearchResponse
// Price bounds are cents, so the $50-$300 band above is 5000-30000.

type ListingResult struct {
	ID                 string   `json:"id"`
	Title              string   `json:"title"`
	PricePerNightCents int64    `json:"price_per_night_cents"`
	Rating             float64  `json:"rating"`
	ReviewCount        int      `json:"review_count"`
	ThumbnailURL       string   `json:"thumbnail_url"`
}

type SearchResponse struct {
	Listings []ListingResult `json:"listings"`
	Total    int             `json:"total"`
	Page     int             `json:"page"`
	HasMore  bool            `json:"has_more"`
}

// GET /api/v1/listings/{listing_id}
// Response: full listing details with photos, reviews, calendar

// GET /api/v1/listings/{listing_id}/calendar?month=2026-06
// Response: CalendarResponse

type CalendarResponse struct {
	ListingID string        `json:"listing_id"`
	Month     string        `json:"month"`
	Days      []CalendarDay `json:"days"`
}

type CalendarDay struct {
	Date       string `json:"date"`
	Available  bool   `json:"available"`
	PriceCents int64  `json:"price_cents"`
	MinStay    int    `json:"min_stay"`
}

// POST /api/v1/bookings
// Request: BookingRequest
// Response: Booking

// POST /api/v1/bookings/{booking_id}/cancel
// Response: CancellationResponse

type CancellationResponse struct {
	BookingID         string `json:"booking_id"`
	RefundAmountCents int64  `json:"refund_amount_cents"`
	Currency          string `json:"currency"`
	RefundPolicy      string `json:"refund_policy"` // flexible, moderate, strict
}

// POST /api/v1/bookings/{booking_id}/reviews
// Request: ReviewRequest
// Response: Review

type ReviewRequest struct {
	OverallRating       int    `json:"overall_rating" validate:"required,min=1,max=5"`
	CleanlinessRating   int    `json:"cleanliness_rating" validate:"min=1,max=5"`
	AccuracyRating      int    `json:"accuracy_rating" validate:"min=1,max=5"`
	CommunicationRating int    `json:"communication_rating" validate:"min=1,max=5"`
	LocationRating      int    `json:"location_rating" validate:"min=1,max=5"`
	ValueRating         int    `json:"value_rating" validate:"min=1,max=5"`
	Comment             string `json:"comment" validate:"required,min=10,max=2000"`
}

// ========== Host-Facing APIs ==========

// POST /api/v1/listings
// PUT /api/v1/listings/{listing_id}
// PUT /api/v1/listings/{listing_id}/calendar
// Request: CalendarUpdateRequest

type CalendarUpdateRequest struct {
	Updates []CalendarUpdate `json:"updates"`
}

type CalendarUpdate struct {
	StartDate  string `json:"start_date"`
	EndDate    string `json:"end_date"`
	Available  bool   `json:"available"`
	PriceCents int64  `json:"price_cents,omitempty"`
	MinStay    int    `json:"min_stay,omitempty"`
	Reason     string `json:"reason,omitempty"` // owner_blocked, maintenance
}

// GET /api/v1/hosts/{host_id}/earnings?period=monthly
// Response: HostEarningsResponse

// Summing earnings is exact because the parts are integers. Summing a column
// of float64 dollars gives an answer that depends on the order you added them
// in, which is not a property anyone wants in a payout statement.
type HostEarningsResponse struct {
	Period              string         `json:"period"`
	TotalEarningsCents  int64          `json:"total_earnings_cents"`
	TotalPayoutsCents   int64          `json:"total_payouts_cents"`
	PendingPayoutsCents int64          `json:"pending_payouts_cents"`
	Currency            string         `json:"currency"` // ISO 4217, e.g. USD
	Bookings            []EarningEntry `json:"bookings"`
}

type EarningEntry struct {
	BookingID   string    `json:"booking_id"`
	GuestName   string    `json:"guest_name"`
	CheckIn     time.Time `json:"check_in"`
	CheckOut    time.Time `json:"check_out"`
	AmountCents int64     `json:"amount_cents"`
	Status      string    `json:"status"` // paid, pending, refunded
}

// ========== Messaging APIs ==========

// POST /api/v1/conversations
// GET /api/v1/conversations?page=1
// POST /api/v1/conversations/{id}/messages
```

---
