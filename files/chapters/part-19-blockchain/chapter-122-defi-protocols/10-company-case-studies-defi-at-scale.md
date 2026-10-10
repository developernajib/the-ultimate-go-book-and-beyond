## 122.10 Company Case Studies: DeFi at Scale

### Coinbase: Institutional DeFi Access

Coinbase provides institutional DeFi access:

```go
// Coinbase-style institutional DeFi
package institutional

import (
    "context"
    "fmt"
    "time"
)

// InstitutionalDeFiClient provides compliant DeFi access
type InstitutionalDeFiClient struct {
    protocols       map[string]DeFiProtocol
    compliance      *ComplianceEngine
    riskManager     *RiskManager
    custodyService  *CustodyService
    auditLog        *AuditLog
}

type DeFiOperation struct {
    ID           string
    Type         string  // deposit, withdraw, swap, stake
    Protocol     string
    Asset        string
    Amount       float64
    User         string
    Status       string
    ApprovalLevel int
    CreatedAt    time.Time
}

// ExecuteOperation handles compliant DeFi operations
func (c *InstitutionalDeFiClient) ExecuteOperation(
    ctx context.Context,
    op *DeFiOperation,
) (*OperationResult, error) {
    // Compliance check
    if err := c.compliance.Check(op); err != nil {
        c.auditLog.RecordBlocked(op, err)
        return nil, fmt.Errorf("compliance check failed: %w", err)
    }

    // Risk assessment
    risk := c.riskManager.Assess(op)
    if risk.Score > 0.8 {
        c.auditLog.RecordHighRisk(op, risk)
        return nil, fmt.Errorf("operation exceeds risk threshold")
    }

    // Check approval requirements
    if op.Amount > c.getApprovalThreshold(op.Type) {
        if op.ApprovalLevel < 2 {
            return nil, fmt.Errorf("operation requires additional approval")
        }
    }

    // Get protocol handler
    protocol, ok := c.protocols[op.Protocol]
    if !ok {
        return nil, fmt.Errorf("unsupported protocol: %s", op.Protocol)
    }

    // Execute via custody service
    result, err := c.custodyService.ExecuteWithSigning(ctx, protocol, op)
    if err != nil {
        c.auditLog.RecordFailed(op, err)
        return nil, err
    }

    c.auditLog.RecordSuccess(op, result)
    return result, nil
}

// ComplianceEngine checks regulatory compliance
type ComplianceEngine struct {
    sanctionsList  *SanctionsList
    amlRules       []AMLRule
    geofencing     *GeofenceService
}

func (e *ComplianceEngine) Check(op *DeFiOperation) error {
    // Sanctions check
    if e.sanctionsList.IsBlocked(op.User) {
        return fmt.Errorf("user is on sanctions list")
    }

    // AML rules
    for _, rule := range e.amlRules {
        if err := rule.Evaluate(op); err != nil {
            return err
        }
    }

    // Geofencing
    if !e.geofencing.IsAllowed(op.User) {
        return fmt.Errorf("operation not allowed in user's jurisdiction")
    }

    return nil
}
```

### Yearn Finance: Yield Aggregation

Yearn-style yield optimization:

```go
// Yearn-style yield aggregation
package yield

import (
    "context"
    "math/big"
    "sort"
    "sync"
    "time"
)

// YieldAggregator finds best yields across protocols
type YieldAggregator struct {
    strategies  []*Strategy
    vaults      map[string]*Vault
    harvester   *Harvester
}

type Strategy struct {
    Name        string
    Protocol    string
    Asset       string
    APY         float64
    Risk        float64
    Capacity    *big.Int
    Allocated   *big.Int
    Contract    *Contract
}

type Vault struct {
    Asset       string
    TotalAssets *big.Int
    Strategies  []*Strategy
    DepositFee  float64
    WithdrawFee float64
}

// FindBestStrategies returns optimal yield strategies
func (a *YieldAggregator) FindBestStrategies(
    ctx context.Context,
    asset string,
    amount *big.Int,
    maxRisk float64,
) ([]*StrategyAllocation, error) {
    // Get all strategies for asset
    var candidates []*Strategy
    for _, s := range a.strategies {
        if s.Asset == asset && s.Risk <= maxRisk {
            // Check capacity
            available := new(big.Int).Sub(s.Capacity, s.Allocated)
            if available.Sign() > 0 {
                candidates = append(candidates, s)
            }
        }
    }

    // Sort by APY (descending)
    sort.Slice(candidates, func(i, j int) bool {
        return candidates[i].APY > candidates[j].APY
    })

    // Allocate across strategies
    remaining := new(big.Int).Set(amount)
    var allocations []*StrategyAllocation

    for _, strategy := range candidates {
        if remaining.Sign() == 0 {
            break
        }

        available := new(big.Int).Sub(strategy.Capacity, strategy.Allocated)
        allocation := min(remaining, available)

        allocations = append(allocations, &StrategyAllocation{
            Strategy: strategy,
            Amount:   allocation,
        })

        remaining = remaining.Sub(remaining, allocation)
    }

    if remaining.Sign() > 0 {
        return nil, fmt.Errorf("insufficient strategy capacity")
    }

    return allocations, nil
}

// Harvester collects and compounds yields
type Harvester struct {
    strategies []*Strategy
    lastHarvest map[string]time.Time
}

func (h *Harvester) Harvest(ctx context.Context, strategy *Strategy) error {
    // Get pending rewards
    pending, err := strategy.Contract.PendingRewards(ctx)
    if err != nil {
        return err
    }

    if pending.Sign() == 0 {
        return nil
    }

    // Harvest rewards
    tx, err := strategy.Contract.Harvest(ctx)
    if err != nil {
        return err
    }

    // Wait for confirmation
    _, err = waitForReceipt(ctx, tx.Hash)
    if err != nil {
        return err
    }

    // Compound back into strategy
    return strategy.Contract.Compound(ctx)
}
```

### 1inch: DEX Aggregation

1inch-style DEX aggregation patterns:

```go
// 1inch-style DEX aggregator
package aggregator

import (
    "context"
    "math/big"
    "sort"
    "sync"
)

// DEXAggregator finds best swap routes across DEXes
type DEXAggregator struct {
    dexes       []DEX
    pathfinder  *Pathfinder
    gasEstimator *GasEstimator
}

type DEX interface {
    Name() string
    GetQuote(ctx context.Context, tokenIn, tokenOut string, amountIn *big.Int) (*Quote, error)
    ExecuteSwap(ctx context.Context, params SwapParams) (string, error)
}

type Quote struct {
    DEX         string
    AmountOut   *big.Int
    PriceImpact float64
    GasEstimate uint64
    Route       []string
}

// GetBestRoute finds optimal swap route
func (a *DEXAggregator) GetBestRoute(
    ctx context.Context,
    tokenIn, tokenOut string,
    amountIn *big.Int,
) (*AggregatedQuote, error) {
    // Get quotes from all DEXes in parallel
    quotes := make(chan *Quote, len(a.dexes))
    var wg sync.WaitGroup

    for _, dex := range a.dexes {
        wg.Add(1)
        go func(d DEX) {
            defer wg.Done()
            quote, err := d.GetQuote(ctx, tokenIn, tokenOut, amountIn)
            if err == nil && quote != nil {
                quotes <- quote
            }
        }(dex)
    }

    wg.Wait()
    close(quotes)

    // Collect and sort quotes
    var allQuotes []*Quote
    for q := range quotes {
        allQuotes = append(allQuotes, q)
    }

    if len(allQuotes) == 0 {
        return nil, fmt.Errorf("no quotes available")
    }

    // Sort by net output (amountOut - gasCost)
    sort.Slice(allQuotes, func(i, j int) bool {
        netI := a.calculateNetOutput(allQuotes[i])
        netJ := a.calculateNetOutput(allQuotes[j])
        return netI.Cmp(netJ) > 0
    })

    best := allQuotes[0]

    // Try to find split routes for better execution
    splitRoute := a.findSplitRoute(ctx, tokenIn, tokenOut, amountIn, allQuotes)
    if splitRoute != nil && splitRoute.TotalOutput.Cmp(best.AmountOut) > 0 {
        return splitRoute, nil
    }

    return &AggregatedQuote{
        Routes:      []*Quote{best},
        TotalOutput: best.AmountOut,
        GasEstimate: best.GasEstimate,
    }, nil
}

// findSplitRoute finds optimal split across multiple DEXes
func (a *DEXAggregator) findSplitRoute(
    ctx context.Context,
    tokenIn, tokenOut string,
    amountIn *big.Int,
    quotes []*Quote,
) *AggregatedQuote {
    // Try 50/50 split between top 2 DEXes
    if len(quotes) < 2 {
        return nil
    }

    halfAmount := new(big.Int).Div(amountIn, big.NewInt(2))

    // Get quotes for split amounts
    var splitQuotes []*Quote
    for i := 0; i < 2; i++ {
        dex := a.getDEXByName(quotes[i].DEX)
        quote, err := dex.GetQuote(ctx, tokenIn, tokenOut, halfAmount)
        if err == nil {
            splitQuotes = append(splitQuotes, quote)
        }
    }

    if len(splitQuotes) < 2 {
        return nil
    }

    totalOutput := new(big.Int).Add(splitQuotes[0].AmountOut, splitQuotes[1].AmountOut)

    return &AggregatedQuote{
        Routes:      splitQuotes,
        TotalOutput: totalOutput,
        GasEstimate: splitQuotes[0].GasEstimate + splitQuotes[1].GasEstimate,
        IsSplit:     true,
    }
}
```

### Lido: Liquid Staking

Lido-style liquid staking integration:

```go
// Lido-style liquid staking
package staking

import (
    "context"
    "math/big"
)

// LiquidStakingClient interacts with liquid staking protocols
type LiquidStakingClient struct {
    lidoContract *Contract
    wstETH       *Contract
    oracle       *Contract
    chainClient  *ChainClient
}

// Stake deposits ETH and receives stETH
func (c *LiquidStakingClient) Stake(
    ctx context.Context,
    amount *big.Int,
    referral string,
    privateKey string,
) (*StakeResult, error) {
    // Get stETH exchange rate
    rate, err := c.GetExchangeRate(ctx)
    if err != nil {
        return nil, err
    }

    // Calculate expected stETH
    expectedSTETH := new(big.Int).Mul(amount, big.NewInt(1e18))
    expectedSTETH = expectedSTETH.Div(expectedSTETH, rate)

    // Submit ETH
    tx, err := c.lidoContract.Submit(ctx, amount, referral, privateKey)
    if err != nil {
        return nil, err
    }

    receipt, err := c.chainClient.WaitForReceipt(ctx, tx.Hash)
    if err != nil {
        return nil, err
    }

    return &StakeResult{
        TxHash:       tx.Hash,
        ETHDeposited: amount,
        STETHReceived: parseSTETHReceived(receipt),
        ExchangeRate: rate,
    }, nil
}

// WrapStETH converts stETH to wstETH
func (c *LiquidStakingClient) WrapStETH(
    ctx context.Context,
    stETHAmount *big.Int,
    privateKey string,
) (*WrapResult, error) {
    // Approve wstETH contract
    if err := c.lidoContract.Approve(ctx, c.wstETH.Address, stETHAmount, privateKey); err != nil {
        return nil, err
    }

    // Wrap stETH
    tx, err := c.wstETH.Wrap(ctx, stETHAmount, privateKey)
    if err != nil {
        return nil, err
    }

    receipt, err := c.chainClient.WaitForReceipt(ctx, tx.Hash)
    if err != nil {
        return nil, err
    }

    return &WrapResult{
        TxHash:        tx.Hash,
        STETHWrapped:  stETHAmount,
        WSTETHReceived: parseWSTETHReceived(receipt),
    }, nil
}

// GetExchangeRate returns current stETH/ETH rate
func (c *LiquidStakingClient) GetExchangeRate(ctx context.Context) (*big.Int, error) {
    // stETH is rebasing, so 1 stETH = 1 ETH in shares
    // wstETH is wrapped and represents shares
    totalPooled, err := c.lidoContract.GetTotalPooledEther(ctx)
    if err != nil {
        return nil, err
    }

    totalShares, err := c.lidoContract.GetTotalShares(ctx)
    if err != nil {
        return nil, err
    }

    // Rate = totalPooled / totalShares * 1e18
    rate := new(big.Int).Mul(totalPooled, big.NewInt(1e18))
    rate = rate.Div(rate, totalShares)

    return rate, nil
}
```

### Curve: Stablecoin Swaps

Curve Finance stable swap patterns:

```go
// Curve-style stablecoin swap
package curve

import (
    "context"
    "math/big"
)

// CurveClient interacts with Curve pools
type CurveClient struct {
    registry    *Contract
    pools       map[string]*CurvePool
    chainClient *ChainClient
}

type CurvePool struct {
    Address     string
    Coins       []string
    A           *big.Int  // Amplification coefficient
    Fee         *big.Int
    Contract    *Contract
}

// GetDY calculates expected output for swap
func (c *CurveClient) GetDY(
    ctx context.Context,
    poolAddress string,
    i, j int,
    dx *big.Int,
) (*big.Int, error) {
    pool := c.pools[poolAddress]
    if pool == nil {
        return nil, fmt.Errorf("pool not found")
    }

    return pool.Contract.GetDY(ctx, big.NewInt(int64(i)), big.NewInt(int64(j)), dx)
}

// Exchange performs a swap in a Curve pool
func (c *CurveClient) Exchange(
    ctx context.Context,
    poolAddress string,
    i, j int,
    dx, minDY *big.Int,
    privateKey string,
) (*SwapResult, error) {
    pool := c.pools[poolAddress]
    if pool == nil {
        return nil, fmt.Errorf("pool not found")
    }

    // Approve pool to spend token
    tokenIn := pool.Coins[i]
    if err := approveToken(ctx, tokenIn, poolAddress, dx, privateKey); err != nil {
        return nil, err
    }

    // Execute swap
    tx, err := pool.Contract.Exchange(
        ctx,
        big.NewInt(int64(i)),
        big.NewInt(int64(j)),
        dx,
        minDY,
        privateKey,
    )
    if err != nil {
        return nil, err
    }

    receipt, err := c.chainClient.WaitForReceipt(ctx, tx.Hash)
    if err != nil {
        return nil, err
    }

    return &SwapResult{
        TxHash:    tx.Hash,
        AmountIn:  dx,
        AmountOut: parseAmountOut(receipt),
        Pool:      poolAddress,
    }, nil
}

// AddLiquidity adds liquidity to a pool
func (c *CurveClient) AddLiquidity(
    ctx context.Context,
    poolAddress string,
    amounts []*big.Int,
    minMintAmount *big.Int,
    privateKey string,
) (*LiquidityResult, error) {
    pool := c.pools[poolAddress]

    // Approve all tokens
    for i, amount := range amounts {
        if amount.Sign() > 0 {
            if err := approveToken(ctx, pool.Coins[i], poolAddress, amount, privateKey); err != nil {
                return nil, err
            }
        }
    }

    // Add liquidity
    tx, err := pool.Contract.AddLiquidity(ctx, amounts, minMintAmount, privateKey)
    if err != nil {
        return nil, err
    }

    receipt, err := c.chainClient.WaitForReceipt(ctx, tx.Hash)
    if err != nil {
        return nil, err
    }

    return &LiquidityResult{
        TxHash:    tx.Hash,
        LPTokens:  parseLPTokensMinted(receipt),
        Amounts:   amounts,
    }, nil
}
```

---

### Junior → FAANG: DeFi Scale Case Studies as Reality Checks

DeFi scale case studies provide the reality check that prevents junior engineers from underestimating the complexity and risk of production DeFi integration. When you read about Compound's "drip" bug that accidentally distributed \$90 million of COMP tokens due to a governance upgrade error, or about the Yearn Finance v1 to v2 migration that required careful coordination across dozens of interdependent vaults, you understand why production DeFi engineering is not just a matter of calling the right functions.

The most instructive pattern across DeFi scale case studies is the gap between testnet behavior and mainnet reality. Testnet has low liquidity, low gas prices, few competing transactions, and no MEV. Mainnet has the opposite of all four. Code that works perfectly on testnet can fail repeatedly on mainnet because gas prices spike during the first operation, because other transactions front-run your price-sensitive operations, or because the protocol's behavior differs at mainnet scale. Case studies that describe this testnet-to-mainnet transition are particularly valuable for junior engineers who have not experienced it directly.

For interview preparation, select one DeFi scale case study that illustrates a systemic failure rather than a simple bug. The March 2020 "Black Thursday" event (ETH price dropped 50 percent in hours, causing mass liquidations, ETH gas price spike to 1000 gwei, and MakerDAO liquidation bots failing to compete, resulting in approximately \$4 million of under-collateralized ETH auctions at 0 DAI) is the best example of a systemic failure that affected multiple protocols simultaneously. Being able to describe this event and its root causes demonstrates mature DeFi ecosystem understanding.

First-job wisdom from case studies: in DeFi, the correct response to "this is working fine in development" is to list all the ways it could fail in production, not to celebrate. The systems that fail most dramatically in DeFi are always the ones that felt fully tested before deployment.

### Senior @ FAANG: DeFi Scale Case Studies as Infrastructure Design Input

At staff level, DeFi scale case studies are primary inputs to infrastructure design and risk management framework development. The specific failure modes described in case studies should translate directly into specific architectural requirements and monitoring alerts. "After the Compound drip bug, we require all governance transactions to go through a 48-hour time lock with off-chain simulation verification" is the kind of case-study-derived requirement that produces more reliable governance systems.

The Uniswap V3 launch case study is one of the most instructive for engineers who are building complex DeFi systems. The concentrated liquidity mechanism created a significantly more complex LP position management challenge (positions are not fungible, they have price ranges, and they require active management for optimal fee accrual), which drove the creation of an entire ecosystem of LP management protocols (Gamma, Arrakis, Range Protocol). Staff engineers who study this evolution understand how DeFi complexity creates infrastructure opportunities.

The Curve Wars case study (the competition among DeFi protocols to control veCRV votes in order to direct CRV emissions to their pools) illustrates the game-theoretic dynamics that emerge in DeFi ecosystems. Convex Finance, Yearn Finance, and dozens of other protocols competed for voting power, leading to complex multi-protocol coordination arrangements. Staff engineers who understand this ecosystem can design systems that participate in similar governance dynamics and can model the economic incentives correctly.

The Lido liquid staking case study is particularly relevant for protocol designers who must balance centralization risk against capital efficiency. Lido's rapid growth to controlling approximately 32 percent of staked ETH created systemic centralization risk for Ethereum's consensus layer. The community's response (distributed validator technology, Distributed Key Generation for Lido validators, discussions about operator set caps) illustrates how protocol risk management at the systemic level requires both technical and governance innovation.

Scale case studies also reveal the importance of monitoring and alerting in production DeFi infrastructure. Most of the major DeFi exploits were visible in on-chain data before the team was aware of them: anomalous transaction patterns, unusual protocol utilization rates, or large position size changes that violated expected behavior. A monitoring system designed to detect these patterns would have given the protocol team time to pause the protocol before significant funds were drained. Staff engineers use case studies to design more effective anomaly detection for their own systems.

Bar-raiser signals: describing the Compound cToken exchange rate bug (where the COMP drip function used an incorrect exchange rate calculation that accrued too many tokens over time), explaining why the bug was not caught in testing (it required the compoundExchangeRate to accumulate over many blocks in a specific way that differed from the test environment's state), and proposing the integration testing approach that would have caught it (time-travel tests that simulate specific block counts and verify accumulated state). This level of case study analysis reveals genuine engineering depth.

---
