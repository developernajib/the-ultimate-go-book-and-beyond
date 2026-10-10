## 123.6 Event Indexing Service

A production-ready event indexing service for blockchain events:

```go
// pkg/web3/indexer/indexer.go
package indexer

import (
    "context"
    "database/sql"
    "fmt"
    "math/big"
    "sync"
    "time"

    "github.com/ethereum/go-ethereum"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/ethclient"
)

// EventIndexer indexes blockchain events
type EventIndexer struct {
    client       *ethclient.Client
    db           *sql.DB
    contracts    []common.Address
    startBlock   uint64
    currentBlock uint64
    batchSize    uint64
    mu           sync.RWMutex

    // Reorg handling
    confirmations uint64
    reorgDepth    uint64
}

// IndexerConfig represents indexer configuration
type IndexerConfig struct {
    StartBlock    uint64
    BatchSize     uint64
    Confirmations uint64
    ReorgDepth    uint64
}

// NewEventIndexer creates a new event indexer
func NewEventIndexer(
    client *ethclient.Client,
    db *sql.DB,
    contracts []common.Address,
    config IndexerConfig,
) *EventIndexer {
    return &EventIndexer{
        client:        client,
        db:            db,
        contracts:     contracts,
        startBlock:    config.StartBlock,
        currentBlock:  config.StartBlock,
        batchSize:     config.BatchSize,
        confirmations: config.Confirmations,
        reorgDepth:    config.ReorgDepth,
    }
}

// Start starts the indexing process
func (idx *EventIndexer) Start(ctx context.Context) error {
    // Initialize database schema
    if err := idx.initDB(); err != nil {
        return fmt.Errorf("failed to init database: %w", err)
    }

    // Load current progress from database
    if err := idx.loadProgress(); err != nil {
        return fmt.Errorf("failed to load progress: %w", err)
    }

    // Start indexing loop
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if err := idx.indexBatch(ctx); err != nil {
                fmt.Printf("Indexing error: %v\n", err)
                continue
            }
        }
    }
}

// indexBatch indexes a batch of blocks
func (idx *EventIndexer) indexBatch(ctx context.Context) error {
    // Get latest block
    latestBlock, err := idx.client.BlockNumber(ctx)
    if err != nil {
        return fmt.Errorf("failed to get latest block: %w", err)
    }

    // Account for confirmations
    safeBlock := latestBlock - idx.confirmations
    if safeBlock <= idx.currentBlock {
        return nil // Nothing to index yet
    }

    // Calculate batch end
    endBlock := idx.currentBlock + idx.batchSize
    if endBlock > safeBlock {
        endBlock = safeBlock
    }

    // Query events
    query := ethereum.FilterQuery{
        FromBlock: big.NewInt(int64(idx.currentBlock)),
        ToBlock:   big.NewInt(int64(endBlock)),
        Addresses: idx.contracts,
    }

    logs, err := idx.client.FilterLogs(ctx, query)
    if err != nil {
        return fmt.Errorf("failed to filter logs: %w", err)
    }

    // Process events in transaction
    tx, err := idx.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    for _, log := range logs {
        if err := idx.processLog(ctx, tx, log); err != nil {
            return fmt.Errorf("failed to process log: %w", err)
        }
    }

    // Update progress
    if err := idx.updateProgress(tx, endBlock); err != nil {
        return err
    }

    if err := tx.Commit(); err != nil {
        return fmt.Errorf("failed to commit transaction: %w", err)
    }

    idx.mu.Lock()
    idx.currentBlock = endBlock
    idx.mu.Unlock()

    fmt.Printf("Indexed blocks %d-%d (%d events)\n", idx.currentBlock, endBlock, len(logs))

    return nil
}

// processLog processes a single log entry
func (idx *EventIndexer) processLog(
    ctx context.Context,
    tx *sql.Tx,
    log types.Log,
) error {
    // Insert event into database
    query := `
        INSERT INTO events (
            contract_address,
            block_number,
            transaction_hash,
            log_index,
            topic0,
            topic1,
            topic2,
            topic3,
            data,
            removed
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (transaction_hash, log_index) DO UPDATE SET
            removed = EXCLUDED.removed
    `

    var topic1, topic2, topic3 *string
    if len(log.Topics) > 1 {
        t := log.Topics[1].Hex()
        topic1 = &t
    }
    if len(log.Topics) > 2 {
        t := log.Topics[2].Hex()
        topic2 = &t
    }
    if len(log.Topics) > 3 {
        t := log.Topics[3].Hex()
        topic3 = &t
    }

    _, err := tx.ExecContext(
        ctx,
        query,
        log.Address.Hex(),
        log.BlockNumber,
        log.TxHash.Hex(),
        log.Index,
        log.Topics[0].Hex(),
        topic1,
        topic2,
        topic3,
        common.Bytes2Hex(log.Data),
        log.Removed,
    )

    return err
}

// initDB initializes the database schema
func (idx *EventIndexer) initDB() error {
    schema := `
        CREATE TABLE IF NOT EXISTS events (
            id SERIAL PRIMARY KEY,
            contract_address TEXT NOT NULL,
            block_number BIGINT NOT NULL,
            transaction_hash TEXT NOT NULL,
            log_index INTEGER NOT NULL,
            topic0 TEXT NOT NULL,
            topic1 TEXT,
            topic2 TEXT,
            topic3 TEXT,
            data TEXT,
            removed BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(transaction_hash, log_index)
        );

        CREATE INDEX IF NOT EXISTS idx_events_block ON events(block_number);
        CREATE INDEX IF NOT EXISTS idx_events_contract ON events(contract_address);
        CREATE INDEX IF NOT EXISTS idx_events_topic0 ON events(topic0);
        CREATE INDEX IF NOT EXISTS idx_events_tx ON events(transaction_hash);

        CREATE TABLE IF NOT EXISTS indexer_progress (
            id INTEGER PRIMARY KEY DEFAULT 1,
            current_block BIGINT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CHECK (id = 1)
        );
    `

    _, err := idx.db.Exec(schema)
    return err
}

// loadProgress loads indexing progress from database
func (idx *EventIndexer) loadProgress() error {
    var blockNumber uint64
    err := idx.db.QueryRow("SELECT current_block FROM indexer_progress WHERE id = 1").
        Scan(&blockNumber)

    if err == sql.ErrNoRows {
        // First run, use start block
        return nil
    }
    if err != nil {
        return err
    }

    idx.currentBlock = blockNumber
    return nil
}

// updateProgress updates indexing progress in database
func (idx *EventIndexer) updateProgress(tx *sql.Tx, blockNumber uint64) error {
    _, err := tx.Exec(`
        INSERT INTO indexer_progress (id, current_block, updated_at)
        VALUES (1, $1, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO UPDATE SET
            current_block = EXCLUDED.current_block,
            updated_at = CURRENT_TIMESTAMP
    `, blockNumber)

    return err
}

// HandleReorg handles blockchain reorganizations
func (idx *EventIndexer) HandleReorg(ctx context.Context, reorgBlock uint64) error {
    tx, err := idx.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Delete events from reorged blocks
    _, err = tx.ExecContext(
        ctx,
        "DELETE FROM events WHERE block_number >= $1",
        reorgBlock,
    )
    if err != nil {
        return fmt.Errorf("failed to delete reorged events: %w", err)
    }

    // Update progress
    if err := idx.updateProgress(tx, reorgBlock-1); err != nil {
        return err
    }

    if err := tx.Commit(); err != nil {
        return err
    }

    idx.mu.Lock()
    idx.currentBlock = reorgBlock - 1
    idx.mu.Unlock()

    fmt.Printf("Handled reorg at block %d\n", reorgBlock)

    return nil
}

// GetProgress returns current indexing progress
func (idx *EventIndexer) GetProgress() uint64 {
    idx.mu.RLock()
    defer idx.mu.RUnlock()
    return idx.currentBlock
}
```

### Reorg Detection

The reorg detector compares the stored block hash at each height against what the node currently reports and walks backward until it finds a common ancestor. When a reorg is detected, events from the orphaned chain segment are rolled back in the database before re-indexing the canonical chain, preventing stale event data from persisting in the index.

```go
// pkg/web3/indexer/reorg.go
package indexer

import (
    "context"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
)

// ReorgDetector detects blockchain reorganizations
type ReorgDetector struct {
    client     *ethclient.Client
    blockCache map[uint64]common.Hash
    maxDepth   uint64
}

// NewReorgDetector creates a new reorg detector
func NewReorgDetector(client *ethclient.Client, maxDepth uint64) *ReorgDetector {
    return &ReorgDetector{
        client:     client,
        blockCache: make(map[uint64]common.Hash),
        maxDepth:   maxDepth,
    }
}

// CheckReorg checks if a reorg occurred
func (rd *ReorgDetector) CheckReorg(
    ctx context.Context,
    blockNumber uint64,
) (bool, uint64, error) {
    // Get current block hash
    block, err := rd.client.BlockByNumber(ctx, big.NewInt(int64(blockNumber)))
    if err != nil {
        return false, 0, fmt.Errorf("failed to get block: %w", err)
    }

    currentHash := block.Hash()

    // Check against cache
    cachedHash, exists := rd.blockCache[blockNumber]
    if exists && cachedHash != currentHash {
        // Reorg detected!
        // Find the common ancestor
        reorgBlock := rd.findCommonAncestor(ctx, blockNumber)
        return true, reorgBlock, nil
    }

    // Update cache
    rd.blockCache[blockNumber] = currentHash

    // Limit cache size
    if uint64(len(rd.blockCache)) > rd.maxDepth {
        // Remove oldest entries
        for k := range rd.blockCache {
            if k < blockNumber-rd.maxDepth {
                delete(rd.blockCache, k)
            }
        }
    }

    return false, 0, nil
}

// findCommonAncestor finds the common ancestor block after a reorg
func (rd *ReorgDetector) findCommonAncestor(
    ctx context.Context,
    startBlock uint64,
) uint64 {
    for i := startBlock; i > 0 && i > startBlock-rd.maxDepth; i-- {
        block, err := rd.client.BlockByNumber(ctx, big.NewInt(int64(i)))
        if err != nil {
            continue
        }

        if cachedHash, exists := rd.blockCache[i]; exists {
            if cachedHash == block.Hash() {
                return i + 1 // Return first divergent block
            }
        }
    }

    return startBlock - rd.maxDepth
}
```

### Junior → FAANG: Building Your First Event Indexing Service

An event indexing service is the bridge between the blockchain's append-only event log and your application's queryable database. Building one from scratch in Go is a valuable exercise because it forces you to confront the exact challenges that The Graph and other indexing platforms solve: startup replay, reorg handling, event schema evolution, and idempotent processing.

The minimal event indexing service has three components: a block fetcher (which fetches new blocks from the Ethereum node, either by polling `eth_getBlockByNumber` or subscribing via WebSocket), an event processor (which decodes log events from each block using ABI bindings and maps them to application entities), and a state store (which persists the processed entities to a database with the processed block number as the cursor). These three components communicate through Go channels, providing natural backpressure.

The startup sequence for an event indexing service is the most complex part: on startup, read the last processed block number from the database, fetch all log events from that block to the current head using `eth_getLogs` with a range, process them in order, and then switch to subscription mode for real-time processing. The key correctness requirement is that no event is skipped and no event is processed twice during the transition from replay to subscription.

Interview entry point: design the data model for an event indexing service for a simple token transfer system. You need: a `transfers` table (id, tx_hash, log_index, block_number, block_hash, from_address, to_address, amount, token_address, created_at), a `processing_state` table (chain_id, last_processed_block, last_processed_block_hash), and indexes on `from_address`, `to_address`, and `block_number`. The `log_index` plus `tx_hash` form the deduplication key. The `block_hash` allows reorg detection.

### Senior @ FAANG: Event Indexing Service Architecture at Production Scale

At staff level, the event indexing service is a core infrastructure component that many teams and applications depend on. Designing it for reliability, correctness, and scalability requires addressing several concerns that a basic implementation glosses over.

Reorg handling at depth requires the indexer to maintain a rollback buffer: the processed state for the last N blocks must be reversible. When a reorg is detected (the block hash for a previously processed block no longer matches the canonical chain), the indexer must: identify the fork point (the last block where its stored hash matches the current canonical hash), roll back all processed state from the fork point to the current head, and replay from the fork point in the new canonical chain. This rollback-and-replay operation must be atomic from the database's perspective.

The reorg detection mechanism depends on how the indexer tracks processed blocks. An indexer that stores only the last processed block number cannot detect reorgs: block number 1000 on the fork has the same number as block 1000 on the canonical chain. An indexer that stores both the block number and the block hash can detect reorgs by comparing its stored hash against `eth_getBlockByNumber(1000).hash`. Storing block hashes for the last N blocks (where N exceeds the maximum expected reorg depth) enables reorg detection without maintaining a full rollback buffer.

Event processing throughput at production scale may require parallelization of the event processing pipeline. A single-threaded event processor is limited by the processing speed of each event and the database write speed. Parallelizing across independent block ranges (splitting the work across multiple goroutines, each responsible for a range of blocks) can increase throughput but requires careful management of the processing cursor to ensure that the cursor only advances when all events up to that point have been successfully committed.

Schema evolution for event indexing services is a production concern that is easy to overlook in early development. When the smart contract is upgraded and its event schema changes (new parameters, renamed parameters, changed parameter types), the indexer must handle both old and new event formats correctly for their respective block ranges. This requires maintaining multiple ABI versions and selecting the correct one based on the block height of each event. Designing the indexer with ABI version management from the start avoids a painful migration when the first contract upgrade occurs.

Operational concerns for a production event indexing service include: lag monitoring (the difference between the current chain head and the last indexed block), alert thresholds for indexing lag (a lag of more than 10 blocks on Ethereum mainnet indicates the indexer is falling behind and should trigger a page), database storage growth projections (event storage for a high-activity contract grows continuously and requires capacity planning), and deployment procedures that minimize indexing downtime during service upgrades.

Bar-raiser signals: designing an event indexing service that supports multiple concurrent subscribers (different application teams who need different subsets of events from the same contracts) by implementing a subscription model where each subscriber registers the events and addresses they are interested in, and the indexer fan-outs processed events to registered subscribers, or explaining how the indexer should handle the case where `eth_getLogs` returns a "exceeded maximum block range" error from the RPC provider (which requires splitting the range into smaller chunks and combining the results). These operational details reveal genuine production indexer experience.

---
