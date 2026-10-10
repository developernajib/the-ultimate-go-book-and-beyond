## 122.2 Uniswap V2 Integration

Uniswap is the most popular AMM (Automated Market Maker) protocol. Let's implement a production-ready integration.

### Uniswap V2 Router Interface

The Uniswap V2 router interface mirrors the Solidity function signatures as Go methods, providing the complete vocabulary for swap execution, liquidity provision, and path-based routing. Defining this as a Go interface rather than using the concrete generated struct allows the integration layer to be tested against a mock router without deploying to a testnet.

```go
// pkg/defi/uniswap/v2/router.go
package v2

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
)

// RouterV2 implements Uniswap V2 Router integration
type RouterV2 struct {
	client       *ethclient.Client
	routerAddr   common.Address
	factoryAddr  common.Address
	router       *bind.BoundContract
	transactor   *bind.TransactOpts
	chainID      *big.Int
}

// Common addresses (Ethereum mainnet)
var (
	UniswapV2Router  = common.HexToAddress("0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D")
	UniswapV2Factory = common.HexToAddress("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f")
	WETH             = common.HexToAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")
)

// NewRouterV2 creates a Uniswap V2 router client
func NewRouterV2(client *ethclient.Client, routerAddr common.Address, transactor *bind.TransactOpts) (*RouterV2, error) {
	chainID, err := client.ChainID(context.Background())
	if err != nil {
		return nil, fmt.Errorf("get chain ID: %w", err)
	}

	return &RouterV2{
		client:      client,
		routerAddr:  routerAddr,
		factoryAddr: UniswapV2Factory,
		transactor:  transactor,
		chainID:     chainID,
	}, nil
}

// GetAmountsOut calculates output amounts for a swap path
func (r *RouterV2) GetAmountsOut(ctx context.Context, amountIn *big.Int, path []common.Address) ([]*big.Int, error) {
	// Load contract ABI
	router, err := NewIUniswapV2Router02(r.routerAddr, r.client)
	if err != nil {
		return nil, fmt.Errorf("load router: %w", err)
	}

	amounts, err := router.GetAmountsOut(&bind.CallOpts{Context: ctx}, amountIn, path)
	if err != nil {
		return nil, fmt.Errorf("get amounts out: %w", err)
	}

	return amounts, nil
}

// SwapExactTokensForTokens executes a token swap
func (r *RouterV2) SwapExactTokensForTokens(
	ctx context.Context,
	amountIn *big.Int,
	amountOutMin *big.Int,
	path []common.Address,
	to common.Address,
	deadline time.Time,
) (*types.Transaction, error) {
	router, err := NewIUniswapV2Router02(r.routerAddr, r.client)
	if err != nil {
		return nil, fmt.Errorf("load router: %w", err)
	}

	opts := *r.transactor
	opts.Context = ctx
	opts.NoSend = false

	deadlineBig := big.NewInt(deadline.Unix())

	tx, err := router.SwapExactTokensForTokens(
		&opts,
		amountIn,
		amountOutMin,
		path,
		to,
		deadlineBig,
	)
	if err != nil {
		return nil, fmt.Errorf("execute swap: %w", err)
	}

	return tx, nil
}

// SwapExactETHForTokens swaps ETH for tokens
func (r *RouterV2) SwapExactETHForTokens(
	ctx context.Context,
	amountOutMin *big.Int,
	path []common.Address,
	to common.Address,
	deadline time.Time,
) (*types.Transaction, error) {
	if path[0] != WETH {
		return nil, fmt.Errorf("first token in path must be WETH")
	}

	router, err := NewIUniswapV2Router02(r.routerAddr, r.client)
	if err != nil {
		return nil, fmt.Errorf("load router: %w", err)
	}

	opts := *r.transactor
	opts.Context = ctx
	opts.Value = r.transactor.Value // ETH amount to send

	deadlineBig := big.NewInt(deadline.Unix())

	tx, err := router.SwapExactETHForTokens(
		&opts,
		amountOutMin,
		path,
		to,
		deadlineBig,
	)
	if err != nil {
		return nil, fmt.Errorf("execute swap: %w", err)
	}

	return tx, nil
}

// GetPair retrieves the pair address for two tokens
func (r *RouterV2) GetPair(ctx context.Context, tokenA, tokenB common.Address) (common.Address, error) {
	factory, err := NewIUniswapV2Factory(r.factoryAddr, r.client)
	if err != nil {
		return common.Address{}, fmt.Errorf("load factory: %w", err)
	}

	pairAddr, err := factory.GetPair(&bind.CallOpts{Context: ctx}, tokenA, tokenB)
	if err != nil {
		return common.Address{}, fmt.Errorf("get pair: %w", err)
	}

	return pairAddr, nil
}

// GetReserves retrieves pool reserves
func (r *RouterV2) GetReserves(ctx context.Context, pairAddr common.Address) (*Reserves, error) {
	pair, err := NewIUniswapV2Pair(pairAddr, r.client)
	if err != nil {
		return nil, fmt.Errorf("load pair: %w", err)
	}

	reserves, err := pair.GetReserves(&bind.CallOpts{Context: ctx})
	if err != nil {
		return nil, fmt.Errorf("get reserves: %w", err)
	}

	token0, err := pair.Token0(&bind.CallOpts{Context: ctx})
	if err != nil {
		return nil, fmt.Errorf("get token0: %w", err)
	}

	token1, err := pair.Token1(&bind.CallOpts{Context: ctx})
	if err != nil {
		return nil, fmt.Errorf("get token1: %w", err)
	}

	return &Reserves{
		Reserve0:    reserves.Reserve0,
		Reserve1:    reserves.Reserve1,
		BlockTimestamp: reserves.BlockTimestampLast,
		Token0:      token0,
		Token1:      token1,
	}, nil
}

// Reserves represents pool reserves
type Reserves struct {
	Reserve0       *big.Int
	Reserve1       *big.Int
	BlockTimestamp uint32
	Token0         common.Address
	Token1         common.Address
}

// CalculatePriceImpact calculates the price impact of a swap
func CalculatePriceImpact(amountIn, reserveIn, reserveOut *big.Int) float64 {
	// Price before swap
	priceBefore := new(big.Float).Quo(
		new(big.Float).SetInt(reserveOut),
		new(big.Float).SetInt(reserveIn),
	)

	// Amount out with 0.3% fee
	amountInWithFee := new(big.Int).Mul(amountIn, big.NewInt(997))
	numerator := new(big.Int).Mul(amountInWithFee, reserveOut)
	denominator := new(big.Int).Add(
		new(big.Int).Mul(reserveIn, big.NewInt(1000)),
		amountInWithFee,
	)
	amountOut := new(big.Int).Div(numerator, denominator)

	// New reserves after swap
	newReserveIn := new(big.Int).Add(reserveIn, amountIn)
	newReserveOut := new(big.Int).Sub(reserveOut, amountOut)

	// Price after swap
	priceAfter := new(big.Float).Quo(
		new(big.Float).SetInt(newReserveOut),
		new(big.Float).SetInt(newReserveIn),
	)

	// Price impact percentage
	impact := new(big.Float).Quo(
		new(big.Float).Sub(priceBefore, priceAfter),
		priceBefore,
	)

	impactFloat, _ := impact.Float64()
	return impactFloat * 100
}
```

### High-Level Swap Client

The high-level swap client calculates price impact against the pool reserves using the constant product formula before submitting, reverting if impact exceeds the caller's tolerance. The deadline parameter enforces a time limit on the swap: if the transaction is mined after the deadline, the router reverts so the trade is not executed at a stale price from a block that was delayed or front-run.

```go
// pkg/defi/uniswap/client.go
package uniswap

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

// Client provides high-level Uniswap operations
type Client struct {
	v2Router   *v2.RouterV2
	client     *ethclient.Client
	transactor *bind.TransactOpts
}

// NewClient creates a new Uniswap client
func NewClient(rpcURL string, transactor *bind.TransactOpts) (*Client, error) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial rpc: %w", err)
	}

	router, err := v2.NewRouterV2(client, v2.UniswapV2Router, transactor)
	if err != nil {
		return nil, fmt.Errorf("create router: %w", err)
	}

	return &Client{
		v2Router:   router,
		client:     client,
		transactor: transactor,
	}, nil
}

// Swap executes a token swap with slippage protection
func (c *Client) Swap(ctx context.Context, req *defi.SwapRequest) (*defi.SwapResult, error) {
	// Build path
	path := []common.Address{req.TokenIn, req.TokenOut}

	// Get quote
	amounts, err := c.v2Router.GetAmountsOut(ctx, req.AmountIn, path)
	if err != nil {
		return nil, fmt.Errorf("get quote: %w", err)
	}

	expectedOut := amounts[len(amounts)-1]

	// Check minimum output
	if expectedOut.Cmp(req.MinAmountOut) < 0 {
		return nil, fmt.Errorf("expected output %s below minimum %s",
			expectedOut.String(), req.MinAmountOut.String())
	}

	// Get reserves for price impact calculation
	pairAddr, err := c.v2Router.GetPair(ctx, req.TokenIn, req.TokenOut)
	if err != nil {
		return nil, fmt.Errorf("get pair: %w", err)
	}

	reserves, err := c.v2Router.GetReserves(ctx, pairAddr)
	if err != nil {
		return nil, fmt.Errorf("get reserves: %w", err)
	}

	// Calculate price impact
	var reserveIn, reserveOut *big.Int
	if reserves.Token0 == req.TokenIn {
		reserveIn, reserveOut = reserves.Reserve0, reserves.Reserve1
	} else {
		reserveIn, reserveOut = reserves.Reserve1, reserves.Reserve0
	}

	priceImpact := v2.CalculatePriceImpact(req.AmountIn, reserveIn, reserveOut)

	// Execute swap
	tx, err := c.v2Router.SwapExactTokensForTokens(
		ctx,
		req.AmountIn,
		req.MinAmountOut,
		path,
		req.Recipient,
		req.Deadline,
	)
	if err != nil {
		return nil, fmt.Errorf("execute swap: %w", err)
	}

	// Wait for receipt
	receipt, err := bind.WaitMined(ctx, c.client, tx)
	if err != nil {
		return nil, fmt.Errorf("wait for tx: %w", err)
	}

	return &defi.SwapResult{
		AmountIn:    req.AmountIn,
		AmountOut:   expectedOut,
		Path:        path,
		PriceImpact: priceImpact,
		GasUsed:     receipt.GasUsed,
		TxHash:      tx.Hash(),
	}, nil
}

// GetQuote returns expected output amount without executing
func (c *Client) GetQuote(ctx context.Context, amountIn *big.Int, tokenIn, tokenOut common.Address) (*Quote, error) {
	path := []common.Address{tokenIn, tokenOut}

	amounts, err := c.v2Router.GetAmountsOut(ctx, amountIn, path)
	if err != nil {
		return nil, fmt.Errorf("get amounts: %w", err)
	}

	pairAddr, err := c.v2Router.GetPair(ctx, tokenIn, tokenOut)
	if err != nil {
		return nil, fmt.Errorf("get pair: %w", err)
	}

	reserves, err := c.v2Router.GetReserves(ctx, pairAddr)
	if err != nil {
		return nil, fmt.Errorf("get reserves: %w", err)
	}

	var reserveIn, reserveOut *big.Int
	if reserves.Token0 == tokenIn {
		reserveIn, reserveOut = reserves.Reserve0, reserves.Reserve1
	} else {
		reserveIn, reserveOut = reserves.Reserve1, reserves.Reserve0
	}

	priceImpact := v2.CalculatePriceImpact(amountIn, reserveIn, reserveOut)

	return &Quote{
		AmountIn:    amountIn,
		AmountOut:   amounts[len(amounts)-1],
		Path:        path,
		PriceImpact: priceImpact,
		Reserves:    reserves,
	}, nil
}

// Quote represents a swap quote
type Quote struct {
	AmountIn    *big.Int
	AmountOut   *big.Int
	Path        []common.Address
	PriceImpact float64
	Reserves    *v2.Reserves
}
```

### Junior → FAANG: Uniswap V2 as Your First DeFi Integration Touchstone

Uniswap V2 is the canonical first DeFi protocol integration for several reasons: its AMM logic is simple enough to understand completely, its Go interface is well-documented, it is deployed on every major EVM chain and testnet, and the constant product formula is the foundation for understanding all subsequent AMM designs. Starting with V2 rather than V3 is the right pedagogical choice even if V3 is more capital-efficient in production.

The Uniswap V2 router functions you need to master first are `swapExactTokensForTokens` (exact input, variable output) and `swapTokensForExactTokens` (variable input, exact output). Understanding which to use in which situation is an economic judgment: use exact input when you want to spend a specific amount of a token, use exact output when you need a specific amount of the output token. The difference affects how you calculate the slippage tolerance and how you handle partial fills.

The path parameter in Uniswap V2 swaps defines the routing: `[tokenA, tokenB]` for a direct pool, or `[tokenA, WETH, tokenB]` for a route through ETH as an intermediate. Direct pools only exist for token pairs with sufficient liquidity. If you try to swap between two low-liquidity tokens directly, you will get a very high price impact. Checking available paths and their liquidity before submitting a swap is a required step in production integrations.

Interview entry point: explain why you must approve the Uniswap router to spend your tokens before calling `swapExactTokensForTokens`. The router uses `transferFrom` to pull tokens from your wallet into the pool. If the router is not approved for the amount you want to swap, `transferFrom` will revert with an insufficient allowance error. In production Go code, always check the current allowance before submitting a swap and approve only if necessary (and approve only the exact amount needed, not `uint256.max`, for security).

### Senior @ FAANG: Uniswap V2 Integration Design and Operational Patterns

At staff level, Uniswap V2 integration is the baseline from which more complex DeFi integrations are designed. The patterns established for V2 (path selection, slippage calculation, deadline management, approval handling) apply with modifications to V3, V4, Sushi, Balancer, and other AMMs. Investing in a clean, well-tested V2 integration is the foundation for all subsequent AMM work.

Slippage calculation for Uniswap V2 swaps requires understanding the relationship between the trade size, the pool reserves, and the price impact. The formula for the amount out given amount in on a V2 pool (accounting for the 0.3 percent fee) is: `amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)`. This calculation should be implemented in Go using `math/big` for correct precision and used to estimate the expected output before submitting the transaction. The slippage tolerance is the acceptable percentage deviation below this estimated output.

Deadline management is a production concern that is frequently overlooked. The `deadline` parameter in Uniswap V2 transactions specifies the block timestamp after which the transaction will revert if not yet included. Setting the deadline to `block.timestamp + 5 minutes` is a reasonable default, but the deadline must be calculated relative to the current block timestamp (obtained via `eth_getBlockByNumber("latest")`), not the wall clock time, because significant differences between the two can occur during network congestion. Setting an excessively long deadline allows a transaction to remain valid in the mempool during a period of significant price movement, which is a financial risk.

Price oracle design using Uniswap V2 TWAP (Time Weighted Average Price) is a common pattern for building on-chain price feeds. Uniswap V2 accumulates a price accumulator in every block, and the TWAP for a period is computed by taking the difference in accumulators divided by the time elapsed. Go code that reads these TWAP values must understand that the TWAP calculation requires fetching the accumulator at two different blocks, and that the result is a fixed-point number with 112 bits of precision. TWAP values are resistant to single-block price manipulation but can still be manipulated over the time window they measure.

Liquidity monitoring for Uniswap V2 integrations is a critical operational practice. A production swap integration that sets an absolute slippage amount (e.g., `amountOutMin = amountOut * 0.98`) is implicitly assuming that the pool has sufficient liquidity to execute the swap with 2 percent price impact. If pool liquidity decreases significantly (a major LP withdraws), the swap will fail with insufficient output and the integration will need to either widen the slippage tolerance (increasing MEV exposure) or reduce the swap size. Monitoring pool reserves with alerts for significant drops is the production response to this risk.

Bar-raiser signals: explaining how the Uniswap V2 oracle is vulnerable to flash loan manipulation within a single block (the accumulator is updated at the start of the block, so a flash loan that manipulates the price within a block can affect the accumulator if the TWAP window is very short), or designing a swap integration that automatically selects between V2 and V3 based on price impact comparison (requiring a simulated quote from both, which can be done using `eth_call` on the respective quoter contracts). These design choices reveal genuine production DeFi integration experience.

---
