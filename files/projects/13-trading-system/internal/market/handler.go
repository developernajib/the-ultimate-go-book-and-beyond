// internal/market/handler.go
package market

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/example/trading-system/internal/orderbook"
	"github.com/example/trading-system/pkg/types"
)

// Handler processes market data feeds
type Handler struct {
	// Order books
	orderBooks map[types.Symbol]*orderbook.OrderBook
	mu         sync.RWMutex

	// Market data channels
	trades chan *types.Trade
	quotes chan *types.Quote
	books  chan *types.OrderBook

	// Subscribers
	tradeSubscribers map[types.Symbol][]TradeSubscriber
	quoteSubscribers map[types.Symbol][]QuoteSubscriber
	bookSubscribers  map[types.Symbol][]BookSubscriber
	subMu            sync.RWMutex

	// Statistics
	stats *Statistics

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// TradeSubscriber receives trade updates
type TradeSubscriber interface {
	OnTrade(*types.Trade)
}

// QuoteSubscriber receives quote updates
type QuoteSubscriber interface {
	OnQuote(*types.Quote)
}

// BookSubscriber receives order book updates
type BookSubscriber interface {
	OnBook(*types.OrderBook)
}

// Statistics tracks market data statistics
type Statistics struct {
	TradesProcessed   atomic.Uint64
	QuotesProcessed   atomic.Uint64
	BooksProcessed    atomic.Uint64
	UpdatesPerSecond  atomic.Uint64
	AvgLatencyMicros  atomic.Uint64
	LastUpdateTime    atomic.Value // time.Time
}

// NewHandler creates a new market data handler
func NewHandler() *Handler {
	ctx, cancel := context.WithCancel(context.Background())

	h := &Handler{
		orderBooks:       make(map[types.Symbol]*orderbook.OrderBook),
		trades:           make(chan *types.Trade, 100000),
		quotes:           make(chan *types.Quote, 100000),
		books:            make(chan *types.OrderBook, 10000),
		tradeSubscribers: make(map[types.Symbol][]TradeSubscriber),
		quoteSubscribers: make(map[types.Symbol][]QuoteSubscriber),
		bookSubscribers:  make(map[types.Symbol][]BookSubscriber),
		stats:            &Statistics{},
		ctx:              ctx,
		cancel:           cancel,
	}

	h.stats.LastUpdateTime.Store(time.Now())

	return h
}

// Start starts the market data handler
func (h *Handler) Start() error {
	// Start processing goroutines
	h.wg.Add(3)
	go h.processTrades()
	go h.processQuotes()
	go h.processBooks()

	// Start statistics updater
	h.wg.Add(1)
	go h.updateStatistics()

	return nil
}

// Stop stops the market data handler
func (h *Handler) Stop() error {
	h.cancel()
	h.wg.Wait()
	return nil
}

// ProcessTrade processes a trade update
func (h *Handler) ProcessTrade(trade *types.Trade) {
	select {
	case h.trades <- trade:
	case <-h.ctx.Done():
	default:
		// Drop trade if channel is full (circuit breaker)
	}
}

// ProcessQuote processes a quote update
func (h *Handler) ProcessQuote(quote *types.Quote) {
	select {
	case h.quotes <- quote:
	case <-h.ctx.Done():
	default:
		// Drop quote if channel is full
	}
}

// ProcessBook processes an order book update
func (h *Handler) ProcessBook(book *types.OrderBook) {
	select {
	case h.books <- book:
	case <-h.ctx.Done():
	default:
		// Drop book update if channel is full
	}
}

// SubscribeTrades subscribes to trade updates for a symbol
func (h *Handler) SubscribeTrades(symbol types.Symbol, subscriber TradeSubscriber) {
	h.subMu.Lock()
	defer h.subMu.Unlock()

	h.tradeSubscribers[symbol] = append(h.tradeSubscribers[symbol], subscriber)
}

// SubscribeQuotes subscribes to quote updates for a symbol
func (h *Handler) SubscribeQuotes(symbol types.Symbol, subscriber QuoteSubscriber) {
	h.subMu.Lock()
	defer h.subMu.Unlock()

	h.quoteSubscribers[symbol] = append(h.quoteSubscribers[symbol], subscriber)
}

// SubscribeBooks subscribes to order book updates for a symbol
func (h *Handler) SubscribeBooks(symbol types.Symbol, subscriber BookSubscriber) {
	h.subMu.Lock()
	defer h.subMu.Unlock()

	h.bookSubscribers[symbol] = append(h.bookSubscribers[symbol], subscriber)
}

// GetOrderBook returns the current order book for a symbol
func (h *Handler) GetOrderBook(symbol types.Symbol) *orderbook.OrderBook {
	h.mu.RLock()
	defer h.mu.RUnlock()

	return h.orderBooks[symbol]
}

// GetQuote returns the current quote for a symbol
func (h *Handler) GetQuote(symbol types.Symbol) *types.Quote {
	h.mu.RLock()
	book := h.orderBooks[symbol]
	h.mu.RUnlock()

	if book == nil {
		return nil
	}

	return book.GetQuote()
}

// processTrades processes trade updates
func (h *Handler) processTrades() {
	defer h.wg.Done()

	for {
		select {
		case <-h.ctx.Done():
			return

		case trade := <-h.trades:
			start := time.Now()

			// Update statistics
			h.stats.TradesProcessed.Add(1)

			// Notify subscribers
			h.subMu.RLock()
			subscribers := h.tradeSubscribers[trade.Symbol]
			h.subMu.RUnlock()

			for _, sub := range subscribers {
				sub.OnTrade(trade)
			}

			// Record latency
			latency := time.Since(start).Microseconds()
			h.stats.AvgLatencyMicros.Store(uint64(latency))
		}
	}
}

// processQuotes processes quote updates
func (h *Handler) processQuotes() {
	defer h.wg.Done()

	for {
		select {
		case <-h.ctx.Done():
			return

		case quote := <-h.quotes:
			start := time.Now()

			// Update statistics
			h.stats.QuotesProcessed.Add(1)

			// Notify subscribers
			h.subMu.RLock()
			subscribers := h.quoteSubscribers[quote.Symbol]
			h.subMu.RUnlock()

			for _, sub := range subscribers {
				sub.OnQuote(quote)
			}

			// Record latency
			latency := time.Since(start).Microseconds()
			h.stats.AvgLatencyMicros.Store(uint64(latency))
		}
	}
}

// processBooks processes order book updates
func (h *Handler) processBooks() {
	defer h.wg.Done()

	for {
		select {
		case <-h.ctx.Done():
			return

		case book := <-h.books:
			start := time.Now()

			// Update statistics
			h.stats.BooksProcessed.Add(1)

			// Update internal order book
			h.updateOrderBook(book)

			// Notify subscribers
			h.subMu.RLock()
			subscribers := h.bookSubscribers[book.Symbol]
			h.subMu.RUnlock()

			for _, sub := range subscribers {
				sub.OnBook(book)
			}

			// Record latency
			latency := time.Since(start).Microseconds()
			h.stats.AvgLatencyMicros.Store(uint64(latency))
		}
	}
}

// updateOrderBook updates the internal order book
func (h *Handler) updateOrderBook(book *types.OrderBook) {
	h.mu.Lock()
	defer h.mu.Unlock()

	existingBook, exists := h.orderBooks[book.Symbol]
	if !exists {
		// Create new order book
		existingBook = orderbook.NewOrderBook(book.Symbol)
		h.orderBooks[book.Symbol] = existingBook
	}

	// In a real implementation, we'd apply incremental updates
	// For this example, we'll update the cached snapshot
	// This is simplified - production systems use delta updates
}

// updateStatistics updates per-second statistics
func (h *Handler) updateStatistics() {
	defer h.wg.Done()

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	var lastTrades, lastQuotes, lastBooks uint64

	for {
		select {
		case <-h.ctx.Done():
			return

		case <-ticker.C:
			trades := h.stats.TradesProcessed.Load()
			quotes := h.stats.QuotesProcessed.Load()
			books := h.stats.BooksProcessed.Load()

			updatesPerSecond := (trades - lastTrades) +
				(quotes - lastQuotes) +
				(books - lastBooks)

			h.stats.UpdatesPerSecond.Store(updatesPerSecond)
			h.stats.LastUpdateTime.Store(time.Now())

			lastTrades = trades
			lastQuotes = quotes
			lastBooks = books
		}
	}
}

// GetStatistics returns current statistics
func (h *Handler) GetStatistics() *Statistics {
	return h.stats
}
