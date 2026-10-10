## API Design

The API layer defines the contract between the mobile apps (rider and driver) and the backend services. It uses REST endpoints for request-response interactions like requesting a ride or fetching trip details, and WebSocket connections for real-time location streaming in both directions. Each request and response struct is kept focused on what the client actually needs, for example, the rider does not need to know the driver's internal scoring data, only their name, rating, vehicle, and ETA.

Two decisions in this contract are worth defending, because both are places where the obvious choice is wrong.

Money crosses the wire as integer cents, never as a JSON number with a decimal point. JSON has no decimal type, so `"estimated_fare": 12.30` is a double on both ends, and every client language will eventually render it as 12.299999999999999 or round it inconsistently. Sending `"estimated_fare_cents": 1230` makes the value exact and the unit explicit, and it costs nothing.

Ride requests carry a client-generated idempotency key. A rider on a subway platform taps "Request", loses signal, and the app retries. Without a key, that rider now has two trips and two drivers en route. The key makes the retry return the original trip instead of booking a second one, and it has to come from the client because only the client knows the two attempts were one intent.

```go
package api

import "time"

// POST /api/v1/rides/estimate
type RideEstimateReq struct {
	PickupLat float64 `json:"pickup_lat"`; PickupLng float64 `json:"pickup_lng"`
	DropoffLat float64 `json:"dropoff_lat"`; DropoffLng float64 `json:"dropoff_lng"`
	RideType string `json:"ride_type"`
}

// Money is int64 minor units end to end. A JSON float here would be a double
// on the client and would not survive the round trip exactly.
type RideOption struct {
	RideType string `json:"ride_type"`; PriceMinCents int64 `json:"price_min_cents"`
	PriceMaxCents int64 `json:"price_max_cents"`; EtaMinutes float64 `json:"eta_minutes"`
	Surge float64 `json:"surge_multiplier"`; Currency string `json:"currency"`
}

// POST /api/v1/rides/request
// Header: Idempotency-Key: <client-generated UUID, stable across retries>
type RideRequestReq struct {
	PickupLat float64 `json:"pickup_lat"`; PickupLng float64 `json:"pickup_lng"`
	DropoffLat float64 `json:"dropoff_lat"`; DropoffLng float64 `json:"dropoff_lng"`
	RideType string `json:"ride_type"`
	// QuotedFareCents is the estimate the rider actually saw and accepted.
	// The server re-prices and rejects the request if surge moved materially,
	// so a stale quote fails loudly instead of silently billing more.
	QuotedFareCents int64 `json:"quoted_fare_cents"`
}

type RideRequestResp struct {
	TripID string `json:"trip_id"`; DriverID string `json:"driver_id"`
	DriverName string `json:"driver_name"`; DriverRating float64 `json:"driver_rating"`
	Vehicle string `json:"vehicle_info"`; EtaMinutes float64 `json:"eta_minutes"`
	EstimatedFareCents int64 `json:"estimated_fare_cents"`; Surge float64 `json:"surge_multiplier"`
	Currency string `json:"currency"`
}

// GET /api/v1/rides/{trip_id}
type TripDetail struct {
	TripID string `json:"trip_id"`; Status string `json:"status"`
	DriverLat float64 `json:"driver_lat"`; DriverLng float64 `json:"driver_lng"`
	EtaMinutes float64 `json:"eta_minutes"`
	FinalPriceCents *int64 `json:"final_price_cents,omitempty"` // nil until completed
	Currency string `json:"currency"`
	RequestedAt time.Time `json:"requested_at"`
}

// Rider WebSocket: wss://{host}/ws/trip/{trip_id}
// Pushes the driver's position as it arrives. The server cannot stream fresher
// than drivers report, which is every 4s, so this is not a 2s feed. Clients
// interpolate between fixes to animate the car smoothly.
type LocationUpdate struct {
	DriverLat float64 `json:"driver_lat"`; DriverLng float64 `json:"driver_lng"`
	Heading float32 `json:"heading"`; EtaMinutes float64 `json:"eta_minutes"`
}

// Driver WebSocket: wss://{host}/ws/driver (location every 4s)
// This is a WebSocket frame, not a POST. At 1.25M updates/sec, a fresh HTTP
// request per fix would spend more on headers and handshakes than on payload.
type DriverLocUpdate struct {
	Lat float64 `json:"lat"`; Lng float64 `json:"lng"`; Status string `json:"status"`
	// Device clock time of the fix. Updates arrive out of order over
	// reconnects, and without this the server cannot tell a delayed old fix
	// from a new one, so it would happily move a driver backwards.
	FixedAt time.Time `json:"fixed_at"`
}
```

---
