## Deep Dive: ETA Prediction Engine

The ETA is the single most important number shown to the customer. Getting it wrong by even 5 minutes erodes trust. The prediction engine combines three independent time estimates: restaurant prep time (predicted by an ML model), driver travel to the restaurant, and restaurant-to-customer travel time. A critical insight is that driver travel and food preparation happen in parallel, so the total ETA uses the maximum of those two values rather than their sum.

```go
package eta

import (
	"context"
	"math"
	"time"
)

type RoutingAPIClient interface {
	GetRoute(ctx context.Context, req RouteRequest) (*RouteResponse, error)
}

type PredictPrepRequest struct {
	RestaurantID      string
	ItemCount         int
	ItemComplexity    float64
	CurrentQueueDepth int
	TimeOfDay         int
	DayOfWeek         int
	HistoricalAvg     float64
}

type PrepTimePredictor interface {
	PredictPrepTime(ctx context.Context, req PredictPrepRequest) (float64, float64)
}

type TrafficService interface {
	GetMultiplier(ctx context.Context, lat, lng float64) float64
}

type HistoricalETAStore interface {
	GetAvgError(ctx context.Context, restaurantID string, hour int) float64
}

// ETAService predicts delivery time using multiple signals
type ETAService struct {
	routingAPI   RoutingAPIClient   // Google Maps / OSRM
	mlPredictor  PrepTimePredictor  // ML model for restaurant prep time
	trafficSvc   TrafficService     // real-time traffic conditions
	historicalDB HistoricalETAStore // past ETA accuracy for calibration
}

// ETABreakdown provides transparent ETA components
type ETABreakdown struct {
	PrepTimeMinutes         float64 `json:"prep_time_minutes"`
	DriverToRestaurantMin   float64 `json:"driver_to_restaurant_min"`
	RestaurantToCustomerMin float64 `json:"restaurant_to_customer_min"`
	BufferMinutes           float64 `json:"buffer_minutes"`
	TotalMinutes            float64 `json:"total_minutes"`
	Confidence              float64 `json:"confidence"` // 0.0-1.0
}

// PredictETA calculates estimated delivery time
func (s *ETAService) PredictETA(ctx context.Context, req ETARequest) (*ETABreakdown, error) {
	// 1. Predict restaurant prep time using ML model
	prepTime, prepConfidence := s.mlPredictor.PredictPrepTime(ctx, PredictPrepRequest{
		RestaurantID:      req.RestaurantID,
		ItemCount:         req.ItemCount,
		ItemComplexity:    req.ItemComplexity, // custom items take longer
		CurrentQueueDepth: req.QueueDepth,     // orders ahead in kitchen
		TimeOfDay:         time.Now().Hour(),
		DayOfWeek:         int(time.Now().Weekday()),
		HistoricalAvg:     req.HistoricalPrepAvg,
	})

	// 2. Calculate driver-to-restaurant travel time
	driverToRestaurant := float64(0)
	if req.DriverLat != 0 {
		route, err := s.routingAPI.GetRoute(ctx, RouteRequest{
			OriginLat: req.DriverLat, OriginLng: req.DriverLng,
			DestLat: req.RestaurantLat, DestLng: req.RestaurantLng,
			DepartureTime: time.Now(),
		})
		if err == nil {
			driverToRestaurant = route.DurationMinutes
		}
	}

	// 3. Calculate restaurant-to-customer travel time
	route, err := s.routingAPI.GetRoute(ctx, RouteRequest{
		OriginLat: req.RestaurantLat, OriginLng: req.RestaurantLng,
		DestLat: req.CustomerLat, DestLng: req.CustomerLng,
		DepartureTime: time.Now().Add(time.Duration(prepTime) * time.Minute),
	})
	if err != nil {
		// Fallback: haversine distance / avg speed. The routing API
		// already accounts for live traffic, so the multiplier is
		// applied only on this traffic-blind estimate.
		dist := haversineKm(req.RestaurantLat, req.RestaurantLng,
			req.CustomerLat, req.CustomerLng)
		trafficMultiplier := s.trafficSvc.GetMultiplier(ctx, req.RestaurantLat, req.RestaurantLng)
		route = &RouteResponse{DurationMinutes: dist / 30.0 * 60 * trafficMultiplier} // 30km/h avg
	}

	// 4. Add buffer based on historical accuracy
	historicalError := s.historicalDB.GetAvgError(ctx, req.RestaurantID, time.Now().Hour())
	buffer := math.Max(2.0, historicalError*0.5) // min 2 min buffer

	breakdown := &ETABreakdown{
		PrepTimeMinutes:         prepTime,
		DriverToRestaurantMin:   driverToRestaurant,
		RestaurantToCustomerMin: route.DurationMinutes,
		BufferMinutes:           buffer,
		Confidence:              prepConfidence * 0.8,
	}
	// Key insight: driver travel to restaurant overlaps with prep time.
	// Total = max(prep_time, driver_to_restaurant) + restaurant_to_customer + buffer
	breakdown.TotalMinutes = math.Max(breakdown.PrepTimeMinutes, breakdown.DriverToRestaurantMin) +
		breakdown.RestaurantToCustomerMin +
		breakdown.BufferMinutes

	return breakdown, nil
}

type ETARequest struct {
	RestaurantID      string
	RestaurantLat     float64
	RestaurantLng     float64
	CustomerLat       float64
	CustomerLng       float64
	DriverLat         float64
	DriverLng         float64
	ItemCount         int
	ItemComplexity    float64
	QueueDepth        int
	HistoricalPrepAvg float64
}

type RouteRequest struct {
	OriginLat, OriginLng float64
	DestLat, DestLng     float64
	DepartureTime        time.Time
}

type RouteResponse struct {
	DurationMinutes float64
	DistanceKm      float64
}

func haversineKm(lat1, lng1, lat2, lng2 float64) float64 {
	const R = 6371.0
	dLat := (lat2 - lat1) * math.Pi / 180
	dLng := (lng2 - lng1) * math.Pi / 180
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*
			math.Sin(dLng/2)*math.Sin(dLng/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return R * c
}
```

---
