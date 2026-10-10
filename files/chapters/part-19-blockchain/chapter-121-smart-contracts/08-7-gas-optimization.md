## 121.7 Gas Optimization

Gas is the computational cost of executing transactions. Optimizing gas usage saves users money.

### 7.1 Understanding Gas

The EVM charges gas per opcode, making the total cost a function of execution complexity rather than payload size, an empty storage write costs 20,000 gas while a simple addition costs 3 gas. EIP-1559 separates fees into a burned base fee set by the network and a priority fee tip paid to validators, giving callers control over inclusion speed without over-paying on every transaction.

```
Transaction Cost = Gas Used × Gas Price

Gas Used:     Determined by computation complexity
Gas Price:    Set by user (higher = faster confirmation)
Max Fee:      Maximum willing to pay (EIP-1559)
Priority Fee: Tip to miners/validators (EIP-1559)
```

### 7.2 Estimating Gas Costs

The estimator calls `EstimateGas` against the current chain state and then applies a configurable multiplier buffer before returning the gas limit to use in the transaction. Adding 20% headroom accounts for state changes between estimation and mining that would otherwise push the actual gas consumption above the estimated limit and revert the transaction.

```go
package gas

import (
    "context"
    "fmt"
    "math/big"
    "strings"

    "github.com/ethereum/go-ethereum"
    "github.com/ethereum/go-ethereum/accounts/abi"
    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
)

// Estimator handles gas estimation
type Estimator struct {
    client *ethclient.Client
}

// NewEstimator creates a gas estimator
func NewEstimator(client *ethclient.Client) *Estimator {
    return &Estimator{client: client}
}

// EstimateTransfer estimates gas for a token transfer
func (e *Estimator) EstimateTransfer(
    ctx context.Context,
    tokenAddr common.Address,
    from common.Address,
    to common.Address,
    amount *big.Int,
) (uint64, error) {
    // Parse ERC-20 ABI
    parsed, err := abi.JSON(strings.NewReader(erc20.ERC20ABI))
    if err != nil {
        return 0, fmt.Errorf("parse abi: %w", err)
    }

    // Pack transfer function call
    data, err := parsed.Pack("transfer", to, amount)
    if err != nil {
        return 0, fmt.Errorf("pack transfer: %w", err)
    }

    // Estimate gas
    gasLimit, err := e.client.EstimateGas(ctx, ethereum.CallMsg{
        From: from,
        To:   &tokenAddr,
        Data: data,
    })
    if err != nil {
        return 0, fmt.Errorf("estimate gas: %w", err)
    }

    return gasLimit, nil
}

// GasPrice fetches current gas price information
func (e *Estimator) GasPrice(ctx context.Context) (*GasPriceInfo, error) {
    // Get legacy gas price
    gasPrice, err := e.client.SuggestGasPrice(ctx)
    if err != nil {
        return nil, fmt.Errorf("suggest gas price: %w", err)
    }

    // Get EIP-1559 gas prices
    gasTipCap, err := e.client.SuggestGasTipCap(ctx)
    if err != nil {
        return nil, fmt.Errorf("suggest gas tip: %w", err)
    }

    // Get latest block for base fee
    block, err := e.client.HeaderByNumber(ctx, nil)
    if err != nil {
        return nil, fmt.Errorf("get latest block: %w", err)
    }

    return &GasPriceInfo{
        Legacy:  gasPrice,
        BaseFee: block.BaseFee,
        Tip:     gasTipCap,
    }, nil
}

// GasPriceInfo holds gas price information
type GasPriceInfo struct {
    Legacy  *big.Int // Legacy gas price
    BaseFee *big.Int // EIP-1559 base fee
    Tip     *big.Int // EIP-1559 priority fee (tip)
}

// CalculateCost calculates transaction cost
func (info *GasPriceInfo) CalculateCost(gasLimit uint64) *big.Int {
    // For EIP-1559: cost = (baseFee + tip) * gasLimit
    if info.BaseFee != nil {
        totalPrice := new(big.Int).Add(info.BaseFee, info.Tip)
        return new(big.Int).Mul(totalPrice, big.NewInt(int64(gasLimit)))
    }

    // For legacy: cost = gasPrice * gasLimit
    return new(big.Int).Mul(info.Legacy, big.NewInt(int64(gasLimit)))
}
```

### 7.3 EIP-1559 Transactions

EIP-1559 introduced a new fee market mechanism:

```go
package transactions

import (
    "context"
    "crypto/ecdsa"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/ethclient"
)

// EIP1559Transactor handles EIP-1559 transactions
type EIP1559Transactor struct {
    client  *ethclient.Client
    chainID *big.Int
}

// NewEIP1559Transactor creates an EIP-1559 transactor
func NewEIP1559Transactor(ctx context.Context, client *ethclient.Client) (*EIP1559Transactor, error) {
    chainID, err := client.NetworkID(ctx)
    if err != nil {
        return nil, fmt.Errorf("get chain id: %w", err)
    }

    return &EIP1559Transactor{
        client:  client,
        chainID: chainID,
    }, nil
}

// CreateAuth creates TransactOpts with EIP-1559 pricing
func (t *EIP1559Transactor) CreateAuth(
    ctx context.Context,
    privateKey *ecdsa.PrivateKey,
    priorityLevel Priority,
) (*bind.TransactOpts, error) {
    // Create base auth
    auth, err := bind.NewKeyedTransactorWithChainID(privateKey, t.chainID)
    if err != nil {
        return nil, fmt.Errorf("create transactor: %w", err)
    }

    // Get suggested tip
    suggestedTip, err := t.client.SuggestGasTipCap(ctx)
    if err != nil {
        return nil, fmt.Errorf("suggest tip: %w", err)
    }

    // Adjust tip based on priority
    tip := t.adjustTipByPriority(suggestedTip, priorityLevel)

    // Get latest block for base fee
    block, err := t.client.HeaderByNumber(ctx, nil)
    if err != nil {
        return nil, fmt.Errorf("get latest block: %w", err)
    }

    // Calculate max fee per gas
    // maxFeePerGas = baseFee * 2 + tip (to account for base fee fluctuation)
    maxFeePerGas := new(big.Int).Mul(block.BaseFee, big.NewInt(2))
    maxFeePerGas.Add(maxFeePerGas, tip)

    // Set EIP-1559 fields
    auth.GasTipCap = tip
    auth.GasFeeCap = maxFeePerGas
    auth.Context = ctx

    return auth, nil
}

// Priority represents transaction priority level
type Priority int

const (
    PriorityLow Priority = iota
    PriorityMedium
    PriorityHigh
    PriorityUrgent
)

// adjustTipByPriority adjusts tip based on priority
func (t *EIP1559Transactor) adjustTipByPriority(baseTip *big.Int, priority Priority) *big.Int {
    multipliers := map[Priority]int64{
        PriorityLow:    50,  // 0.5x
        PriorityMedium: 100, // 1x
        PriorityHigh:   150, // 1.5x
        PriorityUrgent: 200, // 2x
    }

    multiplier := multipliers[priority]
    adjusted := new(big.Int).Mul(baseTip, big.NewInt(multiplier))
    return new(big.Int).Div(adjusted, big.NewInt(100))
}

// EstimatedConfirmationTime estimates confirmation time by priority
func (t *EIP1559Transactor) EstimatedConfirmationTime(priority Priority) string {
    times := map[Priority]string{
        PriorityLow:    "~5 minutes",
        PriorityMedium: "~1 minute",
        PriorityHigh:   "~30 seconds",
        PriorityUrgent: "~15 seconds",
    }
    return times[priority]
}
```

### 7.4 Batch Operations for Gas Savings

Batch multiple operations to save gas:

```go
package batch

import (
    "context"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
)

// BatchTransfer represents a transfer in a batch
type BatchTransfer struct {
    To     common.Address
    Amount *big.Int
}

// BatchTransferTokens transfers tokens to multiple recipients in one transaction
// Note: This requires a custom contract with a batch transfer function
func BatchTransferTokens(
    ctx context.Context,
    auth *bind.TransactOpts,
    contract *batchtoken.BatchToken, // Custom contract with batchTransfer
    transfers []BatchTransfer,
) error {
    if len(transfers) == 0 {
        return fmt.Errorf("no transfers provided")
    }

    // Prepare arrays for batch call
    recipients := make([]common.Address, len(transfers))
    amounts := make([]*big.Int, len(transfers))

    for i, transfer := range transfers {
        recipients[i] = transfer.To
        amounts[i] = transfer.Amount
    }

    // Single transaction for multiple transfers
    tx, err := contract.BatchTransfer(auth, recipients, amounts)
    if err != nil {
        return fmt.Errorf("batch transfer: %w", err)
    }

    fmt.Printf("Batch transfer transaction: %s\n", tx.Hash().Hex())
    fmt.Printf("Transferred to %d recipients\n", len(transfers))

    return nil
}

// Example Solidity contract with batch transfer:
/*
contract BatchToken is ERC20 {
    function batchTransfer(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        require(recipients.length == amounts.length, "length mismatch");

        for (uint256 i = 0; i < recipients.length; i++) {
            _transfer(msg.sender, recipients[i], amounts[i]);
        }
    }
}
*/
```

### 7.5 Gas Price Strategies

The gas price strategy fetches the current base fee from the pending block and computes `maxFeePerGas` as `2 × baseFee + priorityFee` to provide a safety buffer against rising fees across the next two blocks. The 2× multiplier ensures the transaction remains valid even if the base fee increases at the maximum allowed rate between submission and inclusion.

```go
package strategy

import (
    "context"
    "fmt"
    "math/big"
    "time"

    "github.com/ethereum/go-ethereum/ethclient"
)

// GasPriceStrategy determines optimal gas price
type GasPriceStrategy struct {
    client *ethclient.Client
}

// NewGasPriceStrategy creates a gas price strategy
func NewGasPriceStrategy(client *ethclient.Client) *GasPriceStrategy {
    return &GasPriceStrategy{client: client}
}

// WaitForOptimalGasPrice waits until gas price drops below threshold
func (s *GasPriceStrategy) WaitForOptimalGasPrice(
    ctx context.Context,
    maxGasPrice *big.Int,
    checkInterval time.Duration,
) (*big.Int, error) {
    ticker := time.NewTicker(checkInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-ticker.C:
            gasPrice, err := s.client.SuggestGasPrice(ctx)
            if err != nil {
                return nil, fmt.Errorf("suggest gas price: %w", err)
            }

            if gasPrice.Cmp(maxGasPrice) <= 0 {
                return gasPrice, nil
            }

            fmt.Printf("Current gas price: %s Gwei (waiting for ≤ %s Gwei)\n",
                toGwei(gasPrice),
                toGwei(maxGasPrice),
            )
        }
    }
}

// GetHistoricalGasPrices fetches gas prices over time
func (s *GasPriceStrategy) GetHistoricalGasPrices(
    ctx context.Context,
    blocks uint64,
) ([]*big.Int, error) {
    latestBlock, err := s.client.BlockNumber(ctx)
    if err != nil {
        return nil, fmt.Errorf("get latest block: %w", err)
    }

    var prices []*big.Int
    for i := uint64(0); i < blocks; i++ {
        blockNum := big.NewInt(int64(latestBlock - i))
        block, err := s.client.BlockByNumber(ctx, blockNum)
        if err != nil {
            return nil, fmt.Errorf("get block %s: %w", blockNum.String(), err)
        }

        if block.BaseFee() != nil {
            prices = append(prices, block.BaseFee())
        }
    }

    return prices, nil
}

func toGwei(wei *big.Int) string {
    gwei := new(big.Float).Quo(
        new(big.Float).SetInt(wei),
        big.NewFloat(1e9),
    )
    return gwei.Text('f', 2)
}
```

---

### Junior → FAANG: Gas Optimization for Go Backend Engineers

Gas optimization for Go backend engineers focuses on minimizing the number and cost of on-chain operations, not on optimizing Solidity bytecode. The most impactful gas optimizations available at the application layer are: batching multiple reads into a single Multicall3 call, batching multiple writes into a contract that processes them in a loop, using `eth_call` for reads that do not require state changes, and avoiding redundant `eth_getCode` or `eth_getTransactionCount` calls for known addresses.

The most expensive on-chain operations that backend code might trigger are: new storage slot writes (20,000 gas), deploying a contract (32,000 gas base plus byte cost of bytecode), and cross-contract calls with value transfer (9,000 gas in addition to call cost). Understanding these costs helps you estimate transaction fees accurately and avoid designs that require unnecessarily expensive operations.

Gas limit setting is a practical first-job skill. Too low and the transaction runs out of gas and reverts (the user loses the gas but the state change does not happen). Too high and you waste ETH on the maximum possible gas cost rather than the actual cost. The correct approach is to use `eth_estimateGas` and add a 20-30 percent buffer to handle state changes between estimation and execution, while setting a hard maximum that reflects the maximum you are willing to pay for the operation.

Interview entry point: explain why `eth_estimateGas` can underestimate the actual gas required for a transaction. The estimate is computed based on current blockchain state, but the actual gas consumed depends on the state at the time of inclusion, which may differ. For operations that read from storage that other transactions might update (like a liquidation that checks a price feed), the estimate can be significantly lower than the actual cost if the price feed changes between estimation and inclusion.

### Senior @ FAANG: Gas Optimization as a Platform Engineering Concern

At staff level, gas optimization is a platform engineering concern that affects the unit economics of every product that touches the blockchain. At Ethereum mainnet gas prices of 20 gwei and ETH at \$3000, a single SSTORE operation costs approximately \$1.20. A withdrawal system that performs 10 storage writes per withdrawal has a gas cost of \$12 in write operations alone, before any token transfer or contract call costs. At 10,000 withdrawals per day, this is \$120,000 per day in gas costs. Staff engineers own the gas cost optimization roadmap.

The Multicall3 pattern for batching reads is the most valuable optimization available at the application layer for read-heavy workloads. A system that currently makes 1000 individual `balanceOf` calls per minute can reduce this to 10 Multicall3 calls (100 reads per call), reducing both gas cost and RPC call overhead. The implementation cost is minimal (a few hours to integrate Multicall3), and the savings are immediate and substantial.

Batch operation contracts (custom contracts that accept a list of operations and execute them in a loop) are the write-side equivalent of Multicall3. A token distribution system that sends rewards to 1000 addresses individually requires 1000 transactions (each with a base gas cost of 21,000 plus token transfer cost). A batch distribution contract executes all 1000 transfers in a single transaction for a fraction of the cost. The trade-off is smart contract deployment and maintenance cost, and the risk of a revert affecting the entire batch (which requires careful error handling design, often using try/catch patterns in Solidity).

EIP-4844 blob transactions provide a dramatically cheaper alternative to calldata for systems that post large amounts of data to Ethereum (primarily rollup operators). The cost per byte of calldata is 16 gas (non-zero byte) versus the blob cost of approximately 1 gas per byte at similar base fee levels. For rollup systems that post megabytes of transaction data per day, switching from calldata to blobs (after the Dencun upgrade) reduces data posting costs by 10x or more. Staff engineers at rollup companies tracked this transition and planned the migration well in advance.

Gas cost monitoring is an operational practice that staff engineers establish for any system that pays for on-chain operations. A dashboard that tracks: average gas cost per transaction type, total gas spend per day, gas cost as a percentage of revenue, and gas spend relative to the gas price (to distinguish volume-driven changes from price-driven changes) provides the visibility needed to identify optimization opportunities and to detect anomalies (unexpected gas consumption increase may indicate a contract behavior change or a bug in fee estimation logic).

Bar-raiser signals: designing a gas cost optimization strategy for a system that currently uses individual SSTORE operations for every update but could switch to a Merkle accumulator pattern (collecting updates off-chain and committing only the Merkle root on-chain, with individual updates verifiable via proofs), or explaining the EIP-1153 transient storage proposal (tstore/tload opcodes) and how it can reduce gas costs for patterns that currently use storage as a reentrancy guard. These optimization techniques require deep EVM knowledge.

---
