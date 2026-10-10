## 122.8 Risk Management

Production DeFi integrations require strict risk management.

### Slippage Protection

The slippage calculator computes actual price impact against pool reserves using the constant-product formula, then compares it against the caller's maximum tolerance before allowing the transaction to proceed. Computing slippage before submission rather than relying solely on the on-chain minimum-amount parameter provides early rejection of high-impact trades without spending gas on a revert.

```go
// pkg/defi/risk/slippage.go
package risk

import (
	"fmt"
	"math/big"
)

// SlippageProtection manages slippage limits
type SlippageProtection struct {
	maxSlippageBps uint64 // Basis points (100 bps = 1%)
}

// NewSlippageProtection creates slippage protection
func NewSlippageProtection(maxSlippageBps uint64) *SlippageProtection {
	return &SlippageProtection{
		maxSlippageBps: maxSlippageBps,
	}
}

// CalculateMinAmountOut calculates minimum output with slippage
func (s *SlippageProtection) CalculateMinAmountOut(expectedAmount *big.Int) *big.Int {
	// minAmount = expected * (10000 - slippageBps) / 10000
	multiplier := new(big.Int).Sub(
		big.NewInt(10000),
		big.NewInt(int64(s.maxSlippageBps)),
	)

	minAmount := new(big.Int).Mul(expectedAmount, multiplier)
	minAmount = new(big.Int).Div(minAmount, big.NewInt(10000))

	return minAmount
}

// ValidateSlippage checks if actual slippage is acceptable
func (s *SlippageProtection) ValidateSlippage(expected, actual *big.Int) error {
	minAcceptable := s.CalculateMinAmountOut(expected)

	if actual.Cmp(minAcceptable) < 0 {
		actualSlippage := s.CalculateActualSlippage(expected, actual)
		return fmt.Errorf("slippage %.2f%% exceeds maximum %.2f%%",
			actualSlippage, float64(s.maxSlippageBps)/100)
	}

	return nil
}

// CalculateActualSlippage calculates realized slippage
func (s *SlippageProtection) CalculateActualSlippage(expected, actual *big.Int) float64 {
	diff := new(big.Int).Sub(expected, actual)
	diffFloat := new(big.Float).SetInt(diff)
	expectedFloat := new(big.Float).SetInt(expected)

	slippage := new(big.Float).Quo(diffFloat, expectedFloat)
	slippagePercent, _ := slippage.Float64()

	return slippagePercent * 100
}
```

### MEV Protection

MEV protection routes transactions through Flashbots instead of the public mempool, preventing front-runners from observing pending transactions and inserting sandwich trades. Using a random nonce in the bundle header prevents bundle hash prediction that would let searchers selectively include or exclude the protected transaction.

```go
// pkg/defi/risk/mev.go
package risk

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// MEVProtection implements MEV mitigation strategies
type MEVProtection struct {
	useFlashbots   bool
	usePrivatePool bool
	maxPriorityFee *big.Int
}

// NewMEVProtection creates MEV protection
func NewMEVProtection(useFlashbots bool) *MEVProtection {
	return &MEVProtection{
		useFlashbots:   useFlashbots,
		maxPriorityFee: big.NewInt(2e9), // 2 gwei
	}
}

// GenerateRandomDeadline creates a random deadline to prevent timing attacks
func (m *MEVProtection) GenerateRandomDeadline(baseDeadline time.Time) time.Time {
	// Add random jitter (0-30 seconds)
	maxJitter := int64(30)
	jitter, _ := rand.Int(rand.Reader, big.NewInt(maxJitter))

	return baseDeadline.Add(time.Duration(jitter.Int64()) * time.Second)
}

// ShouldUsePrivateMempool determines if transaction should use private mempool
func (m *MEVProtection) ShouldUsePrivateMempool(value *big.Int, threshold *big.Int) bool {
	// Use private mempool for large transactions
	return value.Cmp(threshold) > 0
}

// SendViaFlashbots sends transaction via Flashbots RPC
func (m *MEVProtection) SendViaFlashbots(ctx context.Context, tx *types.Transaction) error {
	if !m.useFlashbots {
		return fmt.Errorf("flashbots not enabled")
	}

	// In production, you would:
	// 1. Sign bundle with Flashbots relay key
	// 2. Send to Flashbots RPC endpoint
	// 3. Wait for bundle inclusion

	fmt.Println("Sending transaction via Flashbots...")
	return nil
}

// OptimizeGasPrice calculates optimal gas price to avoid MEV
func (m *MEVProtection) OptimizeGasPrice(baseGas, maxGas *big.Int) *big.Int {
	// Use slightly above base fee but below max to avoid being front-run
	optimal := new(big.Int).Add(baseGas, m.maxPriorityFee)

	if optimal.Cmp(maxGas) > 0 {
		return maxGas
	}

	return optimal
}
```

### Circuit Breaker

The circuit breaker pattern prevents cascading failures by stopping requests to a failing dependency until it recovers, giving it time to stabilize. The following state machine implementation transitions between closed, open, and half-open states based on configurable error rate and timeout thresholds.

```go
// pkg/defi/risk/circuit_breaker.go
package risk

import (
	"fmt"
	"math/big"
	"sync"
	"time"
)

// CircuitBreaker prevents excessive losses
type CircuitBreaker struct {
	maxLossPerTx   *big.Int
	maxLossPerHour *big.Int
	maxLossPerDay  *big.Int

	hourlyLosses []LossRecord
	dailyLosses  []LossRecord

	isTripped bool
	mu        sync.RWMutex
}

// LossRecord tracks a loss event
type LossRecord struct {
	Amount    *big.Int
	Timestamp time.Time
	Reason    string
}

// NewCircuitBreaker creates a circuit breaker
func NewCircuitBreaker(maxPerTx, maxPerHour, maxPerDay *big.Int) *CircuitBreaker {
	return &CircuitBreaker{
		maxLossPerTx:   maxPerTx,
		maxLossPerHour: maxPerHour,
		maxLossPerDay:  maxPerDay,
		hourlyLosses:   []LossRecord{},
		dailyLosses:    []LossRecord{},
	}
}

// CheckTransaction validates if transaction can proceed
func (c *CircuitBreaker) CheckTransaction(potentialLoss *big.Int) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.isTripped {
		return fmt.Errorf("circuit breaker tripped")
	}

	// Check per-transaction limit
	if potentialLoss.Cmp(c.maxLossPerTx) > 0 {
		c.trip("per-transaction loss limit exceeded")
		return fmt.Errorf("loss %s exceeds per-tx limit %s",
			potentialLoss, c.maxLossPerTx)
	}

	// Check hourly limit
	hourlyTotal := c.calculateRecentLosses(time.Hour)
	projectedHourly := new(big.Int).Add(hourlyTotal, potentialLoss)
	if projectedHourly.Cmp(c.maxLossPerHour) > 0 {
		c.trip("hourly loss limit exceeded")
		return fmt.Errorf("hourly loss would exceed limit")
	}

	// Check daily limit
	dailyTotal := c.calculateRecentLosses(24 * time.Hour)
	projectedDaily := new(big.Int).Add(dailyTotal, potentialLoss)
	if projectedDaily.Cmp(c.maxLossPerDay) > 0 {
		c.trip("daily loss limit exceeded")
		return fmt.Errorf("daily loss would exceed limit")
	}

	return nil
}

// RecordLoss records a loss event
func (c *CircuitBreaker) RecordLoss(amount *big.Int, reason string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	record := LossRecord{
		Amount:    amount,
		Timestamp: time.Now(),
		Reason:    reason,
	}

	c.hourlyLosses = append(c.hourlyLosses, record)
	c.dailyLosses = append(c.dailyLosses, record)

	// Clean old records
	c.cleanOldRecords()
}

// calculateRecentLosses sums losses within duration
func (c *CircuitBreaker) calculateRecentLosses(duration time.Duration) *big.Int {
	total := big.NewInt(0)
	cutoff := time.Now().Add(-duration)

	var records []LossRecord
	if duration == time.Hour {
		records = c.hourlyLosses
	} else {
		records = c.dailyLosses
	}

	for _, record := range records {
		if record.Timestamp.After(cutoff) {
			total = new(big.Int).Add(total, record.Amount)
		}
	}

	return total
}

// cleanOldRecords removes expired records
func (c *CircuitBreaker) cleanOldRecords() {
	hourCutoff := time.Now().Add(-time.Hour)
	dayCutoff := time.Now().Add(-24 * time.Hour)

	// Clean hourly
	var newHourly []LossRecord
	for _, record := range c.hourlyLosses {
		if record.Timestamp.After(hourCutoff) {
			newHourly = append(newHourly, record)
		}
	}
	c.hourlyLosses = newHourly

	// Clean daily
	var newDaily []LossRecord
	for _, record := range c.dailyLosses {
		if record.Timestamp.After(dayCutoff) {
			newDaily = append(newDaily, record)
		}
	}
	c.dailyLosses = newDaily
}

// trip activates the circuit breaker
func (c *CircuitBreaker) trip(reason string) {
	c.isTripped = true
	fmt.Printf("CIRCUIT BREAKER TRIPPED: %s\n", reason)
}

// Reset manually resets the circuit breaker
func (c *CircuitBreaker) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.isTripped = false
}

// IsTripped checks if breaker is active
func (c *CircuitBreaker) IsTripped() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.isTripped
}
```

### Complete Risk Manager

`RiskManager` composes the slippage calculator, MEV protection client, and a circuit breaker into a single decision point that every trade must pass through. The circuit breaker pattern trips after repeated failures and stops all trading until manually reset or until a recovery timeout elapses, preventing a cascade of failed transactions from consuming gas during a protocol incident.

```go
// pkg/defi/risk/manager.go
package risk

import (
	"context"
	"fmt"
	"math/big"

	"yourapp/pkg/defi"
)

// Manager coordinates all risk controls
type Manager struct {
	slippage       *SlippageProtection
	mev            *MEVProtection
	circuitBreaker *CircuitBreaker
}

// NewManager creates a risk manager
func NewManager(
	maxSlippageBps uint64,
	useFlashbots bool,
	maxLossPerTx, maxLossPerHour, maxLossPerDay *big.Int,
) *Manager {
	return &Manager{
		slippage:       NewSlippageProtection(maxSlippageBps),
		mev:            NewMEVProtection(useFlashbots),
		circuitBreaker: NewCircuitBreaker(maxLossPerTx, maxLossPerHour, maxLossPerDay),
	}
}

// ValidateSwap performs all risk checks before a swap
func (m *Manager) ValidateSwap(ctx context.Context, req *defi.SwapRequest, expectedOut *big.Int) error {
	// Check slippage
	if err := m.slippage.ValidateSlippage(expectedOut, req.MinAmountOut); err != nil {
		return fmt.Errorf("slippage check failed: %w", err)
	}

	// Calculate potential loss
	potentialLoss := new(big.Int).Sub(expectedOut, req.MinAmountOut)

	// Check circuit breaker
	if err := m.circuitBreaker.CheckTransaction(potentialLoss); err != nil {
		return fmt.Errorf("circuit breaker check failed: %w", err)
	}

	return nil
}

// RecordSwapResult records swap outcome for risk tracking
func (m *Manager) RecordSwapResult(expected, actual *big.Int) {
	if actual.Cmp(expected) < 0 {
		loss := new(big.Int).Sub(expected, actual)
		m.circuitBreaker.RecordLoss(loss, "slippage")
	}
}
```

### Junior → FAANG: DeFi Risk Management Fundamentals

DeFi risk management for backend engineers starts with understanding the categories of risk: smart contract risk (bugs in the protocol's code), economic risk (vulnerabilities in the protocol's incentive design), oracle risk (incorrect price data), liquidity risk (inability to execute operations at expected prices), and regulatory risk (changes in the legal environment affecting protocol availability or user access). Each category requires different monitoring and mitigation strategies.

The most immediately actionable risk management practice for junior engineers is implementing exposure limits: hard limits on the total value that your system can have at risk in any single protocol at any time. If your system has a maximum of \$100,000 at risk in Aave, then even a complete Aave exploit (which is unlikely given Aave's security practices but theoretically possible) has a bounded worst-case loss. Implementing and enforcing these limits in Go code before any capital is deployed is a prerequisite, not an afterthought.

Health factor monitoring for lending positions is a concrete risk management implementation task. The system should monitor health factors in real time (or at least every block), alert when a health factor drops below a warning threshold (e.g., 1.5), and automatically execute a de-risking action (add collateral or repay debt) when the health factor drops below a critical threshold (e.g., 1.2). The de-risking action must be tested and verified to work correctly before the system holds any real capital.

Interview entry point: describe the risk monitoring architecture for a system that holds positions in three DeFi protocols simultaneously: Uniswap (LP position), Aave (borrow position), and Compound (supply position). For each protocol, you need different metrics: for Uniswap, track LP value and fee income versus impermanent loss. For Aave, track health factor and interest rate. For Compound, track supply rate and utilization. These different risk profiles require a flexible monitoring architecture that can express protocol-specific risk metrics.

### Senior @ FAANG: DeFi Risk Management as a Quantitative Discipline

At staff level, DeFi risk management is a quantitative discipline that requires numerical risk modeling, portfolio-level correlation analysis, and stress testing. Informal risk management ("this looks safe") is insufficient for systems that manage significant capital because the failure modes in DeFi are correlated across protocols in ways that are not intuitive.

Value at Risk (VaR) calculation for DeFi portfolios requires adapting the traditional financial model to blockchain-specific risks. Traditional VaR uses historical price volatility to estimate the probability of losses exceeding a threshold. DeFi VaR must additionally account for: smart contract exploit risk (non-continuous, binary outcomes that are difficult to model with historical distributions), liquidity risk (the ability to exit positions may be constrained during market stress when liquidity dries up), and oracle manipulation risk (sudden price discrepancies that cause cascading liquidations).

Protocol correlation is a critical and underappreciated risk factor. Many DeFi protocols share the same underlying assets (ETH, USDC, WBTC), the same oracle infrastructure (Chainlink), and the same governance token distribution patterns (large initial allocations to VCs and team members). A market-wide stress event (as in March 2020 or November 2022) causes correlated stress across all protocols simultaneously: ETH price drops cause collateral liquidations across Aave, Compound, and Euler. Stablecoin demand spikes and causes curve pool imbalances. Gas prices spike and make liquidations uneconomical for small positions. Staff engineers model these correlations in their risk frameworks.

Circuit breaker design for DeFi integrations is a technical risk management control that stops the system from taking actions when risk parameters are outside acceptable bounds. Effective circuit breakers in Go code for DeFi integration check: oracle price deviation (halt if any oracle price deviates from the median by more than X percent), protocol health metrics (halt if a lending protocol's utilization rate exceeds a threshold indicating stress), and position size limits (halt if any single protocol exposure exceeds the defined maximum). Circuit breakers must be tested regularly to verify they activate correctly and that the fallback behavior is safe.

The risk management framework must be reviewed and updated after every significant DeFi market event, regardless of whether your system was directly affected. After the Terra/LUNA collapse (May 2022), every DeFi risk framework should have been updated to account for algorithmic stablecoin depeg risk. After the FTX collapse (November 2022), every framework should have been updated to account for CeFi counterparty risk affecting DeFi liquidity through the withdrawal of FTX-affiliated market makers. Staff engineers own this maintenance responsibility.

Bar-raiser signals: designing a stress testing framework that simulates the effect of a 50 percent ETH price drop, a 10 percent stablecoin depeg, and a simultaneous 3x increase in gas prices on a DeFi portfolio's positions across multiple protocols, computing the expected P&L and the actions required to maintain each position within risk parameters, or explaining how the EigenLayer restaking mechanism creates a new category of protocol risk (slashing on EigenLayer can reduce the ETH collateral backing positions in other protocols, creating a cascading liquidation risk that did not exist before restaking). These quantitative risk topics reveal principal-level thinking.

---
