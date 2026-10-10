## Part 12: Main Application

Putting it all together in the main trading application. The `main` function is where all the components we have built so far get wired together and started in the correct order. It reads configuration, initializes dependencies (database connections, exchange connectors, memory pools), creates each subsystem, and launches them as concurrent goroutines. Graceful shutdown is especially important here: when the application receives a termination signal, it must stop accepting new orders, wait for in-flight orders to complete, flush pending data to the database, and close exchange connections cleanly to avoid orphaned orders on external exchanges.

```go
// cmd/trader/main.go
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/yourusername/trading-system/internal/exchange"
	"github.com/yourusername/trading-system/internal/market"
	"github.com/yourusername/trading-system/internal/metrics"
	"github.com/yourusername/trading-system/internal/orders"
	"github.com/yourusername/trading-system/internal/persistence"
	"github.com/yourusername/trading-system/internal/risk"
	"github.com/yourusername/trading-system/internal/strategy"
	"github.com/yourusername/trading-system/pkg/types"
)

// TradingSystem is the main trading system application
type TradingSystem struct {
	// Core components
	orderManager   *orders.Manager
	riskManager    *risk.Manager
	marketHandler  *market.Handler
	strategyEngine *strategy.Engine
	repository     *persistence.Repository
	collector      *metrics.Collector

	// Exchange connectors
	connectors map[string]exchange.Connector

	// Configuration
	config *Config

	// Context
	ctx    context.Context
	cancel context.CancelFunc
}

// Config holds system configuration
type Config struct {
	// Database
	DatabaseURL string

	// Exchange
	ExchangeURL    string
	ExchangeAPIKey string
	ExchangeSecret string

	// Risk
	MaxOrderSize     types.Quantity
	MaxPositionSize  types.Quantity
	MaxDailyLoss     types.Price

	// System
	MetricsPort      int
	GCPercent        int
	MaxGoroutines    int
	EnableCPUProfile bool
}

func main() {
	// Load configuration
	config := loadConfig()

	// Optimize Go runtime for low latency
	optimizeRuntime(config)

	// Create trading system
	system, err := NewTradingSystem(config)
	if err != nil {
		log.Fatalf("Failed to create trading system: %v", err)
	}

	// Start the system
	if err := system.Start(); err != nil {
		log.Fatalf("Failed to start trading system: %v", err)
	}

	log.Println("Trading system started successfully")

	// Wait for shutdown signal
	system.WaitForShutdown()

	// Graceful shutdown
	if err := system.Stop(); err != nil {
		log.Printf("Error during shutdown: %v", err)
	}

	log.Println("Trading system stopped")
}

// NewTradingSystem creates a new trading system
func NewTradingSystem(config *Config) (*TradingSystem, error) {
	ctx, cancel := context.WithCancel(context.Background())

	// Initialize components
	orderManager := orders.NewManager()
	riskManager := risk.NewManager(&risk.Config{
		EnablePreTradeRisk:  true,
		EnablePostTradeRisk: true,
		MaxOrderSize:        config.MaxOrderSize,
		MaxPositionSize:     config.MaxPositionSize,
		MaxDailyLoss:        config.MaxDailyLoss,
	})
	marketHandler := market.NewHandler()
	strategyEngine := strategy.NewEngine(strategy.ModeLive)
	collector := metrics.NewCollector()

	// Initialize persistence
	repository, err := persistence.NewRepository(config.DatabaseURL)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to initialize repository: %w", err)
	}

	// Create exchange connector
	connector := exchange.NewWebSocketConnector(
		"main",
		config.ExchangeURL,
		config.ExchangeAPIKey,
		config.ExchangeSecret,
	)

	system := &TradingSystem{
		orderManager:   orderManager,
		riskManager:    riskManager,
		marketHandler:  marketHandler,
		strategyEngine: strategyEngine,
		repository:     repository,
		collector:      collector,
		connectors:     map[string]exchange.Connector{"main": connector},
		config:         config,
		ctx:            ctx,
		cancel:         cancel,
	}

	// Wire up components
	system.wireComponents()

	return system, nil
}

// wireComponents connects all components together
func (ts *TradingSystem) wireComponents() {
	// Market data flow: Exchange -> Market Handler -> Strategy Engine
	connector := ts.connectors["main"]

	connector.OnTrade(func(trade *types.Trade) {
		start := time.Now()
		ts.marketHandler.ProcessTrade(trade)
		ts.collector.RecordMarketDataLatency(time.Since(start))
		ts.collector.RecordTradeProcessed()
	})

	connector.OnQuote(func(quote *types.Quote) {
		start := time.Now()
		ts.marketHandler.ProcessQuote(quote)
		ts.collector.RecordMarketDataLatency(time.Since(start))
		ts.collector.RecordQuoteProcessed()
	})

	connector.OnBook(func(book *types.OrderBook) {
		start := time.Now()
		ts.marketHandler.ProcessBook(book)
		ts.collector.RecordMarketDataLatency(time.Since(start))
		ts.collector.RecordBookProcessed()
	})

	// Subscribe strategy engine to market data
	ts.marketHandler.SubscribeQuotes("BTC/USD", ts.strategyEngine)
	ts.marketHandler.SubscribeTrades("BTC/USD", ts.strategyEngine)

	// Order flow: Strategy -> Risk -> Order Manager -> Exchange
	go ts.processSignals()

	// Fill flow: Exchange -> Order Manager -> Risk Manager -> Strategy
	connector.OnFill(func(fill *types.Fill) {
		start := time.Now()

		// Update order manager
		ts.orderManager.OnFill([]risk.FillHandler{
			func(f *types.Fill) {
				// Persist fill
				if err := ts.repository.SaveFill(ts.ctx, f); err != nil {
					log.Printf("Failed to save fill: %v", err)
				}

				// Update position
				order, err := ts.orderManager.GetOrder(f.OrderID)
				if err == nil {
					if err := ts.riskManager.UpdatePosition(order.AccountID, f); err != nil {
						log.Printf("Failed to update position: %v", err)
					}
				}

				// Notify strategy
				// (strategy would implement OnFill)

				// Record metrics
				ts.collector.RecordFill(
					f.Quantity.Float64(),
					f.Price.Mul(f.Quantity).Float64(),
				)
				ts.collector.RecordFillLatency(time.Since(start))
			},
		})
	})

	// Order update flow
	connector.OnUpdate(func(order *types.Order) {
		// Persist order update
		if err := ts.repository.SaveOrder(ts.ctx, order); err != nil {
			log.Printf("Failed to save order: %v", err)
		}

		// Update metrics
		switch order.Status {
		case types.OrderStatusFilled:
			ts.collector.RecordOrderFilled()
		case types.OrderStatusRejected:
			ts.collector.RecordOrderRejected()
		case types.OrderStatusCanceled:
			ts.collector.RecordOrderCanceled()
		}
	})
}

// processSignals processes trading signals from strategies
func (ts *TradingSystem) processSignals() {
	signals := ts.strategyEngine.GetSignals()

	for {
		select {
		case <-ts.ctx.Done():
			return

		case signal := <-signals:
			// Convert signal to order
			order := &types.Order{
				AccountID: "default", // From signal metadata
				Symbol:    signal.Symbol,
				Side:      signal.Side,
				Type:      types.OrderTypeLimit,
				Price:     signal.Price,
				Quantity:  signal.Quantity,
				TimeInForce: types.TimeInForceGTC,
				StrategyID: signal.StrategyID,
			}

			// Risk check
			start := time.Now()
			riskCheck := ts.riskManager.CheckOrder(order)
			ts.collector.RecordRiskCheck(riskCheck.Passed)

			if !riskCheck.Passed {
				log.Printf("Risk check failed for order: %v", riskCheck.Violations)
				ts.collector.RecordOrderRejected()
				continue
			}

			// Submit order
			if err := ts.orderManager.SubmitOrder(order); err != nil {
				log.Printf("Failed to submit order: %v", err)
				ts.collector.RecordOrderRejected()
				continue
			}

			// Send to exchange
			connector := ts.connectors["main"]
			if err := connector.SubmitOrder(order); err != nil {
				log.Printf("Failed to send order to exchange: %v", err)
				ts.collector.RecordOrderRejected()
				continue
			}

			// Record metrics
			ts.collector.RecordOrderSubmitted()
			ts.collector.RecordOrderAccepted()
			ts.collector.RecordOrderLatency(time.Since(start))

			// Persist order
			if err := ts.repository.SaveOrder(ts.ctx, order); err != nil {
				log.Printf("Failed to save order: %v", err)
			}
		}
	}
}

// Start starts the trading system
func (ts *TradingSystem) Start() error {
	// Start metrics server
	go ts.startMetricsServer()

	// Start system metrics collector
	go ts.collectSystemMetrics()

	// Start order manager
	if err := ts.orderManager.Start(); err != nil {
		return fmt.Errorf("failed to start order manager: %w", err)
	}

	// Start market handler
	if err := ts.marketHandler.Start(); err != nil {
		return fmt.Errorf("failed to start market handler: %w", err)
	}

	// Start strategy engine
	if err := ts.strategyEngine.Start(); err != nil {
		return fmt.Errorf("failed to start strategy engine: %w", err)
	}

	// Connect to exchange
	for name, connector := range ts.connectors {
		if err := connector.Connect(ts.ctx); err != nil {
			return fmt.Errorf("failed to connect to exchange %s: %w", name, err)
		}
		log.Printf("Connected to exchange: %s", name)
	}

	// Subscribe to market data
	symbols := []types.Symbol{"BTC/USD", "ETH/USD"}
	for _, connector := range ts.connectors {
		if err := connector.SubscribeMarketData(symbols); err != nil {
			return fmt.Errorf("failed to subscribe to market data: %w", err)
		}
	}

	// Add strategies
	mmStrategy := strategy.NewMarketMaker(
		"mm-btc",
		[]types.Symbol{"BTC/USD"},
		types.NewPrice(10), // $10 spread
		types.NewQuantity(0.1), // 0.1 BTC per order
	)
	ts.strategyEngine.AddStrategy(mmStrategy)

	return nil
}

// Stop stops the trading system
func (ts *TradingSystem) Stop() error {
	log.Println("Shutting down trading system...")

	// Cancel all pending orders
	// In production, implement graceful order cancellation

	// Disconnect from exchanges
	for name, connector := range ts.connectors {
		if err := connector.Disconnect(); err != nil {
			log.Printf("Error disconnecting from %s: %v", name, err)
		}
	}

	// Stop components
	if err := ts.strategyEngine.Stop(); err != nil {
		log.Printf("Error stopping strategy engine: %v", err)
	}

	if err := ts.marketHandler.Stop(); err != nil {
		log.Printf("Error stopping market handler: %v", err)
	}

	if err := ts.orderManager.Stop(); err != nil {
		log.Printf("Error stopping order manager: %v", err)
	}

	// Close database
	if err := ts.repository.Close(); err != nil {
		log.Printf("Error closing repository: %v", err)
	}

	ts.cancel()

	return nil
}

// WaitForShutdown waits for shutdown signal
func (ts *TradingSystem) WaitForShutdown() {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	sig := <-sigCh
	log.Printf("Received shutdown signal: %v", sig)
}

// startMetricsServer starts the Prometheus metrics server
func (ts *TradingSystem) startMetricsServer() {
	http.Handle("/metrics", promhttp.Handler())

	addr := fmt.Sprintf(":%d", ts.config.MetricsPort)
	log.Printf("Starting metrics server on %s", addr)

	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Printf("Metrics server error: %v", err)
	}
}

// collectSystemMetrics collects system-level metrics
func (ts *TradingSystem) collectSystemMetrics() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	var lastGCStats debug.GCStats
	debug.ReadGCStats(&lastGCStats)

	for {
		select {
		case <-ts.ctx.Done():
			return

		case <-ticker.C:
			// Goroutine count
			goroutines := runtime.NumGoroutine()

			// Memory stats
			var m runtime.MemStats
			runtime.ReadMemStats(&m)

			// GC stats
			var gcStats debug.GCStats
			debug.ReadGCStats(&gcStats)

			// Update metrics
			ts.collector.UpdateSystemMetrics(goroutines, m.HeapAlloc)

			// Record GC pauses
			if len(gcStats.Pause) > len(lastGCStats.Pause) {
				for i := len(lastGCStats.Pause); i < len(gcStats.Pause); i++ {
					ts.collector.RecordGCPause(gcStats.Pause[i])
				}
			}

			lastGCStats = gcStats
		}
	}
}

// optimizeRuntime optimizes Go runtime for low latency
func optimizeRuntime(config *Config) {
	// Set GOMAXPROCS to number of CPUs
	runtime.GOMAXPROCS(runtime.NumCPU())

	// Reduce GC frequency for lower latency
	// Trade memory for latency
	if config.GCPercent > 0 {
		debug.SetGCPercent(config.GCPercent)
	} else {
		debug.SetGCPercent(200) // Default: less frequent GC
	}

	// Pre-allocate memory to reduce GC pressure
	// This forces Go to allocate a large heap upfront
	ballast := make([]byte, 1<<30) // 1GB ballast
	runtime.KeepAlive(ballast)

	log.Printf("Runtime optimized: GOMAXPROCS=%d, GCPercent=%d",
		runtime.GOMAXPROCS(0), debug.SetGCPercent(-1))
	debug.SetGCPercent(config.GCPercent)
}

// loadConfig loads configuration from environment
func loadConfig() *Config {
	return &Config{
		DatabaseURL:      getEnv("DATABASE_URL", "postgres://localhost/trading?sslmode=disable"),
		ExchangeURL:      getEnv("EXCHANGE_URL", "wss://api.exchange.com/ws"),
		ExchangeAPIKey:   getEnv("EXCHANGE_API_KEY", ""),
		ExchangeSecret:   getEnv("EXCHANGE_SECRET", ""),
		MaxOrderSize:     types.NewQuantity(getEnvFloat("MAX_ORDER_SIZE", 10.0)),
		MaxPositionSize:  types.NewQuantity(getEnvFloat("MAX_POSITION_SIZE", 100.0)),
		MaxDailyLoss:     types.NewPrice(getEnvFloat("MAX_DAILY_LOSS", 10000.0)),
		MetricsPort:      getEnvInt("METRICS_PORT", 9090),
		GCPercent:        getEnvInt("GC_PERCENT", 200),
		MaxGoroutines:    getEnvInt("MAX_GOROUTINES", 10000),
		EnableCPUProfile: getEnvBool("ENABLE_CPU_PROFILE", false),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		var intVal int
		fmt.Sscanf(value, "%d", &intVal)
		return intVal
	}
	return defaultValue
}

func getEnvFloat(key string, defaultValue float64) float64 {
	if value := os.Getenv(key); value != "" {
		var floatVal float64
		fmt.Sscanf(value, "%f", &floatVal)
		return floatVal
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		return value == "true" || value == "1"
	}
	return defaultValue
}
```
