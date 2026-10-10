## Part 13: Testing and Benchmarking

Testing is critical for trading systems where bugs can cost millions. Beyond standard unit tests, trading systems require property-based tests to verify that the order book always maintains correct sorting and matching invariants, fuzz tests to ensure the system handles malformed inputs gracefully, and benchmark tests to confirm that performance targets are met under load. Every code change should be accompanied by benchmarks that prove latency has not regressed, because even a small performance degradation can make a profitable strategy unprofitable.

```go
// internal/orderbook/orderbook_test.go
package orderbook

import (
	"testing"
	"github.com/yourusername/trading-system/pkg/types"
)

func TestOrderBook_AddOrder(t *testing.T) {
	ob := NewOrderBook("BTC/USD")

	order := &types.Order{
		ID:       "order1",
		Symbol:   "BTC/USD",
		Side:     types.SideBuy,
		Type:     types.OrderTypeLimit,
		Price:    types.NewPrice(50000),
		Quantity: types.NewQuantity(1.0),
		RemainingQty: types.NewQuantity(1.0),
	}

	if err := ob.AddOrder(order); err != nil {
		t.Fatalf("Failed to add order: %v", err)
	}

	bidPrice, bidSize, ok := ob.GetBestBid()
	if !ok {
		t.Fatal("Expected best bid to exist")
	}

	if bidPrice != order.Price {
		t.Errorf("Expected bid price %v, got %v", order.Price, bidPrice)
	}

	if bidSize != order.Quantity {
		t.Errorf("Expected bid size %v, got %v", order.Quantity, bidSize)
	}
}

func TestOrderBook_Match(t *testing.T) {
	ob := NewOrderBook("BTC/USD")

	// Add resting limit order
	restingOrder := &types.Order{
		ID:           "order1",
		Symbol:       "BTC/USD",
		Side:         types.SideBuy,
		Type:         types.OrderTypeLimit,
		Price:        types.NewPrice(50000),
		Quantity:     types.NewQuantity(1.0),
		RemainingQty: types.NewQuantity(1.0),
	}

	ob.AddOrder(restingOrder)

	// Match with aggressive sell order
	aggressiveOrder := &types.Order{
		ID:           "order2",
		Symbol:       "BTC/USD",
		Side:         types.SideSell,
		Type:         types.OrderTypeMarket,
		Quantity:     types.NewQuantity(0.5),
		RemainingQty: types.NewQuantity(0.5),
	}

	fills, remaining, err := ob.Match(aggressiveOrder)
	if err != nil {
		t.Fatalf("Match failed: %v", err)
	}

	if len(fills) != 1 {
		t.Fatalf("Expected 1 fill, got %d", len(fills))
	}

	if fills[0].Quantity != types.NewQuantity(0.5) {
		t.Errorf("Expected fill quantity 0.5, got %v", fills[0].Quantity)
	}

	if remaining != 0 {
		t.Errorf("Expected no remaining quantity, got %v", remaining)
	}

	// Check resting order updated
	bidPrice, bidSize, ok := ob.GetBestBid()
	if !ok {
		t.Fatal("Expected best bid to still exist")
	}

	if bidSize != types.NewQuantity(0.5) {
		t.Errorf("Expected remaining bid size 0.5, got %v", bidSize)
	}
}

func TestOrderBook_PriceTimePriority(t *testing.T) {
	ob := NewOrderBook("BTC/USD")

	// Add three orders at same price
	order1 := &types.Order{
		ID:           "order1",
		Symbol:       "BTC/USD",
		Side:         types.SideBuy,
		Type:         types.OrderTypeLimit,
		Price:        types.NewPrice(50000),
		Quantity:     types.NewQuantity(1.0),
		RemainingQty: types.NewQuantity(1.0),
	}

	order2 := &types.Order{
		ID:           "order2",
		Symbol:       "BTC/USD",
		Side:         types.SideBuy,
		Type:         types.OrderTypeLimit,
		Price:        types.NewPrice(50000),
		Quantity:     types.NewQuantity(1.0),
		RemainingQty: types.NewQuantity(1.0),
	}

	ob.AddOrder(order1)
	ob.AddOrder(order2)

	// Match should fill order1 first (time priority)
	aggressiveOrder := &types.Order{
		ID:           "order3",
		Symbol:       "BTC/USD",
		Side:         types.SideSell,
		Type:         types.OrderTypeMarket,
		Quantity:     types.NewQuantity(1.0),
		RemainingQty: types.NewQuantity(1.0),
	}

	fills, _, _ := ob.Match(aggressiveOrder)

	if fills[0].OrderID != "order1" {
		t.Errorf("Expected order1 to be filled first, got %v", fills[0].OrderID)
	}
}

// Benchmark order book operations
func BenchmarkOrderBook_AddOrder(b *testing.B) {
	ob := NewOrderBook("BTC/USD")

	b.ResetTimer()
	for b.Loop() {
		order := &types.Order{
			ID:           types.OrderID(fmt.Sprintf("order%d", i)),
			Symbol:       "BTC/USD",
			Side:         types.SideBuy,
			Type:         types.OrderTypeLimit,
			Price:        types.NewPrice(50000 + float64(i%100)),
			Quantity:     types.NewQuantity(1.0),
			RemainingQty: types.NewQuantity(1.0),
		}
		ob.AddOrder(order)
	}
}

func BenchmarkOrderBook_Match(b *testing.B) {
	ob := NewOrderBook("BTC/USD")

	// Pre-populate order book
	for i := 0; i < 1000; i++ {
		order := &types.Order{
			ID:           types.OrderID(fmt.Sprintf("order%d", i)),
			Symbol:       "BTC/USD",
			Side:         types.SideBuy,
			Type:         types.OrderTypeLimit,
			Price:        types.NewPrice(50000 - float64(i)),
			Quantity:     types.NewQuantity(1.0),
			RemainingQty: types.NewQuantity(1.0),
		}
		ob.AddOrder(order)
	}

	b.ResetTimer()
	for b.Loop() {
		order := &types.Order{
			ID:           types.OrderID(fmt.Sprintf("market%d", i)),
			Symbol:       "BTC/USD",
			Side:         types.SideSell,
			Type:         types.OrderTypeMarket,
			Quantity:     types.NewQuantity(0.1),
			RemainingQty: types.NewQuantity(0.1),
		}
		ob.Match(order)
	}
}

func BenchmarkOrderBook_GetQuote(b *testing.B) {
	ob := NewOrderBook("BTC/USD")

	// Add orders
	buyOrder := &types.Order{
		ID:           "buy1",
		Symbol:       "BTC/USD",
		Side:         types.SideBuy,
		Type:         types.OrderTypeLimit,
		Price:        types.NewPrice(50000),
		Quantity:     types.NewQuantity(1.0),
		RemainingQty: types.NewQuantity(1.0),
	}

	sellOrder := &types.Order{
		ID:           "sell1",
		Symbol:       "BTC/USD",
		Side:         types.SideSell,
		Type:         types.OrderTypeLimit,
		Price:        types.NewPrice(50100),
		Quantity:     types.NewQuantity(1.0),
		RemainingQty: types.NewQuantity(1.0),
	}

	ob.AddOrder(buyOrder)
	ob.AddOrder(sellOrder)

	b.ResetTimer()
	for b.Loop() {
		ob.GetQuote()
	}
}
```

### Integration Tests

The integration tests wire up the full order matching engine, submit a sequence of limit and market orders, and verify that fills, partial fills, and order book state updates are correct.

```go
// internal/integration_test.go
package integration

import (
	"context"
	"testing"
	"time"

	"github.com/yourusername/trading-system/internal/orders"
	"github.com/yourusername/trading-system/internal/risk"
	"github.com/yourusername/trading-system/pkg/types"
)

func TestEndToEndOrderFlow(t *testing.T) {
	// Setup
	ctx := context.Background()
	orderManager := orders.NewManager()
	riskManager := risk.NewManager(&risk.Config{
		EnablePreTradeRisk: true,
		MaxOrderSize:       types.NewQuantity(100),
	})

	// Create account
	account := riskManager.CreateAccount("test-account", types.NewPrice(100000))

	// Start managers
	orderManager.Start()
	defer orderManager.Stop()

	// Submit order
	order := &types.Order{
		AccountID:    account.ID,
		Symbol:       "BTC/USD",
		Side:         types.SideBuy,
		Type:         types.OrderTypeLimit,
		Price:        types.NewPrice(50000),
		Quantity:     types.NewQuantity(1.0),
		TimeInForce:  types.TimeInForceGTC,
	}

	// Risk check
	riskCheck := riskManager.CheckOrder(order)
	if !riskCheck.Passed {
		t.Fatalf("Risk check failed: %v", riskCheck.Violations)
	}

	// Submit order
	if err := orderManager.SubmitOrder(order); err != nil {
		t.Fatalf("Failed to submit order: %v", err)
	}

	// Simulate fill
	fill := &types.Fill{
		OrderID:   order.ID,
		Symbol:    order.Symbol,
		Side:      order.Side,
		Price:     order.Price,
		Quantity:  order.Quantity,
		Timestamp: time.Now(),
		IsMaker:   true,
	}

	// Update position
	if err := riskManager.UpdatePosition(account.ID, fill); err != nil {
		t.Fatalf("Failed to update position: %v", err)
	}

	// Verify position
	updatedAccount, _ := riskManager.GetAccount(account.ID)
	position, exists := updatedAccount.Positions[order.Symbol]

	if !exists {
		t.Fatal("Expected position to exist")
	}

	if position.Quantity != order.Quantity {
		t.Errorf("Expected position quantity %v, got %v", order.Quantity, position.Quantity)
	}
}
```
