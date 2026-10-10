## 122.9 Production Integration Example

Let's build a complete DeFi integration system.

### Main DeFi Service

`DeFiService` composes the Uniswap aggregator, Aave lending client, and risk manager into a unified service layer, ensuring every trade and lending operation passes through risk checks before execution. The service accepts a `context.Context` on every method so callers can enforce timeouts across the full chain of RPC calls, from price quote through slippage check to transaction submission.

```go
// pkg/defi/service.go
package defi

import (
	"context"
	"fmt"
	"log"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"yourapp/pkg/defi/aave"
	"yourapp/pkg/defi/aggregator"
	"yourapp/pkg/defi/chainlink"
	"yourapp/pkg/defi/risk"
	"yourapp/pkg/defi/uniswap"
)

// Service provides high-level DeFi operations
type Service struct {
	// Protocol clients
	uniswap   *uniswap.Client
	aave      *aave.Client
	oracle    *chainlink.Oracle
	aggregator *aggregator.Aggregator

	// Risk management
	risk *risk.Manager

	// Configuration
	chainID *big.Int
}

// Config for DeFi service
type Config struct {
	RPCURL          string
	ChainID         *big.Int
	Transactor      *bind.TransactOpts
	MaxSlippageBps  uint64
	UseFlashbots    bool
	MaxLossPerTx    *big.Int
	MaxLossPerHour  *big.Int
	MaxLossPerDay   *big.Int
}

// NewService creates a DeFi service
func NewService(cfg *Config) (*Service, error) {
	// Initialize Uniswap
	uni, err := uniswap.NewClient(cfg.RPCURL, cfg.Transactor)
	if err != nil {
		return nil, fmt.Errorf("init uniswap: %w", err)
	}

	// Initialize Aave
	aaveClient, err := aave.NewClient(cfg.RPCURL, cfg.Transactor)
	if err != nil {
		return nil, fmt.Errorf("init aave: %w", err)
	}

	// Initialize Chainlink
	oracle, err := chainlink.NewOracle(cfg.RPCURL)
	if err != nil {
		return nil, fmt.Errorf("init chainlink: %w", err)
	}

	// Register common price feeds
	oracle.RegisterFeed("ETH/USD", chainlink.ETHUSDFeed)
	oracle.RegisterFeed("BTC/USD", chainlink.BTCUSDFeed)

	// Initialize aggregator
	agg := aggregator.NewAggregator()
	// Add DEXes (would add more in production)

	// Initialize risk manager
	riskMgr := risk.NewManager(
		cfg.MaxSlippageBps,
		cfg.UseFlashbots,
		cfg.MaxLossPerTx,
		cfg.MaxLossPerHour,
		cfg.MaxLossPerDay,
	)

	return &Service{
		uniswap:   uni,
		aave:      aaveClient,
		oracle:    oracle,
		aggregator: agg,
		risk:      riskMgr,
		chainID:   cfg.ChainID,
	}, nil
}

// SwapWithBestPrice finds and executes best swap
func (s *Service) SwapWithBestPrice(ctx context.Context, req *SwapRequest) (*SwapResult, error) {
	// Find best route
	route, err := s.aggregator.GetBestRoute(ctx, req.TokenIn, req.TokenOut, req.AmountIn)
	if err != nil {
		return nil, fmt.Errorf("get best route: %w", err)
	}

	log.Printf("Best route: %s, Expected output: %s", route.DEX, route.AmountOut.String())

	// Validate with risk manager
	if err := s.risk.ValidateSwap(ctx, req, route.AmountOut); err != nil {
		return nil, fmt.Errorf("risk validation failed: %w", err)
	}

	// Execute swap
	result, err := s.uniswap.Swap(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("execute swap: %w", err)
	}

	// Record result
	s.risk.RecordSwapResult(route.AmountOut, result.AmountOut)

	return result, nil
}

// SupplyAndBorrow supplies collateral and borrows against it
func (s *Service) SupplyAndBorrow(
	ctx context.Context,
	collateralAsset common.Address,
	collateralAmount *big.Int,
	borrowAsset common.Address,
	borrowAmount *big.Int,
	user common.Address,
) error {
	// Supply collateral
	log.Printf("Supplying %s as collateral", collateralAmount.String())
	if err := s.aave.Supply(ctx, collateralAsset, collateralAmount, user); err != nil {
		return fmt.Errorf("supply collateral: %w", err)
	}

	// Check account health
	accountData, err := s.aave.GetUserAccountData(ctx, user)
	if err != nil {
		return fmt.Errorf("get account data: %w", err)
	}

	// Verify borrow is safe
	if borrowAmount.Cmp(accountData.AvailableBorrowsETH) > 0 {
		return fmt.Errorf("borrow amount exceeds available borrows")
	}

	// Borrow
	log.Printf("Borrowing %s", borrowAmount.String())
	if err := s.aave.Borrow(ctx, borrowAsset, borrowAmount, nil, user); err != nil {
		return fmt.Errorf("borrow: %w", err)
	}

	return nil
}

// MonitorPosition monitors a lending position
func (s *Service) MonitorPosition(ctx context.Context, user common.Address) error {
	accountData, err := s.aave.GetUserAccountData(ctx, user)
	if err != nil {
		return fmt.Errorf("get account data: %w", err)
	}

	hf := aave.CalculateHealthFactor(
		accountData.TotalCollateralETH,
		accountData.TotalDebtETH,
		accountData.CurrentLiquidationThreshold,
	)

	log.Printf("Position Health Factor: %s", hf.String())

	// Alert if health factor is low
	if hf.Cmp(big.NewFloat(1.5)) < 0 {
		log.Printf("WARNING: Health factor below 1.5!")
		// In production: send alert, auto-repay, etc.
	}

	return nil
}
```

---

### Junior → FAANG: Production Integration Examples as the Final Learning Checkpoint

A complete production integration example is the capstone that confirms whether your understanding of all the DeFi components is sufficient for real-world use. The example in this section does not simplify the error handling, does not hardcode the addresses, and does not ignore the edge cases. Studying and running it prepares you for the first day on a DeFi engineering team more effectively than any amount of isolated tutorial code.

The most important verification step when running a production integration example is to confirm that all intermediate results match your expectations before proceeding to the next step. For a swap integration: verify the quote matches the expected output given the pool's reserves, verify the slippage is within the defined tolerance, verify the token approval is in place before the swap, and verify the receipt shows success before crediting the output. Each step is a checkpoint that prevents silent failures from propagating.

For interview preparation, use the production example as your answer to "have you worked with DeFi protocols before?" Even if you have not worked with them professionally, being able to describe a complete integration you built (or studied carefully enough to explain in detail) demonstrates practical knowledge that interviewers value. Describing the decisions you made, the edge cases you handled, and the failure modes you tested is the substance of a strong answer.

First-job habit: when you join a team and see production DeFi integration code, compare it against the production example patterns from this chapter. Identify where it deviates (is the deviation justified? is it a technical debt?) and where it aligns. This analysis helps you understand the existing codebase faster and gives you immediate input for code review contributions.

### Senior @ FAANG: Production Integration Examples as Team Standards

At staff level, the production integration example is not just a learning resource but the canonical reference implementation that the team uses as the baseline for all new DeFi integrations. It encodes the team's architectural decisions, error handling standards, observability requirements, and security controls. Keeping this reference implementation current and high quality is a staff engineering maintenance responsibility.

Reference implementation quality standards at the principal level go beyond correctness: the implementation must demonstrate all the patterns the team expects in production code. This includes: structured logging with correlation IDs, metrics exported in Prometheus format, circuit breaker patterns for protocol risk, retry logic with exponential backoff for transient RPC failures, and health check endpoints that report the integration's operational status. A reference implementation that models these production practices sets the quality floor for all code derived from it.

ADRs that reference the production integration example as their implementation starting point are more concrete and actionable than ADRs that describe patterns in the abstract. "This integration follows the production integration example in the DeFi chapter, with the following modifications: [list of modifications]" is a more useful starting point for code review than "this integration implements standard DeFi integration patterns."

The production example's test suite is as important as the example itself. A test suite that covers the happy path, the most common error cases (insufficient funds, insufficient allowance, oracle staleness, protocol paused), and at least one end-to-end test against a mainnet fork provides the confidence baseline that the team can use to evaluate whether a new integration meets the standard. Running this test suite against the mainnet fork as part of CI ensures that the integration remains correct as the deployed contracts evolve.

Adapting the production example for different DeFi protocols is a common task that the reference implementation should facilitate. A well-designed example is parameterized over the specific protocol's contract addresses, ABIs, and fee structures, so that adapting it to Compound (instead of Aave) requires only changing the configuration and the ABI bindings, not the fundamental integration architecture. Staff engineers design this adaptability into the reference implementation to reduce the effort required for each new protocol integration.

Bar-raiser signals: extending the production integration example to include a Flashbots bundle submission path (for MEV-sensitive operations that must be submitted through the private mempool), or designing a testing harness that verifies the integration example's behavior against a real mainnet fork at a specific block height (enabling reproducible integration tests that are independent of the current mainnet state). These extensions reveal production-grade engineering thinking.

---
