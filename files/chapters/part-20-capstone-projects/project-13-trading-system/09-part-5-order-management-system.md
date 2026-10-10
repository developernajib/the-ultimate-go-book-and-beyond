## Part 5: Order Management System

The Order Management System (OMS) handles order lifecycle, routing, and tracking. Think of the OMS as the central coordinator that knows the state of every order in the system, from the moment a strategy submits it until it is fully filled, canceled, or rejected. It validates incoming orders, passes them through risk checks, routes them to the appropriate exchange or internal matching engine, and publishes status updates so that other components can react. A well-designed OMS must be thread-safe and highly available, because losing track of even a single order can lead to significant financial exposure.

```go
// internal/orders/manager.go
package orders

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/yourusername/trading-system/pkg/types"
	"github.com/yourusername/trading-system/pkg/pool"
	"github.com/yourusername/trading-system/internal/orderbook"
)

// Manager manages order lifecycle
type Manager struct {
	orders     map[types.OrderID]*types.Order
	byAccount  map[types.AccountID]map[types.OrderID]*types.Order
	bySymbol   map[types.Symbol]map[types.OrderID]*types.Order
	mu         sync.RWMutex

	orderPool  *pool.OrderPool
	fillPool   *pool.FillPool

	orderBooks map[types.Symbol]*orderbook.OrderBook

	// Channels
	newOrders    chan *types.Order
	cancelOrders chan types.OrderID
	fills        chan *types.Fill
	updates      chan *types.Order

	// Event handlers
	onFill   []FillHandler
	onUpdate []UpdateHandler

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// FillHandler processes order fills
type FillHandler func(*types.Fill)

// UpdateHandler processes order updates
type UpdateHandler func(*types.Order)

// NewManager creates a new order manager
func NewManager() *Manager {
	ctx, cancel := context.WithCancel(context.Background())

	return &Manager{
		orders:       make(map[types.OrderID]*types.Order),
		byAccount:    make(map[types.AccountID]map[types.OrderID]*types.Order),
		bySymbol:     make(map[types.Symbol]map[types.OrderID]*types.Order),
		orderPool:    pool.NewOrderPool(),
		fillPool:     pool.NewFillPool(),
		orderBooks:   make(map[types.Symbol]*orderbook.OrderBook),
		newOrders:    make(chan *types.Order, 10000),
		cancelOrders: make(chan types.OrderID, 10000),
		fills:        make(chan *types.Fill, 10000),
		updates:      make(chan *types.Order, 10000),
		ctx:          ctx,
		cancel:       cancel,
	}
}

// Start starts the order manager
func (m *Manager) Start() error {
	m.wg.Add(1)
	go m.processOrders()

	return nil
}

// Stop stops the order manager
func (m *Manager) Stop() error {
	m.cancel()
	m.wg.Wait()
	return nil
}

// SubmitOrder submits a new order
func (m *Manager) SubmitOrder(order *types.Order) error {
	// Validate order
	if err := m.validateOrder(order); err != nil {
		return err
	}

	// Set initial state
	order.Status = types.OrderStatusNew
	order.CreatedAt = time.Now()
	order.UpdatedAt = time.Now()
	order.RemainingQty = order.Quantity

	// Generate order ID if not set
	if order.ID == "" {
		order.ID = m.generateOrderID()
	}

	// Send to processing channel
	select {
	case m.newOrders <- order:
		return nil
	case <-m.ctx.Done():
		return types.ErrShutdown
	default:
		return types.ErrSystemOverload
	}
}

// CancelOrder cancels an existing order
func (m *Manager) CancelOrder(orderID types.OrderID) error {
	select {
	case m.cancelOrders <- orderID:
		return nil
	case <-m.ctx.Done():
		return types.ErrShutdown
	default:
		return types.ErrSystemOverload
	}
}

// GetOrder retrieves an order by ID
func (m *Manager) GetOrder(orderID types.OrderID) (*types.Order, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	order, exists := m.orders[orderID]
	if !exists {
		return nil, types.ErrOrderNotFound
	}

	return order, nil
}

// GetAccountOrders returns all orders for an account
func (m *Manager) GetAccountOrders(accountID types.AccountID) []*types.Order {
	m.mu.RLock()
	defer m.mu.RUnlock()

	accountOrders := m.byAccount[accountID]
	orders := make([]*types.Order, 0, len(accountOrders))

	for _, order := range accountOrders {
		orders = append(orders, order)
	}

	return orders
}

// GetSymbolOrders returns all orders for a symbol
func (m *Manager) GetSymbolOrders(symbol types.Symbol) []*types.Order {
	m.mu.RLock()
	defer m.mu.RUnlock()

	symbolOrders := m.bySymbol[symbol]
	orders := make([]*types.Order, 0, len(symbolOrders))

	for _, order := range symbolOrders {
		orders = append(orders, order)
	}

	return orders
}

// OnFill registers a fill handler
func (m *Manager) OnFill(handler FillHandler) {
	m.onFill = append(m.onFill, handler)
}

// OnUpdate registers an update handler
func (m *Manager) OnUpdate(handler UpdateHandler) {
	m.onUpdate = append(m.onUpdate, handler)
}

// processOrders is the main order processing loop
func (m *Manager) processOrders() {
	defer m.wg.Done()

	for {
		select {
		case <-m.ctx.Done():
			return

		case order := <-m.newOrders:
			m.handleNewOrder(order)

		case orderID := <-m.cancelOrders:
			m.handleCancelOrder(orderID)

		case fill := <-m.fills:
			m.handleFill(fill)

		case order := <-m.updates:
			m.handleUpdate(order)
		}
	}
}

// handleNewOrder processes a new order
func (m *Manager) handleNewOrder(order *types.Order) {
	m.mu.Lock()

	// Store order
	m.orders[order.ID] = order

	// Index by account
	if m.byAccount[order.AccountID] == nil {
		m.byAccount[order.AccountID] = make(map[types.OrderID]*types.Order)
	}
	m.byAccount[order.AccountID][order.ID] = order

	// Index by symbol
	if m.bySymbol[order.Symbol] == nil {
		m.bySymbol[order.Symbol] = make(map[types.OrderID]*types.Order)
	}
	m.bySymbol[order.Symbol][order.ID] = order

	m.mu.Unlock()

	// Get or create order book
	book := m.getOrCreateOrderBook(order.Symbol)

	// Handle different order types
	switch order.Type {
	case types.OrderTypeMarket:
		m.executeMarketOrder(order, book)

	case types.OrderTypeLimit:
		m.executeLimitOrder(order, book)

	case types.OrderTypeIOC:
		m.executeIOCOrder(order, book)

	case types.OrderTypeFOK:
		m.executeFOKOrder(order, book)

	case types.OrderTypePostOnly:
		m.executePostOnlyOrder(order, book)
	}

	// Notify handlers
	for _, handler := range m.onUpdate {
		handler(order)
	}
}

// handleCancelOrder processes order cancellation
func (m *Manager) handleCancelOrder(orderID types.OrderID) {
	m.mu.Lock()
	order, exists := m.orders[orderID]
	if !exists {
		m.mu.Unlock()
		return
	}

	// Update status
	order.Status = types.OrderStatusCanceling
	order.UpdatedAt = time.Now()
	m.mu.Unlock()

	// Get order book
	book := m.getOrCreateOrderBook(order.Symbol)

	// Remove from book
	book.RemoveOrder(orderID)

	// Update final status
	m.mu.Lock()
	order.Status = types.OrderStatusCanceled
	order.UpdatedAt = time.Now()
	m.mu.Unlock()

	// Notify handlers
	for _, handler := range m.onUpdate {
		handler(order)
	}
}

// handleFill processes order fills
func (m *Manager) handleFill(fill *types.Fill) {
	m.mu.Lock()
	order, exists := m.orders[fill.OrderID]
	if !exists {
		m.mu.Unlock()
		return
	}

	// Update order
	order.FilledQuantity += fill.Quantity
	order.RemainingQty -= fill.Quantity
	order.UpdatedAt = time.Now()

	if order.RemainingQty == 0 {
		order.Status = types.OrderStatusFilled
	} else {
		order.Status = types.OrderStatusPartiallyFilled
	}

	m.mu.Unlock()

	// Notify fill handlers
	for _, handler := range m.onFill {
		handler(fill)
	}

	// Notify update handlers
	for _, handler := range m.onUpdate {
		handler(order)
	}
}

// handleUpdate processes order updates
func (m *Manager) handleUpdate(order *types.Order) {
	for _, handler := range m.onUpdate {
		handler(order)
	}
}

// executeMarketOrder executes a market order
func (m *Manager) executeMarketOrder(order *types.Order, book *orderbook.OrderBook) {
	fills, remaining, err := book.Match(order)
	if err != nil {
		order.Status = types.OrderStatusRejected
		return
	}

	// Process fills
	for _, fill := range fills {
		m.fills <- fill
	}

	// Update order
	if remaining == 0 {
		order.Status = types.OrderStatusFilled
	} else {
		// Market order partially filled - cancel remaining
		order.Status = types.OrderStatusPartiallyFilled
		order.RemainingQty = remaining
	}
}

// executeLimitOrder executes a limit order
func (m *Manager) executeLimitOrder(order *types.Order, book *orderbook.OrderBook) {
	fills, remaining, err := book.Match(order)
	if err != nil {
		order.Status = types.OrderStatusRejected
		return
	}

	// Process fills
	for _, fill := range fills {
		m.fills <- fill
	}

	// Update order
	order.RemainingQty = remaining

	if remaining == 0 {
		order.Status = types.OrderStatusFilled
	} else {
		// Add remaining to book
		if len(fills) > 0 {
			order.Status = types.OrderStatusPartiallyFilled
		}
		book.AddOrder(order)
	}
}

// executeIOCOrder executes an Immediate-or-Cancel order
func (m *Manager) executeIOCOrder(order *types.Order, book *orderbook.OrderBook) {
	fills, remaining, err := book.Match(order)
	if err != nil {
		order.Status = types.OrderStatusRejected
		return
	}

	// Process fills
	for _, fill := range fills {
		m.fills <- fill
	}

	// IOC cancels any unfilled portion
	if len(fills) > 0 {
		order.Status = types.OrderStatusPartiallyFilled
	} else {
		order.Status = types.OrderStatusCanceled
	}
	order.RemainingQty = 0
}

// executeFOKOrder executes a Fill-or-Kill order
func (m *Manager) executeFOKOrder(order *types.Order, book *orderbook.OrderBook) {
	fills, remaining, err := book.Match(order)
	if err != nil || remaining > 0 {
		// FOK requires complete fill
		order.Status = types.OrderStatusCanceled
		return
	}

	// Process fills
	for _, fill := range fills {
		m.fills <- fill
	}

	order.Status = types.OrderStatusFilled
	order.RemainingQty = 0
}

// executePostOnlyOrder executes a post-only order
func (m *Manager) executePostOnlyOrder(order *types.Order, book *orderbook.OrderBook) {
	// Post-only orders are rejected if they would match immediately

	// Check if order would cross the spread
	if order.Side == types.SideBuy {
		askPrice, _, hasAsk := book.GetBestAsk()
		if hasAsk && order.Price >= askPrice {
			order.Status = types.OrderStatusRejected
			return
		}
	} else {
		bidPrice, _, hasBid := book.GetBestBid()
		if hasBid && order.Price <= bidPrice {
			order.Status = types.OrderStatusRejected
			return
		}
	}

	// Add to book
	book.AddOrder(order)
}

// validateOrder validates order parameters
func (m *Manager) validateOrder(order *types.Order) error {
	if order.Symbol == "" {
		return types.ErrInvalidOrder
	}

	if order.Quantity <= 0 {
		return types.ErrInvalidQuantity
	}

	if order.Type == types.OrderTypeLimit && order.Price <= 0 {
		return types.ErrInvalidPrice
	}

	return nil
}

// getOrCreateOrderBook gets or creates an order book for a symbol
func (m *Manager) getOrCreateOrderBook(symbol types.Symbol) *orderbook.OrderBook {
	m.mu.Lock()
	defer m.mu.Unlock()

	book, exists := m.orderBooks[symbol]
	if !exists {
		book = orderbook.NewOrderBook(symbol)
		m.orderBooks[symbol] = book
	}

	return book
}

// generateOrderID generates a unique order ID
func (m *Manager) generateOrderID() types.OrderID {
	return types.OrderID(fmt.Sprintf("ORD-%d-%d", time.Now().UnixNano(), len(m.orders)))
}
```
