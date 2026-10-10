## 90J.12 Flash Crash: $1 Trillion in Minutes (2010)

### The Incident

On May 6, 2010, the U.S. stock market experienced the most dramatic intraday crash in its history. In
approximately 36 minutes, the Dow Jones Industrial Average fell nearly 1,000 points (about 9%), and
approximately $1 trillion in market value evaporated. Some individual stocks traded at absurd prices - Accenture
briefly traded at $0.01, while Apple traded at $100,000. The market then recovered almost completely within
minutes.

### The Timeline

**May 6, 2010: 2:32 PM ET**

A large institutional trader (later identified as Waddell & Reed, a Kansas City mutual fund) began executing
an algorithm to sell $4.1 billion worth of E-mini S&P 500 futures contracts. The algorithm was programmed to
sell at a rate based on market volume - the more the market traded, the faster it would sell. But critically,
the algorithm had no price sensitivity - it would sell at any price.

**2:32 PM - 2:45 PM: The Cascade**

As the algorithm sold, high-frequency traders (HFTs) bought the contracts and then immediately resold them.
This created a "hot potato" effect where the same contracts were being rapidly traded back and forth between
HFTs, inflating the volume that Waddell & Reed's algorithm used to determine its selling rate. Higher volume
caused faster selling, which caused more HFT activity, which caused higher volume.

The E-mini futures price dropped, pulling the broader equity market down with it. As stock prices fell, other
automated trading systems triggered their own sell orders. Stop-loss orders were triggered. Market makers
withdrew liquidity. In the absence of buyers, prices fell to whatever any remaining buyer was willing to pay.

**2:45 PM - 2:47 PM: The Abyss**

The E-mini S&P 500 dropped approximately 5% in a matter of minutes. Individual stocks experienced even more
extreme moves:

- **Accenture**: Traded at $0.01 per share (normally ~$40)
- **Exelon**: Traded at $0.01 per share
- **Sotheby's**: Traded at $100,000 per share (normally ~$34)
- **Apple**: Traded at $100,000 per share

These absurd prices occurred because, in the absence of real buyers, automated systems matched sell orders
against "stub quotes" - placeholder orders that market makers posted at extreme prices with the assumption
they would never actually execute.

**2:47 PM: CME Circuit Breaker**

The Chicago Mercantile Exchange's automated circuit breaker halted trading in E-mini futures for five seconds.
This brief pause was enough to break the cascade. When trading resumed, buyers returned, and prices rapidly
recovered. By 3:00 PM, the market had recovered most of its losses.

### Root Cause Analysis

1. **Algorithm without price limits**: The Waddell & Reed algorithm had no price floor or ceiling
2. **Volume-based selling**: Using market volume as a throttle created a positive feedback loop
3. **HFT hot potato effect**: High-frequency traders amplified volume without adding real liquidity
4. **Stub quotes executing**: Placeholder orders at absurd prices actually filled
5. **Liquidity withdrawal**: Market makers pulled out when they were needed most
6. **Inadequate circuit breakers**: Exchange-level halts were too slow and too brief

### Go Code: Trading Circuit Breaker

The Flash Crash demonstrates the need for circuit breakers at every level of the trading system - from
individual algorithms to exchanges. Here is a multi-level circuit breaker implementation:

```go
package circuitbreaker

import (
	"context"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"
)

// -----------------------------------------------------------------------
// Multi-level circuit breaker for trading systems
// -----------------------------------------------------------------------

// PriceLevel represents a reference price point for circuit breaker
// calculations.
type PriceLevel struct {
	Symbol       string
	ReferencePrice float64  // Baseline price (e.g., previous close)
	CurrentPrice  float64
	Timestamp     time.Time
}

// CircuitBreakerConfig defines the thresholds at which trading is
// halted.
type CircuitBreakerConfig struct {
	// Price movement limits (percentage from reference)
	Level1PercentDown float64 // e.g., 7%  - 15-minute halt
	Level2PercentDown float64 // e.g., 13% - 15-minute halt
	Level3PercentDown float64 // e.g., 20% - market close for the day
	Level1PercentUp   float64 // e.g., 10% - unusual for indices but relevant for individual stocks

	// Single-stock limits
	StockLimitUpPercent   float64 // e.g., 10% in 5 minutes
	StockLimitDownPercent float64 // e.g., 10% in 5 minutes
	StockLimitWindow      time.Duration

	// Velocity limits (rate of change)
	MaxPriceVelocity float64       // Maximum price change per second (%)
	VelocityWindow   time.Duration

	// Volume limits
	MaxVolumeMultiple float64 // Multiple of average volume that triggers review

	// Halt durations
	Level1HaltDuration time.Duration
	Level2HaltDuration time.Duration
}

// CircuitBreakerState tracks the current state of the circuit breaker.
type CircuitBreakerState int32

const (
	StateTradingOpen   CircuitBreakerState = 0
	StateLevel1Halt    CircuitBreakerState = 1
	StateLevel2Halt    CircuitBreakerState = 2
	StateLevel3Halt    CircuitBreakerState = 3 // Market closed for day
	StateLULD          CircuitBreakerState = 4 // Limit Up/Limit Down
)

// TradingHalt represents an active or historical trading halt.
type TradingHalt struct {
	Level      CircuitBreakerState
	Symbol     string // Empty for market-wide halts
	TriggeredAt time.Time
	ResumeAt   time.Time
	Reason     string
	PriceAtHalt float64
	ReferencePrice float64
	PercentMove float64
}

// PriceUpdate represents a new price tick.
type PriceUpdate struct {
	Symbol    string
	Price     float64
	Volume    int64
	Timestamp time.Time
}

// CircuitBreaker monitors price movements and triggers halts when
// thresholds are breached.
type CircuitBreaker struct {
	config      CircuitBreakerConfig
	state       atomic.Int32
	mu          sync.RWMutex
	prices      map[string]*PriceHistory
	activeHalts []TradingHalt
	haltHistory []TradingHalt
	onHalt      func(halt TradingHalt)
	onResume    func(symbol string)
}

// PriceHistory maintains a rolling window of prices for a symbol.
type PriceHistory struct {
	Symbol         string
	ReferencePrice float64
	CurrentPrice   float64
	Prices         []PriceUpdate
	MaxSize        int
}

// NewCircuitBreaker creates a circuit breaker with the given config.
func NewCircuitBreaker(config CircuitBreakerConfig) *CircuitBreaker {
	cb := &CircuitBreaker{
		config: config,
		prices: make(map[string]*PriceHistory),
	}
	cb.state.Store(int32(StateTradingOpen))
	return cb
}

// SetHaltCallback registers a function called when a halt is triggered.
func (cb *CircuitBreaker) SetHaltCallback(fn func(halt TradingHalt)) {
	cb.onHalt = fn
}

// SetResumeCallback registers a function called when trading resumes.
func (cb *CircuitBreaker) SetResumeCallback(fn func(symbol string)) {
	cb.onResume = fn
}

// SetReferencePrice sets the baseline price for a symbol (typically
// the previous day's close).
func (cb *CircuitBreaker) SetReferencePrice(symbol string, price float64) {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.prices[symbol] = &PriceHistory{
		Symbol:         symbol,
		ReferencePrice: price,
		CurrentPrice:   price,
		MaxSize:        10000,
	}
}

// ProcessTick evaluates a new price update against all circuit breaker
// thresholds. Returns nil if trading should continue, or a TradingHalt
// if trading should stop.
func (cb *CircuitBreaker) ProcessTick(update PriceUpdate) *TradingHalt {
	// If already halted at Level 3, reject everything.
	if CircuitBreakerState(cb.state.Load()) == StateLevel3Halt {
		return &TradingHalt{
			Level:  StateLevel3Halt,
			Reason: "market closed for the day",
		}
	}

	cb.mu.Lock()
	defer cb.mu.Unlock()

	history, exists := cb.prices[update.Symbol]
	if !exists {
		return nil
	}

	// Update price history.
	history.CurrentPrice = update.Price
	history.Prices = append(history.Prices, update)
	if len(history.Prices) > history.MaxSize {
		history.Prices = history.Prices[len(history.Prices)-history.MaxSize:]
	}

	// Check market-wide circuit breaker levels (for index symbols).
	percentMove := (update.Price - history.ReferencePrice) / history.ReferencePrice * 100

	if percentMove <= -cb.config.Level3PercentDown {
		halt := TradingHalt{
			Level:          StateLevel3Halt,
			Symbol:         update.Symbol,
			TriggeredAt:    time.Now(),
			Reason:         fmt.Sprintf("Level 3 breached: %.2f%% decline", percentMove),
			PriceAtHalt:    update.Price,
			ReferencePrice: history.ReferencePrice,
			PercentMove:    percentMove,
		}
		cb.triggerHalt(halt)
		return &halt
	}

	if percentMove <= -cb.config.Level2PercentDown {
		halt := TradingHalt{
			Level:          StateLevel2Halt,
			Symbol:         update.Symbol,
			TriggeredAt:    time.Now(),
			ResumeAt:       time.Now().Add(cb.config.Level2HaltDuration),
			Reason:         fmt.Sprintf("Level 2 breached: %.2f%% decline", percentMove),
			PriceAtHalt:    update.Price,
			ReferencePrice: history.ReferencePrice,
			PercentMove:    percentMove,
		}
		cb.triggerHalt(halt)
		return &halt
	}

	if percentMove <= -cb.config.Level1PercentDown {
		halt := TradingHalt{
			Level:          StateLevel1Halt,
			Symbol:         update.Symbol,
			TriggeredAt:    time.Now(),
			ResumeAt:       time.Now().Add(cb.config.Level1HaltDuration),
			Reason:         fmt.Sprintf("Level 1 breached: %.2f%% decline", percentMove),
			PriceAtHalt:    update.Price,
			ReferencePrice: history.ReferencePrice,
			PercentMove:    percentMove,
		}
		cb.triggerHalt(halt)
		return &halt
	}

	// Check single-stock LULD (Limit Up / Limit Down).
	if halt := cb.checkLULD(update, history); halt != nil {
		return halt
	}

	// Check price velocity.
	if halt := cb.checkVelocity(update, history); halt != nil {
		return halt
	}

	return nil
}

// checkLULD checks for rapid single-stock price movements.
func (cb *CircuitBreaker) checkLULD(update PriceUpdate, history *PriceHistory) *TradingHalt {
	windowStart := update.Timestamp.Add(-cb.config.StockLimitWindow)

	var windowStartPrice float64
	for _, p := range history.Prices {
		if p.Timestamp.After(windowStart) {
			windowStartPrice = p.Price
			break
		}
	}

	if windowStartPrice == 0 {
		return nil
	}

	percentChange := (update.Price - windowStartPrice) / windowStartPrice * 100

	if percentChange >= cb.config.StockLimitUpPercent ||
		percentChange <= -cb.config.StockLimitDownPercent {
		halt := TradingHalt{
			Level:       StateLULD,
			Symbol:      update.Symbol,
			TriggeredAt: time.Now(),
			ResumeAt:    time.Now().Add(5 * time.Minute),
			Reason: fmt.Sprintf("LULD: %.2f%% move in %v",
				percentChange, cb.config.StockLimitWindow),
			PriceAtHalt:    update.Price,
			ReferencePrice: windowStartPrice,
			PercentMove:    percentChange,
		}
		cb.triggerHalt(halt)
		return &halt
	}

	return nil
}

// checkVelocity checks for rapid price changes per second.
func (cb *CircuitBreaker) checkVelocity(update PriceUpdate, history *PriceHistory) *TradingHalt {
	if len(history.Prices) < 2 {
		return nil
	}

	windowStart := update.Timestamp.Add(-cb.config.VelocityWindow)
	var velocities []float64

	for i := 1; i < len(history.Prices); i++ {
		if history.Prices[i].Timestamp.Before(windowStart) {
			continue
		}
		dt := history.Prices[i].Timestamp.Sub(history.Prices[i-1].Timestamp).Seconds()
		if dt == 0 {
			continue
		}
		dp := math.Abs(history.Prices[i].Price-history.Prices[i-1].Price) /
			history.Prices[i-1].Price * 100
		velocity := dp / dt
		velocities = append(velocities, velocity)
	}

	if len(velocities) == 0 {
		return nil
	}

	// Check max velocity.
	var maxVelocity float64
	for _, v := range velocities {
		if v > maxVelocity {
			maxVelocity = v
		}
	}

	if maxVelocity > cb.config.MaxPriceVelocity {
		halt := TradingHalt{
			Level:       StateLULD,
			Symbol:      update.Symbol,
			TriggeredAt: time.Now(),
			ResumeAt:    time.Now().Add(5 * time.Minute),
			Reason: fmt.Sprintf("Velocity breach: %.4f%%/sec (max: %.4f%%/sec)",
				maxVelocity, cb.config.MaxPriceVelocity),
			PriceAtHalt: update.Price,
		}
		cb.triggerHalt(halt)
		return &halt
	}

	return nil
}

// triggerHalt activates a trading halt.
func (cb *CircuitBreaker) triggerHalt(halt TradingHalt) {
	cb.state.Store(int32(halt.Level))
	cb.activeHalts = append(cb.activeHalts, halt)
	cb.haltHistory = append(cb.haltHistory, halt)

	fmt.Printf("\n!!! CIRCUIT BREAKER TRIGGERED !!!\n")
	fmt.Printf("  Level:     %d\n", halt.Level)
	fmt.Printf("  Symbol:    %s\n", halt.Symbol)
	fmt.Printf("  Reason:    %s\n", halt.Reason)
	fmt.Printf("  Price:     %.2f\n", halt.PriceAtHalt)
	fmt.Printf("  Reference: %.2f\n", halt.ReferencePrice)
	fmt.Printf("  Move:      %.2f%%\n", halt.PercentMove)
	if !halt.ResumeAt.IsZero() {
		fmt.Printf("  Resume At: %s\n", halt.ResumeAt.Format(time.RFC3339))
	}
	fmt.Printf("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n\n")

	if cb.onHalt != nil {
		cb.onHalt(halt)
	}
}

// MonitorHalts runs a background loop that automatically resumes
// trading when halt durations expire.
func (cb *CircuitBreaker) MonitorHalts(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cb.mu.Lock()
			now := time.Now()
			var remaining []TradingHalt
			for _, halt := range cb.activeHalts {
				if halt.Level == StateLevel3Halt {
					remaining = append(remaining, halt)
					continue
				}
				if now.After(halt.ResumeAt) {
					fmt.Printf("[CIRCUIT BREAKER] Resuming trading for %s after %s halt\n",
						halt.Symbol, halt.Reason)
					if cb.onResume != nil {
						cb.onResume(halt.Symbol)
					}
				} else {
					remaining = append(remaining, halt)
				}
			}
			cb.activeHalts = remaining
			if len(remaining) == 0 {
				cb.state.Store(int32(StateTradingOpen))
			}
			cb.mu.Unlock()
		}
	}
}

// DefaultConfig returns a circuit breaker configuration modeled after
// the post-Flash Crash regulations.
func DefaultConfig() CircuitBreakerConfig {
	return CircuitBreakerConfig{
		Level1PercentDown:     7.0,
		Level2PercentDown:     13.0,
		Level3PercentDown:     20.0,
		Level1PercentUp:       10.0,
		StockLimitUpPercent:   10.0,
		StockLimitDownPercent: 10.0,
		StockLimitWindow:      5 * time.Minute,
		MaxPriceVelocity:      0.5, // 0.5% per second
		VelocityWindow:        30 * time.Second,
		MaxVolumeMultiple:     10.0,
		Level1HaltDuration:    15 * time.Minute,
		Level2HaltDuration:    15 * time.Minute,
	}
}
```

### Engineering Lessons

1. **Algorithms must have price limits** - never build a system that will buy or sell at any price.
2. **Volume-based throttling creates positive feedback loops** - use time-based or price-based limits instead.
3. **Circuit breakers at every level** - individual algorithm, broker, exchange, and market-wide.
4. **Stub quotes are not real liquidity** - do not allow orders to fill against placeholder quotes.
5. **The 5-second CME halt saved the market** - brief pauses can break cascading feedback loops.
6. **Test with adversarial market conditions** - what happens when liquidity disappears?

---

### Junior → FAANG: Circuit Breakers and Algorithmic Safety Limits as Interview Patterns

The Flash Crash is the interview answer to "how do you prevent an algorithm from causing runaway damage?" An algorithm that sold $4.1 billion in e-mini futures contracts with no price limit or volume limit created a positive feedback loop that erased $1 trillion in market value in 36 minutes. For FAANG interviews, the Flash Crash provides the circuit breaker argument at its most dramatic scale. Any algorithm that operates in a feedback loop (trading, ad bidding, auto-scaling, pricing) must have three types of limits: a price or value limit (never buy or sell beyond a defined range), a velocity limit (never move the price more than a defined percentage per time period), and a volume limit (never represent more than a defined fraction of market volume in any window). Without all three limits, an algorithm that encounters unusual market conditions can enter a positive feedback loop that it cannot self-terminate. For interviews, the Flash Crash demonstrates that circuit breakers are not a performance optimization, they are a safety requirement for any system that operates in a feedback environment.

### Senior @ FAANG: Algorithmic Safety as a Platform Governance Standard

At L6, the Flash Crash is a platform governance failure: there were no exchange-level or industry-level standards requiring algorithmic trading systems to implement circuit breakers before 2010. After the crash, circuit breakers became regulatory requirements. The staff engineer's lesson is not to wait for a regulatory mandate. Define the safety standards for any algorithmic system in your organization before the first version is deployed, not after the first failure. For any system that takes automated actions with financial, reputational, or operational consequences (ad bidding, auto-scaling, pricing algorithms, recommendation systems), the safety standard should specify: the maximum action magnitude per decision, the maximum aggregate action volume per time window, the anomaly detection threshold that triggers automatic pause, the human review requirement before resuming after an automatic pause, and the incident playbook for when the system exceeds its safety limits. At the platform level, these standards should be implemented as a shared library that all algorithmic systems use, so the safety properties are consistent across systems and cannot be accidentally omitted by a team that does not understand the risk. The CME's five-second halt during the Flash Crash is evidence that brief pauses break positive feedback loops. Your circuit breaker implementation should include a configurable pause duration that is long enough to break feedback but short enough to allow recovery once the anomalous condition has passed.

---
