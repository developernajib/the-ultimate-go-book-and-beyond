## Production Go Implementation: Order Matching Engine

This matching engine implements price-time priority with the full order lifecycle: limit, market, and stop-limit orders, partial fills, lazy cancellation, self-trade prevention, and deterministic replay. It is the engine core, and it still needs the WAL, the risk gateway, and the failover machinery from the deep dives around it before anything trades on it.

Four decisions in this code are worth arguing with, because each one is a place where the obvious version is wrong.

**Trades block, quotes drop.** `executeTrade` sends to the trade channel with a plain blocking send, while `publishSnapshot` uses `select` with a `default` that discards. That asymmetry is the entire lossy-versus-guaranteed distinction made concrete. A dropped snapshot is superseded a microsecond later. A dropped trade is an execution that happened, that two traders now have positions from, and that the exchange has no record of. When the trade consumer stalls, matching this symbol must stall with it.

**Cancellation is lazy, but the quote is not.** Removing an order from the middle of a heap means finding it first, so a cancel just marks the order dead and lets matching discard it later. The trap is that the tombstone is still sitting in the heap, so `heap.Len()` and `bids[0]` will happily report a canceled order as the best bid: a price the exchange has just promised it will not honor. Depth comes from live counters and the tops get pruned before publishing.

**The maker is passed in, not inferred.** It is tempting to say the lower sequence number is the resting order. Elected stop orders break that, and the code comment on `executeTrade` walks through how.

**Sequence numbers are per book.** A global counter across symbols would serialize every book through one atomic to produce a number that nothing compares across books, since priority only ever has meaning within a single order book.

```go
package matching

import (
	"container/heap"
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// --- Domain Types ---

type Side int

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

type OrderType int

const (
	OrderTypeLimit OrderType = iota
	OrderTypeMarket
	OrderTypeStopLimit
)

type OrderStatus int

const (
	StatusNew OrderStatus = iota
	StatusPartial
	StatusFilled
	StatusCanceled
	StatusPendingTrigger // stop-limit waiting for its stop price
)

// Order represents a single order in the exchange.
// All prices are in integer cents to avoid floating-point issues.
type Order struct {
	ID        string
	Symbol    string
	Side      Side
	Type      OrderType
	Price     int64 // in cents (e.g., 15050 = $150.50)
	StopPrice int64 // trigger price in cents, stop-limit only
	Quantity  int64 // total quantity
	Filled    int64 // cumulative filled
	Remaining int64 // quantity - filled
	TraderID  string
	Status    OrderStatus
	Timestamp time.Time // arrival time, stamped at ingress and logged
	SeqNum    int64     // monotonic sequence for deterministic ordering
}

// Trade represents an executed match between two orders.
type Trade struct {
	ID          string
	Symbol      string
	BuyOrderID  string
	SellOrderID string
	BuyerID     string
	SellerID    string
	Price       int64
	Quantity    int64
	Timestamp   time.Time
}

// --- Order Heaps (Price-Time Priority) ---

// BidHeap is a max-heap: highest price first, then earliest time
type BidHeap []*Order

func (h BidHeap) Len() int { return len(h) }
func (h BidHeap) Less(i, j int) bool {
	if h[i].Price == h[j].Price {
		return h[i].SeqNum < h[j].SeqNum // earlier order wins
	}
	return h[i].Price > h[j].Price // higher price wins for bids
}
func (h BidHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *BidHeap) Push(x any)   { *h = append(*h, x.(*Order)) }
func (h *BidHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return item
}

// AskHeap is a min-heap: lowest price first, then earliest time
type AskHeap []*Order

func (h AskHeap) Len() int { return len(h) }
func (h AskHeap) Less(i, j int) bool {
	if h[i].Price == h[j].Price {
		return h[i].SeqNum < h[j].SeqNum
	}
	return h[i].Price < h[j].Price // lower price wins for asks
}
func (h AskHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *AskHeap) Push(x any)   { *h = append(*h, x.(*Order)) }
func (h *AskHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return item
}

// --- Order Book ---

// OrderBook maintains the buy/sell heaps for a single symbol.
// Each symbol gets its own OrderBook running in a dedicated goroutine.
type OrderBook struct {
	symbol   string
	bids     BidHeap
	asks     AskHeap
	orderMap map[string]*Order // O(1) lookup by order ID for cancel
	seqGen   int64
	tradeSeq int64 // deterministic trade ID counter
	mu       sync.Mutex

	// Cancels are lazy: a canceled order keeps its slot in the heap until
	// matching walks over it. These counters track how many orders are
	// actually live, because heap.Len() counts the tombstones too and
	// publishing that as depth overstates the book.
	liveBids int
	liveAsks int

	// Stop-limit orders are not on the book and cannot trade until the market
	// prints at or through their stop price.
	stops     []*Order
	lastPrice int64
	hasLast   bool

	tradesCh  chan<- Trade
	metricsCh chan<- OrderBookSnapshot
}

// OrderBookSnapshot for market data publishing
type OrderBookSnapshot struct {
	Symbol    string
	BestBid   int64
	BestAsk   int64
	BidDepth  int
	AskDepth  int
	Timestamp time.Time
}

// NewOrderBook creates an order book for a single symbol.
func NewOrderBook(symbol string, tradesCh chan<- Trade, metricsCh chan<- OrderBookSnapshot) *OrderBook {
	ob := &OrderBook{
		symbol:    symbol,
		orderMap:  make(map[string]*Order),
		tradesCh:  tradesCh,
		metricsCh: metricsCh,
	}
	heap.Init(&ob.bids)
	heap.Init(&ob.asks)
	return ob
}

// SubmitOrder processes a new order: validate, match, rest remainder.
func (ob *OrderBook) SubmitOrder(order *Order) ([]Trade, error) {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	if order.Quantity <= 0 {
		return nil, fmt.Errorf("invalid quantity: %d", order.Quantity)
	}
	if order.Type == OrderTypeLimit && order.Price <= 0 {
		return nil, fmt.Errorf("limit order requires positive price")
	}
	if order.Type == OrderTypeStopLimit {
		if order.Price <= 0 {
			return nil, fmt.Errorf("stop-limit order requires positive limit price")
		}
		if order.StopPrice <= 0 {
			return nil, fmt.Errorf("stop-limit order requires positive stop price")
		}
	}

	ob.seqGen++
	order.SeqNum = ob.seqGen
	order.Remaining = order.Quantity
	order.Status = StatusNew

	// Stamp arrival only if the caller did not. A replayed order carries the
	// timestamp the WAL recorded, and overwriting it with time.Now() would
	// make recovery produce trades that differ from the originals.
	if order.Timestamp.IsZero() {
		order.Timestamp = time.Now()
	}

	// A stop-limit waits off-book until the market reaches its stop price.
	// Matching it on arrival would fill it against whatever is resting now,
	// which is the opposite of what the trader asked for.
	if order.Type == OrderTypeStopLimit && !ob.triggered(order) {
		order.Status = StatusPendingTrigger
		ob.stops = append(ob.stops, order)
		ob.publishSnapshot()
		return nil, nil
	}

	trades := ob.matchAndRest(order)

	// Those prints may elect resting stops, whose own prints may elect more.
	trades = append(trades, ob.releaseStops()...)

	ob.publishSnapshot()
	return trades, nil
}

// matchAndRest matches a live order and rests whatever is left.
func (ob *OrderBook) matchAndRest(order *Order) []Trade {
	var trades []Trade

	switch order.Side {
	case SideBuy:
		trades = ob.matchBuy(order)
	case SideSell:
		trades = ob.matchSell(order)
	}

	if len(trades) > 0 {
		ob.lastPrice = trades[len(trades)-1].Price
		ob.hasLast = true
	}

	// Rest remaining quantity on book. An elected stop-limit is a limit order
	// from here on, so it rests like one.
	switch {
	case order.Remaining > 0 && (order.Type == OrderTypeLimit || order.Type == OrderTypeStopLimit):
		ob.addToBook(order)
	case order.Remaining > 0 && order.Type == OrderTypeMarket:
		order.Status = StatusCanceled
	}

	return trades
}

// triggered reports whether the market has printed at or through the stop
// price. Buy stops elect on the way up, sell stops on the way down.
func (ob *OrderBook) triggered(o *Order) bool {
	if !ob.hasLast {
		return false
	}
	if o.Side == SideBuy {
		return ob.lastPrice >= o.StopPrice
	}
	return ob.lastPrice <= o.StopPrice
}

// releaseStops elects every stop the last price has reached, in submission
// order so that two stops at the same stop price keep time priority.
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

		sort.Slice(elected, func(i, j int) bool { return elected[i].SeqNum < elected[j].SeqNum })
		for _, s := range elected {
			s.Status = StatusNew
			trades = append(trades, ob.matchAndRest(s)...)
		}
	}
}

func (ob *OrderBook) matchBuy(buyOrder *Order) []Trade {
	var trades []Trade
	for ob.asks.Len() > 0 && buyOrder.Remaining > 0 {
		bestAsk := ob.asks[0]
		if bestAsk.Remaining == 0 {
			heap.Pop(&ob.asks) // tombstone from a cancel, already uncounted
			continue
		}
		// An elected stop-limit matches on its limit price like any limit.
		if buyOrder.Type != OrderTypeMarket && buyOrder.Price < bestAsk.Price {
			break
		}
		// Self-trade prevention: never cross a trader with their own resting
		// order. Pull the resting side and match the next one.
		if bestAsk.TraderID == buyOrder.TraderID {
			bestAsk.Status = StatusCanceled
			bestAsk.Remaining = 0
			heap.Pop(&ob.asks)
			delete(ob.orderMap, bestAsk.ID)
			ob.liveAsks--
			continue
		}
		trade := ob.executeTrade(buyOrder, bestAsk) // taker, maker
		trades = append(trades, trade)
		if bestAsk.Remaining == 0 {
			heap.Pop(&ob.asks)
			delete(ob.orderMap, bestAsk.ID)
			ob.liveAsks--
		}
	}
	return trades
}

func (ob *OrderBook) matchSell(sellOrder *Order) []Trade {
	var trades []Trade
	for ob.bids.Len() > 0 && sellOrder.Remaining > 0 {
		bestBid := ob.bids[0]
		if bestBid.Remaining == 0 {
			heap.Pop(&ob.bids) // tombstone from a cancel, already uncounted
			continue
		}
		if sellOrder.Type != OrderTypeMarket && sellOrder.Price > bestBid.Price {
			break
		}
		// Self-trade prevention, mirror of the buy side.
		if bestBid.TraderID == sellOrder.TraderID {
			bestBid.Status = StatusCanceled
			bestBid.Remaining = 0
			heap.Pop(&ob.bids)
			delete(ob.orderMap, bestBid.ID)
			ob.liveBids--
			continue
		}
		trade := ob.executeTrade(sellOrder, bestBid) // taker, maker
		trades = append(trades, trade)
		if bestBid.Remaining == 0 {
			heap.Pop(&ob.bids)
			delete(ob.orderMap, bestBid.ID)
			ob.liveBids--
		}
	}
	return trades
}

// executeTrade fills taker against maker.
//
// The maker is passed in explicitly rather than inferred, and that matters.
// The obvious shortcut is to call the lower sequence number the maker, since
// the order that arrived first must be the one resting. That holds right up
// until a stop order is elected: it keeps the sequence number it was
// submitted with, which is older than the resting orders it now crosses, so
// the shortcut names the aggressor as the maker and prints at its limit
// instead of the offer. A stop-limit buy capped at $107 would fill at $107
// against a resting $106 offer, and the trader is out a dollar a share on an
// order the book could have filled better. The caller always knows which side
// came off the book, so it says so.
func (ob *OrderBook) executeTrade(taker, maker *Order) Trade {
	qty := min(taker.Remaining, maker.Remaining)

	// The resting order set the terms, the taker crossed the spread to accept
	// them. This is also why a market order, which carries no price of its
	// own, always prints at the resting side.
	price := maker.Price

	taker.Filled += qty
	taker.Remaining -= qty
	maker.Filled += qty
	maker.Remaining -= qty

	for _, o := range [2]*Order{taker, maker} {
		if o.Remaining == 0 {
			o.Status = StatusFilled
		} else {
			o.Status = StatusPartial
		}
	}

	buyOrder, sellOrder := taker, maker
	if taker.Side == SideSell {
		buyOrder, sellOrder = maker, taker
	}

	// Both the ID and the timestamp are derived from state the WAL already
	// holds, never from the wall clock. A trade ID built from time.Now() and
	// a timestamp read at match time would differ on every replay, so the
	// standby would rebuild a book of trades that do not match the originals
	// even though every fill was identical.
	ob.tradeSeq++
	trade := Trade{
		ID:          fmt.Sprintf("T-%s-%d", ob.symbol, ob.tradeSeq),
		Symbol:      ob.symbol,
		BuyOrderID:  buyOrder.ID,
		SellOrderID: sellOrder.ID,
		BuyerID:     buyOrder.TraderID,
		SellerID:    sellOrder.TraderID,
		Price:       price,
		Quantity:    qty,
		Timestamp:   taker.Timestamp,
	}

	// Blocking send, deliberately. The tempting `select` with a `default`
	// that drops the trade when the buffer is full does not shed load, it
	// destroys an execution that already happened: two traders have a
	// position the exchange has no record of. If the trade consumer cannot
	// keep up, the correct behavior is to stop matching this symbol and let
	// the backpressure reach the gateway. Market data may be lossy. Trades
	// may not.
	ob.tradesCh <- trade
	return trade
}

func (ob *OrderBook) addToBook(order *Order) {
	ob.orderMap[order.ID] = order
	if order.Side == SideBuy {
		heap.Push(&ob.bids, order)
		ob.liveBids++
	} else {
		heap.Push(&ob.asks, order)
		ob.liveAsks++
	}
}

// CancelOrder removes an order from the book using lazy deletion: the order
// is marked dead and left in the heap for matching to discard when it walks
// past it, which avoids an O(n) search for its heap index.
func (ob *OrderBook) CancelOrder(orderID string) error {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	order, exists := ob.orderMap[orderID]
	if !exists {
		// Either never existed, or already filled. Both are "too late to
		// cancel", which is the correct answer to a cancel that lost the race
		// with a match.
		return fmt.Errorf("order not found: %s", orderID)
	}
	order.Status = StatusCanceled
	order.Remaining = 0
	delete(ob.orderMap, orderID)

	if order.Side == SideBuy {
		ob.liveBids--
	} else {
		ob.liveAsks--
	}

	ob.pruneTops()
	return nil
}

// pruneTops discards lazily-canceled orders sitting at the top of either
// heap. Without it the published best bid or ask can be the price of an order
// that no longer exists, which is a quote the exchange cannot honor.
func (ob *OrderBook) pruneTops() {
	for ob.bids.Len() > 0 && ob.bids[0].Remaining == 0 {
		heap.Pop(&ob.bids)
	}
	for ob.asks.Len() > 0 && ob.asks[0].Remaining == 0 {
		heap.Pop(&ob.asks)
	}
}

func (ob *OrderBook) publishSnapshot() {
	ob.pruneTops()

	// Depth comes from the live counters, not heap.Len(), which still counts
	// canceled tombstones that have not been walked over yet.
	snap := OrderBookSnapshot{
		Symbol:    ob.symbol,
		BidDepth:  ob.liveBids,
		AskDepth:  ob.liveAsks,
		Timestamp: time.Now(),
	}
	if ob.bids.Len() > 0 {
		snap.BestBid = ob.bids[0].Price
	}
	if ob.asks.Len() > 0 {
		snap.BestAsk = ob.asks[0].Price
	}

	// Metrics and quotes may be dropped under load: the next snapshot
	// supersedes this one. Contrast executeTrade, where dropping is illegal.
	select {
	case ob.metricsCh <- snap:
	default:
	}
}

// --- Matching Engine Coordinator ---

type MatchingEngine struct {
	books     map[string]*OrderBook
	mu        sync.RWMutex
	tradesCh  chan Trade
	metricsCh chan OrderBookSnapshot
}

func NewMatchingEngine(tradeBufferSize int) *MatchingEngine {
	return &MatchingEngine{
		books:     make(map[string]*OrderBook),
		tradesCh:  make(chan Trade, tradeBufferSize),
		metricsCh: make(chan OrderBookSnapshot, 1000),
	}
}

func (me *MatchingEngine) getOrCreateBook(symbol string) *OrderBook {
	me.mu.RLock()
	book, exists := me.books[symbol]
	me.mu.RUnlock()
	if exists {
		return book
	}
	me.mu.Lock()
	defer me.mu.Unlock()
	if book, exists = me.books[symbol]; exists {
		return book
	}
	book = NewOrderBook(symbol, me.tradesCh, me.metricsCh)
	me.books[symbol] = book
	return book
}

// Submit routes an order to its symbol's book.
//
// Sequence numbers are assigned by the book, not here. A global counter would
// be both useless and misleading: price-time priority is only ever compared
// within one book, and an engine-wide atomic would serialize every symbol
// through one cache line to produce a number nothing reads across books.
func (me *MatchingEngine) Submit(ctx context.Context, order *Order) ([]Trade, error) {
	book := me.getOrCreateBook(order.Symbol)
	return book.SubmitOrder(order)
}

func (me *MatchingEngine) Cancel(ctx context.Context, symbol, orderID string) error {
	me.mu.RLock()
	book, exists := me.books[symbol]
	me.mu.RUnlock()
	if !exists {
		return fmt.Errorf("no book for symbol: %s", symbol)
	}
	return book.CancelOrder(orderID)
}

func (me *MatchingEngine) Trades() <-chan Trade {
	return me.tradesCh
}
```

---
