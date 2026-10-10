## 120.4 Reading Blockchain Data

### 4.1 Getting Account Balances

Balances are returned in Wei as a `*big.Int` because 1 ETH = 10^18 Wei, which overflows int64 and float64, requiring arbitrary-precision arithmetic for correct conversion. Passing `nil` as the block number fetches the latest confirmed balance, while passing a specific block number retrieves the historical balance at that point in the chain.

```go
// pkg/eth/balance.go
package eth

import (
    "context"
    "fmt"
    "math"
    "math/big"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
)

// WeiToEther converts Wei to Ether
func WeiToEther(wei *big.Int) *big.Float {
    ether := new(big.Float)
    ether.SetString(wei.String())
    return ether.Quo(ether, big.NewFloat(math.Pow10(18)))
}

// GetBalance retrieves an account's balance
func GetBalance(client *ethclient.Client, address common.Address) (*big.Int, error) {
    ctx := context.Background()

    balance, err := client.BalanceAt(ctx, address, nil) // nil = latest block
    if err != nil {
        return nil, fmt.Errorf("failed to get balance: %w", err)
    }

    return balance, nil
}

// GetBalanceAtBlock retrieves balance at a specific block
func GetBalanceAtBlock(client *ethclient.Client, address common.Address, blockNumber *big.Int) (*big.Int, error) {
    ctx := context.Background()

    balance, err := client.BalanceAt(ctx, address, blockNumber)
    if err != nil {
        return nil, fmt.Errorf("failed to get balance at block %s: %w", blockNumber, err)
    }

    return balance, nil
}

// Example usage
func ExampleGetBalance() {
    client, err := ethclient.Dial("https://eth-sepolia.g.alchemy.com/v2/YOUR-API-KEY")
    if err != nil {
        panic(err)
    }
    defer client.Close()

    // Vitalik's address
    address := common.HexToAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")

    balance, err := GetBalance(client, address)
    if err != nil {
        panic(err)
    }

    fmt.Printf("Balance (Wei): %s\n", balance.String())
    fmt.Printf("Balance (ETH): %f\n", WeiToEther(balance))
}
```

### 4.2 Reading Blocks

Reading block data from the Ethereum chain provides the raw material for block explorers, analytics services, and reorg detection logic. The following example retrieves a full block including all transactions and demonstrates safe handling of the pending block edge case.

```go
// pkg/eth/blocks.go
package eth

import (
    "context"
    "fmt"
    "math/big"
    "time"

    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/ethclient"
)

// GetLatestBlock retrieves the latest block
func GetLatestBlock(client *ethclient.Client) (*types.Block, error) {
    ctx := context.Background()

    block, err := client.BlockByNumber(ctx, nil) // nil = latest
    if err != nil {
        return nil, fmt.Errorf("failed to get latest block: %w", err)
    }

    return block, nil
}

// GetBlockByNumber retrieves a specific block
func GetBlockByNumber(client *ethclient.Client, blockNumber *big.Int) (*types.Block, error) {
    ctx := context.Background()

    block, err := client.BlockByNumber(ctx, blockNumber)
    if err != nil {
        return nil, fmt.Errorf("failed to get block %s: %w", blockNumber, err)
    }

    return block, nil
}

// GetBlockByHash retrieves a block by its hash
func GetBlockByHash(client *ethclient.Client, blockHash common.Hash) (*types.Block, error) {
    ctx := context.Background()

    block, err := client.BlockByHash(ctx, blockHash)
    if err != nil {
        return nil, fmt.Errorf("failed to get block %s: %w", blockHash.Hex(), err)
    }

    return block, nil
}

// PrintBlockInfo displays detailed block information
func PrintBlockInfo(block *types.Block) {
    fmt.Printf("Block Number:     %d\n", block.Number().Uint64())
    fmt.Printf("Block Hash:       %s\n", block.Hash().Hex())
    fmt.Printf("Parent Hash:      %s\n", block.ParentHash().Hex())
    fmt.Printf("Timestamp:        %s\n", time.Unix(int64(block.Time()), 0))
    fmt.Printf("Nonce:            %d\n", block.Nonce())
    fmt.Printf("Difficulty:       %s\n", block.Difficulty())
    fmt.Printf("Gas Used:         %d\n", block.GasUsed())
    fmt.Printf("Gas Limit:        %d\n", block.GasLimit())
    fmt.Printf("Transaction Count: %d\n", len(block.Transactions()))
    fmt.Printf("Miner:            %s\n", block.Coinbase().Hex())
    fmt.Printf("Block Size:       %d bytes\n", block.Size())

    // EIP-1559 fields (post-London fork)
    if block.BaseFee() != nil {
        fmt.Printf("Base Fee:         %s Wei\n", block.BaseFee())
    }
}

// StreamBlocks continuously streams new blocks
func StreamBlocks(client *ethclient.Client, callback func(*types.Block)) error {
    ctx := context.Background()

    headers := make(chan *types.Header)
    sub, err := client.SubscribeNewHead(ctx, headers)
    if err != nil {
        return fmt.Errorf("failed to subscribe to new blocks: %w", err)
    }
    defer sub.Unsubscribe()

    for {
        select {
        case err := <-sub.Err():
            return fmt.Errorf("subscription error: %w", err)
        case header := <-headers:
            // Get full block (header doesn't include transactions)
            block, err := client.BlockByNumber(ctx, header.Number)
            if err != nil {
                fmt.Printf("Failed to get block: %v\n", err)
                continue
            }
            callback(block)
        }
    }
}

// Example: Monitor new blocks
func ExampleStreamBlocks() {
    client, err := ethclient.Dial("wss://eth-sepolia.g.alchemy.com/v2/YOUR-API-KEY")
    if err != nil {
        panic(err)
    }
    defer client.Close()

    fmt.Println("Listening for new blocks...")
    StreamBlocks(client, func(block *types.Block) {
        fmt.Printf("\n--- New Block %d ---\n", block.Number().Uint64())
        PrintBlockInfo(block)
    })
}
```

### 4.3 Reading Transactions

Reading on-chain transactions by hash returns the raw `types.Transaction` alongside a `types.Receipt` that carries the execution result, gas used, logs emitted, and the status field indicating success (1) or revert (0). The receipt is fetched separately because it is only available after the transaction is included in a mined block, so callers must wait for confirmation before querying it.

```go
// pkg/eth/transactions.go
package eth

import (
    "context"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/ethclient"
)

// GetTransaction retrieves a transaction by hash
func GetTransaction(client *ethclient.Client, txHash common.Hash) (*types.Transaction, bool, error) {
    ctx := context.Background()

    tx, isPending, err := client.TransactionByHash(ctx, txHash)
    if err != nil {
        return nil, false, fmt.Errorf("failed to get transaction: %w", err)
    }

    return tx, isPending, nil
}

// GetTransactionReceipt retrieves a transaction receipt
func GetTransactionReceipt(client *ethclient.Client, txHash common.Hash) (*types.Receipt, error) {
    ctx := context.Background()

    receipt, err := client.TransactionReceipt(ctx, txHash)
    if err != nil {
        return nil, fmt.Errorf("failed to get receipt: %w", err)
    }

    return receipt, nil
}

// TransactionInfo holds detailed transaction information
type TransactionInfo struct {
    Hash             common.Hash
    From             common.Address
    To               *common.Address
    Value            *big.Int
    Gas              uint64
    GasPrice         *big.Int
    Nonce            uint64
    Data             []byte
    BlockNumber      *big.Int
    BlockHash        common.Hash
    TransactionIndex uint

    // Receipt info
    Status           uint64 // 1 = success, 0 = failed
    GasUsed          uint64
    CumulativeGasUsed uint64
    ContractAddress  common.Address // for contract creation (zero address if not a deploy)
    Logs             []*types.Log
}

// GetTransactionInfo retrieves comprehensive transaction information
func GetTransactionInfo(client *ethclient.Client, txHash common.Hash, chainID *big.Int) (*TransactionInfo, error) {
    ctx := context.Background()

    // Get transaction
    tx, isPending, err := client.TransactionByHash(ctx, txHash)
    if err != nil {
        return nil, fmt.Errorf("failed to get transaction: %w", err)
    }

    if isPending {
        return nil, fmt.Errorf("transaction is still pending")
    }

    // Get receipt
    receipt, err := client.TransactionReceipt(ctx, txHash)
    if err != nil {
        return nil, fmt.Errorf("failed to get receipt: %w", err)
    }

    // Get sender (requires chain ID for signature recovery)
    signer := types.LatestSignerForChainID(chainID)
    from, err := types.Sender(signer, tx)
    if err != nil {
        return nil, fmt.Errorf("failed to get sender: %w", err)
    }

    info := &TransactionInfo{
        Hash:              tx.Hash(),
        From:              from,
        To:                tx.To(),
        Value:             tx.Value(),
        Gas:               tx.Gas(),
        GasPrice:          tx.GasPrice(),
        Nonce:             tx.Nonce(),
        Data:              tx.Data(),
        BlockNumber:       receipt.BlockNumber,
        BlockHash:         receipt.BlockHash,
        TransactionIndex:  receipt.TransactionIndex,
        Status:            receipt.Status,
        GasUsed:           receipt.GasUsed,
        CumulativeGasUsed: receipt.CumulativeGasUsed,
        ContractAddress:   receipt.ContractAddress,
        Logs:              receipt.Logs,
    }

    return info, nil
}

// PrintTransactionInfo displays transaction details
func PrintTransactionInfo(info *TransactionInfo) {
    fmt.Printf("Transaction Hash: %s\n", info.Hash.Hex())
    fmt.Printf("From:             %s\n", info.From.Hex())
    if info.To != nil {
        fmt.Printf("To:               %s\n", info.To.Hex())
    } else {
        fmt.Printf("To:               Contract Creation\n")
    }
    fmt.Printf("Value:            %s Wei (%f ETH)\n", info.Value, WeiToEther(info.Value))
    fmt.Printf("Gas Limit:        %d\n", info.Gas)
    fmt.Printf("Gas Used:         %d (%.2f%%)\n", info.GasUsed, float64(info.GasUsed)/float64(info.Gas)*100)
    fmt.Printf("Gas Price:        %s Wei\n", info.GasPrice)
    fmt.Printf("Nonce:            %d\n", info.Nonce)
    fmt.Printf("Block Number:     %s\n", info.BlockNumber)
    fmt.Printf("Block Hash:       %s\n", info.BlockHash.Hex())
    fmt.Printf("Transaction Index: %d\n", info.TransactionIndex)

    if info.Status == 1 {
        fmt.Println("Status:           Success ✓")
    } else {
        fmt.Println("Status:           Failed ✗")
    }

    if info.ContractAddress != (common.Address{}) {
        fmt.Printf("Contract Created: %s\n", info.ContractAddress.Hex())
    }

    if len(info.Data) > 0 {
        fmt.Printf("Input Data:       %x... (%d bytes)\n", info.Data[:min(32, len(info.Data))], len(info.Data))
    }

    fmt.Printf("Logs:             %d events emitted\n", len(info.Logs))
}

// GetBlockTransactions retrieves all transactions from a block
func GetBlockTransactions(client *ethclient.Client, blockNumber *big.Int, chainID *big.Int) ([]*TransactionInfo, error) {
    ctx := context.Background()

    block, err := client.BlockByNumber(ctx, blockNumber)
    if err != nil {
        return nil, fmt.Errorf("failed to get block: %w", err)
    }

    signer := types.LatestSignerForChainID(chainID)
    txInfos := make([]*TransactionInfo, 0, len(block.Transactions()))

    for _, tx := range block.Transactions() {
        receipt, err := client.TransactionReceipt(ctx, tx.Hash())
        if err != nil {
            continue
        }

        from, err := types.Sender(signer, tx)
        if err != nil {
            continue
        }

        txInfos = append(txInfos, &TransactionInfo{
            Hash:              tx.Hash(),
            From:              from,
            To:                tx.To(),
            Value:             tx.Value(),
            Gas:               tx.Gas(),
            GasPrice:          tx.GasPrice(),
            Nonce:             tx.Nonce(),
            Data:              tx.Data(),
            BlockNumber:       block.Number(),
            BlockHash:         block.Hash(),
            TransactionIndex:  receipt.TransactionIndex,
            Status:            receipt.Status,
            GasUsed:           receipt.GasUsed,
            CumulativeGasUsed: receipt.CumulativeGasUsed,
            ContractAddress:   receipt.ContractAddress,
            Logs:              receipt.Logs,
        })
    }

    return txInfos, nil
}
```

---

### Junior → FAANG: Reading Blockchain Data Correctly and Reliably

Reading blockchain data correctly requires understanding that the Ethereum JSON-RPC API is not a consistent database snapshot: the "current" state you observe depends on which block the node considers canonical, which may change during a reorg. Every read that requires consistency must specify a block number or use the `finalized` block tag to read from a state that the network has finalized and will not reorg.

The most important distinction for junior engineers is between `latest`, `safe`, and `finalized` block tags. `latest` is the most recent block the node knows about, which can be reorged. `safe` is the most recent block that is unlikely to be reorged (a few slots ahead of the finalization checkpoint). `finalized` is the most recent block that has been finalized by Ethereum's Casper FFG, which cannot be reorged without slashing more than one-third of all staked ETH. For any read operation that drives a business decision (credit an account, trigger a withdrawal), always use `finalized` or a specific block number with sufficient confirmation depth.

Batch reading using Multicall3 (a contract deployed at the same address on all major Ethereum-compatible networks: `0xcA11bde05977b3631167028862bE2a173976CA11`) is a critical optimization technique. Without Multicall3, reading 1000 token balances requires 1000 separate RPC calls. With Multicall3, all 1000 reads are packaged into a single `eth_call` that executes all the balance queries in one EVM run and returns all results in one response. This reduces latency from seconds (serial RPC calls) to milliseconds.

Interview entry point: explain the difference between `eth_call` (simulates a transaction without broadcasting it or consuming gas, reads state at a specific block) and `eth_estimateGas` (simulates execution and returns the estimated gas cost, also without broadcasting). Both are useful for different purposes in reading blockchain data, and confusing them leads to incorrect implementations.

### Senior @ FAANG: Blockchain Data Reading at Production Scale

At staff level, reading blockchain data is a system design problem that involves the trade-off between freshness, cost, and reliability. Reading from a third-party RPC provider is fresh and cheap for low volume but becomes expensive and rate-limited at high volume. Running your own archive node provides unlimited reads at any historical block but requires infrastructure investment and ongoing operational cost. Using a specialized indexing service (The Graph, Goldsky, Morph, Quicknode Streams) trades customization for development speed.

ADRs for blockchain data reading infrastructure must quantify the query volume, latency requirements, and historical depth requirements before choosing an approach. A system that needs only recent data (within 128 blocks, the default in-memory state for Geth) does not need an archive node. A system that needs arbitrary historical state (for auditing, analytics, or proof generation) requires an archive node or a specialized historical state service.

Caching blockchain data correctly requires understanding which data is immutable and which can change. Block data with at least 128 confirmations is effectively immutable and can be cached indefinitely. Transaction receipts are similarly stable. Account balances, contract storage values, and token balances all change with each block and should only be cached with a TTL calibrated to the block time (12 seconds on Ethereum mainnet). The finalized block tag provides a natural cache invalidation signal: anything read at a finalized block number is permanently cacheable.

Event log reading at scale requires pagination and careful handling of the `eth_getLogs` rate limits and response size limits. Many RPC providers limit the number of logs returned in a single `eth_getLogs` call (Infura limits to 10,000 results). Production event indexers implement pagination using the `fromBlock` and `toBlock` parameters, processing one range at a time and tracking progress. The `blockHash` parameter (filtering by specific block hash rather than number range) is more precise and avoids ambiguity during reorgs but requires knowing the specific block hash.

Data consistency across multiple reads is a subtle but important challenge. If your application reads an account balance and a token allowance in two separate RPC calls, those reads may reflect different block states if a block was produced between the two calls. Multicall3 or a single `eth_call` that reads all required values in one transaction execution guarantees that all values are consistent with respect to a single block state. Staff engineers identify consistency requirements during design and use appropriate read batching to satisfy them.

Bar-raiser signals: explaining how EIP-4844 blob data can be read from a beacon node's REST API (rather than the execution layer JSON-RPC) and what the implications are for data availability verification in rollup systems, or designing a system that maintains a consistent, replicated view of a specific smart contract's state across multiple downstream consumers with defined staleness SLAs. These topics reveal production-grade systems thinking.

---
