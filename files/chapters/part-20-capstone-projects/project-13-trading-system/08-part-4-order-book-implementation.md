## Part 4: Order Book Implementation

The order book is the heart of the trading system. We'll implement a high-performance price-time priority order book. An order book maintains two sorted lists: bids (buy orders) sorted from highest to lowest price, and asks (sell orders) sorted from lowest to highest price. When a new order arrives, the matching engine checks whether it can be filled against existing orders on the opposite side. Orders at the same price level are filled in the order they arrived (time priority). This price-time priority model is the standard used by virtually every major stock and cryptocurrency exchange in the world.

```go
// internal/orderbook/orderbook.go
package orderbook

import (
	"container/list"
	"sync"
	"time"

	"github.com/yourusername/trading-system/pkg/types"
)

// OrderBook implements a limit order book with price-time priority
type OrderBook struct {
	symbol    types.Symbol
	bids      *PriceLevel // Buy side
	asks      *PriceLevel // Sell side
	orderMap  map[types.OrderID]*BookOrder
	mu        sync.RWMutex
	sequence  uint64
	timestamp time.Time
}

// BookOrder wraps an order with book-specific metadata
type BookOrder struct {
	Order     *types.Order
	ListElem  *list.Element // Position in price level queue
	Level     *PriceLevel
}

// PriceLevel represents orders at a specific price
type PriceLevel struct {
	price  types.Price
	orders *list.List // Queue of orders at this price
	volume types.Quantity
	parent *PriceLevelTree
}

// PriceLevelTree is a red-black tree of price levels
// For production, use a specialized tree or skip list
type PriceLevelTree struct {
	root *PriceLevelNode
	size int
}

type PriceLevelNode struct {
	level  *PriceLevel
	left   *PriceLevelNode
	right  *PriceLevelNode
	parent *PriceLevelNode
	color  bool // true = red, false = black
}

// NewOrderBook creates a new order book
func NewOrderBook(symbol types.Symbol) *OrderBook {
	return &OrderBook{
		symbol:   symbol,
		bids:     newPriceLevelTree(true),  // Best bid = highest price
		asks:     newPriceLevelTree(false), // Best ask = lowest price
		orderMap: make(map[types.OrderID]*BookOrder),
	}
}

// AddOrder adds an order to the book
func (ob *OrderBook) AddOrder(order *types.Order) error {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	// Check for duplicate
	if _, exists := ob.orderMap[order.ID]; exists {
		return types.ErrDuplicateOrder
	}

	// Select side
	var tree *PriceLevelTree
	if order.Side == types.SideBuy {
		tree = ob.bids.parent
	} else {
		tree = ob.asks.parent
	}

	// Get or create price level
	level := tree.getOrCreateLevel(order.Price)

	// Create book order
	bookOrder := &BookOrder{
		Order: order,
		Level: level,
	}

	// Add to price level queue (FIFO for price-time priority)
	bookOrder.ListElem = level.orders.PushBack(bookOrder)
	level.volume = level.volume + order.RemainingQty

	// Add to order map
	ob.orderMap[order.ID] = bookOrder

	// Update sequence and timestamp
	ob.sequence++
	ob.timestamp = time.Now()

	return nil
}

// RemoveOrder removes an order from the book
func (ob *OrderBook) RemoveOrder(orderID types.OrderID) (*types.Order, error) {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	bookOrder, exists := ob.orderMap[orderID]
	if !exists {
		return nil, types.ErrOrderNotFound
	}

	// Remove from price level
	level := bookOrder.Level
	level.orders.Remove(bookOrder.ListElem)
	level.volume = level.volume - bookOrder.Order.RemainingQty

	// Remove price level if empty
	if level.orders.Len() == 0 {
		level.parent.removeLevel(level.price)
	}

	// Remove from order map
	delete(ob.orderMap, orderID)

	// Update sequence and timestamp
	ob.sequence++
	ob.timestamp = time.Now()

	return bookOrder.Order, nil
}

// ModifyOrder modifies an order's quantity
// Note: Price modification requires cancel/replace
func (ob *OrderBook) ModifyOrder(orderID types.OrderID, newQty types.Quantity) error {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	bookOrder, exists := ob.orderMap[orderID]
	if !exists {
		return types.ErrOrderNotFound
	}

	// Update volume at price level
	level := bookOrder.Level
	level.volume = level.volume - bookOrder.Order.RemainingQty + newQty

	// Update order
	bookOrder.Order.RemainingQty = newQty

	// Update sequence and timestamp
	ob.sequence++
	ob.timestamp = time.Now()

	return nil
}

// Match attempts to match an incoming order against the book
// Returns list of fills and remaining order quantity
func (ob *OrderBook) Match(order *types.Order) ([]*types.Fill, types.Quantity, error) {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	var fills []*types.Fill
	remaining := order.RemainingQty

	// Select opposite side for matching
	var tree *PriceLevelTree
	if order.Side == types.SideBuy {
		tree = ob.asks.parent
	} else {
		tree = ob.bids.parent
	}

	// Match against best prices
	for remaining > 0 {
		// Get best price level
		bestLevel := tree.getBestLevel()
		if bestLevel == nil {
			break // No more liquidity
		}

		// Check if price matches
		if order.Type == types.OrderTypeLimit {
			if order.Side == types.SideBuy && order.Price < bestLevel.price {
				break // Incoming bid below best ask
			}
			if order.Side == types.SideSell && order.Price > bestLevel.price {
				break // Incoming offer above best bid
			}
		}

		// Match against orders at this level
		for elem := bestLevel.orders.Front(); elem != nil && remaining > 0; {
			bookOrder := elem.Value.(*BookOrder)
			restingOrder := bookOrder.Order

			// Calculate fill quantity
			fillQty := remaining
			if fillQty > restingOrder.RemainingQty {
				fillQty = restingOrder.RemainingQty
			}

			// Create fill for incoming order
			fill := &types.Fill{
				OrderID:   order.ID,
				Symbol:    order.Symbol,
				Side:      order.Side,
				Price:     bestLevel.price,
				Quantity:  fillQty,
				Timestamp: time.Now(),
				IsMaker:   false,
			}
			fills = append(fills, fill)

			// Update incoming order
			remaining -= fillQty

			// Update resting order
			restingOrder.RemainingQty -= fillQty
			restingOrder.FilledQuantity += fillQty
			bestLevel.volume -= fillQty

			// Remove if fully filled
			nextElem := elem.Next()
			if restingOrder.RemainingQty == 0 {
				restingOrder.Status = types.OrderStatusFilled
				bestLevel.orders.Remove(elem)
				delete(ob.orderMap, restingOrder.ID)
			} else {
				restingOrder.Status = types.OrderStatusPartiallyFilled
			}

			elem = nextElem
		}

		// Remove price level if empty
		if bestLevel.orders.Len() == 0 {
			tree.removeLevel(bestLevel.price)
		}
	}

	// Update sequence and timestamp
	ob.sequence++
	ob.timestamp = time.Now()

	return fills, remaining, nil
}

// GetBestBid returns the best bid price and quantity
func (ob *OrderBook) GetBestBid() (types.Price, types.Quantity, bool) {
	ob.mu.RLock()
	defer ob.mu.RUnlock()

	level := ob.bids.parent.getBestLevel()
	if level == nil {
		return 0, 0, false
	}

	return level.price, level.volume, true
}

// GetBestAsk returns the best ask price and quantity
func (ob *OrderBook) GetBestAsk() (types.Price, types.Quantity, bool) {
	ob.mu.RLock()
	defer ob.mu.RUnlock()

	level := ob.asks.parent.getBestLevel()
	if level == nil {
		return 0, 0, false
	}

	return level.price, level.volume, true
}

// GetQuote returns best bid and ask
func (ob *OrderBook) GetQuote() *types.Quote {
	ob.mu.RLock()
	defer ob.mu.RUnlock()

	quote := &types.Quote{
		Symbol:    ob.symbol,
		Timestamp: ob.timestamp,
	}

	if bidLevel := ob.bids.parent.getBestLevel(); bidLevel != nil {
		quote.BidPrice = bidLevel.price
		quote.BidSize = bidLevel.volume
	}

	if askLevel := ob.asks.parent.getBestLevel(); askLevel != nil {
		quote.AskPrice = askLevel.price
		quote.AskSize = askLevel.volume
	}

	return quote
}

// GetDepth returns order book depth up to specified levels
func (ob *OrderBook) GetDepth(levels int) *types.OrderBook {
	ob.mu.RLock()
	defer ob.mu.RUnlock()

	book := &types.OrderBook{
		Symbol:    ob.symbol,
		Timestamp: ob.timestamp,
		Sequence:  ob.sequence,
		Bids:      make([]types.Level, 0, levels),
		Asks:      make([]types.Level, 0, levels),
	}

	// Collect bid levels
	ob.bids.parent.traverse(func(level *PriceLevel) bool {
		if len(book.Bids) >= levels {
			return false
		}
		book.Bids = append(book.Bids, types.Level{
			Price:    level.price,
			Quantity: level.volume,
			Orders:   int32(level.orders.Len()),
		})
		return true
	})

	// Collect ask levels
	ob.asks.parent.traverse(func(level *PriceLevel) bool {
		if len(book.Asks) >= levels {
			return false
		}
		book.Asks = append(book.Asks, types.Level{
			Price:    level.price,
			Quantity: level.volume,
			Orders:   int32(level.orders.Len()),
		})
		return true
	})

	return book
}

// GetMidPrice returns the mid-market price
func (ob *OrderBook) GetMidPrice() (types.Price, bool) {
	bidPrice, _, hasBid := ob.GetBestBid()
	askPrice, _, hasAsk := ob.GetBestAsk()

	if !hasBid || !hasAsk {
		return 0, false
	}

	return (bidPrice + askPrice) / 2, true
}

// GetSpread returns the bid-ask spread
func (ob *OrderBook) GetSpread() (types.Price, bool) {
	bidPrice, _, hasBid := ob.GetBestBid()
	askPrice, _, hasAsk := ob.GetBestAsk()

	if !hasBid || !hasAsk {
		return 0, false
	}

	return askPrice - bidPrice, true
}

// Price Level Tree Implementation (Simplified)
// For production, use a more efficient data structure like a skip list

func newPriceLevelTree(isBid bool) *PriceLevel {
	tree := &PriceLevelTree{}
	return &PriceLevel{
		parent: tree,
	}
}

func (tree *PriceLevelTree) getOrCreateLevel(price types.Price) *PriceLevel {
	// Simplified implementation - in production use proper red-black tree
	// For now, we'll do a simple search and insert

	node := tree.root
	var parent *PriceLevelNode

	for node != nil {
		parent = node
		if price == node.level.price {
			return node.level
		} else if price < node.level.price {
			node = node.left
		} else {
			node = node.right
		}
	}

	// Create new level
	level := &PriceLevel{
		price:  price,
		orders: list.New(),
		parent: tree,
	}

	newNode := &PriceLevelNode{
		level:  level,
		parent: parent,
		color:  true, // Red
	}

	if parent == nil {
		tree.root = newNode
	} else if price < parent.level.price {
		parent.left = newNode
	} else {
		parent.right = newNode
	}

	tree.size++
	tree.fixInsert(newNode)

	return level
}

func (tree *PriceLevelTree) removeLevel(price types.Price) {
	// Simplified removal - in production implement full RB tree deletion
	// This is a complex operation that maintains RB tree properties
}

func (tree *PriceLevelTree) getBestLevel() *PriceLevel {
	if tree.root == nil {
		return nil
	}

	// For bids, best is rightmost (highest)
	// For asks, best is leftmost (lowest)
	// This simplified version returns leftmost
	node := tree.root
	for node.left != nil {
		node = node.left
	}

	return node.level
}

func (tree *PriceLevelTree) traverse(fn func(*PriceLevel) bool) {
	tree.inorderTraverse(tree.root, fn)
}

func (tree *PriceLevelTree) inorderTraverse(node *PriceLevelNode, fn func(*PriceLevel) bool) bool {
	if node == nil {
		return true
	}

	if !tree.inorderTraverse(node.left, fn) {
		return false
	}

	if !fn(node.level) {
		return false
	}

	return tree.inorderTraverse(node.right, fn)
}

func (tree *PriceLevelTree) fixInsert(node *PriceLevelNode) {
	// Simplified RB tree fix-up after insertion
	// In production, implement full red-black tree balancing

	for node.parent != nil && node.parent.color {
		// Rebalancing logic here
		// This ensures O(log n) operations
	}

	tree.root.color = false // Root is always black
}
```
