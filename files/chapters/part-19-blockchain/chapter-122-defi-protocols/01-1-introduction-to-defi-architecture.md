## 122.1 Introduction to DeFi Architecture

Decentralized Finance (DeFi) protocols are smart contract-based financial primitives that enable permissionless trading, lending, and yield generation. Unlike centralized exchanges, DeFi protocols are non-custodial, transparent, and composable.

### Core DeFi Primitives

The core DeFi type definitions model the shared concepts, swap paths, pool reserves, price quotes, and slippage tolerances, that every protocol integration in this chapter builds on. Encoding slippage as a `Basis Points` integer rather than a float64 avoids rounding errors and matches the convention used by Uniswap and other AMM contracts on-chain.

```go
// pkg/defi/types.go
package defi

import (
	"context"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// Protocol types
const (
	ProtocolUniswapV2 = "uniswap-v2"
	ProtocolUniswapV3 = "uniswap-v3"
	ProtocolAave      = "aave"
	ProtocolCompound  = "compound"
	ProtocolCurve     = "curve"
)

// DEX represents a decentralized exchange
type DEX interface {
	GetAmountOut(ctx context.Context, amountIn *big.Int, path []common.Address) (*big.Int, error)
	Swap(ctx context.Context, req *SwapRequest) (*SwapResult, error)
	AddLiquidity(ctx context.Context, req *LiquidityRequest) (*LiquidityResult, error)
	RemoveLiquidity(ctx context.Context, req *RemoveLiquidityRequest) (*LiquidityResult, error)
}

// LendingProtocol represents a lending/borrowing platform
type LendingProtocol interface {
	Supply(ctx context.Context, asset common.Address, amount *big.Int) error
	Borrow(ctx context.Context, asset common.Address, amount *big.Int) error
	Repay(ctx context.Context, asset common.Address, amount *big.Int) error
	Withdraw(ctx context.Context, asset common.Address, amount *big.Int) error
	GetAccountData(ctx context.Context, user common.Address) (*AccountData, error)
}

// Oracle provides price feeds
type Oracle interface {
	GetPrice(ctx context.Context, base, quote common.Address) (*big.Int, error)
	GetPriceWithTimestamp(ctx context.Context, base, quote common.Address) (*PriceData, error)
}

// SwapRequest defines a token swap
type SwapRequest struct {
	TokenIn      common.Address
	TokenOut     common.Address
	AmountIn     *big.Int
	MinAmountOut *big.Int // Slippage protection
	Recipient    common.Address
	Deadline     time.Time
}

// SwapResult contains swap execution details
type SwapResult struct {
	AmountIn     *big.Int
	AmountOut    *big.Int
	Path         []common.Address
	PriceImpact  float64 // Percentage
	GasUsed      uint64
	TxHash       common.Hash
}

// LiquidityRequest for adding liquidity
type LiquidityRequest struct {
	TokenA         common.Address
	TokenB         common.Address
	AmountADesired *big.Int
	AmountBDesired *big.Int
	AmountAMin     *big.Int
	AmountBMin     *big.Int
	Recipient      common.Address
	Deadline       time.Time
}

// LiquidityResult contains liquidity operation results
type LiquidityResult struct {
	AmountA    *big.Int
	AmountB    *big.Int
	Liquidity  *big.Int
	TxHash     common.Hash
}

// RemoveLiquidityRequest for withdrawing liquidity
type RemoveLiquidityRequest struct {
	TokenA       common.Address
	TokenB       common.Address
	Liquidity    *big.Int
	AmountAMin   *big.Int
	AmountBMin   *big.Int
	Recipient    common.Address
	Deadline     time.Time
}

// AccountData represents lending account status
type AccountData struct {
	TotalCollateralETH          *big.Int
	TotalDebtETH                *big.Int
	AvailableBorrowsETH         *big.Int
	CurrentLiquidationThreshold *big.Int
	LTV                         *big.Int
	HealthFactor                *big.Int
}

// PriceData contains price with metadata
type PriceData struct {
	Price       *big.Int
	Decimals    uint8
	Timestamp   time.Time
	RoundID     *big.Int
	Source      string
}

// FlashLoanRequest for flash loan execution
type FlashLoanRequest struct {
	Assets    []common.Address
	Amounts   []*big.Int
	Modes     []*big.Int // 0 = no debt, 1 = stable, 2 = variable
	Params    []byte     // Custom execution params
	OnBehalfOf common.Address
}
```

### DeFi Architecture Patterns

Production DeFi infrastructure relies on modular architectural patterns to aggregate liquidity and coordinate multi-protocol interactions safely:
```go
// pkg/defi/architecture.go
package defi

import (
	"context"
	"fmt"
	"math/big"
	"sync"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// DeFiHub aggregates multiple protocols
type DeFiHub struct {
	client   *ethclient.Client
	chainID  *big.Int

	// Protocol instances
	dexes    map[string]DEX
	lenders  map[string]LendingProtocol
	oracles  map[string]Oracle

	// Cache
	priceCache *PriceCache
	mu         sync.RWMutex
}

// NewDeFiHub initializes the DeFi integration hub
func NewDeFiHub(rpcURL string, chainID *big.Int) (*DeFiHub, error) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial rpc: %w", err)
	}

	hub := &DeFiHub{
		client:     client,
		chainID:    chainID,
		dexes:      make(map[string]DEX),
		lenders:    make(map[string]LendingProtocol),
		oracles:    make(map[string]Oracle),
		priceCache: NewPriceCache(),
	}

	return hub, nil
}

// RegisterDEX adds a DEX to the hub
func (h *DeFiHub) RegisterDEX(name string, dex DEX) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.dexes[name] = dex
}

// RegisterLender adds a lending protocol
func (h *DeFiHub) RegisterLender(name string, lender LendingProtocol) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lenders[name] = lender
}

// RegisterOracle adds a price oracle
func (h *DeFiHub) RegisterOracle(name string, oracle Oracle) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.oracles[name] = oracle
}

// GetBestPrice compares prices across multiple DEXes
func (h *DeFiHub) GetBestPrice(ctx context.Context, tokenIn, tokenOut common.Address, amountIn *big.Int) (*BestQuote, error) {
	h.mu.RLock()
	dexes := make(map[string]DEX)
	for name, dex := range h.dexes {
		dexes[name] = dex
	}
	h.mu.RUnlock()

	type quote struct {
		name      string
		amountOut *big.Int
		err       error
	}

	quotes := make(chan quote, len(dexes))

	// Query all DEXes in parallel
	for name, dex := range dexes {
		go func(name string, dex DEX) {
			path := []common.Address{tokenIn, tokenOut}
			amount, err := dex.GetAmountOut(ctx, amountIn, path)
			quotes <- quote{name: name, amountOut: amount, err: err}
		}(name, dex)
	}

	var best *BestQuote
	for i := 0; i < len(dexes); i++ {
		q := <-quotes
		if q.err != nil {
			continue
		}

		if best == nil || q.amountOut.Cmp(best.AmountOut) > 0 {
			best = &BestQuote{
				DEX:       q.name,
				AmountOut: q.amountOut,
				AmountIn:  amountIn,
				TokenIn:   tokenIn,
				TokenOut:  tokenOut,
			}
		}
	}

	if best == nil {
		return nil, fmt.Errorf("no valid quotes found")
	}

	return best, nil
}

// BestQuote represents the optimal swap route
type BestQuote struct {
	DEX       string
	AmountOut *big.Int
	AmountIn  *big.Int
	TokenIn   common.Address
	TokenOut  common.Address
	Path      []common.Address
}
```

### Junior → FAANG: DeFi Architecture as a System of Interconnected Protocols

DeFi architecture is best understood as a set of primitive protocols that compose to create complex financial systems. The primitives are: decentralized exchanges (AMMs and order books), lending protocols, stablecoins, oracles, and cross-chain bridges. Understanding each primitive's economic model and trust assumptions is prerequisite knowledge before integrating with any system built from these primitives.

The "money lego" metaphor for DeFi composability is accurate but carries a hidden danger: when one piece of the stack fails (an oracle reports an incorrect price, a lending protocol has a bad debt crisis, a bridge is exploited), the effects propagate through every system that depends on that component. A junior engineer integrating with a DeFi protocol must trace the full dependency graph of that protocol to understand which failure modes they are inheriting.

For interview preparation, be able to explain the yield source for each major DeFi category: AMM liquidity providers earn trading fees plus incentive tokens (minus impermanent loss risk), lending protocol depositors earn interest from borrowers (subject to bad debt risk), yield aggregators earn by optimizing capital allocation across protocols (subject to the underlying protocol risks). Understanding yield sources is how you reason about whether a DeFi integration is economically sustainable.

First-job habit for DeFi architecture understanding: use a DeFi analytics platform (Dune Analytics, DeFiLlama, Token Terminal) to study the actual usage patterns of protocols you are integrating with. Seeing real liquidity volumes, real user counts, and real revenue figures gives you a reality check on the protocol's health that documentation alone cannot provide.

### Senior @ FAANG: DeFi Architecture as a Trust and Risk Hierarchy

At staff level, DeFi architecture analysis starts with mapping the trust hierarchy. At the base layer, you trust Ethereum's consensus security. On top of that, you trust the smart contracts that implement the protocol's logic. On top of that, you trust the protocol's governance (which controls upgrades, parameter changes, and emergency actions). Each layer's trust assumption is distinct and must be assessed separately.

The governance layer of DeFi protocols is where the most significant trust decisions are made. When a DAO votes to add a new collateral type to a lending protocol, or to change the risk parameters for an existing collateral, the entire protocol's risk profile changes. Staff engineers who run integrations with governance-controlled protocols must participate in or monitor the governance process to receive advance notice of changes that affect their systems.

Systemic risk in DeFi architecture arises from the concentration of activity in a small number of protocols. Approximately 80 percent of Ethereum DeFi liquidity is concentrated in ten or fewer protocols. An exploit of any of these protocols creates a liquidity shock that affects every system that routes through them. Designing DeFi integrations with multiple fallback routing paths (multiple DEX options, multiple lending venues) reduces exposure to single-protocol failure events.

The risk-free rate in DeFi is an important architectural concept: it is the yield available from the lowest-risk DeFi activities (currently ETH staking through Lido or a liquid staking derivative, or DAI in the DSR). Any yield above the risk-free rate comes with additional risk, and the architecture of a DeFi system should make these risk trade-offs explicit. Staff engineers who design yield-generating features must articulate the risk-return profile clearly and ensure that product and legal stakeholders understand the risks before the feature launches.

Protocol interdependencies create hidden correlations in risk exposure. Many DeFi protocols use USDC as a stablecoin, ETH as the primary collateral, and Chainlink as the oracle. When USDC experienced a brief de-peg in March 2023 (due to Silicon Valley Bank exposure), every protocol with USDC exposure was simultaneously affected. Staff engineers use correlation analysis to identify and document these hidden dependencies in their DeFi integration portfolios.

Bar-raiser signals: designing a DeFi protocol monitoring system that tracks TVL (Total Value Locked), utilization rates, and yield across all protocols in your integration's dependency graph, with alerts for anomalies that may indicate stress in the system (large TVL drops, utilization rates approaching 100 percent in lending protocols, governance proposals that could change risk parameters), or explaining the systemic difference between transparent proxy governance (admin can upgrade unilaterally) and DAO governance (requires token holder vote with time lock) for the protocols your system depends on. These topics reveal genuine DeFi ecosystem understanding.

---
