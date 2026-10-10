## Company Case Studies: Trading Systems at Scale

### Jane Street: Market Making Systems

Jane Street's quantitative trading infrastructure:

```go
// Jane Street-style market making system
package janestreet

import (
    "sync"
    "sync/atomic"
    "time"
)

// MarketMaker handles automated market making
type MarketMaker struct {
    symbol         string
    orderBook      *OrderBook
    inventory      *InventoryManager
    riskManager    *RiskManager
    quoteEngine    *QuoteEngine
    hedgeEngine    *HedgeEngine
}

// Quote represents a two-sided quote
type Quote struct {
    Symbol    string
    BidPrice  int64 // Fixed-point price
    BidSize   int64
    AskPrice  int64
    AskSize   int64
    Timestamp int64
}

// InventoryManager tracks position and risk
type InventoryManager struct {
    position    atomic.Int64
    maxPosition int64
    targetPos   int64
    skew        atomic.Int64
}

// GenerateQuotes produces continuous two-sided markets
func (m *MarketMaker) GenerateQuotes(updates <-chan *MarketDataUpdate) <-chan *Quote {
    quotes := make(chan *Quote, 100)

    go func() {
        defer close(quotes)

        for update := range updates {
            // Update order book
            m.orderBook.Update(update)

            // Check if we can quote
            if !m.riskManager.CanQuote() {
                continue
            }

            // Calculate fair value
            fairValue := m.calculateFairValue()

            // Get inventory skew
            skew := m.inventory.GetSkew()

            // Generate spread
            spread := m.quoteEngine.CalculateSpread(m.orderBook, fairValue)

            // Apply inventory skew to prices
            bidPrice := fairValue - spread/2 - skew
            askPrice := fairValue + spread/2 - skew

            // Calculate sizes based on inventory limits
            bidSize := m.calculateQuoteSize(true)
            askSize := m.calculateQuoteSize(false)

            quote := &Quote{
                Symbol:    m.symbol,
                BidPrice:  bidPrice,
                BidSize:   bidSize,
                AskPrice:  askPrice,
                AskSize:   askSize,
                Timestamp: time.Now().UnixNano(),
            }

            quotes <- quote
        }
    }()

    return quotes
}

// calculateFairValue computes mid-price with adjustments
func (m *MarketMaker) calculateFairValue() int64 {
    // Get current mid
    mid := m.orderBook.MidPrice()

    // Apply micro-price adjustment (weighted by queue sizes)
    bidQty := m.orderBook.BestBidQty()
    askQty := m.orderBook.BestAskQty()

    imbalance := float64(bidQty-askQty) / float64(bidQty+askQty)

    // Adjust fair value based on imbalance
    tickSize := m.orderBook.TickSize()
    adjustment := int64(imbalance * float64(tickSize))

    return mid + adjustment
}
```

### Two Sigma: Quantitative Research Platform

Two Sigma's research and backtesting system:

```go
// Two Sigma-style quantitative research platform
package twosigma

import (
    "context"
    "time"
)

// ResearchPlatform manages alpha research
type ResearchPlatform struct {
    dataStore      *MarketDataStore
    alphaEngine    *AlphaEngine
    backtester     *Backtester
    riskAnalyzer   *RiskAnalyzer
    portfolioOpt   *PortfolioOptimizer
}

// Alpha represents a trading signal
type Alpha struct {
    Name           string
    Universe       []string
    Expression     string
    Lookback       int
    Decay          float64
    Neutralization string // market, sector, none
}

// BacktestResult contains simulation results
type BacktestResult struct {
    Alpha          string
    StartDate      time.Time
    EndDate        time.Time
    Returns        []float64
    Positions      []map[string]float64
    Sharpe         float64
    MaxDrawdown    float64
    Turnover       float64
    InformationRatio float64
    TStats         map[string]float64
}

// BacktestAlpha runs historical simulation
func (p *ResearchPlatform) BacktestAlpha(ctx context.Context, alpha *Alpha, config *BacktestConfig) (*BacktestResult, error) {
    result := &BacktestResult{
        Alpha:     alpha.Name,
        StartDate: config.StartDate,
        EndDate:   config.EndDate,
        Returns:   make([]float64, 0),
        Positions: make([]map[string]float64, 0),
    }

    // Generate dates
    dates := generateTradingDays(config.StartDate, config.EndDate)

    var prevPositions map[string]float64

    for _, date := range dates {
        // Get market data
        data, err := p.dataStore.GetData(ctx, alpha.Universe, date, alpha.Lookback)
        if err != nil {
            continue
        }

        // Calculate alpha values
        alphaValues := p.alphaEngine.Calculate(ctx, alpha, data)

        // Apply neutralization
        neutralized := p.neutralize(alphaValues, alpha.Neutralization)

        // Normalize to target leverage
        positions := p.normalize(neutralized, config.Leverage)

        // Calculate returns
        if prevPositions != nil {
            dayReturn := p.calculateReturn(ctx, prevPositions, data)
            result.Returns = append(result.Returns, dayReturn)
        }

        result.Positions = append(result.Positions, positions)
        prevPositions = positions
    }

    // Calculate statistics
    result.Sharpe = calculateSharpe(result.Returns)
    result.MaxDrawdown = calculateMaxDrawdown(result.Returns)
    result.Turnover = calculateTurnover(result.Positions)
    result.InformationRatio = calculateIR(result.Returns)

    return result, nil
}

// PortfolioOptimizer combines multiple alphas
type PortfolioOptimizer struct {
    riskModel *RiskModel
}

func (o *PortfolioOptimizer) Optimize(ctx context.Context, alphas []*AlphaSignal, constraints *Constraints) (map[string]float64, error) {
    // Build covariance matrix
    cov := o.riskModel.GetCovariance(ctx)

    // Build expected returns from alpha signals
    expectedReturns := o.combineAlphas(alphas)

    // Mean-variance optimization with constraints
    weights := o.meanVarianceOptimize(expectedReturns, cov, constraints)

    return weights, nil
}
```

### Citadel: Low-Latency Trading Infrastructure

Citadel's ultra-low-latency systems:

```go
// Citadel-style low-latency trading infrastructure
package citadel

import (
    "sync/atomic"
    "unsafe"
)

// LockFreeOrderBook provides nanosecond-level updates
type LockFreeOrderBook struct {
    bids *LockFreePriceLevel
    asks *LockFreePriceLevel
    seq  atomic.Uint64
}

// LockFreePriceLevel is a lock-free price level list
type LockFreePriceLevel struct {
    head unsafe.Pointer // *priceNode
}

type priceNode struct {
    price    int64
    quantity atomic.Int64
    orders   *lockFreeOrderList
    next     unsafe.Pointer // *priceNode
}

// Update applies an order book update lock-free
func (b *LockFreeOrderBook) Update(side int, price int64, qty int64) {
    var levels *LockFreePriceLevel
    if side == 0 {
        levels = b.bids
    } else {
        levels = b.asks
    }

    for {
        head := atomic.LoadPointer(&levels.head)
        node := (*priceNode)(head)

        // Find the right position
        var prev *priceNode
        curr := node

        for curr != nil && curr.price > price {
            prev = curr
            curr = (*priceNode)(atomic.LoadPointer(&curr.next))
        }

        if curr != nil && curr.price == price {
            // Update existing level
            if qty == 0 {
                // Remove level
                if prev == nil {
                    if atomic.CompareAndSwapPointer(&levels.head, head, curr.next) {
                        break
                    }
                } else {
                    if atomic.CompareAndSwapPointer(&prev.next, unsafe.Pointer(curr), curr.next) {
                        break
                    }
                }
            } else {
                // Update quantity
                curr.quantity.Store(qty)
                break
            }
        } else if qty > 0 {
            // Insert new level
            newNode := &priceNode{
                price:    price,
                next:     unsafe.Pointer(curr),
            }
            newNode.quantity.Store(qty)

            if prev == nil {
                if atomic.CompareAndSwapPointer(&levels.head, head, unsafe.Pointer(newNode)) {
                    break
                }
            } else {
                if atomic.CompareAndSwapPointer(&prev.next, unsafe.Pointer(curr), unsafe.Pointer(newNode)) {
                    break
                }
            }
        } else {
            break // Nothing to do
        }
    }

    b.seq.Add(1)
}

// FPGA-Accelerated Order Processing
type FPGAOrderProcessor struct {
    fpgaDevice    *FPGADevice
    orderBuffer   *RingBuffer
    resultBuffer  *RingBuffer
}

// ProcessOrderFPGA offloads order matching to FPGA
func (p *FPGAOrderProcessor) ProcessOrderFPGA(order *Order) (*ExecutionReport, error) {
    // Serialize order to FPGA format
    orderBytes := p.serializeOrder(order)

    // Send to FPGA via memory-mapped I/O
    p.fpgaDevice.Write(orderBytes)

    // Wait for result (typically <1μs)
    resultBytes := p.fpgaDevice.Read()

    // Deserialize execution report
    return p.deserializeReport(resultBytes)
}
```

### Robinhood: Retail Trading Platform

Robinhood's retail trading system:

```go
// Robinhood-style retail trading platform
package robinhood

import (
    "context"
    "time"
)

// TradingService handles retail order flow
type TradingService struct {
    orderRouter    *OrderRouter
    accountService *AccountService
    riskService    *RiskService
    marketData     *MarketDataService
}

// Order represents a retail order
type Order struct {
    ID            string    `json:"id"`
    AccountID     string    `json:"account_id"`
    Symbol        string    `json:"symbol"`
    Side          string    `json:"side"` // buy, sell
    Type          string    `json:"type"` // market, limit, stop, stop_limit
    Quantity      float64   `json:"quantity"`
    Price         float64   `json:"price,omitempty"`
    StopPrice     float64   `json:"stop_price,omitempty"`
    TimeInForce   string    `json:"time_in_force"` // day, gtc, ioc, fok
    ExtendedHours bool      `json:"extended_hours"`
    State         string    `json:"state"`
    CreatedAt     time.Time `json:"created_at"`
}

// SubmitOrder processes a retail order
func (s *TradingService) SubmitOrder(ctx context.Context, order *Order) (*Order, error) {
    // Validate order
    if err := s.validateOrder(ctx, order); err != nil {
        return nil, err
    }

    // Check buying power / shares
    if err := s.accountService.ValidateBuyingPower(ctx, order); err != nil {
        return nil, err
    }

    // Risk checks
    if err := s.riskService.CheckOrder(ctx, order); err != nil {
        return nil, err
    }

    // Get best execution venue
    venue := s.orderRouter.SelectVenue(ctx, order)

    // Route order
    order.State = "pending"
    routed, err := s.orderRouter.Route(ctx, order, venue)
    if err != nil {
        order.State = "rejected"
        return order, err
    }

    // Wait for acknowledgment
    order.State = "queued"
    order.ID = routed.OrderID

    // Lock funds/shares
    s.accountService.Reserve(ctx, order)

    return order, nil
}

// OrderRouter handles best execution
type OrderRouter struct {
    venues       []*ExecutionVenue
    pfofPartners []*PFOFPartner
}

func (r *OrderRouter) SelectVenue(ctx context.Context, order *Order) *ExecutionVenue {
    // For small orders, consider PFOF partners
    if order.Quantity*s.getPrice(order.Symbol) < 200000 {
        // Check PFOF partner quotes
        bestPFOF := r.getBestPFOFQuote(ctx, order)
        if bestPFOF != nil && r.isPriceImprovement(bestPFOF, order) {
            return bestPFOF.Venue
        }
    }

    // Otherwise, smart order routing
    quotes := r.getQuotesFromVenues(ctx, order.Symbol)

    if order.Side == "buy" {
        return r.selectLowestAsk(quotes)
    }
    return r.selectHighestBid(quotes)
}

// FractionalSharesService handles fractional trading
type FractionalSharesService struct {
    poolManager *FractionalPoolManager
}

func (f *FractionalSharesService) ExecuteFractional(ctx context.Context, order *Order) (*Execution, error) {
    // Fractional orders are batched
    batch := f.poolManager.AddToBatch(order)

    // When batch is full or timer expires, execute
    if batch.ShouldExecute() {
        // Aggregate to whole shares
        wholeShares := int(batch.TotalQuantity)
        fractionalRemainder := batch.TotalQuantity - float64(wholeShares)

        // Execute whole share portion on market
        if wholeShares > 0 {
            f.executeWholeShares(ctx, batch.Symbol, batch.Side, wholeShares)
        }

        // Fractional from inventory
        f.poolManager.FillFromInventory(batch, fractionalRemainder)

        // Allocate fills pro-rata to orders
        return f.allocateFills(batch)
    }

    return nil, nil // Pending batch execution
}
```

### Key Takeaways from Industry Leaders

| Company | Key Innovation | Scale |
|---------|---------------|-------|
| Jane Street | Market making, inventory management | \$17T+ annual volume |
| Two Sigma | Quantitative research, alpha combination | \$60B+ AUM |
| Citadel | Lock-free structures, FPGA acceleration | Sub-microsecond latency |
| Robinhood | Retail PFOF, fractional shares | 23M+ users |

---
