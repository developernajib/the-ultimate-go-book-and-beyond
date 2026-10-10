## API Design

### REST Endpoints

The API is organized around the three user types: customers, restaurants, and drivers. Each endpoint group uses different authentication mechanisms (bearer tokens for customers and drivers, API keys for restaurants) and different rate limits based on expected usage patterns. Notice how the API enforces business rules at the endpoint level, such as only allowing cancellation before the "preparing" status. These endpoints form the contract between your frontend apps and backend services.

```go
package api

// ========== Customer-Facing APIs ==========

// POST /api/v1/orders
// Request: PlaceOrderRequest (defined above)
// Response: Order
// Auth: Bearer token (customer)
// Rate limit: 5 req/min per customer

// GET /api/v1/orders/{order_id}
// Response: Order with full details
// Auth: Bearer token (customer or driver assigned to order)

// GET /api/v1/orders?status=active&page=1&limit=10
// Response: paginated list of customer's orders

// POST /api/v1/orders/{order_id}/cancel
// Request: { "reason": "changed_mind" }
// Response: { "refund_amount": 3500, "refund_eta": "3-5 business days" }  // amount in cents
// Auth: Bearer token (customer), only if status < preparing

// POST /api/v1/orders/{order_id}/rate
// Request: RateOrderRequest
// Response: 204 No Content

type RateOrderRequest struct {
	FoodRating     int     `json:"food_rating" validate:"required,min=1,max=5"`
	DeliveryRating int     `json:"delivery_rating" validate:"required,min=1,max=5"`
	Comment        string  `json:"comment" validate:"max=500"`
	TipAmount      int64   `json:"tip_amount" validate:"min=0"` // cents
}

// ========== Restaurant-Facing APIs ==========

// GET /api/v1/restaurants/{restaurant_id}/orders?status=pending
// Response: list of incoming orders for the restaurant tablet
// Auth: Restaurant API key

// PUT /api/v1/restaurants/{restaurant_id}/orders/{order_id}/accept
// Request: { "estimated_prep_minutes": 25 }
// Response: 200 OK

// PUT /api/v1/restaurants/{restaurant_id}/orders/{order_id}/ready
// Response: 200 OK (triggers driver notification)

// PUT /api/v1/restaurants/{restaurant_id}/menu
// Request: MenuUpdateRequest (bulk menu item updates)
// Response: 200 OK

type MenuUpdateRequest struct {
	Items []MenuItemUpdate `json:"items"`
}

type MenuItemUpdate struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Price       int64   `json:"price"` // cents
	Available   bool    `json:"available"`
	PrepTimeMin int     `json:"prep_time_min"`
	Category    string  `json:"category"`
	ImageURL    string  `json:"image_url"`
}

// ========== Driver-Facing APIs ==========

// POST /api/v1/drivers/{driver_id}/location
// Request: LocationUpdate (lat, lng, speed, heading)
// Response: 204 No Content
// Rate: every 4 seconds while on delivery

// POST /api/v1/drivers/{driver_id}/offers/{order_id}/respond
// Request: { "action": "accept" or "decline" }
// Response: 200 OK with order details if accepted

// POST /api/v1/drivers/{driver_id}/orders/{order_id}/picked-up
// Response: 200 OK (triggers customer notification)

// POST /api/v1/drivers/{driver_id}/orders/{order_id}/delivered
// Request: { "delivery_photo_url": "s3://..." }
// Response: 200 OK

// GET /api/v1/drivers/{driver_id}/earnings?period=weekly
// Response: EarningsResponse

type EarningsResponse struct {
	Period        string  `json:"period"`
	TotalEarnings int64   `json:"total_earnings"` // cents
	TotalTips     int64   `json:"total_tips"`     // cents
	Deliveries    int     `json:"deliveries"`
	OnlineHours   float64 `json:"online_hours"`
	PerHourAvg    int64   `json:"per_hour_avg"` // cents per hour
}

// ========== Search & Discovery APIs ==========

// GET /api/v1/restaurants?lat=37.77&lng=-122.41&radius_km=5&cuisine=italian&sort=rating
// Response: paginated list of nearby restaurants

// GET /api/v1/restaurants/{restaurant_id}/menu
// Response: full menu with categories, items, prices, availability

type RestaurantSearchResponse struct {
	Restaurants []RestaurantSummary `json:"restaurants"`
	Total       int                 `json:"total"`
	Page        int                 `json:"page"`
	HasMore     bool                `json:"has_more"`
}

type RestaurantSummary struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	CuisineType  string   `json:"cuisine_type"`
	Rating       float64  `json:"rating"`
	ReviewCount  int      `json:"review_count"`
	DeliveryFee  int64    `json:"delivery_fee"` // cents
	DeliveryTime string   `json:"delivery_time"` // "25-35 min"
	DistanceKm   float64  `json:"distance_km"`
	ImageURL     string   `json:"image_url"`
	IsOpen       bool     `json:"is_open"`
	Tags         []string `json:"tags"` // "Free Delivery", "Top Rated"
}
```

---
