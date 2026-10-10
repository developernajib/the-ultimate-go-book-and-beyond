## 120.7 Event Listening and Filtering

### 7.1 Subscribing to Events

Ethereum event logs are the primary mechanism for smart contracts to communicate state changes to off-chain systems. The following implementation subscribes to contract events via WebSocket, ABI-decodes the indexed topics and data fields, and handles reorg-safe log processing.

```go
// pkg/events/listener.go
package events

import (
    "context"
    "fmt"
    "log"
    "math/big"

    "github.com/ethereum/go-ethereum"
    "github.com/ethereum/go-ethereum/accounts/abi"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/ethclient"

    "yourmodule/pkg/token"
)

// EventListener listens for contract events
type EventListener struct {
    client  *ethclient.Client
    address common.Address
}

// NewEventListener creates a new event listener
func NewEventListener(client *ethclient.Client, contractAddress common.Address) *EventListener {
    return &EventListener{
        client:  client,
        address: contractAddress,
    }
}

// ListenForTransfers subscribes to Transfer events
func (el *EventListener) ListenForTransfers(ctx context.Context) error {
    // Create filter query
    query := ethereum.FilterQuery{
        Addresses: []common.Address{el.address},
    }

    // Subscribe to logs
    logs := make(chan types.Log)
    sub, err := el.client.SubscribeFilterLogs(ctx, query, logs)
    if err != nil {
        return fmt.Errorf("failed to subscribe to logs: %w", err)
    }
    defer sub.Unsubscribe()

    // Parse contract ABI
    contractABI, err := abi.JSON(strings.NewReader(token.SimpleTokenABI))
    if err != nil {
        return fmt.Errorf("failed to parse ABI: %w", err)
    }

    fmt.Println("Listening for Transfer events...")

    for {
        select {
        case err := <-sub.Err():
            return fmt.Errorf("subscription error: %w", err)
        case vLog := <-logs:
            // Parse Transfer event
            var transferEvent struct {
                From  common.Address
                To    common.Address
                Value *big.Int
            }

            err := contractABI.UnpackIntoInterface(&transferEvent, "Transfer", vLog.Data)
            if err != nil {
                log.Printf("Failed to unpack log: %v", err)
                continue
            }

            // Indexed parameters are in Topics, not Data
            transferEvent.From = common.HexToAddress(vLog.Topics[1].Hex())
            transferEvent.To = common.HexToAddress(vLog.Topics[2].Hex())

            fmt.Printf("Transfer: %s -> %s: %s tokens (block %d, tx %s)\n",
                transferEvent.From.Hex(),
                transferEvent.To.Hex(),
                transferEvent.Value,
                vLog.BlockNumber,
                vLog.TxHash.Hex(),
            )
        }
    }
}
```

### 7.2 Filtering Historical Events

`ethereum.FilterQuery` specifies the block range and topic hash computed from the event signature string, so the node returns only the relevant log entries rather than all logs from the contract. The topic is the Keccak-256 hash of the canonical event signature (e.g., `Transfer(address,address,uint256)`) that the EVM stores as the first indexed topic in every emitted log.

```go
// GetTransferHistory retrieves historical Transfer events
func (el *EventListener) GetTransferHistory(fromBlock, toBlock *big.Int) ([]TransferEvent, error) {
    // Create filter query
    query := ethereum.FilterQuery{
        FromBlock: fromBlock,
        ToBlock:   toBlock,
        Addresses: []common.Address{el.address},
        Topics:    [][]common.Hash{{crypto.Keccak256Hash([]byte("Transfer(address,address,uint256)"))}},
    }

    // Get logs
    logs, err := el.client.FilterLogs(context.Background(), query)
    if err != nil {
        return nil, fmt.Errorf("failed to filter logs: %w", err)
    }

    // Parse contract ABI
    contractABI, err := abi.JSON(strings.NewReader(token.SimpleTokenABI))
    if err != nil {
        return nil, fmt.Errorf("failed to parse ABI: %w", err)
    }

    var transfers []TransferEvent
    for _, vLog := range logs {
        var transferEvent struct {
            From  common.Address
            To    common.Address
            Value *big.Int
        }

        err := contractABI.UnpackIntoInterface(&transferEvent, "Transfer", vLog.Data)
        if err != nil {
            log.Printf("Failed to unpack log: %v", err)
            continue
        }

        transferEvent.From = common.HexToAddress(vLog.Topics[1].Hex())
        transferEvent.To = common.HexToAddress(vLog.Topics[2].Hex())

        transfers = append(transfers, TransferEvent{
            From:        transferEvent.From,
            To:          transferEvent.To,
            Value:       transferEvent.Value,
            BlockNumber: vLog.BlockNumber,
            TxHash:      vLog.TxHash,
        })
    }

    return transfers, nil
}

type TransferEvent struct {
    From        common.Address
    To          common.Address
    Value       *big.Int
    BlockNumber uint64
    TxHash      common.Hash
}

// Example: Get last 1000 blocks of transfers
func ExampleGetHistory() {
    client, _ := ethclient.Dial("https://eth-sepolia.g.alchemy.com/v2/YOUR-API-KEY")
    defer client.Close()

    contractAddress := common.HexToAddress("0x...")
    listener := NewEventListener(client, contractAddress)

    // Get current block
    currentBlock, _ := client.BlockNumber(context.Background())
    fromBlock := new(big.Int).SetUint64(currentBlock - 1000)
    toBlock := new(big.Int).SetUint64(currentBlock)

    transfers, err := listener.GetTransferHistory(fromBlock, toBlock)
    if err != nil {
        panic(err)
    }

    fmt.Printf("Found %d transfers in last 1000 blocks\n", len(transfers))
    for _, t := range transfers {
        fmt.Printf("Block %d: %s -> %s: %s\n",
            t.BlockNumber, t.From.Hex(), t.To.Hex(), t.Value)
    }
}
```

---

### Junior → FAANG: Event Listening as the Core of Blockchain Backend Development

Event listening is how blockchain backends know when something interesting happened on-chain. Every significant state change in a well-designed smart contract emits an event, and backend systems that need to react to on-chain state (crediting deposits, triggering settlements, updating databases) must listen to these events reliably. "Reliably" has a specific technical meaning here: the system must not miss events, must handle reorgs correctly, and must be idempotent in processing each event.

The two approaches for event listening in Go are: subscription via WebSocket (`ethclient.SubscribeFilterLogs`) for real-time push delivery, and polling via `ethclient.FilterLogs` for historical and catch-up processing. Production systems use both: WebSocket subscription for real-time delivery of new events, and polling for startup replay (processing all events since the last checkpoint when the service restarts) and for gap filling (re-fetching events from a range where the WebSocket connection was interrupted).

The `removed` field in an event log is the most important field that junior engineers overlook. When a reorg occurs, events that were in reorged-out blocks are re-delivered via the subscription with `removed: true`. A system that ignores this field will process events twice: once when they are included and once when they are removed, leading to incorrect state (double-credited deposits, duplicate notifications). Always check `removed` and, for events where it is set to true, reverse the action taken when the event was first processed.

Interview entry point: design an event listener that survives service restarts without missing events or processing events twice. The correct design stores the last processed block number in a database, replays events from that block on startup, and uses a deduplication key (event transaction hash plus log index) to skip events that were already processed. This design pattern appears in almost every blockchain backend system.

### Senior @ FAANG: Event-Driven Architecture for Blockchain Systems

At staff level, event listening is the backbone of blockchain-driven application architecture. The design of the event processing pipeline determines the latency, reliability, and consistency of every feature that depends on on-chain state. A poorly designed event pipeline is a source of subtle, intermittent, and difficult-to-diagnose bugs that compound over time.

The canonical architecture for production blockchain event processing has three stages: ingestion (raw log fetching and WebSocket subscription, with reorg handling), normalization (converting raw logs to application events using ABI decoding and business logic), and processing (applying events to application state in a transactional, idempotent manner). Each stage should be a separate service or goroutine with defined interfaces and independent failure modes.

Exactly-once processing of blockchain events is impossible in a distributed system without a global transaction coordinator, but at-least-once processing with idempotent handlers achieves the same semantic outcome. The deduplication key for a blockchain event is the transaction hash combined with the log index (the position of the event within the transaction's logs). This key uniquely identifies each event across reorgs because the log index is relative to the transaction, and the transaction hash includes the full transaction content including block hash through EIP-155.

Reorg handling at production scale requires more than checking the `removed` flag on WebSocket events. Deep reorgs (more than two or three blocks, which are rare on Ethereum mainnet but common on Layer 2 chains and during testnet forks) require the event pipeline to replay all events from the point of the reorg fork. This means the pipeline must store enough historical state to reverse actions taken for any event that might be reorged within the maximum expected reorg depth. For Ethereum mainnet, a depth of 64 blocks is conservative. For Layer 2 chains, the reorg depth depends on the chain's finality model.

Event schema versioning is a production concern that is easy to overlook during initial development. When a smart contract is upgraded and its events change (new parameters added, parameter types changed, events renamed), the event processing code must be updated to handle both old and new event formats from their respective block ranges. A migration that processes historical events emitted before the upgrade must use the old ABI, while processing current events must use the new ABI. Maintaining this per-block-range ABI mapping is a sophisticated infrastructure concern that affects every event-driven blockchain system.

Bar-raiser signals: designing a multi-chain event aggregation system that maintains a consistent global ordering of events across Ethereum mainnet, Polygon, Arbitrum, and Optimism (requires defining a total ordering that respects finality on each chain rather than just using wall clock time), or explaining why an event subscription that uses `eth_newFilter` (polling) rather than `eth_subscribe` (WebSocket push) may miss events on a node that has limited filter lifetime (Geth drops filters after 5 minutes of inactivity). These operational details reveal genuine production systems experience.

---
