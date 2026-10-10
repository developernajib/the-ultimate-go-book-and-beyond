## Deep Dive: Order Gateway with Risk Checks

Before any order reaches the matching engine, it must pass through a series of pre-trade risk checks at the gateway level. These checks protect both the exchange and individual traders from catastrophic mistakes. The risk engine enforces position limits (preventing any single trader from accumulating too large a position), margin requirements (ensuring traders have enough collateral to cover their trades), and fat-finger checks (rejecting limit orders whose price deviates wildly from the current market price). The LULD (Limit Up / Limit Down) circuit breaker keeps trades from printing outside a band computed around the security's recent average price, which is what stops a flash crash from cascading through resting orders at absurd prices.

The rule that governs this whole file is that it fails closed. A risk check exists to say no, so every input it cannot read is a reason to reject the order, never a reason to skip the check. Discarding a store error with `_` looks harmless until you notice that the zero value of a position is "no position" and the zero value of a price is "this order is worth nothing", at which point a failing database silently turns the risk engine off and the orders keep flowing.

```go
package gateway

import (
	"context"
	"fmt"
	"sync"
)

// All rates are basis points (1 bp = 0.01%), all prices and money are integer
// cents. Nothing in a risk check is allowed to touch a float.
const (
	initialMarginBps = 5000   // Reg T initial margin for equities: 50%
	marketBufferBps  = 500    // extra 5% headroom when there is no limit price
	fatFingerBps     = 1000   // reject a limit more than 10% off the market
	maxPosition      = 100000 // shares, per trader per symbol
)

// Order represents a candidate order arriving at the gateway.
type Order struct {
	TraderID string
	Symbol   string
	Side     Side
	Type     OrderType
	Price    int64 // cents
	Quantity int64
}

type OrderType int

const (
	TypeMarket OrderType = iota
	TypeLimit
	TypeStop
	TypeStopLimit
)

type Side int

const (
	Buy Side = iota
	Sell
)

type Position struct {
	TraderID string
	Symbol   string
	Quantity int64
}

type PositionStore interface {
	GetPosition(ctx context.Context, traderID, symbol string) (Position, error)
	GetLastPrice(ctx context.Context, symbol string) (int64, error)
}

type MarginStore interface {
	GetAvailableMargin(ctx context.Context, traderID string) (int64, error)
}

type RiskEngine struct {
	positionStore PositionStore
	marginStore   MarginStore
}

// PreTradeRiskCheck rejects an order that would breach position, margin, or
// sanity limits.
//
// Every store error here is fatal to the check. A risk check that cannot read
// its inputs must fail closed: if the position store hiccups and the error is
// swallowed, the zero value says "no position" and an unbounded order sails
// through. This is the single most important property in this file.
func (r *RiskEngine) PreTradeRiskCheck(ctx context.Context, order *Order) error {
	// Position limits
	position, err := r.positionStore.GetPosition(ctx, order.TraderID, order.Symbol)
	if err != nil {
		return fmt.Errorf("position lookup for %s: %w", order.TraderID, err)
	}

	projected := position.Quantity
	if order.Side == Buy {
		projected += order.Quantity
	} else {
		projected -= order.Quantity
	}
	if abs64(projected) > maxPosition {
		return fmt.Errorf("position limit exceeded: projected %d, max %d", projected, maxPosition)
	}

	lastPrice, err := r.positionStore.GetLastPrice(ctx, order.Symbol)
	if err != nil {
		return fmt.Errorf("last price lookup for %s: %w", order.Symbol, err)
	}

	// Value the order in cents. Only a limit order carries its own worst-case
	// price. Market and stop orders are valued at the last trade plus a
	// buffer, and an order that cannot be valued at all is rejected rather
	// than waved through at a notional of zero.
	refPrice := order.Price
	rateBps := int64(initialMarginBps)
	if order.Type != TypeLimit && order.Type != TypeStopLimit {
		if lastPrice <= 0 {
			return fmt.Errorf("no reference price for %s, cannot size margin", order.Symbol)
		}
		refPrice = lastPrice
		rateBps += marketBufferBps
	}
	if refPrice <= 0 {
		return fmt.Errorf("order has no usable price")
	}

	// Round the requirement up. Rounding a margin requirement down hands the
	// trader free leverage one cent at a time, and across millions of orders
	// those cents are real money the exchange is not holding collateral for.
	requiredMargin := ceilDiv(refPrice*order.Quantity*rateBps, 10000)

	available, err := r.marginStore.GetAvailableMargin(ctx, order.TraderID)
	if err != nil {
		return fmt.Errorf("margin lookup for %s: %w", order.TraderID, err)
	}
	if requiredMargin > available {
		return fmt.Errorf("insufficient margin: required %d, available %d", requiredMargin, available)
	}

	// Fat finger check, in integer math: |price - last| / last > 10% becomes
	// |price - last| * 10000 > last * bps, with no division and no rounding.
	if order.Type == TypeLimit || order.Type == TypeStopLimit {
		if lastPrice > 0 && abs64(order.Price-lastPrice)*10000 > lastPrice*fatFingerBps {
			return fmt.Errorf("fat finger: limit %d is too far from market %d", order.Price, lastPrice)
		}
	}

	return nil
}

// LULD circuit breaker.
// Bands are recomputed from the reference price as trades print, while the
// gateway reads them on every order, so the map is shared mutable state and
// needs a lock.
type LULD struct {
	mu    sync.RWMutex
	bands map[string]band
}

type band struct{ lower, upper int64 }

func NewLULD() *LULD {
	return &LULD{bands: make(map[string]band)}
}

// CheckPrice reports whether a print at this price would fall outside the
// band. Note what this does and does not do: LULD does not halt a security
// because it moved fast, it stops trades printing through the band. A pause
// only follows if the security sits in the limit state without recovering.
func (l *LULD) CheckPrice(symbol string, price int64) (bool, string) {
	l.mu.RLock()
	defer l.mu.RUnlock()

	b, ok := l.bands[symbol]
	if !ok {
		return false, ""
	}
	switch {
	case price > b.upper:
		return true, "limit_up"
	case price < b.lower:
		return true, "limit_down"
	}
	return false, ""
}

// UpdateBands recomputes the band around the reference price, which is the
// mean trade price over the preceding five minutes. Width is in basis points
// (500 = 5% for Tier 1, 1000 = 10% for Tier 2 above $3) and doubles near the
// open and close.
func (l *LULD) UpdateBands(symbol string, ref, widthBps int64) {
	delta := ceilDiv(ref*widthBps, 10000)

	l.mu.Lock()
	defer l.mu.Unlock()
	l.bands[symbol] = band{lower: ref - delta, upper: ref + delta}
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// ceilDiv divides a by b rounding up, for non-negative a and positive b.
func ceilDiv(a, b int64) int64 { return (a + b - 1) / b }
```

---
