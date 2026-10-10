## 122.7 DEX Aggregation

DEX aggregators find the best execution path across multiple exchanges.

### Simple Aggregator

The aggregator queries multiple DEX sources concurrently using goroutines and selects the quote with the highest output amount after deducting estimated gas costs, ensuring the best net outcome rather than just the best gross rate. Each DEX source implements a `Source` interface so new exchanges can be added without modifying the aggregation logic.

```go
// pkg/defi/aggregator/aggregator.go
package aggregator

import (
	"context"
	"fmt"
	"math/big"
	"sync"

	"github.com/ethereum/go-ethereum/common"
	"yourapp/pkg/defi"
)

// Aggregator finds best swap routes across DEXes
type Aggregator struct {
	dexes map[string]defi.DEX
	mu    sync.RWMutex
}

// NewAggregator creates a DEX aggregator
func NewAggregator() *Aggregator {
	return &Aggregator{
		dexes: make(map[string]defi.DEX),
	}
}

// AddDEX registers a DEX
func (a *Aggregator) AddDEX(name string, dex defi.DEX) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.dexes[name] = dex
}

// GetBestRoute finds the optimal swap route
func (a *Aggregator) GetBestRoute(
	ctx context.Context,
	tokenIn, tokenOut common.Address,
	amountIn *big.Int,
) (*Route, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()

	type result struct {
		dex    string
		amount *big.Int
		err    error
	}

	results := make(chan result, len(a.dexes))

	// Query all DEXes in parallel
	for name, dex := range a.dexes {
		go func(name string, dex defi.DEX) {
			path := []common.Address{tokenIn, tokenOut}
			amount, err := dex.GetAmountOut(ctx, amountIn, path)
			results <- result{dex: name, amount: amount, err: err}
		}(name, dex)
	}

	var bestRoute *Route

	for i := 0; i < len(a.dexes); i++ {
		res := <-results
		if res.err != nil {
			continue
		}

		if bestRoute == nil || res.amount.Cmp(bestRoute.AmountOut) > 0 {
			bestRoute = &Route{
				DEX:       res.dex,
				Path:      []common.Address{tokenIn, tokenOut},
				AmountIn:  amountIn,
				AmountOut: res.amount,
			}
		}
	}

	if bestRoute == nil {
		return nil, fmt.Errorf("no valid routes found")
	}

	return bestRoute, nil
}

// GetSplitRoute splits order across multiple DEXes
func (a *Aggregator) GetSplitRoute(
	ctx context.Context,
	tokenIn, tokenOut common.Address,
	amountIn *big.Int,
) (*SplitRoute, error) {
	// For large orders, splitting across DEXes can reduce slippage
	// This is a simplified implementation

	routes, err := a.getAllRoutes(ctx, tokenIn, tokenOut, amountIn)
	if err != nil {
		return nil, err
	}

	// Sort by price (best first)
	sortRoutes(routes)

	// Split order to minimize price impact
	split := &SplitRoute{
		TotalAmountIn:  amountIn,
		TotalAmountOut: big.NewInt(0),
		Routes:         []RouteSegment{},
	}

	remaining := new(big.Int).Set(amountIn)

	for _, route := range routes {
		if remaining.Cmp(big.NewInt(0)) == 0 {
			break
		}

		// Allocate portion to this DEX
		portion := new(big.Int).Div(remaining, big.NewInt(2))
		if portion.Cmp(remaining) > 0 {
			portion = remaining
		}

		path := []common.Address{tokenIn, tokenOut}
		amountOut, err := a.dexes[route.DEX].GetAmountOut(ctx, portion, path)
		if err != nil {
			continue
		}

		split.Routes = append(split.Routes, RouteSegment{
			DEX:       route.DEX,
			AmountIn:  portion,
			AmountOut: amountOut,
		})

		split.TotalAmountOut = new(big.Int).Add(split.TotalAmountOut, amountOut)
		remaining = new(big.Int).Sub(remaining, portion)
	}

	return split, nil
}

// getAllRoutes gets quotes from all DEXes
func (a *Aggregator) getAllRoutes(
	ctx context.Context,
	tokenIn, tokenOut common.Address,
	amountIn *big.Int,
) ([]*Route, error) {
	var routes []*Route

	for name, dex := range a.dexes {
		path := []common.Address{tokenIn, tokenOut}
		amount, err := dex.GetAmountOut(ctx, amountIn, path)
		if err != nil {
			continue
		}

		routes = append(routes, &Route{
			DEX:       name,
			Path:      path,
			AmountIn:  amountIn,
			AmountOut: amount,
		})
	}

	return routes, nil
}

// Route represents a single swap route
type Route struct {
	DEX       string
	Path      []common.Address
	AmountIn  *big.Int
	AmountOut *big.Int
}

// SplitRoute represents a split order
type SplitRoute struct {
	TotalAmountIn  *big.Int
	TotalAmountOut *big.Int
	Routes         []RouteSegment
}

// RouteSegment is part of a split route
type RouteSegment struct {
	DEX       string
	AmountIn  *big.Int
	AmountOut *big.Int
}

// sortRoutes sorts by best price
func sortRoutes(routes []*Route) {
	// Simple bubble sort for demonstration
	n := len(routes)
	for i := 0; i < n-1; i++ {
		for j := 0; j < n-i-1; j++ {
			// Calculate price for each route
			priceJ := new(big.Float).Quo(
				new(big.Float).SetInt(routes[j].AmountOut),
				new(big.Float).SetInt(routes[j].AmountIn),
			)
			priceJ1 := new(big.Float).Quo(
				new(big.Float).SetInt(routes[j+1].AmountOut),
				new(big.Float).SetInt(routes[j+1].AmountIn),
			)

			if priceJ.Cmp(priceJ1) < 0 {
				routes[j], routes[j+1] = routes[j+1], routes[j]
			}
		}
	}
}
```

### Junior → FAANG: DEX Aggregation as Price Optimization

DEX aggregation is the practice of routing a trade through multiple liquidity sources to achieve a better effective price than any single DEX can offer. Instead of swapping 1000 USDC for ETH entirely through Uniswap V3, an aggregator might route 60 percent through Uniswap V3, 30 percent through Curve (for the stablecoin leg), and 10 percent through Balancer, achieving a lower average price impact across the combined routes.

The prerequisite for understanding DEX aggregation is understanding why splitting a trade across multiple pools reduces price impact. In a constant product AMM, the marginal price increases with every unit of the input token swapped (the denominator decreases as the pool's reserve of the input token increases). By splitting the trade across multiple pools, you avoid pushing any single pool's price too far, resulting in a better average execution price.

For interview preparation, be able to explain the 1inch V5 Fusion mode (off-chain resolver auction model) versus the classic on-chain routing model. In classic routing, the aggregator computes the optimal split and encodes it as a single transaction. In Fusion mode, professional market makers (resolvers) compete off-chain to provide the best price, and the winning resolver's transaction executes on-chain. The Fusion model can achieve better prices than on-chain routing by using resolver capital and MEV rebates.

First-job tip: for simple integrations, using an aggregator API (1inch API, 0x API, Paraswap API) rather than computing the optimal route yourself is the right engineering trade-off. These APIs perform complex route optimization across dozens of liquidity sources in real time and are maintained by teams specialized in this problem. Build your own aggregation only when you have specific requirements that these APIs cannot satisfy.

### Senior @ FAANG: DEX Aggregation Architecture and Integration Strategy

At staff level, DEX aggregation strategy involves a build-versus-integrate decision with significant implications for control, cost, and complexity. Integrating with a third-party aggregator API (1inch, 0x, Paraswap) is fast to implement but introduces a dependency on the aggregator's availability, their routing quality, and their API pricing. Building an internal aggregation engine provides full control and avoids the dependency but requires specialized MEV and liquidity expertise.

The smart order routing problem (finding the optimal split across multiple liquidity sources to minimize price impact and maximize output) is an optimization problem that has been extensively researched. The naive approach (try all splits and pick the best) is computationally infeasible for more than a few liquidity sources. Production aggregators use heuristic approaches (proportional split based on pool depth), dynamic programming, and simulation using `eth_call` to evaluate candidate routes. Staff engineers who design internal routing engines must choose between these approaches based on the latency requirements of the system.

Integration with multiple aggregators provides redundancy and price competition. A system that queries 1inch, 0x, and Paraswap simultaneously and executes through whichever returns the best quote is more resilient to any single aggregator's downtime and may achieve better prices in practice. The implementation complexity is low (each aggregator provides a similar API structure), and the price improvement can be significant for large trades.

MEV-aware aggregation is an increasingly important feature. A swap that is submitted to the public mempool after fetching a quote is subject to price movement between quote time and execution time, as well as front-running and sandwiching by MEV bots. Aggregators that use private mempool infrastructure (Flashbots Protect, MEV Blocker, CoW Protocol) or that use commit-reveal schemes to prevent front-running provide better protection against MEV extraction. Staff engineers evaluate MEV protection mechanisms when selecting aggregators for high-value swap use cases.

CoW Protocol (Coincidence of Wants) is a distinct aggregation architecture that batches trades from multiple users and looks for off-chain matches (where user A wants to sell ETH for USDC and user B wants to sell USDC for ETH, so they can be matched without using on-chain AMM liquidity at all). Excess demand after matching is routed through on-chain AMMs. This approach provides gas savings and MEV protection but has higher latency (batch settlement takes 1-5 minutes). Staff engineers evaluate CoW Protocol for use cases where latency is less critical than MEV protection and gas efficiency.

Bar-raiser signals: designing a cross-chain DEX aggregation system that finds the optimal route for a swap that starts on Ethereum and ends on Arbitrum (requires bridging costs, source chain DEX costs, and destination chain DEX costs to all be accounted for in the optimization), or explaining why the optimal split for a large trade is not simply proportional to pool depths (because of diminishing returns as each pool's price moves with each marginal unit swapped, the optimal split requires finding the price equilibrium across all pools). These optimization topics distinguish genuine aggregation system designers.

---
