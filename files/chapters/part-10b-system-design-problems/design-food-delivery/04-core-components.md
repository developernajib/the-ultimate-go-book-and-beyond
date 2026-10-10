## Core Components

### 1. Order Service

The Order Service is the central orchestrator of the entire platform. It manages the full lifecycle of an order, from placement through payment capture to delivery confirmation. The key design here is the order state machine: every order moves through a strict sequence of states, and only valid transitions are allowed. This prevents bugs like charging a customer for an order that was never confirmed, or dispatching a driver to a restaurant that rejected the order.

```go
package order

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Restaurant struct {
	Location Address
}

type PaymentResult struct{}

type ChargeRequest struct {
	IdempotencyKey  string
	CustomerID      string
	Amount          int64
	Currency        string
	PaymentMethodID string
}

type PaymentService interface {
	Charge(ctx context.Context, req ChargeRequest) (*PaymentResult, error)
	ReleaseFunds(ctx context.Context, orderID string) error
}

type DispatchService interface {
	FindDriver(ctx context.Context, order *Order)
}

type RestaurantService interface {
	ValidateAndPriceItems(ctx context.Context, restaurantID string, items []OrderItemRequest) ([]OrderItem, int64, error)
	GetRestaurant(ctx context.Context, id string) (*Restaurant, error)
	EstimatePrepTime(ctx context.Context, restaurantID string) time.Duration
}

type NotificationService interface {
	NotifyDriver(ctx context.Context, driverID string, message string)
	NotifyCustomer(ctx context.Context, customerID string, message string)
	RequestReview(ctx context.Context, order *Order)
}

type EventProducer interface {
	Publish(ctx context.Context, topic string, key string, payload any) error
}

// OrderService manages the order lifecycle
type OrderService struct {
	db          *pgxpool.Pool
	paymentSvc  PaymentService
	dispatchSvc DispatchService
	restaurantSvc RestaurantService
	notifier    NotificationService
	kafka       EventProducer
}

// Order represents a food delivery order
type Order struct {
	ID             string     `json:"id"`
	CustomerID     string     `json:"customer_id"`
	RestaurantID   string     `json:"restaurant_id"`
	DriverID       string     `json:"driver_id,omitempty"`
	Items          []OrderItem `json:"items"`
	Status         string     `json:"status"`
	SubTotal       int64      `json:"subtotal"`     // cents
	DeliveryFee    int64      `json:"delivery_fee"` // cents
	ServiceFee     int64      `json:"service_fee"`  // cents
	Tax            int64      `json:"tax"`          // cents
	TotalPrice     int64      `json:"total_price"`  // cents
	DeliveryAddress Address   `json:"delivery_address"`
	SpecialInstructions string `json:"special_instructions"`
	EstimatedPickup time.Time  `json:"estimated_pickup"`
	EstimatedDelivery time.Time `json:"estimated_delivery"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

// OrderItem is a single menu item in an order
type OrderItem struct {
	MenuItemID  string  `json:"menu_item_id"`
	Name        string  `json:"name"`
	Quantity    int     `json:"quantity"`
	Price       int64   `json:"price"` // cents
	Customizations []string `json:"customizations"` // extra cheese, no onions
}

// Address is a delivery location
type Address struct {
	Street  string  `json:"street"`
	City    string  `json:"city"`
	ZipCode string  `json:"zip_code"`
	Lat     float64 `json:"lat"`
	Lng     float64 `json:"lng"`
}

// OrderStatus state machine
const (
	StatusPending          = "pending"           // order placed, awaiting payment
	StatusConfirmed        = "confirmed"         // payment captured
	StatusSentToRestaurant = "sent_to_restaurant" // restaurant notified
	StatusRestaurantAccepted = "restaurant_accepted" // restaurant confirmed
	StatusPreparing        = "preparing"         // food being prepared
	StatusReadyForPickup   = "ready_for_pickup"  // food ready, waiting driver
	StatusDriverAssigned   = "driver_assigned"   // driver en route to restaurant
	StatusPickedUp         = "picked_up"         // driver has food
	StatusDelivered        = "delivered"         // order complete
	StatusCanceled        = "canceled"
)

// PlaceOrder handles new order placement
func (s *OrderService) PlaceOrder(ctx context.Context, req PlaceOrderRequest) (*Order, error) {
	// 1. Validate items and calculate totals
	items, subtotal, err := s.restaurantSvc.ValidateAndPriceItems(ctx, req.RestaurantID, req.Items)
	if err != nil {
		return nil, fmt.Errorf("validate items: %w", err)
	}

	// 2. Calculate delivery fee (based on distance)
	restaurant, err := s.restaurantSvc.GetRestaurant(ctx, req.RestaurantID)
	if err != nil {
		return nil, err
	}

	deliveryFee := calculateDeliveryFee(restaurant.Location, req.DeliveryAddress, req.SurgeMultiplier)
	serviceFee := subtotal * 15 / 100          // 15%, integer cents
	tax := (subtotal + deliveryFee) * 8 / 100 // 8%, integer cents
	totalPrice := subtotal + deliveryFee + serviceFee + tax

	// 3. Estimate times
	prepTime := s.restaurantSvc.EstimatePrepTime(ctx, req.RestaurantID)
	travelTime := estimateTravelTime(restaurant.Location, req.DeliveryAddress)

	order := &Order{
		ID:           uuid.New().String(),
		CustomerID:   req.CustomerID,
		RestaurantID: req.RestaurantID,
		Items:        items,
		Status:       StatusPending,
		SubTotal:     subtotal,
		DeliveryFee:  deliveryFee,
		ServiceFee:   serviceFee,
		Tax:          tax,
		TotalPrice:   totalPrice,
		DeliveryAddress: req.DeliveryAddress,
		SpecialInstructions: req.SpecialInstructions,
		EstimatedPickup:  time.Now().Add(prepTime),
		EstimatedDelivery: time.Now().Add(prepTime + travelTime),
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}

	// 4. Save order
	if err := s.saveOrder(ctx, order); err != nil {
		return nil, fmt.Errorf("save order: %w", err)
	}

	// 5. Process payment
	if _, err := s.paymentSvc.Charge(ctx, ChargeRequest{
		IdempotencyKey:  "order-" + order.ID,
		CustomerID:      req.CustomerID,
		Amount:          totalPrice, // already in cents
		Currency:        "USD",
		PaymentMethodID: req.PaymentMethodID,
	}); err != nil {
		s.updateOrderStatus(ctx, order.ID, StatusCanceled)
		return nil, fmt.Errorf("payment failed: %w", err)
	}

	order.Status = StatusConfirmed
	s.updateOrderStatus(ctx, order.ID, StatusConfirmed)

	// 6. Send to restaurant
	go s.notifyRestaurant(ctx, order)

	// 7. Begin dispatch (find driver)
	go s.dispatchSvc.FindDriver(ctx, order)

	// 8. Publish order event
	s.kafka.Publish(ctx, "order-events", order.ID, order)

	return order, nil
}

// UpdateStatus processes an order status transition
func (s *OrderService) UpdateStatus(ctx context.Context, orderID, newStatus, actorID string) error {
	order, err := s.getOrder(ctx, orderID)
	if err != nil {
		return err
	}

	if !isValidTransition(order.Status, newStatus) {
		return fmt.Errorf("invalid transition: %s → %s", order.Status, newStatus)
	}

	order.Status = newStatus
	order.UpdatedAt = time.Now()

	if err := s.updateOrderStatus(ctx, orderID, newStatus); err != nil {
		return err
	}

	// Trigger downstream actions
	switch newStatus {
	case StatusReadyForPickup:
		s.notifier.NotifyDriver(ctx, order.DriverID, "Order is ready for pickup")
	case StatusPickedUp:
		s.notifier.NotifyCustomer(ctx, order.CustomerID, "Your food is on the way!")
	case StatusDelivered:
		s.triggerPostDelivery(ctx, order)
	}

	// Broadcast status update to tracking WebSocket
	s.kafka.Publish(ctx, "order-status-updates", orderID, map[string]any{
		"order_id": orderID,
		"status":   newStatus,
		"updated_at": order.UpdatedAt,
	})

	return nil
}

// triggerPostDelivery handles actions after order completion
func (s *OrderService) triggerPostDelivery(ctx context.Context, order *Order) {
	// Release payment to restaurant (after delivery window)
	go func() {
		time.Sleep(1 * time.Hour) // T+1h: release funds
		s.paymentSvc.ReleaseFunds(ctx, order.ID)
	}()

	// Request review
	go s.notifier.RequestReview(ctx, order)
}

func isValidTransition(current, next string) bool {
	transitions := map[string][]string{
		StatusPending:            {StatusConfirmed, StatusCanceled},
		StatusConfirmed:          {StatusSentToRestaurant, StatusCanceled},
		StatusSentToRestaurant:   {StatusRestaurantAccepted, StatusCanceled},
		StatusRestaurantAccepted: {StatusPreparing, StatusCanceled},
		StatusPreparing:          {StatusReadyForPickup, StatusCanceled},
		StatusReadyForPickup:     {StatusDriverAssigned},
		StatusDriverAssigned:     {StatusPickedUp, StatusCanceled},
		StatusPickedUp:           {StatusDelivered},
	}
	allowed := transitions[current]
	for _, s := range allowed {
		if s == next {
			return true
		}
	}
	return false
}

func calculateDeliveryFee(restaurantLoc, deliveryAddr Address, surgeMultiplier float64) int64 {
	dist := haversineKm(restaurantLoc.Lat, restaurantLoc.Lng, deliveryAddr.Lat, deliveryAddr.Lng)
	baseFee := 299 + dist*50 // $2.99 base + $0.50/km, in cents
	return int64(baseFee * surgeMultiplier)
}

type PlaceOrderRequest struct {
	CustomerID          string
	RestaurantID        string
	Items               []OrderItemRequest
	DeliveryAddress     Address
	PaymentMethodID     string
	SpecialInstructions string
	SurgeMultiplier     float64
}

type OrderItemRequest struct {
	MenuItemID     string
	Quantity       int
	Customizations []string
}

func (s *OrderService) saveOrder(ctx context.Context, order *Order) error { return nil }
func (s *OrderService) updateOrderStatus(ctx context.Context, orderID, status string) error { return nil }
func (s *OrderService) notifyRestaurant(ctx context.Context, order *Order) {}
func (s *OrderService) getOrder(ctx context.Context, orderID string) (*Order, error) { return &Order{}, nil }

func estimateTravelTime(origin, dest Address) time.Duration {
	dist := haversineKm(origin.Lat, origin.Lng, dest.Lat, dest.Lng)
	return time.Duration(dist/30.0*60) * time.Minute
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

### 2. Dispatch Service

The Dispatch Service solves the core matching problem: which driver should deliver which order. It uses a two-phase approach where nearby drivers are first found using Redis GEO spatial queries, then scored on a weighted combination of proximity, rating, and acceptance rate. The winning driver receives a time-limited offer and must actively accept it. If the driver declines or the offer times out, the system moves to the next best candidate. This approach prevents wasted time from unresponsive drivers and ensures orders get picked up quickly.

```go
package dispatch

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
)

type Order struct {
	ID           string
	CustomerID   string
	RestaurantID string
}

type Location struct {
	Lat float64
	Lng float64
}

type LocationService interface {
	FindNearbyDrivers(ctx context.Context, lat, lng float64, radiusMeters float64, limit int) ([]NearbyDriver, error)
}

type OrderUpdater interface {
	UpdateStatus(ctx context.Context, orderID, status, driverID string) error
}

type NotificationService interface {
	NotifyCustomer(ctx context.Context, customerID string, message string)
	NotifyDriver(ctx context.Context, driverID string, message string, order *Order)
}

// DispatchService assigns drivers to orders
type DispatchService struct {
	rdb        *redis.ClusterClient
	locationSvc LocationService
	orderSvc   OrderUpdater
	notifier   NotificationService
}

// DriverStatus represents a driver's availability
type DriverStatus struct {
	DriverID   string
	Lat        float64
	Lng        float64
	Status     string    // available, on_delivery, offline
	Rating     float64
	VehicleType string   // bike, car, scooter
}

// FindDriver finds the best available driver for an order
func (s *DispatchService) FindDriver(ctx context.Context, order *Order) {
	restaurant, err := s.getRestaurantLocation(ctx, order.RestaurantID)
	if err != nil {
		return
	}

	maxAttempts := 3
	radiusKm := 2.0

	for attempt := 0; attempt < maxAttempts; attempt++ {
		// Find nearby available drivers
		drivers, err := s.locationSvc.FindNearbyDrivers(ctx, restaurant.Lat, restaurant.Lng, radiusKm*1000, 20)
		if err != nil || len(drivers) == 0 {
			radiusKm *= 2 // expand radius
			time.Sleep(30 * time.Second) // wait before retry
			continue
		}

		// Score drivers
		best := s.selectBestDriver(ctx, drivers, order, restaurant)
		if best == nil {
			radiusKm *= 2
			continue
		}

		// Offer order to driver (driver has 30s to accept)
		accepted, err := s.offerOrderToDriver(ctx, best.DriverID, order, 30*time.Second)
		if err != nil || !accepted {
			// Mark driver as temporarily busy (avoid re-offering)
			s.rdb.Set(ctx, fmt.Sprintf("driver:busy:%s", best.DriverID), "1", 2*time.Minute)
			continue
		}

		// Driver accepted - assign
		s.orderSvc.UpdateStatus(ctx, order.ID, "driver_assigned", best.DriverID)
		s.updateDriverStatus(ctx, best.DriverID, "on_delivery")
		s.notifier.NotifyCustomer(ctx, order.CustomerID,
			fmt.Sprintf("Driver assigned! ETA: %d minutes", int(best.DistanceKm/30*60)))
		return
	}

	// No driver found - escalate
	s.handleNoDriverFound(ctx, order)
}

// selectBestDriver scores and picks the optimal driver
func (s *DispatchService) selectBestDriver(ctx context.Context, drivers []NearbyDriver, order *Order, restaurant Location) *NearbyDriver {
	type scored struct {
		driver NearbyDriver
		score  float64
	}

	var candidates []scored
	for _, d := range drivers {
		// Check if driver is temporarily busy
		busyKey := fmt.Sprintf("driver:busy:%s", d.DriverID)
		if busy, _ := s.rdb.Exists(ctx, busyKey).Result(); busy > 0 {
			continue
		}

		// Score = proximity (60%) + rating (30%) + acceptance rate (10%)
		stats := s.getDriverStats(ctx, d.DriverID)
		score := (1.0/d.DistanceKm)*0.6 + stats.Rating*0.3 + stats.AcceptanceRate*0.1
		candidates = append(candidates, scored{d, score})
	}

	if len(candidates) == 0 {
		return nil
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].score > candidates[j].score
	})

	return &candidates[0].driver
}

// offerOrderToDriver sends offer to driver and waits for response
func (s *DispatchService) offerOrderToDriver(ctx context.Context, driverID string, order *Order, timeout time.Duration) (bool, error) {
	// Send offer via push notification
	s.notifier.NotifyDriver(ctx, driverID, "New delivery offer!", order)

	// Wait for driver response in Redis
	responseKey := fmt.Sprintf("dispatch:response:%s:%s", driverID, order.ID)
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		response, err := s.rdb.Get(ctx, responseKey).Result()
		if err == nil {
			s.rdb.Del(ctx, responseKey)
			return response == "accept", nil
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Timeout - driver didn't respond
	return false, fmt.Errorf("driver response timeout")
}

// RespondToOffer handles a driver's accept/decline
func (s *DispatchService) RespondToOffer(ctx context.Context, driverID, orderID, response string) error {
	key := fmt.Sprintf("dispatch:response:%s:%s", driverID, orderID)
	return s.rdb.Set(ctx, key, response, 1*time.Minute).Err()
}

func (s *DispatchService) updateDriverStatus(ctx context.Context, driverID, status string) {
	s.rdb.HSet(ctx, fmt.Sprintf("driver:status:%s", driverID), "status", status)
}

func (s *DispatchService) handleNoDriverFound(ctx context.Context, order *Order) {
	// Options: extend search radius, increase incentive, or cancel
	s.notifier.NotifyCustomer(ctx, order.CustomerID, "We're having trouble finding a driver. We'll keep trying.")
}

type NearbyDriver struct {
	DriverID   string
	DistanceKm float64
	Lat, Lng   float64
}

type DriverStats struct {
	Rating         float64
	AcceptanceRate float64
}

func (s *DispatchService) getRestaurantLocation(ctx context.Context, restaurantID string) (Location, error) {
	return Location{}, nil
}

func (s *DispatchService) getDriverStats(ctx context.Context, driverID string) DriverStats {
	return DriverStats{Rating: 4.8, AcceptanceRate: 0.9}
}
```

### 3. Real-Time Tracking

Real-time tracking is what turns a food delivery app from a simple ordering tool into an experience customers trust. The Tracking Service uses WebSockets to push live driver location updates to customers without the overhead of HTTP polling. When a driver's app sends a GPS update every 4 seconds, the service stores it in Redis and immediately broadcasts it to all WebSocket subscribers watching that order. Permission checks ensure only the customer and assigned driver can see tracking data for a given order.

```go
package tracking

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// TrackingService provides real-time order tracking via WebSocket
type TrackingService struct {
	subscribers map[string][]*client // orderID → connections
	mu          sync.RWMutex
	rdb         *redis.Client
	upgrader    websocket.Upgrader
}

// client wraps a WebSocket connection with a write mutex.
// gorilla/websocket does not allow concurrent writers, so every
// write must go through send.
type client struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

func (c *client) send(msg []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.WriteMessage(websocket.TextMessage, msg)
}

// LocationUpdate is a driver's position update
type LocationUpdate struct {
	OrderID   string  `json:"order_id"`
	DriverID  string  `json:"driver_id"`
	Lat       float64 `json:"lat"`
	Lng       float64 `json:"lng"`
	Speed     float32 `json:"speed"`
	Heading   float32 `json:"heading"`
	Timestamp int64   `json:"ts"`
}

// HandleDriverLocation processes location update from driver app
func (s *TrackingService) HandleDriverLocation(ctx context.Context, update LocationUpdate) error {
	// Store latest position
	key := fmt.Sprintf("driver:location:%s", update.DriverID)
	data, _ := json.Marshal(update)
	s.rdb.Set(ctx, key, data, 30*time.Second)

	// Broadcast to all subscribers of this order. Copy the slice
	// under the read lock, then write outside it so a slow client
	// cannot block subscription changes.
	s.mu.RLock()
	conns := append([]*client(nil), s.subscribers[update.OrderID]...)
	s.mu.RUnlock()

	if len(conns) == 0 {
		return nil
	}

	msg, _ := json.Marshal(map[string]any{
		"type":     "location",
		"driver_lat": update.Lat,
		"driver_lng": update.Lng,
		"heading":  update.Heading,
		"ts":       update.Timestamp,
	})

	for _, c := range conns {
		c.send(msg)
	}

	return nil
}

// HandleTrackingWebSocket sets up WebSocket for order tracking
func (s *TrackingService) HandleTrackingWebSocket(w http.ResponseWriter, r *http.Request) {
	orderID := r.PathValue("order_id")
	userID := r.Header.Get("X-User-ID")

	if !s.hasTrackingPermission(r.Context(), orderID, userID) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	cl := &client{conn: conn}

	s.mu.Lock()
	s.subscribers[orderID] = append(s.subscribers[orderID], cl)
	s.mu.Unlock()

	// Send current driver location immediately
	s.sendCurrentLocation(cl, orderID)

	// Wait for disconnect
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}

	// Cleanup
	s.mu.Lock()
	conns := s.subscribers[orderID]
	for i, c := range conns {
		if c == cl {
			s.subscribers[orderID] = append(conns[:i], conns[i+1:]...)
			break
		}
	}
	s.mu.Unlock()
	conn.Close()
}

func (s *TrackingService) sendCurrentLocation(cl *client, orderID string) {
	ctx := context.Background()
	// Get driver ID for this order
	driverID, err := s.rdb.HGet(ctx, fmt.Sprintf("order:%s", orderID), "driver_id").Result()
	if err != nil {
		return
	}

	data, err := s.rdb.Get(ctx, fmt.Sprintf("driver:location:%s", driverID)).Bytes()
	if err != nil {
		return
	}
	cl.send(data)
}

func (s *TrackingService) hasTrackingPermission(ctx context.Context, orderID, userID string) bool {
	if userID == "" {
		return false // missing header must never match a missing Redis field
	}
	// Check if user is customer or driver for this order
	customerID, _ := s.rdb.HGet(ctx, fmt.Sprintf("order:%s", orderID), "customer_id").Result()
	driverID, _ := s.rdb.HGet(ctx, fmt.Sprintf("order:%s", orderID), "driver_id").Result()
	return userID == customerID || userID == driverID
}
```

---
