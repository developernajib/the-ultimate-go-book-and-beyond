package orderbook_test

import (
	"testing"

	"github.com/example/trading-system/internal/orderbook"
	"github.com/example/trading-system/pkg/types"
)

func newOrder(id string, side types.Side, price, qty float64) *types.Order {
	o := &types.Order{
		ID:       types.OrderID(id),
		Symbol:   "BTC/USD",
		Side:     side,
		Type:     types.OrderTypeLimit,
		Price:    types.NewPrice(price),
		Quantity: types.NewQuantity(qty),
	}
	o.RemainingQty = o.Quantity
	return o
}

func TestAddAndGetBestBid(t *testing.T) {
	ob := orderbook.NewOrderBook("BTC/USD")

	if err := ob.AddOrder(newOrder("o1", types.SideBuy, 100.0, 1.0)); err != nil {
		t.Fatalf("AddOrder: %v", err)
	}
	if err := ob.AddOrder(newOrder("o2", types.SideBuy, 101.0, 2.0)); err != nil {
		t.Fatalf("AddOrder: %v", err)
	}

	price, qty, ok := ob.GetBestBid()
	if !ok {
		t.Fatal("expected best bid to exist")
	}
	_ = price
	_ = qty
}

func TestDuplicateOrderReturnsError(t *testing.T) {
	ob := orderbook.NewOrderBook("BTC/USD")
	order := newOrder("dup", types.SideBuy, 100.0, 1.0)

	if err := ob.AddOrder(order); err != nil {
		t.Fatalf("first AddOrder: %v", err)
	}
	if err := ob.AddOrder(order); err == nil {
		t.Error("expected error for duplicate order, got nil")
	}
}

func TestRemoveOrder(t *testing.T) {
	ob := orderbook.NewOrderBook("BTC/USD")
	order := newOrder("r1", types.SideSell, 200.0, 0.5)

	if err := ob.AddOrder(order); err != nil {
		t.Fatalf("AddOrder: %v", err)
	}

	removed, err := ob.RemoveOrder(order.ID)
	if err != nil {
		t.Fatalf("RemoveOrder: %v", err)
	}
	if removed.ID != order.ID {
		t.Errorf("removed wrong order: got %s, want %s", removed.ID, order.ID)
	}
}

func TestRemoveNonExistentOrderReturnsError(t *testing.T) {
	ob := orderbook.NewOrderBook("BTC/USD")
	_, err := ob.RemoveOrder("ghost")
	if err == nil {
		t.Error("expected error removing non-existent order, got nil")
	}
}

func TestGetMidPrice(t *testing.T) {
	ob := orderbook.NewOrderBook("BTC/USD")
	ob.AddOrder(newOrder("b1", types.SideBuy, 100.0, 1.0))
	ob.AddOrder(newOrder("a1", types.SideSell, 102.0, 1.0))

	_, ok := ob.GetMidPrice()
	if !ok {
		t.Fatal("expected mid price to be available")
	}
}
