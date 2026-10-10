## 123.10 Building a Block Explorer Backend

### API Server

The block explorer API server proxies Ethereum RPC calls through a Go HTTP layer that normalizes responses, adds caching headers for immutable historical data, and handles address validation before forwarding to the node. Routing address, block, and transaction queries to separate handler methods keeps each endpoint's parameter parsing and response shaping isolated and independently testable.

```go
// pkg/explorer/server.go
package explorer

import (
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "strconv"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
    "github.com/gorilla/mux"
)

// ExplorerAPI provides block explorer API
type ExplorerAPI struct {
    client *ethclient.Client
    cache  *Cache
    db     *Database
}

// NewExplorerAPI creates a new explorer API
func NewExplorerAPI(
    client *ethclient.Client,
    cache *Cache,
    db *Database,
) *ExplorerAPI {
    return &ExplorerAPI{
        client: client,
        cache:  cache,
        db:     db,
    }
}

// SetupRoutes sets up HTTP routes
func (api *ExplorerAPI) SetupRoutes(r *mux.Router) {
    r.HandleFunc("/api/block/{number}", api.handleGetBlock).Methods("GET")
    r.HandleFunc("/api/tx/{hash}", api.handleGetTransaction).Methods("GET")
    r.HandleFunc("/api/address/{address}", api.handleGetAddress).Methods("GET")
    r.HandleFunc("/api/address/{address}/txs", api.handleGetAddressTransactions).Methods("GET")
    r.HandleFunc("/api/address/{address}/tokens", api.handleGetAddressTokens).Methods("GET")
    r.HandleFunc("/api/stats", api.handleGetStats).Methods("GET")
}

// handleGetBlock handles block queries
func (api *ExplorerAPI) handleGetBlock(w http.ResponseWriter, r *http.Request) {
    vars := mux.Vars(r)
    blockNumber, err := strconv.ParseUint(vars["number"], 10, 64)
    if err != nil {
        http.Error(w, "Invalid block number", http.StatusBadRequest)
        return
    }

    ctx := r.Context()

    // Try cache first
    cacheKey := fmt.Sprintf("block:%d", blockNumber)
    var blockData BlockData
    if err := api.cache.Get(ctx, cacheKey, &blockData); err == nil {
        api.respondJSON(w, blockData)
        return
    }

    // Fetch from blockchain
    block, err := api.client.BlockByNumber(ctx, big.NewInt(int64(blockNumber)))
    if err != nil {
        http.Error(w, "Block not found", http.StatusNotFound)
        return
    }

    blockData = BlockData{
        Number:       block.Number().Uint64(),
        Hash:         block.Hash().Hex(),
        ParentHash:   block.ParentHash().Hex(),
        Timestamp:    block.Time(),
        Miner:        block.Coinbase().Hex(),
        GasUsed:      block.GasUsed(),
        GasLimit:     block.GasLimit(),
        Transactions: len(block.Transactions()),
    }

    // Cache the result
    api.cache.Set(ctx, cacheKey, blockData)

    api.respondJSON(w, blockData)
}

// handleGetTransaction handles transaction queries
func (api *ExplorerAPI) handleGetTransaction(w http.ResponseWriter, r *http.Request) {
    vars := mux.Vars(r)
    txHash := common.HexToHash(vars["hash"])

    ctx := r.Context()

    // Fetch transaction
    tx, isPending, err := api.client.TransactionByHash(ctx, txHash)
    if err != nil {
        http.Error(w, "Transaction not found", http.StatusNotFound)
        return
    }

    // Get receipt
    receipt, err := api.client.TransactionReceipt(ctx, txHash)
    if err != nil && !isPending {
        http.Error(w, "Failed to get receipt", http.StatusInternalServerError)
        return
    }

    msg, _ := tx.AsMessage(types.LatestSignerForChainID(tx.ChainId()), nil)

    txData := TransactionData{
        Hash:     tx.Hash().Hex(),
        From:     msg.From().Hex(),
        To:       "",
        Value:    tx.Value().String(),
        GasPrice: tx.GasPrice().String(),
        Gas:      tx.Gas(),
        Nonce:    tx.Nonce(),
        Data:     common.Bytes2Hex(tx.Data()),
        Pending:  isPending,
    }

    if tx.To() != nil {
        txData.To = tx.To().Hex()
    }

    if receipt != nil {
        txData.BlockNumber = receipt.BlockNumber.Uint64()
        txData.Status = receipt.Status
        txData.GasUsed = receipt.GasUsed
    }

    api.respondJSON(w, txData)
}

// handleGetAddress handles address queries
func (api *ExplorerAPI) handleGetAddress(w http.ResponseWriter, r *http.Request) {
    vars := mux.Vars(r)
    address := common.HexToAddress(vars["address"])

    ctx := r.Context()

    // Get balance
    balance, err := api.client.BalanceAt(ctx, address, nil)
    if err != nil {
        http.Error(w, "Failed to get balance", http.StatusInternalServerError)
        return
    }

    // Get transaction count
    txCount, err := api.client.TransactionCount(ctx, address)
    if err != nil {
        http.Error(w, "Failed to get transaction count", http.StatusInternalServerError)
        return
    }

    addressData := AddressData{
        Address:          address.Hex(),
        Balance:          balance.String(),
        TransactionCount: txCount,
    }

    api.respondJSON(w, addressData)
}

// handleGetAddressTransactions handles address transaction history
func (api *ExplorerAPI) handleGetAddressTransactions(w http.ResponseWriter, r *http.Request) {
    vars := mux.Vars(r)
    address := vars["address"]

    // Parse pagination parameters
    page := 1
    limit := 20
    if p := r.URL.Query().Get("page"); p != "" {
        page, _ = strconv.Atoi(p)
    }
    if l := r.URL.Query().Get("limit"); l != "" {
        limit, _ = strconv.Atoi(l)
    }

    // Query database for transactions
    txs, total, err := api.db.GetAddressTransactions(address, page, limit)
    if err != nil {
        http.Error(w, "Failed to get transactions", http.StatusInternalServerError)
        return
    }

    result := PaginatedResult{
        Data:  txs,
        Page:  page,
        Limit: limit,
        Total: total,
    }

    api.respondJSON(w, result)
}

// respondJSON sends a JSON response
func (api *ExplorerAPI) respondJSON(w http.ResponseWriter, data any) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(data)
}

// BlockData represents block information
type BlockData struct {
    Number       uint64 `json:"number"`
    Hash         string `json:"hash"`
    ParentHash   string `json:"parent_hash"`
    Timestamp    uint64 `json:"timestamp"`
    Miner        string `json:"miner"`
    GasUsed      uint64 `json:"gas_used"`
    GasLimit     uint64 `json:"gas_limit"`
    Transactions int    `json:"transactions"`
}

// TransactionData represents transaction information
type TransactionData struct {
    Hash        string `json:"hash"`
    From        string `json:"from"`
    To          string `json:"to"`
    Value       string `json:"value"`
    GasPrice    string `json:"gas_price"`
    Gas         uint64 `json:"gas"`
    GasUsed     uint64 `json:"gas_used"`
    Nonce       uint64 `json:"nonce"`
    Data        string `json:"data"`
    BlockNumber uint64 `json:"block_number"`
    Status      uint64 `json:"status"`
    Pending     bool   `json:"pending"`
}

// AddressData represents address information
type AddressData struct {
    Address          string `json:"address"`
    Balance          string `json:"balance"`
    TransactionCount uint64 `json:"transaction_count"`
}

// PaginatedResult represents paginated results
type PaginatedResult struct {
    Data  any `json:"data"`
    Page  int         `json:"page"`
    Limit int         `json:"limit"`
    Total int         `json:"total"`
}
```

### Analytics Engine

The analytics engine queries a relational database populated by the event indexer rather than querying the Ethereum node directly, enabling aggregate SQL queries, like total transaction volume over a time window, that would be impractical to compute in real time from RPC calls. Time-range filtering on the indexed `timestamp` column makes these queries efficient when the column is properly indexed.

```go
// pkg/explorer/analytics.go
package explorer

import (
    "context"
    "database/sql"
    "fmt"
    "time"
)

// Analytics provides blockchain analytics
type Analytics struct {
    db *sql.DB
}

// NewAnalytics creates a new analytics engine
func NewAnalytics(db *sql.DB) *Analytics {
    return &Analytics{db: db}
}

// GetDailyStats returns daily statistics
func (a *Analytics) GetDailyStats(ctx context.Context, date time.Time) (*DailyStats, error) {
    query := `
        SELECT
            DATE(timestamp) as date,
            COUNT(*) as transactions,
            COUNT(DISTINCT from_address) as active_addresses,
            SUM(gas_used) as total_gas,
            AVG(gas_price) as avg_gas_price
        FROM transactions
        WHERE DATE(timestamp) = $1
        GROUP BY DATE(timestamp)
    `

    var stats DailyStats
    err := a.db.QueryRowContext(ctx, query, date).Scan(
        &stats.Date,
        &stats.Transactions,
        &stats.ActiveAddresses,
        &stats.TotalGas,
        &stats.AvgGasPrice,
    )

    if err != nil {
        return nil, fmt.Errorf("failed to get daily stats: %w", err)
    }

    return &stats, nil
}

// GetTopAddresses returns top addresses by transaction count
func (a *Analytics) GetTopAddresses(
    ctx context.Context,
    limit int,
) ([]AddressStats, error) {
    query := `
        SELECT
            address,
            COUNT(*) as tx_count,
            SUM(value) as total_value
        FROM (
            SELECT from_address as address, value FROM transactions
            UNION ALL
            SELECT to_address as address, value FROM transactions
        ) combined
        GROUP BY address
        ORDER BY tx_count DESC
        LIMIT $1
    `

    rows, err := a.db.QueryContext(ctx, query, limit)
    if err != nil {
        return nil, fmt.Errorf("failed to query top addresses: %w", err)
    }
    defer rows.Close()

    var results []AddressStats
    for rows.Next() {
        var stats AddressStats
        if err := rows.Scan(&stats.Address, &stats.TxCount, &stats.TotalValue); err != nil {
            return nil, err
        }
        results = append(results, stats)
    }

    return results, nil
}

// DailyStats represents daily statistics
type DailyStats struct {
    Date            time.Time
    Transactions    int64
    ActiveAddresses int64
    TotalGas        uint64
    AvgGasPrice     float64
}

// AddressStats represents address statistics
type AddressStats struct {
    Address    string
    TxCount    int64
    TotalValue string
}
```

### Junior → FAANG: Block Explorer Backend as a Full-Stack Indexing Exercise

Building a block explorer backend is the comprehensive exercise that combines every Web3 infrastructure skill: running a node, indexing events, building an API, and monitoring the whole thing. It is the infrastructure equivalent of the "build a blockchain from scratch" exercise for protocol-level knowledge: doing it forces you to confront the full complexity of the problem in a concrete way.

The components of a minimal block explorer backend: a block fetcher that downloads blocks and transactions from the Ethereum node and stores them in a database, a transaction indexer that extracts transaction metadata (from, to, value, gas used, status) and token transfer events (from ERC-20 Transfer events), an address indexer that tracks the first and last seen block for each address, and an API layer that serves queries for blocks, transactions, and address history. Each component is an independent concern that can be implemented and tested separately.

The database schema for a block explorer is the most design-intensive part. The key tables are: `blocks` (hash, number, timestamp, parent_hash, gas_used, miner), `transactions` (hash, block_hash, block_number, from, to, value, gas, gas_price, nonce, input, status), `token_transfers` (tx_hash, log_index, token_address, from, to, value), and `addresses` (address, first_seen_block, last_seen_block, tx_count). The indexes must support the query patterns: lookup by block number, by transaction hash, by address, and by token address.

Interview entry point: explain why a block explorer needs an archive node rather than a full (pruned) node. A full node only stores the current state and the last 128 blocks of state history. A block explorer needs to answer queries like "what was the ETH balance of address X at block 1,000,000?" which requires historical state access. Archive nodes store the complete state history at every block, enabling historical balance queries. The cost of an archive node (12+ TB of disk) is the price of this capability.

### Senior @ FAANG: Block Explorer Backend as Production Infrastructure Reference

At staff level, a block explorer backend is a reference implementation of the complete Web3 infrastructure stack. It demonstrates every pattern the team uses in production: node connectivity, event processing, reorg handling, efficient database design, API layer with appropriate caching, and monitoring. The design decisions made in the block explorer backend become the team's standard patterns for all subsequent infrastructure work.

Scale considerations for a block explorer at Etherscan-level traffic: the API layer must serve thousands of requests per second with sub-100ms response times, the indexer must process each new block within the block time (12 seconds on Ethereum mainnet, much less on some L2s), and the historical database must store years of transaction history efficiently. These requirements drive the use of database partitioning (historical data in cold storage, recent data in fast storage), read replicas (to separate API read traffic from indexer write traffic), and CDN caching (for static or slowly-changing data like block information).

The "uncle" and "ommer" block concept is a specific correctness requirement for Ethereum block explorer backends. In the pre-Merge PoW Ethereum, valid blocks that were not included in the canonical chain (because another block at the same height was chosen) were included as "ommers" in subsequent blocks and earned a reduced reward. Post-Merge, ommers no longer exist, but any block explorer that displays pre-Merge history must handle ommer blocks correctly. Staff engineers who maintain block explorers across the Merge boundary must ensure their historical data model correctly represents both eras.

Internal transaction tracing is a capability that distinguishes a basic block explorer from a full-featured one. External transactions are directly visible in blocks, but internal transactions (value transfers triggered by contract executions, such as a DEX router sending ETH to a user as part of a swap) are only visible through transaction tracing (`debug_traceTransaction`). Indexing internal transactions requires an archive node with the trace API enabled and significant additional storage. Staff engineers evaluate whether to implement internal transaction tracing based on the use cases it enables and the infrastructure cost it requires.

The block explorer as a reliability signal: Etherscan's data is often used as an external reference for verifying that your node's view of the chain is correct. If your block explorer's indexed data matches Etherscan's data for the same block and transaction, your infrastructure is likely correct. If it diverges, you have a bug or your node is on a fork. Staff engineers use Etherscan comparison as part of their integration testing and as a production health check, while also being aware that Etherscan itself is a centralized service that can have errors.

Bar-raiser signals: designing the reconciliation system that periodically compares a subset of your block explorer's indexed data against a second independent data source (Etherscan API, another indexed chain, or a direct archive node query) and alerts on discrepancies, or explaining how the block explorer backend should handle EIP-4844 blob transactions (which require fetching blob data from the consensus layer's beacon node REST API rather than from the execution client's JSON-RPC, since blobs are not part of the execution layer's block data). These details reveal comprehensive understanding of the current Ethereum protocol.

---
