## 122.3 Liquidity Pool Operations

Managing liquidity is critical for earning trading fees and providing market depth.

### Liquidity Manager

The liquidity manager computes the optimal token ratio from pool reserves before adding liquidity, then sets minimum amounts using the desired slippage tolerance to protect against sandwich attacks that manipulate the pool ratio between transaction submission and mining. Liquidity position tracking stores the LP token amount received so the manager can later calculate the proportional share of pool reserves when removing liquidity.

```go
// pkg/defi/liquidity/manager.go
package liquidity

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	"yourapp/pkg/defi"
	"yourapp/pkg/defi/uniswap/v2"
)

// Manager handles liquidity operations
type Manager struct {
	client   *ethclient.Client
	router   *v2.RouterV2
	positions map[string]*Position
}

// Position represents a liquidity position
type Position struct {
	Pair           common.Address
	TokenA         common.Address
	TokenB         common.Address
	LiquidityToken *big.Int
	AmountA        *big.Int
	AmountB        *big.Int
	AddedAt        time.Time
	LastUpdate     time.Time
}

// NewManager creates a liquidity manager
func NewManager(client *ethclient.Client, router *v2.RouterV2) *Manager {
	return &Manager{
		client:    client,
		router:    router,
		positions: make(map[string]*Position),
	}
}

// AddLiquidity adds liquidity to a pool
func (m *Manager) AddLiquidity(ctx context.Context, req *defi.LiquidityRequest) (*defi.LiquidityResult, error) {
	// Get current reserves to calculate optimal amounts
	pairAddr, err := m.router.GetPair(ctx, req.TokenA, req.TokenB)
	if err != nil {
		return nil, fmt.Errorf("get pair: %w", err)
	}

	reserves, err := m.router.GetReserves(ctx, pairAddr)
	if err != nil {
		return nil, fmt.Errorf("get reserves: %w", err)
	}

	// Calculate optimal amounts based on current ratio
	optimalB := m.calculateOptimalAmount(
		req.AmountADesired,
		reserves.Reserve0,
		reserves.Reserve1,
	)

	var amountA, amountB *big.Int

	if optimalB.Cmp(req.AmountBDesired) <= 0 {
		amountA = req.AmountADesired
		amountB = optimalB
	} else {
		optimalA := m.calculateOptimalAmount(
			req.AmountBDesired,
			reserves.Reserve1,
			reserves.Reserve0,
		)
		amountA = optimalA
		amountB = req.AmountBDesired
	}

	// Verify minimum amounts
	if amountA.Cmp(req.AmountAMin) < 0 {
		return nil, fmt.Errorf("amount A %s below minimum %s", amountA, req.AmountAMin)
	}
	if amountB.Cmp(req.AmountBMin) < 0 {
		return nil, fmt.Errorf("amount B %s below minimum %s", amountB, req.AmountBMin)
	}

	// Execute add liquidity
	router, err := v2.NewIUniswapV2Router02(m.router.routerAddr, m.client)
	if err != nil {
		return nil, fmt.Errorf("load router: %w", err)
	}

	opts := bind.TransactOpts{
		Context: ctx,
		From:    req.Recipient,
	}

	deadlineBig := big.NewInt(req.Deadline.Unix())

	tx, err := router.AddLiquidity(
		&opts,
		req.TokenA,
		req.TokenB,
		amountA,
		amountB,
		req.AmountAMin,
		req.AmountBMin,
		req.Recipient,
		deadlineBig,
	)
	if err != nil {
		return nil, fmt.Errorf("add liquidity: %w", err)
	}

	// Wait for receipt
	receipt, err := bind.WaitMined(ctx, m.client, tx)
	if err != nil {
		return nil, fmt.Errorf("wait for tx: %w", err)
	}

	// Parse liquidity amount from logs
	liquidity := m.parseLiquidityFromReceipt(receipt)

	// Store position
	position := &Position{
		Pair:           pairAddr,
		TokenA:         req.TokenA,
		TokenB:         req.TokenB,
		LiquidityToken: liquidity,
		AmountA:        amountA,
		AmountB:        amountB,
		AddedAt:        time.Now(),
		LastUpdate:     time.Now(),
	}

	m.positions[pairAddr.Hex()] = position

	return &defi.LiquidityResult{
		AmountA:   amountA,
		AmountB:   amountB,
		Liquidity: liquidity,
		TxHash:    tx.Hash(),
	}, nil
}

// RemoveLiquidity removes liquidity from a pool
func (m *Manager) RemoveLiquidity(ctx context.Context, req *defi.RemoveLiquidityRequest) (*defi.LiquidityResult, error) {
	router, err := v2.NewIUniswapV2Router02(m.router.routerAddr, m.client)
	if err != nil {
		return nil, fmt.Errorf("load router: %w", err)
	}

	opts := bind.TransactOpts{
		Context: ctx,
		From:    req.Recipient,
	}

	deadlineBig := big.NewInt(req.Deadline.Unix())

	tx, err := router.RemoveLiquidity(
		&opts,
		req.TokenA,
		req.TokenB,
		req.Liquidity,
		req.AmountAMin,
		req.AmountBMin,
		req.Recipient,
		deadlineBig,
	)
	if err != nil {
		return nil, fmt.Errorf("remove liquidity: %w", err)
	}

	receipt, err := bind.WaitMined(ctx, m.client, tx)
	if err != nil {
		return nil, fmt.Errorf("wait for tx: %w", err)
	}

	// Parse amounts from logs
	amountA, amountB := m.parseAmountsFromReceipt(receipt)

	return &defi.LiquidityResult{
		AmountA:   amountA,
		AmountB:   amountB,
		Liquidity: req.Liquidity,
		TxHash:    tx.Hash(),
	}, nil
}

// calculateOptimalAmount calculates optimal token amount given the other
func (m *Manager) calculateOptimalAmount(amount, reserveA, reserveB *big.Int) *big.Int {
	// optimal = (amount * reserveB) / reserveA
	numerator := new(big.Int).Mul(amount, reserveB)
	return new(big.Int).Div(numerator, reserveA)
}

// GetPosition retrieves a liquidity position
func (m *Manager) GetPosition(pairAddr common.Address) (*Position, error) {
	pos, exists := m.positions[pairAddr.Hex()]
	if !exists {
		return nil, fmt.Errorf("position not found")
	}
	return pos, nil
}

// CalculateImpermanentLoss calculates IL for a position
func (m *Manager) CalculateImpermanentLoss(ctx context.Context, pos *Position) (float64, error) {
	reserves, err := m.router.GetReserves(ctx, pos.Pair)
	if err != nil {
		return 0, fmt.Errorf("get reserves: %w", err)
	}

	// Price at entry
	priceEntry := new(big.Float).Quo(
		new(big.Float).SetInt(pos.AmountB),
		new(big.Float).SetInt(pos.AmountA),
	)

	// Current price
	priceCurrent := new(big.Float).Quo(
		new(big.Float).SetInt(reserves.Reserve1),
		new(big.Float).SetInt(reserves.Reserve0),
	)

	// Price ratio
	ratio := new(big.Float).Quo(priceCurrent, priceEntry)
	ratioFloat, _ := ratio.Float64()

	// IL formula: 2*sqrt(ratio) / (1 + ratio) - 1
	sqrtRatio := big.NewFloat(0).Sqrt(ratio)
	numerator := new(big.Float).Mul(big.NewFloat(2), sqrtRatio)
	denominator := new(big.Float).Add(big.NewFloat(1), ratio)

	il := new(big.Float).Quo(numerator, denominator)
	il = new(big.Float).Sub(il, big.NewFloat(1))

	ilFloat, _ := il.Float64()
	return ilFloat * 100, nil
}

// Helper functions for parsing transaction receipts
func (m *Manager) parseLiquidityFromReceipt(receipt *types.Receipt) *big.Int {
	// Parse Mint event to extract liquidity amount
	// Implementation depends on ABI parsing
	return big.NewInt(0) // Placeholder
}

func (m *Manager) parseAmountsFromReceipt(receipt *types.Receipt) (*big.Int, *big.Int) {
	// Parse Burn event to extract token amounts
	// Implementation depends on ABI parsing
	return big.NewInt(0), big.NewInt(0) // Placeholder
}
```

### Junior → FAANG: Liquidity Pool Mechanics for Backend Engineers

Liquidity pool operations (adding and removing liquidity) are more complex than swaps from an integration perspective because they involve two-sided asset management, LP token accounting, and impermanent loss exposure. Before integrating liquidity operations into any system, understand the economic implications: adding liquidity exposes you to impermanent loss (the loss relative to holding the assets separately when the price ratio changes), which can exceed the trading fees earned over the same period in volatile markets.

The Uniswap V2 `addLiquidity` function requires: the two token addresses, the desired amount of each, the minimum amount of each (slippage tolerance), the recipient address for LP tokens, and a deadline. The critical detail is that the actual amounts deposited may differ from the desired amounts because the pool enforces a constant ratio: you can specify a desired ratio, but the contract will adjust to match the current pool ratio. The `amountAMin` and `amountBMin` parameters protect you from excessive adjustment.

Removing liquidity requires first approving the router to burn your LP tokens (not the underlying tokens). The LP token represents your proportional share of the pool, and burning it returns your share of the current pool reserves. The returned amounts depend on the pool's current reserves at the time of removal, not at the time of addition. A pool that was 50/50 at addition time may return a different ratio if the price has moved significantly.

Interview entry point: explain impermanent loss quantitatively. If you add liquidity to a 50/50 ETH/USDC pool when ETH is at \$2000, and ETH doubles to \$4000, your LP position will be worth less than simply holding the ETH and USDC separately. The formula for impermanent loss is: `IL = 2 * sqrt(price_ratio) / (1 + price_ratio) - 1`. For a 2x price change, IL is approximately 5.7 percent. This loss is only realized if you remove liquidity. Hence "impermanent."

### Senior @ FAANG: Liquidity Pool Operations as Capital Management Infrastructure

At staff level, liquidity pool operations are a capital management problem with specific risk characteristics. Any system that programmatically manages LP positions must account for: impermanent loss (modeled explicitly, not ignored), gas costs of rebalancing (frequent rebalancing may cost more in gas than it gains in fee optimization), and timing risk (the price at the moment of adding or removing liquidity affects the final capital exposure).

Automated liquidity management systems (like the Gamma Strategies protocol for Uniswap V3 concentrated liquidity management) require sophisticated capital efficiency analysis. At the principal level, designing or evaluating these systems requires understanding: the expected return from fees given the current trading volume and fee tier, the expected impermanent loss given the price volatility of the token pair, and the optimal range width for concentrated liquidity (narrower ranges earn more fees when the price stays in range but suffer larger impermanent loss if the price moves out of range).

LP position tracking at scale requires off-chain accounting that reconciles with on-chain state. The value of an LP position changes with every trade in the pool (even without adding or removing liquidity) because the pool's reserves change. Tracking LP value requires either real-time reserve monitoring (expensive in RPC calls) or periodic reconciliation (acceptable for daily accounting but not for real-time risk management). Staff engineers design the reconciliation frequency to match the business requirement, not the most convenient default.

Protocol fee considerations affect the net return from liquidity provision. Many DeFi protocols (Uniswap, Balancer, Curve) have governance-controlled protocol fees that take a share of trading fees. When these fees change via governance, the return model for all LP positions changes. Staff engineers who manage LP positions for a fund or protocol treasury must monitor governance proposals that affect protocol fees and update their return models accordingly.

Liquidity bootstrapping pools (LBPs, used by Balancer and similar protocols) are a specialized liquidity pool design for token launches: the initial weight is heavily skewed toward the new token (e.g., 98/2 token/USDC), and the weight automatically shifts over time to a target ratio (e.g., 50/50). This creates a price discovery mechanism where early buyers pay high prices and prices decrease as more buyers participate. Staff engineers who design token launch infrastructure must understand the LBP mechanics and implement the Go integration carefully to avoid front-running and manipulation.

Bar-raiser signals: designing a liquidity rebalancing system for Uniswap V3 concentrated liquidity positions that minimizes impermanent loss by detecting when the price is approaching the position's range boundary and proactively widening the range (requiring a calculation of the gas cost of rebalancing versus the impermanent loss cost of holding the current position as the price moves out of range), or explaining the difference between single-sided and double-sided liquidity provision on Uniswap V3 and under what circumstances single-sided provision is the appropriate strategy. These topics require deep AMM economics knowledge.

---
