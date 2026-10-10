## Core Components

### 1. Search Service

The Search Service is the most latency-sensitive component in the entire system, handling nearly 9,000 queries per second. It uses Elasticsearch's built-in `geo_distance` query to find listings within a guest's desired radius, then layers on filters for price, amenities, property type, and guest count. After Elasticsearch returns candidate listings, the service performs a batch availability check against the Availability Service to filter out booked properties. This two-step approach keeps search fast because the expensive availability lookup only runs on the narrowed-down result set, not the full 7 million listings.

```go
package search

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/elastic/go-elasticsearch/v8"
)

// AvailabilityService checks listing availability
type AvailabilityService interface {
	BatchCheckAvailability(ctx context.Context, listingIDs []string, checkIn, checkOut time.Time) (map[string]bool, error)
}

// SearchService handles listing search and filtering
type SearchService struct {
	esClient    *elasticsearch.Client
	availSvc    AvailabilityService
}

// SearchRequest is a guest's search query.
// Money is integer cents throughout this chapter, never float64. A price of
// $149.99 is 14999, and the arithmetic on it is exact.
type SearchRequest struct {
	Location   GeoPoint  `json:"location"`
	RadiusKm   float64   `json:"radius_km"`
	CheckIn    time.Time `json:"check_in"`
	CheckOut   time.Time `json:"check_out"`
	Guests     int       `json:"guests"`
	MinPriceCents int64  `json:"min_price_cents"`
	MaxPriceCents int64  `json:"max_price_cents"`
	Amenities  []string  `json:"amenities"`  // wifi, pool, kitchen, etc.
	PropertyType string  `json:"property_type"` // entire_home, private_room, shared_room
	Page       int       `json:"page"`
	PageSize   int       `json:"page_size"`
}

// GeoPoint is a lat/lng coordinate
type GeoPoint struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

// ListingResult is a search result item
type ListingResult struct {
	ID           string    `json:"id"`
	Title        string    `json:"title"`
	Location     GeoPoint  `json:"location"`
	PricePerNightCents int64 `json:"price_per_night_cents"`
	Rating       float64   `json:"rating"`
	ReviewCount  int       `json:"review_count"`
	ThumbnailURL string    `json:"thumbnail_url"`
	Amenities    []string  `json:"amenities"`
	DistanceKm   float64   `json:"distance_km"`
	Available    bool      `json:"available"`
}

// Search finds available listings matching criteria
func (s *SearchService) Search(ctx context.Context, req SearchRequest) ([]ListingResult, int, error) {
	// Build Elasticsearch query
	query := s.buildQuery(req)

	// Execute search
	res, err := s.esClient.Search(
		s.esClient.Search.WithContext(ctx),
		s.esClient.Search.WithIndex("listings"),
		s.esClient.Search.WithBody(strings.NewReader(query)),
	)
	if err != nil {
		return nil, 0, fmt.Errorf("es search: %w", err)
	}
	defer res.Body.Close()

	var esResult struct {
		Hits struct {
			Total struct {
				Value int `json:"value"`
			} `json:"total"`
			Hits []struct {
				Source ListingResult `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	json.NewDecoder(res.Body).Decode(&esResult)

	listings := make([]ListingResult, len(esResult.Hits.Hits))
	for i, h := range esResult.Hits.Hits {
		listings[i] = h.Source
	}

	// Filter by availability (batch check)
	listingIDs := make([]string, len(listings))
	for i, l := range listings {
		listingIDs[i] = l.ID
	}
	availability, err := s.availSvc.BatchCheckAvailability(ctx, listingIDs, req.CheckIn, req.CheckOut)
	if err != nil {
		return nil, 0, err
	}

	var available []ListingResult
	for _, l := range listings {
		if availability[l.ID] {
			l.Available = true
			available = append(available, l)
		}
	}

	return available, esResult.Hits.Total.Value, nil
}

func (s *SearchService) buildQuery(req SearchRequest) string {
	filters := []map[string]any{
		{"range": map[string]any{
			"accommodates": map[string]any{"gte": req.Guests},
		}},
		{"term": map[string]any{"status": "active"}},
	}

	// The indexed field is cents, so the bounds are cents too. Indexing
	// money as a float in Elasticsearch and filtering on it would put the
	// same rounding drift into search that we removed from booking.
	if req.MinPriceCents > 0 || req.MaxPriceCents > 0 {
		priceRange := map[string]any{}
		if req.MinPriceCents > 0 {
			priceRange["gte"] = req.MinPriceCents
		}
		if req.MaxPriceCents > 0 {
			priceRange["lte"] = req.MaxPriceCents
		}
		filters = append(filters, map[string]any{
			"range": map[string]any{"price_per_night_cents": priceRange},
		})
	}

	if req.PropertyType != "" {
		filters = append(filters, map[string]any{
			"term": map[string]any{"property_type": req.PropertyType},
		})
	}

	for _, amenity := range req.Amenities {
		filters = append(filters, map[string]any{
			"term": map[string]any{"amenities": amenity},
		})
	}

	query := map[string]any{
		"query": map[string]any{
			"bool": map[string]any{
				"must": map[string]any{
					"geo_distance": map[string]any{
						"distance": fmt.Sprintf("%fkm", req.RadiusKm),
						"location": map[string]any{
							"lat": req.Location.Lat,
							"lon": req.Location.Lng,
						},
					},
				},
				"filter": filters,
			},
		},
		"sort": []map[string]any{
			{"_geo_distance": map[string]any{
				"location": map[string]any{
					"lat": req.Location.Lat,
					"lon": req.Location.Lng,
				},
				"order": "asc",
				"unit":  "km",
			}},
			{"rating": map[string]any{"order": "desc"}},
		},
		"from": req.Page * req.PageSize,
		"size": req.PageSize,
	}

	b, _ := json.Marshal(query)
	return string(b)
}
```

### 2. Availability Service

The Availability Service is responsible for tracking which dates are blocked for each listing and managing temporary holds during the booking checkout flow. It uses a dual-storage approach: PostgreSQL stores the authoritative blocked-date records, while Redis provides a fast cache layer for availability lookups and atomic hold acquisition via `SETNX`. The hold mechanism is critical, when a guest starts checkout, Redis locks those dates for 10 minutes so no other guest can book them simultaneously. The hold alone is not sufficient, holds are keyed by exact date range, so the conversion to a permanent database record runs in a transaction that serializes calendar writes per listing and re-checks for overlap. If the booking fails or times out, the hold auto-expires and the dates become available again.

```go
package availability

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// AvailabilityService manages listing calendars and booking holds
type AvailabilityService struct {
	db  *pgxpool.Pool
	rdb *redis.Client
}

// BlockedDate represents a date range that is unavailable
type BlockedDate struct {
	ListingID string
	StartDate time.Time
	EndDate   time.Time
	Reason    string // "booked", "owner_blocked", "maintenance"
	BookingID string // if reason is "booked"
}

// IsAvailable checks if a listing is available for a date range
func (s *AvailabilityService) IsAvailable(ctx context.Context, listingID string, checkIn, checkOut time.Time) (bool, error) {
	// Check cache first
	cacheKey := availabilityCacheKey(listingID, checkIn, checkOut)
	if cached, err := s.rdb.Get(ctx, cacheKey).Result(); err == nil {
		return cached == "1", nil
	}

	var count int
	err := s.db.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM blocked_dates
		WHERE listing_id = $1
		  AND start_date < $3
		  AND end_date > $2`,
		listingID, checkIn, checkOut,
	).Scan(&count)
	if err != nil {
		return false, err
	}

	available := count == 0
	val := "0"
	if available {
		val = "1"
	}
	// Cache for 30 seconds (availability changes frequently)
	s.rdb.Set(ctx, cacheKey, val, 30*time.Second)
	return available, nil
}

// BatchCheckAvailability checks multiple listings at once
func (s *AvailabilityService) BatchCheckAvailability(ctx context.Context, listingIDs []string, checkIn, checkOut time.Time) (map[string]bool, error) {
	if len(listingIDs) == 0 {
		return nil, nil
	}

	// Build IN clause
	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT listing_id
		FROM blocked_dates
		WHERE listing_id = ANY($1)
		  AND start_date < $3
		  AND end_date > $2`,
		listingIDs, checkIn, checkOut,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	blocked := make(map[string]bool)
	for rows.Next() {
		var id string
		rows.Scan(&id)
		blocked[id] = true
	}

	result := make(map[string]bool, len(listingIDs))
	for _, id := range listingIDs {
		result[id] = !blocked[id]
	}
	return result, nil
}

// HoldDates temporarily holds dates during booking flow.
// Hold expires after 10 minutes if booking isn't completed.
// The hold key is derived from the exact date range, so two overlapping
// but different ranges produce different keys. The hold is therefore only
// a fast-path gate: the overlap re-check inside ConfirmBooking's database
// transaction is what actually prevents double-booking.
func (s *AvailabilityService) HoldDates(ctx context.Context, listingID, sessionID string, checkIn, checkOut time.Time) (bool, error) {
	holdKey := holdCacheKey(listingID, checkIn, checkOut)

	// Try to set hold in Redis (NX = only if not exists)
	ok, err := s.rdb.SetNX(ctx, holdKey, sessionID, 10*time.Minute).Result()
	if err != nil {
		return false, err
	}
	if !ok {
		// Dates are held by another session
		return false, nil
	}
	return true, nil
}

// ReleaseHold drops a checkout hold, used when a later booking step fails.
func (s *AvailabilityService) ReleaseHold(ctx context.Context, listingID string, checkIn, checkOut time.Time) {
	s.rdb.Del(ctx, holdCacheKey(listingID, checkIn, checkOut))
}

// ConfirmBooking converts a hold into a permanent blocked date.
// The insert runs in a transaction that serializes calendar writers per
// listing (advisory lock) and re-checks for overlap, the second line of
// defense against double-booking that the Redis hold alone cannot provide.
func (s *AvailabilityService) ConfirmBooking(ctx context.Context, listingID, bookingID, sessionID string, checkIn, checkOut time.Time) error {
	holdKey := holdCacheKey(listingID, checkIn, checkOut)

	// Verify we still own the hold
	holder, err := s.rdb.Get(ctx, holdKey).Result()
	if err != nil || holder != sessionID {
		return fmt.Errorf("hold expired or stolen")
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Serialize all calendar writes for this listing
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", listingID); err != nil {
		return err
	}

	// Re-check overlap now that we hold the lock
	var count int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM blocked_dates
		WHERE listing_id = $1
		  AND start_date < $3
		  AND end_date > $2`,
		listingID, checkIn, checkOut,
	).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return fmt.Errorf("dates no longer available")
	}

	// Insert blocked dates
	if _, err := tx.Exec(ctx, `
		INSERT INTO blocked_dates (listing_id, start_date, end_date, reason, booking_id)
		VALUES ($1, $2, $3, 'booked', $4)`,
		listingID, checkIn, checkOut, bookingID,
	); err != nil {
		return fmt.Errorf("block dates: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	// Release hold
	s.rdb.Del(ctx, holdKey)

	// Invalidate availability cache for this listing
	s.invalidateCache(ctx, listingID)
	return nil
}

// ReleaseBooking unblocks dates when a booking is canceled
func (s *AvailabilityService) ReleaseBooking(ctx context.Context, bookingID string) error {
	var listingID string
	err := s.db.QueryRow(ctx,
		"SELECT listing_id FROM blocked_dates WHERE booking_id = $1",
		bookingID,
	).Scan(&listingID)
	if err != nil {
		return err
	}

	_, err = s.db.Exec(ctx,
		"DELETE FROM blocked_dates WHERE booking_id = $1", bookingID)
	if err != nil {
		return err
	}

	s.invalidateCache(ctx, listingID)
	return nil
}

func (s *AvailabilityService) invalidateCache(ctx context.Context, listingID string) {
	// Delete all cache keys for this listing (pattern delete)
	pattern := fmt.Sprintf("avail:%s:*", listingID)
	keys, _ := s.rdb.Keys(ctx, pattern).Result()
	if len(keys) > 0 {
		s.rdb.Del(ctx, keys...)
	}
}

func availabilityCacheKey(listingID string, checkIn, checkOut time.Time) string {
	return fmt.Sprintf("avail:%s:%s:%s", listingID,
		checkIn.Format("20060102"), checkOut.Format("20060102"))
}

func holdCacheKey(listingID string, checkIn, checkOut time.Time) string {
	return fmt.Sprintf("hold:%s:%s:%s", listingID,
		checkIn.Format("20060102"), checkOut.Format("20060102"))
}
```

### 3. Booking Service

The Booking Service orchestrates the most critical transaction in the system: turning a guest's intent into a confirmed reservation. It follows a strict seven-step flow, validate dates, hold availability, calculate pricing, create a booking record, authorize payment, confirm the availability block, and notify both parties. Each step includes compensating actions so that if any later step fails, earlier side effects are rolled back. For example, if payment authorization fails, the Redis hold is released and the booking is marked as `payment_failed`. This careful choreography is what prevents double-bookings and orphaned charges.

```go
package booking

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type AvailabilityService interface {
	HoldDates(ctx context.Context, listingID, sessionID string, checkIn, checkOut time.Time) (bool, error)
	ReleaseHold(ctx context.Context, listingID string, checkIn, checkOut time.Time)
	ConfirmBooking(ctx context.Context, listingID, bookingID, sessionID string, checkIn, checkOut time.Time) error
}

type AuthorizeRequest struct {
	IdempotencyKey  string
	MerchantID      string
	Amount          int64
	Currency        string
	PaymentMethodID string
	Description     string
}

type PaymentResult struct {
	AuthorizationID string
}

type PaymentService interface {
	Authorize(ctx context.Context, req AuthorizeRequest) (*PaymentResult, error)
	Void(ctx context.Context, authorizationID string) error
	Capture(ctx context.Context, paymentID string) error
}

type NotificationService interface {
	BookingCreated(ctx context.Context, booking *Booking)
}

// BookingService manages the booking lifecycle
type BookingService struct {
	db          *pgxpool.Pool
	availSvc    AvailabilityService
	paymentSvc  PaymentService
	notifier    NotificationService
}

// Booking represents a reservation.
//
// The booking stores every money component, not just the total. Downstream
// services need the pieces: the payout service pays out accommodation plus
// cleaning fee, and the cancellation engine refunds the service fee on a
// different rule than the rest. Storing only the total forces them to back
// the components out by division, which is both lossy and a guess about how
// the total was assembled in the first place.
type Booking struct {
	ID              string    `json:"id"`
	ListingID       string    `json:"listing_id"`
	GuestID         string    `json:"guest_id"`
	HostID          string    `json:"host_id"`
	CheckIn         time.Time `json:"check_in"`
	CheckOut        time.Time `json:"check_out"`
	Guests          int       `json:"guests"`
	SubtotalCents   int64     `json:"subtotal_cents"`    // nightly rate x nights
	CleaningFeeCents int64    `json:"cleaning_fee_cents"`
	ServiceFeeCents int64     `json:"service_fee_cents"` // 14% guest fee
	TotalCents      int64     `json:"total_cents"`       // sum of the three above
	Currency        string    `json:"currency"`          // ISO 4217, e.g. USD
	Status          string    `json:"status"` // pending, confirmed, canceled, completed
	PaymentID       string    `json:"payment_id"`
	CreatedAt       time.Time `json:"created_at"`
}

// BookingRequest from a guest
type BookingRequest struct {
	ListingID  string    `json:"listing_id"`
	GuestID    string    `json:"guest_id"`
	CheckIn    time.Time `json:"check_in"`
	CheckOut   time.Time `json:"check_out"`
	Guests     int       `json:"guests"`
	PaymentMethodID string `json:"payment_method_id"`
	SessionID  string    `json:"session_id"` // for hold management
}

// CreateBooking handles the full booking flow
func (s *BookingService) CreateBooking(ctx context.Context, req BookingRequest) (*Booking, error) {
	// 1. Validate dates
	if req.CheckIn.Before(time.Now().Truncate(24*time.Hour)) {
		return nil, fmt.Errorf("check-in must be in the future")
	}
	if req.CheckOut.Before(req.CheckIn.Add(24*time.Hour)) {
		return nil, fmt.Errorf("minimum stay is 1 night")
	}

	// 2. Check availability and hold dates
	held, err := s.availSvc.HoldDates(ctx, req.ListingID, req.SessionID, req.CheckIn, req.CheckOut)
	if err != nil {
		return nil, fmt.Errorf("availability check: %w", err)
	}
	if !held {
		return nil, fmt.Errorf("listing is not available for those dates")
	}

	// 3. Calculate price
	listing, err := s.getListing(ctx, req.ListingID)
	if err != nil {
		s.availSvc.ReleaseHold(ctx, req.ListingID, req.CheckIn, req.CheckOut)
		return nil, err
	}

	nights := int64(req.CheckOut.Sub(req.CheckIn).Hours() / 24)

	// All money is integer cents, and the rounding rule is uniform across the
	// chapter: a derived amount rounds half-up, and the last component of any
	// split is computed by subtraction so the parts always sum to the whole.
	//
	// Only the service fee needs rounding here. The subtotal is an exact
	// product and the cleaning fee is a stored integer, so the total is the
	// sum of three exact integers. The (x*14 + 50) / 100 idiom is half-up
	// without ever leaving integer arithmetic: on a $220.05 subtotal the fee
	// is (22005*14 + 50) / 100 = 3081 cents, which is $30.81 rather than the
	// $30.807 that no card network can charge.
	subtotalCents := listing.PricePerNightCents * nights
	serviceFeeCents := (subtotalCents*14 + 50) / 100 // 14% guest service fee
	totalCents := subtotalCents + serviceFeeCents + listing.CleaningFeeCents

	// 4. Create booking record
	bookingID := uuid.New().String()
	booking := &Booking{
		ID:               bookingID,
		ListingID:        req.ListingID,
		GuestID:          req.GuestID,
		HostID:           listing.HostID,
		CheckIn:          req.CheckIn,
		CheckOut:         req.CheckOut,
		Guests:           req.Guests,
		SubtotalCents:    subtotalCents,
		CleaningFeeCents: listing.CleaningFeeCents,
		ServiceFeeCents:  serviceFeeCents,
		TotalCents:       totalCents,
		Currency:         listing.Currency,
		Status:           "pending",
		CreatedAt:        time.Now(),
	}

	if err := s.saveBooking(ctx, booking); err != nil {
		s.availSvc.ReleaseHold(ctx, req.ListingID, req.CheckIn, req.CheckOut)
		return nil, fmt.Errorf("save booking: %w", err)
	}

	// 5. Authorize payment (hold funds, don't capture yet)
	paymentResult, err := s.paymentSvc.Authorize(ctx, AuthorizeRequest{
		IdempotencyKey:  "booking-auth-" + bookingID,
		MerchantID:      listing.HostID,
		Amount:          totalCents, // already minor units, nothing to convert
		Currency:        booking.Currency,
		PaymentMethodID: req.PaymentMethodID,
		Description:     fmt.Sprintf("Airbnb booking %s", bookingID),
	})
	if err != nil {
		// Release hold and cancel booking
		s.availSvc.ReleaseHold(ctx, req.ListingID, req.CheckIn, req.CheckOut)
		s.updateBookingStatus(ctx, bookingID, "payment_failed")
		return nil, fmt.Errorf("payment authorization failed: %w", err)
	}

	booking.PaymentID = paymentResult.AuthorizationID
	booking.Status = "authorized"
	s.updateBookingStatus(ctx, bookingID, "authorized")

	// 6. Confirm availability (convert hold to permanent block)
	if err := s.availSvc.ConfirmBooking(ctx, req.ListingID, bookingID, req.SessionID, req.CheckIn, req.CheckOut); err != nil {
		// This shouldn't happen (we held the dates), but handle gracefully
		s.paymentSvc.Void(ctx, paymentResult.AuthorizationID)
		s.updateBookingStatus(ctx, bookingID, "canceled")
		return nil, fmt.Errorf("confirm availability: %w", err)
	}

	// 7. Notify host and guest (background ctx: outlives this request)
	go s.notifier.BookingCreated(context.Background(), booking)

	booking.Status = "confirmed"
	s.updateBookingStatus(ctx, bookingID, "confirmed")

	return booking, nil
}

// CapturePayment captures the held funds once the booking is confirmed.
// Card authorizations expire after roughly 7 days, so capture cannot
// wait for check-in. The host payout happens separately, 24h after check-in.
func (s *BookingService) CapturePayment(ctx context.Context, bookingID string) error {
	booking, err := s.getBooking(ctx, bookingID)
	if err != nil {
		return err
	}

	if booking.Status != "confirmed" {
		return fmt.Errorf("can only capture for confirmed bookings")
	}

	if err := s.paymentSvc.Capture(ctx, booking.PaymentID); err != nil {
		return fmt.Errorf("capture failed: %w", err)
	}

	return s.updateBookingStatus(ctx, bookingID, "payment_captured")
}

func (s *BookingService) getListing(ctx context.Context, listingID string) (*Listing, error) {
	var l Listing
	err := s.db.QueryRow(ctx,
		"SELECT host_id, price_per_night_cents, cleaning_fee_cents, currency FROM listings WHERE id = $1 AND status = 'active'",
		listingID,
	).Scan(&l.HostID, &l.PricePerNightCents, &l.CleaningFeeCents, &l.Currency)
	return &l, err
}

func (s *BookingService) saveBooking(ctx context.Context, b *Booking) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO bookings (id, listing_id, guest_id, host_id, check_in, check_out, guests,
		                      subtotal_cents, cleaning_fee_cents, service_fee_cents, total_cents,
		                      currency, status, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
		b.ID, b.ListingID, b.GuestID, b.HostID, b.CheckIn, b.CheckOut, b.Guests,
		b.SubtotalCents, b.CleaningFeeCents, b.ServiceFeeCents, b.TotalCents,
		b.Currency, b.Status,
	)
	return err
}

func (s *BookingService) updateBookingStatus(ctx context.Context, bookingID, status string) error {
	_, err := s.db.Exec(ctx, "UPDATE bookings SET status = $1 WHERE id = $2", status, bookingID)
	return err
}

func (s *BookingService) getBooking(ctx context.Context, bookingID string) (*Booking, error) {
	var b Booking
	err := s.db.QueryRow(ctx, `
		SELECT id, listing_id, guest_id, host_id, check_in, check_out,
		       subtotal_cents, cleaning_fee_cents, service_fee_cents, total_cents,
		       currency, status, payment_id
		FROM bookings WHERE id = $1`,
		bookingID,
	).Scan(&b.ID, &b.ListingID, &b.GuestID, &b.HostID, &b.CheckIn, &b.CheckOut,
		&b.SubtotalCents, &b.CleaningFeeCents, &b.ServiceFeeCents, &b.TotalCents,
		&b.Currency, &b.Status, &b.PaymentID)
	return &b, err
}

type Listing struct {
	HostID             string
	PricePerNightCents int64
	CleaningFeeCents   int64
	Currency           string
}
```

---
