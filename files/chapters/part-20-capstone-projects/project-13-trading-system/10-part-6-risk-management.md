## Part 6: Risk Management

Risk management is critical for preventing catastrophic losses. In real-world trading, a single bug or runaway algorithm can lose millions of dollars in seconds if there are no safety controls in place. The risk manager acts as a gatekeeper that checks every order before it reaches the market. It enforces limits on position size, order value, loss thresholds, and trading velocity. These pre-trade checks run on every single order submission, so they must be extremely fast while remaining thorough enough to catch dangerous situations.

```go
// internal/risk/manager.go
package risk

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/yourusername/trading-system/pkg/types"
)

// Manager implements risk management
type Manager struct {
	config *Config

	// Account state
	accounts map[types.AccountID]*types.Account
	mu       sync.RWMutex

	// Risk limits
	limits *Limits

	// Kill switch
	killSwitch atomic.Bool

	ctx    context.Context
	cancel context.CancelFunc
}

// Config holds risk management configuration
type Config struct {
	EnablePreTradeRisk  bool
	EnablePostTradeRisk bool
	EnableKillSwitch    bool
	MaxOrderSize        types.Quantity
	MaxPositionSize     types.Quantity
	MaxDailyLoss        types.Price
	MaxDrawdown         float64
}

// Limits defines risk limits
type Limits struct {
	// Per-symbol limits
	MaxPositionSize map[types.Symbol]types.Quantity
	MaxOrderSize    map[types.Symbol]types.Quantity

	// Per-account limits
	MaxAccountLeverage map[types.AccountID]float64
	MaxDailyLoss       map[types.AccountID]types.Price

	// System-wide limits
	MaxSystemLeverage  float64
	MaxOpenOrders      int
	MaxOrderRate       int // Orders per second
}

// NewManager creates a new risk manager
func NewManager(config *Config) *Manager {
	ctx, cancel := context.WithCancel(context.Background())

	return &Manager{
		config:   config,
		accounts: make(map[types.AccountID]*types.Account),
		limits:   &Limits{
			MaxPositionSize:    make(map[types.Symbol]types.Quantity),
			MaxOrderSize:       make(map[types.Symbol]types.Quantity),
			MaxAccountLeverage: make(map[types.AccountID]float64),
			MaxDailyLoss:       make(map[types.AccountID]types.Price),
		},
		ctx:    ctx,
		cancel: cancel,
	}
}

// CheckOrder performs pre-trade risk checks
func (m *Manager) CheckOrder(order *types.Order) *types.RiskCheck {
	check := &types.RiskCheck{
		Order:      order,
		CheckedAt:  time.Now(),
		Passed:     true,
		Violations: make([]string, 0),
	}

	// Check kill switch
	if m.killSwitch.Load() {
		check.Passed = false
		check.Violations = append(check.Violations, "Kill switch activated")
		return check
	}

	// Check order size
	if m.config.MaxOrderSize > 0 && order.Quantity > m.config.MaxOrderSize {
		check.Passed = false
		check.Violations = append(check.Violations,
			fmt.Sprintf("Order size %s exceeds max %s",
				order.Quantity, m.config.MaxOrderSize))
	}

	// Check symbol-specific order size
	if maxSize, exists := m.limits.MaxOrderSize[order.Symbol]; exists {
		if order.Quantity > maxSize {
			check.Passed = false
			check.Violations = append(check.Violations,
				fmt.Sprintf("Order size exceeds symbol limit: %s > %s",
					order.Quantity, maxSize))
		}
	}

	// Get account
	m.mu.RLock()
	account, exists := m.accounts[order.AccountID]
	m.mu.RUnlock()

	if !exists {
		check.Passed = false
		check.Violations = append(check.Violations, "Account not found")
		return check
	}

	// Check available balance
	orderValue := order.Price.Mul(order.Quantity)
	if account.AvailableBalance < orderValue {
		check.Passed = false
		check.Violations = append(check.Violations,
			fmt.Sprintf("Insufficient balance: need %s, have %s",
				orderValue, account.AvailableBalance))
	}

	// Check position limits
	if err := m.checkPositionLimits(account, order); err != nil {
		check.Passed = false
		check.Violations = append(check.Violations, err.Error())
	}

	// Check daily loss limit
	if err := m.checkDailyLoss(account); err != nil {
		check.Passed = false
		check.Violations = append(check.Violations, err.Error())
	}

	return check
}

// UpdatePosition updates position after fill
func (m *Manager) UpdatePosition(accountID types.AccountID, fill *types.Fill) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	account, exists := m.accounts[accountID]
	if !exists {
		return fmt.Errorf("account not found: %s", accountID)
	}

	position, exists := account.Positions[fill.Symbol]
	if !exists {
		position = &types.Position{
			Symbol:    fill.Symbol,
			AccountID: accountID,
		}
		account.Positions[fill.Symbol] = position
	}

	// Update position based on fill
	if fill.Side == types.SideBuy {
		// Buying - increase long position
		oldQty := position.Quantity
		newQty := oldQty + fill.Quantity

		// Calculate new average entry price
		if oldQty == 0 {
			position.AvgEntryPrice = fill.Price
		} else {
			totalValue := position.AvgEntryPrice.Mul(oldQty) + fill.Price.Mul(fill.Quantity)
			position.AvgEntryPrice = types.Price(int64(totalValue) / int64(newQty))
		}

		position.Quantity = newQty
		position.Side = types.SideBuy
	} else {
		// Selling - decrease long or increase short
		if position.Side == types.SideBuy {
			// Closing long position
			position.Quantity -= fill.Quantity

			// Calculate realized PnL
			pnl := (fill.Price - position.AvgEntryPrice).Mul(fill.Quantity)
			position.RealizedPnL += pnl
			account.RealizedPnL += pnl

			if position.Quantity == 0 {
				position.AvgEntryPrice = 0
			}
		} else {
			// Increasing short position
			oldQty := position.Quantity
			newQty := oldQty + fill.Quantity

			if oldQty == 0 {
				position.AvgEntryPrice = fill.Price
			} else {
				totalValue := position.AvgEntryPrice.Mul(oldQty) + fill.Price.Mul(fill.Quantity)
				position.AvgEntryPrice = types.Price(int64(totalValue) / int64(newQty))
			}

			position.Quantity = newQty
			position.Side = types.SideSell
		}
	}

	position.LastUpdateTime = fill.Timestamp

	return nil
}

// CalculateUnrealizedPnL calculates unrealized PnL for a position
func (m *Manager) CalculateUnrealizedPnL(position *types.Position, currentPrice types.Price) types.Price {
	if position.Quantity == 0 {
		return 0
	}

	var pnl types.Price
	if position.Side == types.SideBuy {
		// Long position: profit when price goes up
		pnl = (currentPrice - position.AvgEntryPrice).Mul(position.Quantity)
	} else {
		// Short position: profit when price goes down
		pnl = (position.AvgEntryPrice - currentPrice).Mul(position.Quantity)
	}

	return pnl
}

// UpdateAccountPnL updates account-level PnL
func (m *Manager) UpdateAccountPnL(accountID types.AccountID, prices map[types.Symbol]types.Price) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	account, exists := m.accounts[accountID]
	if !exists {
		return fmt.Errorf("account not found: %s", accountID)
	}

	totalUnrealizedPnL := types.Price(0)

	for symbol, position := range account.Positions {
		currentPrice, hasPrice := prices[symbol]
		if !hasPrice {
			continue
		}

		pnl := m.CalculateUnrealizedPnL(position, currentPrice)
		position.UnrealizedPnL = pnl
		totalUnrealizedPnL += pnl
	}

	account.UnrealizedPnL = totalUnrealizedPnL
	account.LastUpdateTime = time.Now()

	return nil
}

// ActivateKillSwitch activates the kill switch
func (m *Manager) ActivateKillSwitch(reason string) {
	m.killSwitch.Store(true)
	// Log kill switch activation
	// In production, this would trigger immediate order cancellation
}

// DeactivateKillSwitch deactivates the kill switch
func (m *Manager) DeactivateKillSwitch() {
	m.killSwitch.Store(false)
}

// IsKillSwitchActive returns kill switch status
func (m *Manager) IsKillSwitchActive() bool {
	return m.killSwitch.Load()
}

// checkPositionLimits checks if order would exceed position limits
func (m *Manager) checkPositionLimits(account *types.Account, order *types.Order) error {
	position, exists := account.Positions[order.Symbol]
	if !exists {
		// No existing position
		return nil
	}

	// Calculate new position size after order
	newSize := position.Quantity
	if order.Side == position.Side {
		newSize += order.Quantity
	} else {
		newSize -= order.Quantity
	}

	// Check against symbol limit
	if maxSize, hasLimit := m.limits.MaxPositionSize[order.Symbol]; hasLimit {
		if newSize > maxSize {
			return fmt.Errorf("position limit exceeded: %s > %s", newSize, maxSize)
		}
	}

	// Check against global limit
	if m.config.MaxPositionSize > 0 && newSize > m.config.MaxPositionSize {
		return fmt.Errorf("max position size exceeded: %s > %s",
			newSize, m.config.MaxPositionSize)
	}

	return nil
}

// checkDailyLoss checks if daily loss limit is exceeded
func (m *Manager) checkDailyLoss(account *types.Account) error {
	totalPnL := account.RealizedPnL + account.UnrealizedPnL

	if totalPnL < 0 {
		loss := -totalPnL

		// Check account-specific limit
		if maxLoss, hasLimit := m.limits.MaxDailyLoss[account.ID]; hasLimit {
			if loss > maxLoss {
				return fmt.Errorf("daily loss limit exceeded: %s > %s", loss, maxLoss)
			}
		}

		// Check global limit
		if m.config.MaxDailyLoss > 0 && loss > m.config.MaxDailyLoss {
			return fmt.Errorf("max daily loss exceeded: %s > %s",
				loss, m.config.MaxDailyLoss)
		}
	}

	return nil
}

// GetAccount retrieves account state
func (m *Manager) GetAccount(accountID types.AccountID) (*types.Account, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	account, exists := m.accounts[accountID]
	if !exists {
		return nil, fmt.Errorf("account not found: %s", accountID)
	}

	return account, nil
}

// CreateAccount creates a new trading account
func (m *Manager) CreateAccount(accountID types.AccountID, balance types.Price) *types.Account {
	m.mu.Lock()
	defer m.mu.Unlock()

	account := &types.Account{
		ID:               accountID,
		Balance:          balance,
		AvailableBalance: balance,
		Positions:        make(map[types.Symbol]*types.Position),
		LastUpdateTime:   time.Now(),
	}

	m.accounts[accountID] = account

	return account
}
```
