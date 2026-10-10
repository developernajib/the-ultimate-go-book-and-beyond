## Core Components

### 1. Order Book

The order book is the most important data structure in a stock exchange. It maintains two sorted collections for every security: a list of buy orders (bids) sorted from highest price to lowest, and a list of sell orders (asks) sorted from lowest price to highest. When a new order arrives, the matching engine checks whether it can be filled against orders on the opposite side. We use Go's `container/heap` package to implement priority queues, which gives us O(log n) insertion and O(1) access to the best bid or ask price. Prices are stored as integer cents rather than floating-point numbers, because even tiny rounding errors are unacceptable in financial systems. Stop and stop-limit orders are deliberately kept off the book in a separate pending list: they are invisible to other participants and cannot trade until the market prints at or through their stop price, at which point they are elected into a market or limit order.

```go
package orderbook

import (
	"container/heap"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Order represents a trading order
type Order struct {
	ID          string
	Symbol      string
	Type        OrderType
	Side        Side  // Buy or Sell
	Price       int64 // limit price in cents, unused for market orders
	StopPrice   int64 // trigger price in cents, stop and stop-limit only
	Quantity    int64 // number of shares
	Filled      int64 // shares filled so far
	Status      OrderStatus
	TraderID    string
	SubmittedAt time.Time
	Sequence    int64 // monotonic sequence number for FIFO
}

// OrderType specifies the order execution rules
type OrderType int

const (
	TypeMarket    OrderType = iota // execute immediately at best price
	TypeLimit                      // execute only at specified price or better
	TypeStop                       // become market order when stop price reached
	TypeStopLimit                  // become limit order when stop price reached
)

// Side is buy or sell
type Side int

const (
	Buy Side = iota
	Sell
)

type OrderStatus int

const (
	StatusOpen OrderStatus = iota
	StatusPartiallyFilled
	StatusFilled
	StatusCanceled
	StatusPendingTrigger // stop order waiting for its stop price
)

// Trade represents an executed match between a buy and sell order
type Trade struct {
	ID          string
	Symbol      string
	BuyOrderID  string
	SellOrderID string
	Price       int64
	Quantity    int64
	BuyerID     string
	SellerID    string
	ExecutedAt  time.Time
}

// OrderBook maintains the bid and ask queues for one security
// Price/time priority: higher bids first, lower asks first
// At same price level, earlier orders (lower sequence) first
type OrderBook struct {
	Symbol   string
	Bids     *BidHeap // max-heap by price (buy orders)
	Asks     *AskHeap // min-heap by price (sell orders)
	mu       sync.Mutex
	sequence int64

	tradeSeq  int64    // monotonic trade counter, source of deterministic IDs
	stops     []*Order // stop orders waiting to be elected, not on the book
	lastPrice int64    // price of the most recent trade, elects stops
	hasLast   bool     // false until this book has printed its first trade
}

// nextTradeID mints a trade ID from book state alone. It is tempting to use a
// UUID here, but a random ID (or a wall-clock read) would make the standby
// produce different trades from the same WAL, and the whole recovery story
// depends on replay being byte-for-byte reproducible.
func (ob *OrderBook) nextTradeID() string {
	ob.tradeSeq++
	return fmt.Sprintf("%s-%d", ob.Symbol, ob.tradeSeq)
}

// BidHeap is a max-heap of buy orders (highest price first, then earliest first)
type BidHeap []*Order

func (h BidHeap) Len() int { return len(h) }
func (h BidHeap) Less(i, j int) bool {
	if h[i].Price != h[j].Price {
		return h[i].Price > h[j].Price // higher price first
	}
	return h[i].Sequence < h[j].Sequence // earlier order first (FIFO)
}
func (h BidHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *BidHeap) Push(x any)   { *h = append(*h, x.(*Order)) }
func (h *BidHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}

// AskHeap is a min-heap of sell orders (lowest price first, then earliest first)
type AskHeap []*Order

func (h AskHeap) Len() int { return len(h) }
func (h AskHeap) Less(i, j int) bool {
	if h[i].Price != h[j].Price {
		return h[i].Price < h[j].Price // lower price first
	}
	return h[i].Sequence < h[j].Sequence // FIFO
}
func (h AskHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *AskHeap) Push(x any)   { *h = append(*h, x.(*Order)) }
func (h *AskHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}

// AddOrder submits an order and attempts immediate matching
func (ob *OrderBook) AddOrder(order *Order) ([]Trade, error) {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	ob.sequence++
	order.Sequence = ob.sequence

	// Stop and stop-limit orders are not visible to the book and cannot
	// trade until the market prints at or through their stop price. Matching
	// them on arrival would fill them at whatever is resting right now, which
	// is the opposite of what the trader asked for.
	if order.Type == TypeStop || order.Type == TypeStopLimit {
		if !ob.triggered(order) {
			order.Status = StatusPendingTrigger
			ob.stops = append(ob.stops, order)
			return nil, nil
		}
		ob.elect(order)
	}

	trades := ob.matchAndRest(order)

	// Those trades moved the last price, which may elect resting stops, whose
	// own trades may elect more. Cascade until the book reaches a fixed point.
	trades = append(trades, ob.releaseStops()...)

	return trades, nil
}

// matchAndRest matches an order against the opposite side and rests whatever
// is left, for orders that are already live (market and limit).
func (ob *OrderBook) matchAndRest(order *Order) []Trade {
	order.Status = StatusOpen

	var trades []Trade
	switch order.Side {
	case Buy:
		trades = ob.matchBuy(order)
	case Sell:
		trades = ob.matchSell(order)
	}

	if len(trades) > 0 {
		ob.lastPrice = trades[len(trades)-1].Price
		ob.hasLast = true
	}

	// If order not fully filled, add to book (for limit orders)
	if order.Filled < order.Quantity {
		if order.Type == TypeMarket {
			// Market order that couldn't be fully filled → cancel remainder
			order.Status = StatusCanceled
		} else {
			// Limit order → rest on book
			if order.Side == Buy {
				heap.Push(ob.Bids, order)
			} else {
				heap.Push(ob.Asks, order)
			}
		}
	} else {
		order.Status = StatusFilled
	}

	return trades
}

// triggered reports whether the market has traded at or through the stop
// price. Buy stops elect on the way up, sell stops on the way down.
func (ob *OrderBook) triggered(o *Order) bool {
	if !ob.hasLast {
		return false
	}
	if o.Side == Buy {
		return ob.lastPrice >= o.StopPrice
	}
	return ob.lastPrice <= o.StopPrice
}

// elect converts a triggered stop into the order it becomes: a stop turns
// into a market order, a stop-limit into a limit order at its limit price.
func (ob *OrderBook) elect(o *Order) {
	if o.Type == TypeStop {
		o.Type = TypeMarket
	} else {
		o.Type = TypeLimit
	}
}

// releaseStops elects every stop the last price has reached and matches it.
// Elected stops enter the book in submission order so that two stops with the
// same stop price keep time priority between them.
func (ob *OrderBook) releaseStops() []Trade {
	var trades []Trade

	for {
		var elected []*Order
		kept := ob.stops[:0]
		for _, s := range ob.stops {
			if ob.triggered(s) {
				elected = append(elected, s)
			} else {
				kept = append(kept, s)
			}
		}
		ob.stops = kept

		if len(elected) == 0 {
			return trades
		}

		sort.Slice(elected, func(i, j int) bool {
			return elected[i].Sequence < elected[j].Sequence
		})
		for _, s := range elected {
			ob.elect(s)
			trades = append(trades, ob.matchAndRest(s)...)
		}
	}
}

// matchBuy matches an incoming buy order against the ask side
func (ob *OrderBook) matchBuy(buyOrder *Order) []Trade {
	var trades []Trade

	for ob.Asks.Len() > 0 && buyOrder.Filled < buyOrder.Quantity {
		bestAsk := (*ob.Asks)[0]

		// Check if prices cross (buy price >= sell price)
		if buyOrder.Type == TypeLimit && buyOrder.Price < bestAsk.Price {
			break // no match possible
		}

		// Self-trade prevention: a trader never executes against their own
		// resting order. Wash trades are a reportable manipulation pattern, so
		// the engine pulls the older resting side and matches the next one.
		if bestAsk.TraderID == buyOrder.TraderID {
			bestAsk.Status = StatusCanceled
			heap.Pop(ob.Asks)
			continue
		}

		// Calculate fill quantity
		remaining := buyOrder.Quantity - buyOrder.Filled
		available := bestAsk.Quantity - bestAsk.Filled
		fillQty := min(remaining, available)

		// Execute trade at ask price (ask price is the match price for incoming buy)
		tradePrice := bestAsk.Price
		trade := Trade{
			ID:          ob.nextTradeID(),
			Symbol:      ob.Symbol,
			BuyOrderID:  buyOrder.ID,
			SellOrderID: bestAsk.ID,
			Price:       tradePrice,
			Quantity:    fillQty,
			BuyerID:     buyOrder.TraderID,
			SellerID:    bestAsk.TraderID,
			// Stamped from the taker's logged arrival time, not time.Now(),
			// so a replay of the same WAL yields the same trade.
			ExecutedAt: buyOrder.SubmittedAt,
		}

		buyOrder.Filled += fillQty
		bestAsk.Filled += fillQty
		trades = append(trades, trade)

		// Remove ask if fully filled
		if bestAsk.Filled >= bestAsk.Quantity {
			bestAsk.Status = StatusFilled
			heap.Pop(ob.Asks)
		} else {
			bestAsk.Status = StatusPartiallyFilled
		}

		if buyOrder.Filled > 0 {
			buyOrder.Status = StatusPartiallyFilled
		}
	}

	return trades
}

// matchSell matches an incoming sell order against the bid side
func (ob *OrderBook) matchSell(sellOrder *Order) []Trade {
	var trades []Trade

	for ob.Bids.Len() > 0 && sellOrder.Filled < sellOrder.Quantity {
		bestBid := (*ob.Bids)[0]

		if sellOrder.Type == TypeLimit && sellOrder.Price > bestBid.Price {
			break
		}

		// Self-trade prevention, mirror of the buy side.
		if bestBid.TraderID == sellOrder.TraderID {
			bestBid.Status = StatusCanceled
			heap.Pop(ob.Bids)
			continue
		}

		remaining := sellOrder.Quantity - sellOrder.Filled
		available := bestBid.Quantity - bestBid.Filled
		fillQty := min(remaining, available)

		tradePrice := bestBid.Price
		trade := Trade{
			ID:          ob.nextTradeID(),
			Symbol:      ob.Symbol,
			BuyOrderID:  bestBid.ID,
			SellOrderID: sellOrder.ID,
			Price:       tradePrice,
			Quantity:    fillQty,
			BuyerID:     bestBid.TraderID,
			SellerID:    sellOrder.TraderID,
			ExecutedAt:  sellOrder.SubmittedAt,
		}

		sellOrder.Filled += fillQty
		bestBid.Filled += fillQty
		trades = append(trades, trade)

		if bestBid.Filled >= bestBid.Quantity {
			bestBid.Status = StatusFilled
			heap.Pop(ob.Bids)
		} else {
			bestBid.Status = StatusPartiallyFilled
		}

		if sellOrder.Filled > 0 {
			sellOrder.Status = StatusPartiallyFilled
		}
	}

	return trades
}

// CancelOrder removes an order from the book
func (ob *OrderBook) CancelOrder(orderID string) error {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	// Search bids
	for i, o := range *ob.Bids {
		if o.ID == orderID {
			(*ob.Bids)[i].Status = StatusCanceled
			heap.Remove(ob.Bids, i)
			return nil
		}
	}

	// Search asks
	for i, o := range *ob.Asks {
		if o.ID == orderID {
			(*ob.Asks)[i].Status = StatusCanceled
			heap.Remove(ob.Asks, i)
			return nil
		}
	}

	// Search stops that have not been elected yet. They are cancelable even
	// though they are not on the book.
	for i, o := range ob.stops {
		if o.ID == orderID {
			o.Status = StatusCanceled
			ob.stops = append(ob.stops[:i], ob.stops[i+1:]...)
			return nil
		}
	}

	return fmt.Errorf("order not found: %s", orderID)
}

// GetLevel2 returns the current order book state (top N levels)
func (ob *OrderBook) GetLevel2(levels int) (bids, asks []PriceLevel) {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	// Aggregate quantities at each price level for bids
	bidMap := make(map[int64]int64)
	for _, o := range *ob.Bids {
		if o.Status == StatusOpen || o.Status == StatusPartiallyFilled {
			bidMap[o.Price] += o.Quantity - o.Filled
		}
	}

	// Convert to sorted slice
	for price, qty := range bidMap {
		bids = append(bids, PriceLevel{Price: price, Quantity: qty})
	}
	sort.Slice(bids, func(i, j int) bool { return bids[i].Price > bids[j].Price })
	if len(bids) > levels {
		bids = bids[:levels]
	}

	// Asks
	askMap := make(map[int64]int64)
	for _, o := range *ob.Asks {
		if o.Status == StatusOpen || o.Status == StatusPartiallyFilled {
			askMap[o.Price] += o.Quantity - o.Filled
		}
	}
	for price, qty := range askMap {
		asks = append(asks, PriceLevel{Price: price, Quantity: qty})
	}
	sort.Slice(asks, func(i, j int) bool { return asks[i].Price < asks[j].Price })
	if len(asks) > levels {
		asks = asks[:levels]
	}

	return
}

type PriceLevel struct {
	Price    int64 `json:"price"`
	Quantity int64 `json:"quantity"`
}
```

### 2. Matching Engine Coordinator

The matching engine coordinator is responsible for managing all 10,000 order books and routing incoming orders to the correct one. The key design insight here is that each security symbol gets its own dedicated goroutine and channel, so orders for AAPL never compete with orders for GOOGL for lock access. This eliminates cross-symbol contention entirely. Just as important, it gives each book exactly one writer, which is what makes matching deterministic: parallelizing the matching of a single symbol would let two orders race for the same resting quantity and break price-time priority, so the parallelism here stops at the symbol boundary and never crosses it. Cancels ride the same channel as new orders for the same reason, since a cancel that bypassed the queue could remove an order the engine was already matching. The coordinator also writes every order to a write-ahead log (WAL) before matching, so the system can recover its full state by replaying the log after a crash.

```go
package orderbook

import (
	"container/heap"
	"context"
	"fmt"
	"time"
)

// OrderLog is the write-ahead log the engine commits to before it matches.
type OrderLog interface {
	Append(o *Order) error
	AppendCancel(symbol, orderID string) error
	AppendTrade(t Trade) error
}

// MarketDataPublisher receives book updates for broadcast to subscribers.
type MarketDataPublisher interface {
	PublishOrderBook(symbol string, bids, asks []PriceLevel)
}

// command is one unit of work for a symbol's goroutine. New orders and
// cancels travel down the same channel, so the engine's order of operations
// is exactly the channel's order. That is what makes a cancel racing a match
// resolve deterministically instead of by luck.
type command struct {
	order    *Order // set for a new order submission
	cancelID string // set for a cancel request
	result   chan error
}

// MatchingEngine manages order books for all securities
// Each security runs in its own goroutine (no cross-security contention)
type MatchingEngine struct {
	orderBooks map[string]*OrderBook // symbol → order book
	cmdCh      map[string]chan command
	tradeCh    chan Trade
	orderLog   OrderLog // WAL for persistence
	publisher  MarketDataPublisher
}

// NewMatchingEngine creates a matching engine for all listed securities.
// Both maps are built here and never written again, so the lookups in
// SubmitOrder and CancelOrder are safe without a lock.
func NewMatchingEngine(symbols []string, tradeCh chan Trade, orderLog OrderLog, publisher MarketDataPublisher) *MatchingEngine {
	me := &MatchingEngine{
		orderBooks: make(map[string]*OrderBook, len(symbols)),
		cmdCh:      make(map[string]chan command, len(symbols)),
		tradeCh:    tradeCh,
		orderLog:   orderLog,
		publisher:  publisher,
	}

	// One goroutine per security symbol: the only writer of that book
	for _, symbol := range symbols {
		ch := make(chan command, 10000)
		book := &OrderBook{
			Symbol: symbol,
			Bids:   &BidHeap{},
			Asks:   &AskHeap{},
		}
		heap.Init(book.Bids)
		heap.Init(book.Asks)
		me.orderBooks[symbol] = book
		me.cmdCh[symbol] = ch
		go me.processSymbol(symbol, book, ch)
	}

	return me
}

// processSymbol is a dedicated goroutine per security. It is the single
// writer for this book, which is what keeps matching deterministic: the
// sequence numbers it hands out are the sequence the trades replay in.
func (me *MatchingEngine) processSymbol(symbol string, book *OrderBook, cmds <-chan command) {
	for cmd := range cmds {
		if cmd.cancelID != "" {
			err := book.CancelOrder(cmd.cancelID)
			if err == nil {
				me.orderLog.AppendCancel(symbol, cmd.cancelID)
			}
			cmd.result <- err
			continue
		}

		// Write to WAL BEFORE matching. If the log write fails the order must
		// be rejected, not matched: a trade the log never saw cannot be
		// replayed, and the standby would rebuild a book that never existed.
		// Failing open here is how an exchange loses money it cannot find.
		if err := me.orderLog.Append(cmd.order); err != nil {
			cmd.result <- fmt.Errorf("wal append: %w", err)
			continue
		}

		trades, err := book.AddOrder(cmd.order)
		if err != nil {
			cmd.result <- err
			continue
		}
		cmd.result <- nil

		// Log each trade before publishing it. Market data may be lossy, the
		// audit trail may not.
		for _, t := range trades {
			me.orderLog.AppendTrade(t)
			me.tradeCh <- t
		}

		// Broadcast updated order book
		bids, asks := book.GetLevel2(10)
		me.publisher.PublishOrderBook(symbol, bids, asks)
	}
}

// SubmitOrder routes an order to the correct symbol's channel
func (me *MatchingEngine) SubmitOrder(ctx context.Context, order *Order) error {
	ch, ok := me.cmdCh[order.Symbol]
	if !ok {
		return fmt.Errorf("unknown symbol: %s", order.Symbol)
	}

	// Buffered so the engine never blocks handing back a result that a
	// timed-out submitter has stopped waiting for.
	cmd := command{order: order, result: make(chan error, 1)}

	timeout := time.NewTimer(10 * time.Millisecond)
	defer timeout.Stop()

	select {
	case ch <- cmd:
	case <-ctx.Done():
		return ctx.Err()
	case <-timeout.C:
		return fmt.Errorf("order submission timeout (engine overloaded)")
	}

	select {
	case err := <-cmd.result:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// CancelOrder cancels an existing order. The cancel is handled by the same
// goroutine that matches, so it either lands before the match (the order is
// pulled) or after it (the order is gone and this returns not-found). There
// is no window in which both happen.
func (me *MatchingEngine) CancelOrder(ctx context.Context, symbol, orderID string) error {
	ch, ok := me.cmdCh[symbol]
	if !ok {
		return fmt.Errorf("unknown symbol: %s", symbol)
	}

	cmd := command{cancelID: orderID, result: make(chan error, 1)}

	select {
	case ch <- cmd:
	case <-ctx.Done():
		return ctx.Err()
	}

	select {
	case err := <-cmd.result:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}
```

### 3. Market Data Service

The market data service is how traders see what is happening on the exchange in real time. Every time a trade executes or the order book changes, this service broadcasts updates over WebSocket connections to all subscribed clients. Subscribers choose which symbols they want to follow, and the service fans out messages only to interested parties. Because market data is inherently high-frequency, the service uses a "lossy" approach for slow consumers: if a subscriber's send buffer is full, the update is dropped rather than blocking the broadcast for everyone else.

Two simplifications here are worth naming, because a production feed does not look like this. First, the coordinator above rebuilds and republishes a full top-of-book snapshot after every order, which is O(n) over the book and would never survive 1M orders/sec. Real feeds publish incremental deltas (this price level changed by this much) and send a full snapshot only periodically or on request. Second, a lossy feed is only safe if a client can tell that it lost something, so every real feed stamps each message with a monotonic sequence number per symbol. A client that sees a gap knows its book is stale and re-syncs from the next snapshot rather than trading on a book it silently mis-assembled. The deep dives return to both points.

```go
package marketdata

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// MarketDataService broadcasts real-time market data
type MarketDataService struct {
	subscribers map[string][]*Subscriber // symbol → subscribers
	mu          sync.RWMutex
	upgrader    websocket.Upgrader
}

// NewMarketDataService builds the service. The subscriber map has to exist
// before the first subscribe, since writing to a nil map panics.
func NewMarketDataService() *MarketDataService {
	return &MarketDataService{
		subscribers: make(map[string][]*Subscriber),
	}
}

// Subscriber is a WebSocket connection subscribed to market data
type Subscriber struct {
	conn      *websocket.Conn
	symbols   map[string]bool
	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

func (sub *Subscriber) close() {
	sub.closeOnce.Do(func() { close(sub.done) })
}

// Trade represents a matched trade execution broadcast on the public tape.
type Trade struct {
	ID       string
	Symbol   string
	Price    int64
	Quantity int64
}

// PriceLevel represents an aggregate depth level in the market data feed.
type PriceLevel struct {
	Price    int64 `json:"price"`
	Quantity int64 `json:"quantity"`
	Orders   int   `json:"orders"`
}

// MarketDataMessage is a market data broadcast
type MarketDataMessage struct {
	Type    string `json:"type"`
	Symbol  string `json:"symbol"`
	Payload any    `json:"data"`
	Ts      int64  `json:"ts"`
}

// PublishTrade broadcasts a trade execution.
// The public feed carries price, size and time only. Counterparty identity is
// never published: knowing who is buying is exactly the information an
// exchange must not leak, and it is what the audit trail is for instead.
func (s *MarketDataService) PublishTrade(trade Trade) {
	msg := MarketDataMessage{
		Type:   "trade",
		Symbol: trade.Symbol,
		Payload: map[string]any{
			"trade_id": trade.ID,
			"price":    trade.Price,
			"quantity": trade.Quantity,
		},
		Ts: time.Now().UnixNano(),
	}
	s.broadcast(trade.Symbol, msg)
}

// PublishOrderBook broadcasts updated order book depth
func (s *MarketDataService) PublishOrderBook(symbol string, bids, asks []PriceLevel) {
	msg := MarketDataMessage{
		Type:   "orderbook",
		Symbol: symbol,
		Payload: map[string]any{
			"bids": bids,
			"asks": asks,
		},
		Ts: time.Now().UnixNano(),
	}
	s.broadcast(symbol, msg)
}

func (s *MarketDataService) broadcast(symbol string, msg MarketDataMessage) {
	data, _ := json.Marshal(msg)

	s.mu.RLock()
	subs := s.subscribers[symbol]
	s.mu.RUnlock()

	for _, sub := range subs {
		select {
		case sub.send <- data:
		default:
			// Slow consumer - drop message (market data can be lossy)
		}
	}
}

// HandleWebSocket handles WebSocket subscriptions for market data
func (s *MarketDataService) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	sub := &Subscriber{
		conn:    conn,
		symbols: make(map[string]bool),
		send:    make(chan []byte, 1000),
		done:    make(chan struct{}),
	}

	go sub.writePump()
	s.handleSubscriptions(sub)
}

func (s *MarketDataService) handleSubscriptions(sub *Subscriber) {
	// Signal writePump to exit, otherwise it parks on send forever and the
	// goroutine outlives the connection.
	defer sub.close()

	for {
		_, data, err := sub.conn.ReadMessage()
		if err != nil {
			break
		}

		var req struct {
			Action  string   `json:"action"` // subscribe, unsubscribe
			Symbols []string `json:"symbols"`
		}
		if err := json.Unmarshal(data, &req); err != nil {
			continue
		}

		switch req.Action {
		case "subscribe":
			for _, symbol := range req.Symbols {
				if sub.symbols[symbol] {
					continue // already subscribed, do not double-register
				}
				sub.symbols[symbol] = true
				s.mu.Lock()
				s.subscribers[symbol] = append(s.subscribers[symbol], sub)
				s.mu.Unlock()
			}
		case "unsubscribe":
			for _, symbol := range req.Symbols {
				delete(sub.symbols, symbol)
				s.removeSubscriber(symbol, sub)
			}
		}
	}

	// Cleanup on disconnect
	for symbol := range sub.symbols {
		s.removeSubscriber(symbol, sub)
	}
}

func (s *MarketDataService) removeSubscriber(symbol string, sub *Subscriber) {
	s.mu.Lock()
	defer s.mu.Unlock()
	subs := s.subscribers[symbol]
	for i, c := range subs {
		if c == sub {
			s.subscribers[symbol] = append(subs[:i], subs[i+1:]...)
			return
		}
	}
}

// writePump is the only goroutine that ever writes to this connection.
// gorilla/websocket permits one concurrent writer per connection, so every
// broadcast funnels through the send channel rather than touching conn.
func (sub *Subscriber) writePump() {
	defer sub.conn.Close()
	for {
		select {
		case msg := <-sub.send:
			if err := sub.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-sub.done:
			return
		}
	}
}
```

---
