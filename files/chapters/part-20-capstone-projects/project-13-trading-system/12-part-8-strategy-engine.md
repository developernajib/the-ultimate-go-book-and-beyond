## Part 8: Strategy Engine

The strategy engine executes trading strategies with backtesting support. A trading strategy is an algorithm that analyzes market data and decides when to buy or sell. The strategy engine provides the framework for running these algorithms in real-time while also supporting backtesting, which means replaying historical market data to see how a strategy would have performed in the past. This dual-mode design is essential because you should never deploy a strategy to live markets without first validating it against historical data. The engine uses Go interfaces to define a common strategy contract, making it easy to plug in new strategies without modifying the core system.

```go
// internal/strategy/engine.go
package strategy

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/yourusername/trading-system/pkg/types"
)

// Strategy defines a trading strategy interface
type Strategy interface {
	// Initialize prepares the strategy
	Initialize(ctx context.Context, config map[string]any) error

	// OnQuote processes quote updates
	OnQuote(quote *types.Quote) ([]*types.Signal, error)

	// OnTrade processes trade updates
	OnTrade(trade *types.Trade) ([]*types.Signal, error)

	// OnBook processes order book updates
	OnBook(book *types.OrderBook) ([]*types.Signal, error)

	// OnFill processes fill notifications
	OnFill(fill *types.Fill) error

	// GetID returns strategy ID
	GetID() string

	// GetSymbols returns symbols the strategy trades
	GetSymbols() []types.Symbol
}

// Engine manages trading strategies
type Engine struct {
	strategies map[string]Strategy
	mu         sync.RWMutex

	// Signal output
	signals chan *types.Signal

	// Mode
	mode Mode

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Mode defines strategy execution mode
type Mode int

const (
	ModeLive Mode = iota
	ModePaper
	ModeBacktest
)

// NewEngine creates a new strategy engine
func NewEngine(mode Mode) *Engine {
	ctx, cancel := context.WithCancel(context.Background())

	return &Engine{
		strategies: make(map[string]Strategy),
		signals:    make(chan *types.Signal, 10000),
		mode:       mode,
		ctx:        ctx,
		cancel:     cancel,
	}
}

// Start starts the strategy engine
func (e *Engine) Start() error {
	e.wg.Add(1)
	go e.processSignals()

	return nil
}

// Stop stops the strategy engine
func (e *Engine) Stop() error {
	e.cancel()
	e.wg.Wait()
	return nil
}

// AddStrategy adds a strategy to the engine
func (e *Engine) AddStrategy(strategy Strategy) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	id := strategy.GetID()
	if _, exists := e.strategies[id]; exists {
		return fmt.Errorf("strategy %s already exists", id)
	}

	e.strategies[id] = strategy

	return nil
}

// RemoveStrategy removes a strategy from the engine
func (e *Engine) RemoveStrategy(id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if _, exists := e.strategies[id]; !exists {
		return fmt.Errorf("strategy %s not found", id)
	}

	delete(e.strategies, id)

	return nil
}

// OnQuote distributes quote updates to strategies
func (e *Engine) OnQuote(quote *types.Quote) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	for _, strategy := range e.strategies {
		// Check if strategy trades this symbol
		if !e.tradesSymbol(strategy, quote.Symbol) {
			continue
		}

		signals, err := strategy.OnQuote(quote)
		if err != nil {
			// Log error
			continue
		}

		// Publish signals
		for _, signal := range signals {
			select {
			case e.signals <- signal:
			case <-e.ctx.Done():
				return
			default:
				// Drop signal if channel is full
			}
		}
	}
}

// OnTrade distributes trade updates to strategies
func (e *Engine) OnTrade(trade *types.Trade) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	for _, strategy := range e.strategies {
		if !e.tradesSymbol(strategy, trade.Symbol) {
			continue
		}

		signals, err := strategy.OnTrade(trade)
		if err != nil {
			continue
		}

		for _, signal := range signals {
			select {
			case e.signals <- signal:
			case <-e.ctx.Done():
				return
			default:
			}
		}
	}
}

// OnBook distributes order book updates to strategies
func (e *Engine) OnBook(book *types.OrderBook) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	for _, strategy := range e.strategies {
		if !e.tradesSymbol(strategy, book.Symbol) {
			continue
		}

		signals, err := strategy.OnBook(book)
		if err != nil {
			continue
		}

		for _, signal := range signals {
			select {
			case e.signals <- signal:
			case <-e.ctx.Done():
				return
			default:
			}
		}
	}
}

// GetSignals returns the signal channel
func (e *Engine) GetSignals() <-chan *types.Signal {
	return e.signals
}

// processSignals processes generated signals
func (e *Engine) processSignals() {
	defer e.wg.Done()

	for {
		select {
		case <-e.ctx.Done():
			return

		case signal := <-e.signals:
			// In paper/backtest mode, signals would be logged
			// In live mode, they'd be converted to orders
			e.handleSignal(signal)
		}
	}
}

// handleSignal processes a trading signal
func (e *Engine) handleSignal(signal *types.Signal) {
	switch e.mode {
	case ModeLive:
		// Convert to order and submit
		// This would integrate with the order manager

	case ModePaper:
		// Simulate order execution
		// Track paper trading performance

	case ModeBacktest:
		// Record signal for backtesting
	}
}

// tradesSymbol checks if strategy trades a symbol
func (e *Engine) tradesSymbol(strategy Strategy, symbol types.Symbol) bool {
	symbols := strategy.GetSymbols()
	for _, s := range symbols {
		if s == symbol {
			return true
		}
	}
	return false
}

// Example Strategy: Market Making
type MarketMaker struct {
	id      string
	symbols []types.Symbol

	// Strategy parameters
	spread       types.Price
	orderSize    types.Quantity
	maxPosition  types.Quantity

	// State
	position     map[types.Symbol]types.Quantity
	lastQuote    map[types.Symbol]*types.Quote
	mu           sync.RWMutex
}

// NewMarketMaker creates a market making strategy
func NewMarketMaker(id string, symbols []types.Symbol, spread types.Price, orderSize types.Quantity) *MarketMaker {
	return &MarketMaker{
		id:          id,
		symbols:     symbols,
		spread:      spread,
		orderSize:   orderSize,
		maxPosition: types.NewQuantity(100),
		position:    make(map[types.Symbol]types.Quantity),
		lastQuote:   make(map[types.Symbol]*types.Quote),
	}
}

// Initialize implements Strategy
func (mm *MarketMaker) Initialize(ctx context.Context, config map[string]any) error {
	// Load configuration
	if spread, ok := config["spread"].(float64); ok {
		mm.spread = types.NewPrice(spread)
	}

	if orderSize, ok := config["order_size"].(float64); ok {
		mm.orderSize = types.NewQuantity(orderSize)
	}

	return nil
}

// OnQuote implements Strategy
func (mm *MarketMaker) OnQuote(quote *types.Quote) ([]*types.Signal, error) {
	mm.mu.Lock()
	mm.lastQuote[quote.Symbol] = quote
	position := mm.position[quote.Symbol]
	mm.mu.Unlock()

	var signals []*types.Signal

	// Calculate fair value (mid price)
	midPrice := (quote.BidPrice + quote.AskPrice) / 2

	// Generate buy signal if position not too long
	if position < mm.maxPosition {
		buyPrice := midPrice - mm.spread/2
		signals = append(signals, &types.Signal{
			StrategyID: mm.id,
			Symbol:     quote.Symbol,
			Side:       types.SideBuy,
			Price:      buyPrice,
			Quantity:   mm.orderSize,
			Confidence: 0.8,
			Timestamp:  time.Now(),
		})
	}

	// Generate sell signal if position not too short
	if position > -mm.maxPosition {
		sellPrice := midPrice + mm.spread/2
		signals = append(signals, &types.Signal{
			StrategyID: mm.id,
			Symbol:     quote.Symbol,
			Side:       types.SideSell,
			Price:      sellPrice,
			Quantity:   mm.orderSize,
			Confidence: 0.8,
			Timestamp:  time.Now(),
		})
	}

	return signals, nil
}

// OnTrade implements Strategy
func (mm *MarketMaker) OnTrade(trade *types.Trade) ([]*types.Signal, error) {
	// Market makers might adjust quotes based on trade flow
	return nil, nil
}

// OnBook implements Strategy
func (mm *MarketMaker) OnBook(book *types.OrderBook) ([]*types.Signal, error) {
	// Could use book imbalance for signal generation
	return nil, nil
}

// OnFill implements Strategy
func (mm *MarketMaker) OnFill(fill *types.Fill) error {
	mm.mu.Lock()
	defer mm.mu.Unlock()

	// Update position
	if fill.Side == types.SideBuy {
		mm.position[fill.Symbol] += fill.Quantity
	} else {
		mm.position[fill.Symbol] -= fill.Quantity
	}

	return nil
}

// GetID implements Strategy
func (mm *MarketMaker) GetID() string {
	return mm.id
}

// GetSymbols implements Strategy
func (mm *MarketMaker) GetSymbols() []types.Symbol {
	return mm.symbols
}
```
