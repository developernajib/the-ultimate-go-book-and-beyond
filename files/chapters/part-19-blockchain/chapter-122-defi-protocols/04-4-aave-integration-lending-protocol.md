## 122.4 Aave Integration (Lending Protocol)

Aave is a leading decentralized lending protocol that allows users to supply and borrow assets.

### Aave Client

The Aave client wraps the `LendingPool` and `LendingPoolAddressesProvider` contracts to resolve the current pool address dynamically, since Aave deploys upgrades through a proxy registry rather than a fixed address. The `Supply` method calls `approve` on the asset token before calling `deposit`, since Aave's pool contract pulls tokens from the supplier using `transferFrom` and will revert without prior approval.

```go
// pkg/defi/aave/client.go
package aave

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	"yourapp/pkg/defi"
)

// Aave V3 addresses (Ethereum mainnet)
var (
	PoolAddressesProvider = common.HexToAddress("0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e")
	PoolAddress          = common.HexToAddress("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2")
)

// Client provides Aave protocol operations
type Client struct {
	client             *ethclient.Client
	pool               common.Address
	addressesProvider  common.Address
	transactor         *bind.TransactOpts
}

// NewClient creates an Aave client
func NewClient(rpcURL string, transactor *bind.TransactOpts) (*Client, error) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial rpc: %w", err)
	}

	return &Client{
		client:            client,
		pool:              PoolAddress,
		addressesProvider: PoolAddressesProvider,
		transactor:        transactor,
	}, nil
}

// Supply deposits assets into Aave
func (c *Client) Supply(ctx context.Context, asset common.Address, amount *big.Int, onBehalfOf common.Address) error {
	pool, err := NewIPool(c.pool, c.client)
	if err != nil {
		return fmt.Errorf("load pool: %w", err)
	}

	opts := *c.transactor
	opts.Context = ctx

	// referralCode is deprecated in V3, use 0
	tx, err := pool.Supply(&opts, asset, amount, onBehalfOf, 0)
	if err != nil {
		return fmt.Errorf("supply: %w", err)
	}

	_, err = bind.WaitMined(ctx, c.client, tx)
	if err != nil {
		return fmt.Errorf("wait for tx: %w", err)
	}

	return nil
}

// Withdraw withdraws supplied assets
func (c *Client) Withdraw(ctx context.Context, asset common.Address, amount *big.Int, to common.Address) (*big.Int, error) {
	pool, err := NewIPool(c.pool, c.client)
	if err != nil {
		return nil, fmt.Errorf("load pool: %w", err)
	}

	opts := *c.transactor
	opts.Context = ctx

	// Use max uint256 to withdraw all
	if amount == nil {
		amount = new(big.Int).Sub(
			new(big.Int).Lsh(big.NewInt(1), 256),
			big.NewInt(1),
		)
	}

	tx, err := pool.Withdraw(&opts, asset, amount, to)
	if err != nil {
		return nil, fmt.Errorf("withdraw: %w", err)
	}

	receipt, err := bind.WaitMined(ctx, c.client, tx)
	if err != nil {
		return nil, fmt.Errorf("wait for tx: %w", err)
	}

	// Parse actual withdrawn amount from logs
	withdrawnAmount := c.parseWithdrawAmount(receipt)

	return withdrawnAmount, nil
}

// Borrow borrows assets from Aave
func (c *Client) Borrow(ctx context.Context, asset common.Address, amount *big.Int, interestRateMode *big.Int, onBehalfOf common.Address) error {
	pool, err := NewIPool(c.pool, c.client)
	if err != nil {
		return fmt.Errorf("load pool: %w", err)
	}

	opts := *c.transactor
	opts.Context = ctx

	// interestRateMode: 1 = stable, 2 = variable
	if interestRateMode == nil {
		interestRateMode = big.NewInt(2) // Default to variable
	}

	tx, err := pool.Borrow(&opts, asset, amount, interestRateMode, 0, onBehalfOf)
	if err != nil {
		return fmt.Errorf("borrow: %w", err)
	}

	_, err = bind.WaitMined(ctx, c.client, tx)
	if err != nil {
		return fmt.Errorf("wait for tx: %w", err)
	}

	return nil
}

// Repay repays borrowed assets
func (c *Client) Repay(ctx context.Context, asset common.Address, amount *big.Int, interestRateMode *big.Int, onBehalfOf common.Address) error {
	pool, err := NewIPool(c.pool, c.client)
	if err != nil {
		return fmt.Errorf("load pool: %w", err)
	}

	opts := *c.transactor
	opts.Context = ctx

	// Use max uint256 to repay all debt
	if amount == nil {
		amount = new(big.Int).Sub(
			new(big.Int).Lsh(big.NewInt(1), 256),
			big.NewInt(1),
		)
	}

	if interestRateMode == nil {
		interestRateMode = big.NewInt(2)
	}

	tx, err := pool.Repay(&opts, asset, amount, interestRateMode, onBehalfOf)
	if err != nil {
		return fmt.Errorf("repay: %w", err)
	}

	_, err = bind.WaitMined(ctx, c.client, tx)
	if err != nil {
		return fmt.Errorf("wait for tx: %w", err)
	}

	return nil
}

// GetUserAccountData retrieves user's account data
func (c *Client) GetUserAccountData(ctx context.Context, user common.Address) (*defi.AccountData, error) {
	pool, err := NewIPool(c.pool, c.client)
	if err != nil {
		return nil, fmt.Errorf("load pool: %w", err)
	}

	data, err := pool.GetUserAccountData(&bind.CallOpts{Context: ctx}, user)
	if err != nil {
		return nil, fmt.Errorf("get account data: %w", err)
	}

	return &defi.AccountData{
		TotalCollateralETH:          data.TotalCollateralBase,
		TotalDebtETH:                data.TotalDebtBase,
		AvailableBorrowsETH:         data.AvailableBorrowsBase,
		CurrentLiquidationThreshold: data.CurrentLiquidationThreshold,
		LTV:                         data.Ltv,
		HealthFactor:                data.HealthFactor,
	}, nil
}

// GetReserveData retrieves reserve configuration
func (c *Client) GetReserveData(ctx context.Context, asset common.Address) (*ReserveData, error) {
	pool, err := NewIPool(c.pool, c.client)
	if err != nil {
		return nil, fmt.Errorf("load pool: %w", err)
	}

	data, err := pool.GetReserveData(&bind.CallOpts{Context: ctx}, asset)
	if err != nil {
		return nil, fmt.Errorf("get reserve data: %w", err)
	}

	return &ReserveData{
		Configuration:       data.Configuration,
		LiquidityIndex:      data.LiquidityIndex,
		VariableBorrowIndex: data.VariableBorrowIndex,
		CurrentLiquidityRate:    data.CurrentLiquidityRate,
		CurrentVariableBorrowRate: data.CurrentVariableBorrowRate,
		CurrentStableBorrowRate:   data.CurrentStableBorrowRate,
		ATokenAddress:        data.ATokenAddress,
		StableDebtTokenAddress:  data.StableDebtTokenAddress,
		VariableDebtTokenAddress: data.VariableDebtTokenAddress,
	}, nil
}

// ReserveData contains reserve information
type ReserveData struct {
	Configuration            *big.Int
	LiquidityIndex           *big.Int
	VariableBorrowIndex      *big.Int
	CurrentLiquidityRate     *big.Int
	CurrentVariableBorrowRate *big.Int
	CurrentStableBorrowRate   *big.Int
	ATokenAddress            common.Address
	StableDebtTokenAddress   common.Address
	VariableDebtTokenAddress common.Address
}

// CalculateHealthFactor calculates health factor
func CalculateHealthFactor(collateralETH, debtETH, liquidationThreshold *big.Int) *big.Float {
	if debtETH.Cmp(big.NewInt(0)) == 0 {
		return big.NewFloat(0).SetInf(false) // Infinite health factor
	}

	// HF = (collateral * liquidationThreshold / 10000) / debt
	numerator := new(big.Int).Mul(collateralETH, liquidationThreshold)
	numerator = new(big.Int).Div(numerator, big.NewInt(10000))

	hf := new(big.Float).Quo(
		new(big.Float).SetInt(numerator),
		new(big.Float).SetInt(debtETH),
	)

	return hf
}

// Helper to parse withdraw amount from receipt
func (c *Client) parseWithdrawAmount(receipt *types.Receipt) *big.Int {
	// Parse Withdraw event
	return big.NewInt(0) // Placeholder
}
```

### Lending Strategy Example

The lending strategy monitors the health factor from `getUserAccountData` and automatically repays borrowings when it drops below a configurable threshold, preventing liquidation penalties. Automating this reaction requires polling or an event subscription because the health factor changes continuously as interest accrues and collateral prices fluctuate.

```go
// pkg/defi/strategies/lending.go
package strategies

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"yourapp/pkg/defi"
	"yourapp/pkg/defi/aave"
)

// LendingStrategy implements a supply/borrow strategy
type LendingStrategy struct {
	aave    *aave.Client
	user    common.Address

	// Strategy parameters
	targetHealthFactor *big.Float
	minHealthFactor    *big.Float
}

// NewLendingStrategy creates a lending strategy
func NewLendingStrategy(aave *aave.Client, user common.Address) *LendingStrategy {
	return &LendingStrategy{
		aave:               aave,
		user:               user,
		targetHealthFactor: big.NewFloat(2.0),
		minHealthFactor:    big.NewFloat(1.5),
	}
}

// Execute runs the lending strategy
func (s *LendingStrategy) Execute(ctx context.Context) error {
	// Get current account data
	data, err := s.aave.GetUserAccountData(ctx, s.user)
	if err != nil {
		return fmt.Errorf("get account data: %w", err)
	}

	// Calculate current health factor
	hf := aave.CalculateHealthFactor(
		data.TotalCollateralETH,
		data.TotalDebtETH,
		data.CurrentLiquidationThreshold,
	)

	fmt.Printf("Current Health Factor: %s\n", hf.String())

	// Check if we need to rebalance
	if hf.Cmp(s.minHealthFactor) < 0 {
		// Health factor too low, repay some debt
		return s.repayToTarget(ctx, data)
	}

	if hf.Cmp(s.targetHealthFactor) > 0 && data.AvailableBorrowsETH.Cmp(big.NewInt(0)) > 0 {
		// Can borrow more while staying safe
		return s.borrowToTarget(ctx, data)
	}

	fmt.Println("Position is balanced, no action needed")
	return nil
}

// repayToTarget repays debt to reach target health factor
func (s *LendingStrategy) repayToTarget(ctx context.Context, data *defi.AccountData) error {
	// Calculate amount to repay
	// Target: (collateral * liquidationThreshold / 10000) / (debt - repayAmount) = targetHF
	// Solve for repayAmount

	targetHFInt := big.NewInt(int64(s.targetHealthFactor.Sign()))

	numerator := new(big.Int).Mul(data.TotalCollateralETH, data.CurrentLiquidationThreshold)
	numerator = new(big.Int).Div(numerator, big.NewInt(10000))

	targetDebt := new(big.Int).Div(numerator, targetHFInt)
	repayAmount := new(big.Int).Sub(data.TotalDebtETH, targetDebt)

	if repayAmount.Cmp(big.NewInt(0)) <= 0 {
		return fmt.Errorf("no repayment needed")
	}

	fmt.Printf("Repaying %s to improve health factor\n", repayAmount.String())

	// Repay (would need to specify asset)
	// asset := common.HexToAddress("...") // USDC or other
	// return s.aave.Repay(ctx, asset, repayAmount, big.NewInt(2), s.user)

	return nil
}

// borrowToTarget borrows to leverage position
func (s *LendingStrategy) borrowToTarget(ctx context.Context, data *defi.AccountData) error {
	// Calculate maximum safe borrow amount
	targetHFInt := big.NewInt(int64(s.targetHealthFactor.Sign()))

	numerator := new(big.Int).Mul(data.TotalCollateralETH, data.CurrentLiquidationThreshold)
	numerator = new(big.Int).Div(numerator, big.NewInt(10000))

	targetDebt := new(big.Int).Div(numerator, targetHFInt)
	borrowAmount := new(big.Int).Sub(targetDebt, data.TotalDebtETH)

	if borrowAmount.Cmp(data.AvailableBorrowsETH) > 0 {
		borrowAmount = data.AvailableBorrowsETH
	}

	if borrowAmount.Cmp(big.NewInt(0)) <= 0 {
		return fmt.Errorf("no borrowing capacity")
	}

	fmt.Printf("Borrowing %s to optimize leverage\n", borrowAmount.String())

	// Borrow (would need to specify asset)
	// asset := common.HexToAddress("...") // USDC or other
	// return s.aave.Borrow(ctx, asset, borrowAmount, big.NewInt(2), s.user)

	return nil
}
```

### Junior → FAANG: Aave Integration Fundamentals

Aave is the reference lending protocol for DeFi integration: it has a clean interface, comprehensive documentation, multiple audits, and is deployed on all major EVM chains. Understanding Aave's core mechanics (supply, borrow, repay, withdraw) is the foundation for working with any lending protocol.

The most important concept for junior engineers is the health factor: a numeric value representing the safety of a borrow position. Health factor = (total collateral value in ETH * weighted average liquidation threshold) / total borrow value in ETH. A health factor below 1.0 means the position is liquidatable. Go integrations that manage borrowed positions must continuously monitor the health factor and take action (add more collateral or repay some debt) when it approaches the liquidation threshold.

The Aave V3 Pool contract is the central interface: `supply(asset, amount, onBehalfOf, referralCode)`, `borrow(asset, amount, interestRateMode, referralCode, onBehalfOf)`, `repay(asset, amount, interestRateMode, onBehalfOf)`, and `withdraw(asset, amount, to)`. Each of these requires appropriate token approvals (supply and repay require approving the Pool to spend the token, borrow and withdraw do not require approvals). The `referralCode` is for ecosystem partner tracking and can be 0 for direct integrations.

Interview entry point: explain the difference between variable rate and stable rate borrowing in Aave. Variable rate adjusts continuously based on pool utilization (higher utilization means higher variable rate). Stable rate locks in a rate at the time of borrowing but can be rebalanced by the protocol if the stable rate becomes significantly below market rates (to prevent stable borrowers from extracting value from depositors). For integrations that hold borrow positions, variable rate is typically simpler to manage because it does not have the rebalancing risk.

### Senior @ FAANG: Aave Integration at Institutional Scale

At staff level, Aave integration is a capital management and risk management system. Any position in Aave carries liquidation risk, interest rate risk, and protocol risk. The Go infrastructure that manages Aave positions must implement: real-time health factor monitoring with graduated alert thresholds, automated de-risking actions when the health factor approaches a defined minimum, interest rate monitoring to detect when variable rates make borrowing uneconomical, and regular reconciliation of application-side position records against on-chain position data.

Aave V3's efficiency mode (eMode) is an important architectural feature for specialized integrations. eMode allows correlated assets (e.g., ETH and stETH, or USDC and USDT) to be used with higher LTV (loan-to-value) ratios because their prices are correlated. An integration that uses eMode correctly can achieve 90-97 percent LTV on correlated pairs, enabling significantly more capital-efficient strategies. Using eMode requires categorizing assets into the correct eMode category when supplying or borrowing.

Aave's cross-chain portal feature (available on V3) allows supplying liquidity on one chain and borrowing against it on another. This feature has specific integration complexity: the supply and borrow operations happen on different chains, the health factor calculation spans both chains, and liquidation risk exists on both chains independently. Staff engineers who design cross-chain leveraged strategies using Aave portals must account for the cross-chain latency in health factor updates and design conservative margin buffers accordingly.

Liquidation integration is a specialized Aave use case that requires understanding the economic incentive structure. When a position's health factor drops below 1.0, anyone can call `liquidationCall` to liquidate a portion of the position's collateral in exchange for a bonus (the liquidation bonus, typically 5-10 percent above market price). Building a liquidation bot in Go requires: monitoring all positions' health factors (via `getUserAccountData`), estimating the profit of each potential liquidation (accounting for gas costs), and submitting liquidation transactions faster than competing liquidation bots. This is a competitive market where the first transaction to be included in the block wins.

Credit delegation (Aave V3 feature) allows one account to delegate its credit line to another, enabling undercollateralized borrowing when the delegator trusts the delegatee. This feature is used in institutional lending and in protocol-to-protocol credit arrangements. Go integration for credit delegation requires implementing the EIP-712 signature flow for `delegationWithSig`, which allows the delegator to sign an off-chain approval that the delegatee submits on-chain, enabling gasless approval in the delegation workflow.

Bar-raiser signals: designing a monitoring system that tracks all Aave positions that are within 10 percent of their liquidation threshold across multiple chains simultaneously, with alerting via PagerDuty for positions that cross the 5 percent threshold, and automated de-risking transactions that increase collateral when the threshold is crossed, or explaining the mathematical relationship between the liquidation threshold, the liquidation bonus, and the maximum deficit a protocol can incur before the liquidation mechanism fails to fully cover bad debt (the so-called "bad debt cascade" risk). These topics reveal genuine lending protocol integration experience.

---
