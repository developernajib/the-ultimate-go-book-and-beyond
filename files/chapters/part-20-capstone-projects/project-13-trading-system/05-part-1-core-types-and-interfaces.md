## Part 1: Core Types and Interfaces

Let's start with the fundamental types that form the foundation of our trading system. In financial software, you must never use floating-point numbers for prices or quantities because rounding errors accumulate and lead to incorrect calculations. Instead, we represent monetary values as fixed-precision integers, where a single `int64` stores the value multiplied by a large constant. This approach gives us exact arithmetic while keeping operations extremely fast. The types and interfaces defined here will be used by every other component in the system.

### Core Domain Types

The core domain types define immutable value objects for orders, trades, execution reports, and book snapshots. They enforce type safety and domain invariants across the entire matching and risk pipeline.

```go
// pkg/types/types.go
package types

import (
	"fmt"
	"math"
	"time"
)

// Price represents a price with fixed decimal precision
// Using int64 to avoid floating point errors in financial calculations
type Price int64

const (
	PricePrecision = 100000000 // 8 decimal places
)

// NewPrice creates a Price from a float64. The conversion MUST round
// rather than truncate: 19.99 * 1e8 is 1998999999.9999998 in float64, so a
// bare conversion silently loses a unit. In hot paths prefer constructing
// Price values directly from integer sources (exchange feeds deliver
// integer ticks) and keep float64 only at display boundaries.
func NewPrice(f float64) Price {
	return Price(math.Round(f * PricePrecision))
}

// Float64 converts Price to float64
func (p Price) Float64() float64 {
	return float64(p) / PricePrecision
}

// String returns formatted price string
func (p Price) String() string {
	return fmt.Sprintf("%.8f", p.Float64())
}

// Add adds two prices
func (p Price) Add(other Price) Price {
	return p + other
}

// Sub subtracts two prices
func (p Price) Sub(other Price) Price {
	return p - other
}

// Mul multiplies price by quantity
func (p Price) Mul(qty Quantity) Price {
	return Price(int64(p) * int64(qty) / PricePrecision)
}

// Quantity represents order quantity with fixed precision
type Quantity int64

const (
	QuantityPrecision = 100000000 // 8 decimal places
)

// NewQuantity creates Quantity from float64
func NewQuantity(f float64) Quantity {
	return Quantity(f * QuantityPrecision)
}

// Float64 converts Quantity to float64
func (q Quantity) Float64() float64 {
	return float64(q) / QuantityPrecision
}

// String returns formatted quantity string
func (q Quantity) String() string {
	return fmt.Sprintf("%.8f", q.Float64())
}

// Side represents order side (buy/sell)
type Side uint8

const (
	SideBuy Side = iota
	SideSell
)

func (s Side) String() string {
	if s == SideBuy {
		return "BUY"
	}
	return "SELL"
}

// Opposite returns the opposite side
func (s Side) Opposite() Side {
	if s == SideBuy {
		return SideSell
	}
	return SideBuy
}

// OrderType represents different order types
type OrderType uint8

const (
	OrderTypeMarket OrderType = iota
	OrderTypeLimit
	OrderTypeStop
	OrderTypeStopLimit
	OrderTypeIOC     // Immediate or Cancel
	OrderTypeFOK     // Fill or Kill
	OrderTypePostOnly
)

func (ot OrderType) String() string {
	switch ot {
	case OrderTypeMarket:
		return "MARKET"
	case OrderTypeLimit:
		return "LIMIT"
	case OrderTypeStop:
		return "STOP"
	case OrderTypeStopLimit:
		return "STOP_LIMIT"
	case OrderTypeIOC:
		return "IOC"
	case OrderTypeFOK:
		return "FOK"
	case OrderTypePostOnly:
		return "POST_ONLY"
	default:
		return "UNKNOWN"
	}
}

// OrderStatus represents order lifecycle states
type OrderStatus uint8

const (
	OrderStatusNew OrderStatus = iota
	OrderStatusPartiallyFilled
	OrderStatusFilled
	OrderStatusCanceling
	OrderStatusCanceled
	OrderStatusRejected
	OrderStatusExpired
)

func (os OrderStatus) String() string {
	switch os {
	case OrderStatusNew:
		return "NEW"
	case OrderStatusPartiallyFilled:
		return "PARTIALLY_FILLED"
	case OrderStatusFilled:
		return "FILLED"
	case OrderStatusCanceling:
		return "CANCELING"
	case OrderStatusCanceled:
		return "CANCELED"
	case OrderStatusRejected:
		return "REJECTED"
	case OrderStatusExpired:
		return "EXPIRED"
	default:
		return "UNKNOWN"
	}
}

// IsFinal returns true if order is in final state
func (os OrderStatus) IsFinal() bool {
	return os == OrderStatusFilled ||
		os == OrderStatusCanceled ||
		os == OrderStatusRejected ||
		os == OrderStatusExpired
}

// Symbol represents a trading symbol
type Symbol string

// OrderID is a unique order identifier
type OrderID string

// TradeID is a unique trade identifier
type TradeID string

// AccountID identifies a trading account
type AccountID string

// Order represents a trading order
type Order struct {
	ID              OrderID
	ClientOrderID   string
	AccountID       AccountID
	Symbol          Symbol
	Side            Side
	Type            OrderType
	Price           Price
	StopPrice       Price
	Quantity        Quantity
	FilledQuantity  Quantity
	RemainingQty    Quantity
	Status          OrderStatus
	CreatedAt       time.Time
	UpdatedAt       time.Time
	TimeInForce     TimeInForce
	StrategyID      string
	Tags            map[string]string
}

// TimeInForce specifies order duration
type TimeInForce uint8

const (
	TimeInForceGTC TimeInForce = iota // Good Till Cancel
	TimeInForceIOC                    // Immediate or Cancel
	TimeInForceFOK                    // Fill or Kill
	TimeInForceGTD                    // Good Till Date
	TimeInForceDay                    // Day order
)

func (tif TimeInForce) String() string {
	switch tif {
	case TimeInForceGTC:
		return "GTC"
	case TimeInForceIOC:
		return "IOC"
	case TimeInForceFOK:
		return "FOK"
	case TimeInForceGTD:
		return "GTD"
	case TimeInForceDay:
		return "DAY"
	default:
		return "UNKNOWN"
	}
}

// Fill represents an order fill/execution
type Fill struct {
	ID              TradeID
	OrderID         OrderID
	Symbol          Symbol
	Side            Side
	Price           Price
	Quantity        Quantity
	Commission      Price
	CommissionAsset string
	Timestamp       time.Time
	IsMaker         bool
}

// Trade represents a market trade
type Trade struct {
	ID        TradeID
	Symbol    Symbol
	Price     Price
	Quantity  Quantity
	Side      Side
	Timestamp time.Time
}

// Quote represents best bid/ask
type Quote struct {
	Symbol    Symbol
	BidPrice  Price
	BidSize   Quantity
	AskPrice  Price
	AskSize   Quantity
	Timestamp time.Time
}

// Level represents a price level in order book
type Level struct {
	Price    Price
	Quantity Quantity
	Orders   int32 // Number of orders at this level
}

// OrderBook represents a limit order book
type OrderBook struct {
	Symbol    Symbol
	Bids      []Level
	Asks      []Level
	Timestamp time.Time
	Sequence  uint64
}

// Position represents a trading position
type Position struct {
	Symbol          Symbol
	AccountID       AccountID
	Side            Side
	Quantity        Quantity
	AvgEntryPrice   Price
	RealizedPnL     Price
	UnrealizedPnL   Price
	LastUpdateTime  time.Time
}

// Account represents trading account state
type Account struct {
	ID                AccountID
	Balance           Price
	AvailableBalance  Price
	MarginUsed        Price
	UnrealizedPnL     Price
	RealizedPnL       Price
	Positions         map[Symbol]*Position
	LastUpdateTime    time.Time
}

// Signal represents a trading signal
type Signal struct {
	StrategyID string
	Symbol     Symbol
	Side       Side
	Price      Price
	Quantity   Quantity
	Confidence float64
	Metadata   map[string]any
	Timestamp  time.Time
}

// RiskCheck represents risk validation result
type RiskCheck struct {
	Passed       bool
	Violations   []string
	Order        *Order
	CheckedAt    time.Time
}
```

### Error Types

The following type definitions establish the core data model for the Error Types domain. These types are the shared language between layers of the system, so their field names, nullability, and validation rules are chosen for clarity and correctness.

```go
// pkg/types/errors.go
package types

import "errors"

var (
	// Order errors
	ErrInvalidOrder        = errors.New("invalid order")
	ErrInvalidPrice        = errors.New("invalid price")
	ErrInvalidQuantity     = errors.New("invalid quantity")
	ErrOrderNotFound       = errors.New("order not found")
	ErrDuplicateOrder      = errors.New("duplicate order")

	// Risk errors
	ErrInsufficientBalance = errors.New("insufficient balance")
	ErrPositionLimitExceeded = errors.New("position limit exceeded")
	ErrRiskLimitExceeded   = errors.New("risk limit exceeded")
	ErrMaxOrderSizeExceeded = errors.New("max order size exceeded")

	// Market data errors
	ErrInvalidMarketData   = errors.New("invalid market data")
	ErrStaleData           = errors.New("stale market data")
	ErrNoLiquidity         = errors.New("no liquidity")

	// Exchange errors
	ErrExchangeConnection  = errors.New("exchange connection error")
	ErrExchangeRateLimit   = errors.New("exchange rate limit exceeded")
	ErrExchangeRejection   = errors.New("exchange rejected order")

	// System errors
	ErrSystemOverload      = errors.New("system overload")
	ErrTimeout             = errors.New("operation timeout")
	ErrShutdown            = errors.New("system shutting down")
)

// OrderError wraps order-specific errors with context
type OrderError struct {
	Order *Order
	Err   error
}

func (e *OrderError) Error() string {
	return e.Err.Error()
}

func (e *OrderError) Unwrap() error {
	return e.Err
}
```
