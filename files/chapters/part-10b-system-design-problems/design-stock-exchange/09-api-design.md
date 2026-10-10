## API Design

The exchange exposes both a REST API for standard order operations and a WebSocket endpoint for real-time market data streaming. Institutional traders typically connect via the FIX protocol (a tag=value text protocol carried over TCP, the long-standing standard across the financial industry, with binary encodings such as SBE used where latency demands it), while retail brokers use the REST API. Every request includes validation tags to reject malformed orders before they reach the matching engine.

The `time_in_force` field controls how long an order stays active, and the distinctions matter because they change what the engine is allowed to do with a partial fill:

- **GTC** (good-till-canceled) rests on the book until filled or pulled.
- **DAY** rests until market close, then expires.
- **IOC** (immediate-or-cancel) fills whatever it can right now against resting orders and cancels the remainder. A partial fill is a normal outcome.
- **FOK** (fill-or-kill) fills completely and immediately or not at all. A partial fill is not an acceptable outcome, so the engine must check that enough quantity is available at an acceptable price *before* executing anything, and kill the order otherwise.

Notice what is not in the request body: the trader's identity. The order's owner is taken from the authenticated session or API key, never from a client-supplied field. If the caller could name themselves in the JSON, any authenticated client could submit orders that bill to someone else's account, which is about as severe as a bug gets on an exchange.

```go
package api

// POST /api/v1/orders - Submit order
// The trader is resolved from the request's authenticated credentials and is
// deliberately absent from this struct.
type SubmitOrderRequest struct {
	Symbol string `json:"symbol" validate:"required"`
	Side   string `json:"side" validate:"required,oneof=buy sell"`
	Type   string `json:"type" validate:"required,oneof=market limit stop stop_limit"`
	// Price is required for limit and stop_limit, ignored for market and stop.
	Price int64 `json:"price" validate:"gte=0"`
	// StopPrice is required for stop and stop_limit.
	StopPrice int64  `json:"stop_price" validate:"gte=0"`
	Quantity  int64  `json:"quantity" validate:"gt=0"`
	TIF       string `json:"time_in_force" validate:"required,oneof=GTC IOC FOK DAY"`
}

// DELETE /api/v1/orders/{id} - Cancel order
// GET /api/v1/orderbook/{symbol} - Order book depth
// GET /api/v1/trades/{symbol} - Recent trades
// GET /api/v1/positions/{trader_id} - Current positions
// WebSocket /ws/market-data - Real-time stream
// FIX Protocol (TCP 9876) - Institutional trading
```

---
