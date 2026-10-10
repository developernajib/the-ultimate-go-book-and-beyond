## API Design

### REST Endpoints

The API is organized into a customer-facing flow (browse events, view seats, join queue, hold seats, confirm booking) and a resale marketplace. Each endpoint maps directly to a step in the user journey. The request and response types below use Go structs with JSON tags, which double as both API documentation and serialization logic. Pay attention to the `HoldRequest` and `HoldResponse` types, as the hold-then-confirm two-step flow is what makes oversell prevention possible.

```go
package api

import "time"

// ========== Customer APIs ==========

// GET /api/v1/events?city=new_york&category=concerts&date_from=2026-06-01
// Response: EventListResponse

type EventListResponse struct {
	Events  []EventSummary `json:"events"`
	Total   int            `json:"total"`
	HasMore bool           `json:"has_more"`
}

type EventSummary struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Venue          string    `json:"venue"`
	Date           time.Time `json:"date"`
	PriceRange     string    `json:"price_range"`
	Status         string    `json:"status"` // on_sale, presale, sold_out
	AvailableCount int       `json:"available_count"`
}

// GET /api/v1/events/{event_id}/seats?section=A
// Response: SeatMapResponse

type SeatMapResponse struct {
	EventID  string    `json:"event_id"`
	Sections []Section `json:"sections"`
}

type Section struct {
	Name string `json:"name"`
	Rows []Row  `json:"rows"`
	Tier string `json:"tier"`
}

type Row struct {
	Label string     `json:"label"`
	Seats []SeatView `json:"seats"`
}

type SeatView struct {
	ID         string `json:"id"`
	Number     int    `json:"number"`
	PriceCents int64  `json:"price_cents"`
	Status     string `json:"status"` // available, held, sold
}

// POST /api/v1/queue/join { "event_id": "..." }
// GET /api/v1/queue/position?event_id=...

// POST /api/v1/bookings/hold
type HoldRequest struct {
	EventID    string   `json:"event_id"`
	SeatIDs    []string `json:"seat_ids"`
	Tier       string   `json:"tier,omitempty"`
	Quantity   int      `json:"quantity,omitempty"`
	QueueToken string   `json:"queue_token"`
}

// Money crosses the wire as integer minor units with an explicit currency.
// A JSON number is an IEEE 754 double in most clients, so a "total": 150.00
// is one bad round-trip away from 149.99999999999997.
type HoldResponse struct {
	HoldID        string     `json:"hold_id"`
	Seats         []SeatView `json:"seats"`
	SubtotalCents int64      `json:"subtotal_cents"`
	FeeCents      int64      `json:"fee_cents"`
	TotalCents    int64      `json:"total_cents"`
	Currency      string     `json:"currency"` // ISO 4217, e.g. USD
	ExpiresAt     time.Time  `json:"expires_at"`
}

// POST /api/v1/bookings/confirm { "hold_id": "...", "payment_method_id": "..." }
// Confirming is idempotent on hold_id: retrying a confirm that already
// succeeded returns the original booking rather than charging a second time.
// POST /api/v1/bookings/{id}/transfer { "recipient_email": "..." }

// ========== Resale Marketplace ==========
// POST /api/v1/resale/list { "ticket_id": "...", "asking_price_cents": 15000 }
// GET /api/v1/resale?event_id=...&max_price_cents=20000
// POST /api/v1/resale/{listing_id}/buy
```

---
