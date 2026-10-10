## 122.5 Chainlink Oracle Integration

Chainlink provides decentralized price feeds for DeFi protocols.

### Chainlink Client

Blockchain oracles provide smart contracts with trusted off-chain data such as asset prices and event outcomes, bridging deterministic on-chain execution with the real world. The following Go implementation queries a Chainlink price feed contract and validates the response against freshness and deviation thresholds.

```go
// pkg/defi/chainlink/oracle.go
package chainlink

import (
	"context"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	"yourapp/pkg/defi"
)

// Common price feed addresses (Ethereum mainnet)
var (
	ETHUSDFeed  = common.HexToAddress("0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419")
	BTCUSDFeed  = common.HexToAddress("0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c")
	LINKUSDFeed = common.HexToAddress("0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c")
)

// Oracle provides Chainlink price feed access
type Oracle struct {
	client *ethclient.Client
	feeds  map[string]common.Address
}

// NewOracle creates a Chainlink oracle client
func NewOracle(rpcURL string) (*Oracle, error) {
	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		return nil, fmt.Errorf("dial rpc: %w", err)
	}

	return &Oracle{
		client: client,
		feeds:  make(map[string]common.Address),
	}, nil
}

// RegisterFeed adds a price feed
func (o *Oracle) RegisterFeed(pair string, feedAddr common.Address) {
	o.feeds[pair] = feedAddr
}

// GetLatestPrice retrieves the latest price
func (o *Oracle) GetLatestPrice(ctx context.Context, pair string) (*defi.PriceData, error) {
	feedAddr, exists := o.feeds[pair]
	if !exists {
		return nil, fmt.Errorf("feed not found for pair: %s", pair)
	}

	feed, err := NewAggregatorV3Interface(feedAddr, o.client)
	if err != nil {
		return nil, fmt.Errorf("load feed: %w", err)
	}

	data, err := feed.LatestRoundData(&bind.CallOpts{Context: ctx})
	if err != nil {
		return nil, fmt.Errorf("get latest round: %w", err)
	}

	decimals, err := feed.Decimals(&bind.CallOpts{Context: ctx})
	if err != nil {
		return nil, fmt.Errorf("get decimals: %w", err)
	}

	return &defi.PriceData{
		Price:     data.Answer,
		Decimals:  decimals,
		Timestamp: time.Unix(data.UpdatedAt.Int64(), 0),
		RoundID:   data.RoundId,
		Source:    "chainlink",
	}, nil
}

// GetHistoricalPrice retrieves price at a specific round
func (o *Oracle) GetHistoricalPrice(ctx context.Context, pair string, roundID *big.Int) (*defi.PriceData, error) {
	feedAddr, exists := o.feeds[pair]
	if !exists {
		return nil, fmt.Errorf("feed not found for pair: %s", pair)
	}

	feed, err := NewAggregatorV3Interface(feedAddr, o.client)
	if err != nil {
		return nil, fmt.Errorf("load feed: %w", err)
	}

	data, err := feed.GetRoundData(&bind.CallOpts{Context: ctx}, roundID)
	if err != nil {
		return nil, fmt.Errorf("get round data: %w", err)
	}

	decimals, err := feed.Decimals(&bind.CallOpts{Context: ctx})
	if err != nil {
		return nil, fmt.Errorf("get decimals: %w", err)
	}

	return &defi.PriceData{
		Price:     data.Answer,
		Decimals:  decimals,
		Timestamp: time.Unix(data.UpdatedAt.Int64(), 0),
		RoundID:   roundID,
		Source:    "chainlink",
	}, nil
}

// GetPriceWithStalenessCheck checks if price is fresh
func (o *Oracle) GetPriceWithStalenessCheck(ctx context.Context, pair string, maxAge time.Duration) (*defi.PriceData, error) {
	price, err := o.GetLatestPrice(ctx, pair)
	if err != nil {
		return nil, err
	}

	age := time.Since(price.Timestamp)
	if age > maxAge {
		return nil, fmt.Errorf("price is stale: %s old (max: %s)", age, maxAge)
	}

	return price, nil
}

// ComparePrices compares Chainlink price with DEX price
func (o *Oracle) ComparePrices(ctx context.Context, pair string, dexPrice *big.Int, dexDecimals uint8) (float64, error) {
	oraclePrice, err := o.GetLatestPrice(ctx, pair)
	if err != nil {
		return 0, fmt.Errorf("get oracle price: %w", err)
	}

	// Normalize to same decimals
	oracle := normalizePrice(oraclePrice.Price, oraclePrice.Decimals)
	dex := normalizePrice(dexPrice, dexDecimals)

	// Calculate deviation percentage
	deviation := new(big.Float).Sub(dex, oracle)
	deviation = new(big.Float).Quo(deviation, oracle)

	deviationFloat, _ := deviation.Float64()
	return deviationFloat * 100, nil
}

// normalizePrice converts price to 18 decimals
func normalizePrice(price *big.Int, decimals uint8) *big.Float {
	priceFlt := new(big.Float).SetInt(price)

	// Convert to 18 decimals
	if decimals < 18 {
		multiplier := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(18-decimals)), nil)
		priceFlt = new(big.Float).Mul(priceFlt, new(big.Float).SetInt(multiplier))
	} else if decimals > 18 {
		divisor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals-18)), nil)
		priceFlt = new(big.Float).Quo(priceFlt, new(big.Float).SetInt(divisor))
	}

	return priceFlt
}
```

### Price Feed Monitoring

Blockchain oracles provide smart contracts with trusted off-chain data such as asset prices and event outcomes, bridging deterministic on-chain execution with the real world. The following Go implementation queries a Chainlink price feed contract and validates the response against freshness and deviation thresholds.

```go
// pkg/defi/chainlink/monitor.go
package chainlink

import (
	"context"
	"fmt"
	"sync"
	"time"

	"yourapp/pkg/defi"
)

// Monitor watches price feeds for updates
type Monitor struct {
	oracle   *Oracle
	pairs    []string
	interval time.Duration

	// Callbacks
	onPriceUpdate func(pair string, price *defi.PriceData)
	onError       func(pair string, err error)

	stop chan struct{}
	wg   sync.WaitGroup
}

// NewMonitor creates a price feed monitor
func NewMonitor(oracle *Oracle, pairs []string, interval time.Duration) *Monitor {
	return &Monitor{
		oracle:   oracle,
		pairs:    pairs,
		interval: interval,
		stop:     make(chan struct{}),
	}
}

// OnPriceUpdate sets the price update callback
func (m *Monitor) OnPriceUpdate(fn func(pair string, price *defi.PriceData)) {
	m.onPriceUpdate = fn
}

// OnError sets the error callback
func (m *Monitor) OnError(fn func(pair string, err error)) {
	m.onError = fn
}

// Start begins monitoring
func (m *Monitor) Start(ctx context.Context) {
	for _, pair := range m.pairs {
		m.wg.Add(1)
		go m.monitorPair(ctx, pair)
	}
}

// Stop halts monitoring
func (m *Monitor) Stop() {
	close(m.stop)
	m.wg.Wait()
}

// monitorPair monitors a single pair
func (m *Monitor) monitorPair(ctx context.Context, pair string) {
	defer m.wg.Done()

	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	var lastRoundID *big.Int

	for {
		select {
		case <-ctx.Done():
			return
		case <-m.stop:
			return
		case <-ticker.C:
			price, err := m.oracle.GetLatestPrice(ctx, pair)
			if err != nil {
				if m.onError != nil {
					m.onError(pair, err)
				}
				continue
			}

			// Only notify on new rounds
			if lastRoundID == nil || price.RoundID.Cmp(lastRoundID) > 0 {
				if m.onPriceUpdate != nil {
					m.onPriceUpdate(pair, price)
				}
				lastRoundID = price.RoundID
			}
		}
	}
}
```

### Junior → FAANG: Oracle Integration as a Trust Boundary

Oracles are the mechanism by which smart contracts access off-chain data (primarily price feeds). Understanding oracle integration is critical because oracles are a primary attack surface in DeFi: many of the largest DeFi exploits involved oracle price manipulation. Before integrating any oracle, understand its trust model: who provides the data, how is it aggregated, and what happens if the providers report incorrect or malicious values?

Chainlink is the dominant oracle provider, and its price feed interface is simple: `latestRoundData()` returns `(roundId, answer, startedAt, updatedAt, answeredInRound)`. The `answer` field is the price in the feed's denomination (typically USD with 8 decimal places). The `updatedAt` timestamp tells you when the price was last updated. The `answeredInRound` field compared to `roundId` tells you whether the latest round has been finalized.

The most important correctness check for any Chainlink oracle integration is: verify that `updatedAt` is recent (within a reasonable window for the feed's heartbeat interval) before using the price. If the feed has not updated within its heartbeat interval plus a safety margin, the price may be stale. Using a stale price for collateral valuation or trade execution can lead to incorrect calculations. The heartbeat interval for each feed is documented on Chainlink's website (typically 1 hour for volatile assets, 24 hours for stablecoins with deviation thresholds).

Interview entry point: describe the circuit breaker that every Chainlink price feed integration should implement. Check: `answeredInRound >= roundId` (confirms the latest round was answered), `answer > 0` (confirms a positive price), `updatedAt > 0` (confirms the round was updated), and `block.timestamp - updatedAt < staleness_threshold` (confirms the price is recent). Missing any of these checks leaves the integration vulnerable to stale, zero, or unfinalized price data.

### Senior @ FAANG: Oracle Architecture and Manipulation Resistance

At staff level, oracle architecture is a risk management design problem. Relying on a single oracle source (even Chainlink) creates a single point of failure: Chainlink has had temporary service disruptions, and their price feeds can be delayed during extreme market conditions. Production-grade oracle integration requires redundancy: compare prices from multiple independent sources (Chainlink, Uniswap TWAP, Pyth, Redstone) and reject prices that deviate significantly from the consensus.

The multi-oracle comparison architecture has specific implementation challenges. Different oracles use different price denominators (ETH vs USD), different decimal precision (8 decimals for Chainlink USD feeds, 18 decimals for Uniswap reserves), and different update frequencies (Chainlink heartbeat-based, Uniswap block-by-block, Pyth on-demand). Normalizing these to a common representation before comparison requires careful decimal arithmetic using `math/big`.

Oracle manipulation resistance strategies at the application layer include: using TWAPs instead of spot prices (a 30-minute TWAP cannot be manipulated in a single transaction), using the minimum of multiple oracle sources (an attacker must manipulate all sources simultaneously to affect the result), and implementing circuit breakers that pause the integration when any source deviates significantly from the others. Staff engineers document which of these strategies are used in each oracle integration and why.

The Pyth network oracle (push-based, sub-second update frequency) and Chainlink's "Low Latency" product represent a new generation of oracles designed for high-frequency DeFi applications. These oracles provide more up-to-date prices but require different trust models (Pyth relies on a guardian network for data verification, with a different trust assumption than Chainlink's decentralized oracle network). Staff engineers evaluate new oracle providers against a defined trust assessment framework before adopting them.

Regulatory considerations for price feed usage are emerging: the CFTC has signaled interest in oversight of financial data providers that serve crypto derivatives markets. For regulated DeFi protocols or CeFi-DeFi hybrid systems, the price feed provider may need to satisfy specific data quality and auditability requirements. Staff engineers who design systems that use oracle data for regulatory-required pricing (e.g., daily settlement prices for derivative contracts) must assess whether their oracle provider satisfies the applicable regulatory standards.

Bar-raiser signals: designing an oracle aggregation system that uses a median of five independent price sources, detects and excludes outlier sources (those more than two standard deviations from the median), and logs all price feed readings with correlation IDs for audit purposes, or explaining the difference between Chainlink's standard price feeds and their Data Streams product (the Data Streams product provides sub-second price updates via a pull-based architecture where the requester fetches a signed report on demand, rather than waiting for the on-chain update). These topics reveal deep oracle ecosystem knowledge.

---
