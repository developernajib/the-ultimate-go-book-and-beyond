## 123.7 Transaction Monitoring

### Pending Transaction Tracker

The pending transaction tracker stores submitted transaction hashes in a map guarded by a mutex, then polls each one for a receipt until it is confirmed or a timeout elapses. Tracking pending transactions separately from submitted ones lets the monitor detect stuck transactions, those that remain unconfirmed beyond a configurable deadline, and trigger replacement with a higher gas price.

```go
// pkg/web3/txmonitor/pending.go
package txmonitor

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/ethclient"
)

// PendingTxTracker tracks pending transactions
type PendingTxTracker struct {
    client      *ethclient.Client
    pending     map[common.Hash]*PendingTx
    mu          sync.RWMutex
    subscribers []chan TxUpdate
}

// PendingTx represents a pending transaction
type PendingTx struct {
    Hash        common.Hash
    From        common.Address
    To          *common.Address
    Value       *big.Int
    GasPrice    *big.Int
    Nonce       uint64
    SubmittedAt time.Time
    Status      TxStatus
}

// TxStatus represents transaction status
type TxStatus int

const (
    TxStatusPending TxStatus = iota
    TxStatusMined
    TxStatusConfirmed
    TxStatusFailed
    TxStatusDropped
)

// TxUpdate represents a transaction status update
type TxUpdate struct {
    Hash          common.Hash
    Status        TxStatus
    BlockNumber   uint64
    Confirmations uint64
    Receipt       *types.Receipt
}

// NewPendingTxTracker creates a new pending transaction tracker
func NewPendingTxTracker(client *ethclient.Client) *PendingTxTracker {
    return &PendingTxTracker{
        client:      client,
        pending:     make(map[common.Hash]*PendingTx),
        subscribers: make([]chan TxUpdate, 0),
    }
}

// Track starts tracking a transaction
func (t *PendingTxTracker) Track(tx *types.Transaction) {
    t.mu.Lock()
    defer t.mu.Unlock()

    msg, _ := tx.AsMessage(types.LatestSignerForChainID(tx.ChainId()), nil)

    pendingTx := &PendingTx{
        Hash:        tx.Hash(),
        From:        msg.From(),
        To:          tx.To(),
        Value:       tx.Value(),
        GasPrice:    tx.GasPrice(),
        Nonce:       tx.Nonce(),
        SubmittedAt: time.Now(),
        Status:      TxStatusPending,
    }

    t.pending[tx.Hash()] = pendingTx
}

// Monitor monitors tracked transactions
func (t *PendingTxTracker) Monitor(ctx context.Context) {
    ticker := time.NewTicker(5 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            t.checkPendingTransactions(ctx)
        }
    }
}

// checkPendingTransactions checks status of all pending transactions
func (t *PendingTxTracker) checkPendingTransactions(ctx context.Context) {
    t.mu.RLock()
    pending := make([]*PendingTx, 0, len(t.pending))
    for _, tx := range t.pending {
        pending = append(pending, tx)
    }
    t.mu.RUnlock()

    for _, tx := range pending {
        t.checkTransaction(ctx, tx)
    }
}

// checkTransaction checks a single transaction
func (t *PendingTxTracker) checkTransaction(ctx context.Context, tx *PendingTx) {
    receipt, err := t.client.TransactionReceipt(ctx, tx.Hash)
    if err != nil {
        // Transaction still pending or dropped
        if time.Since(tx.SubmittedAt) > 10*time.Minute {
            t.updateStatus(tx.Hash, TxStatusDropped, 0, nil)
        }
        return
    }

    // Transaction mined
    latestBlock, err := t.client.BlockNumber(ctx)
    if err != nil {
        return
    }

    confirmations := latestBlock - receipt.BlockNumber.Uint64()

    if receipt.Status == types.ReceiptStatusSuccessful {
        if confirmations >= 12 {
            t.updateStatus(tx.Hash, TxStatusConfirmed, confirmations, receipt)
        } else {
            t.updateStatus(tx.Hash, TxStatusMined, confirmations, receipt)
        }
    } else {
        t.updateStatus(tx.Hash, TxStatusFailed, confirmations, receipt)
    }
}

// updateStatus updates transaction status
func (t *PendingTxTracker) updateStatus(
    hash common.Hash,
    status TxStatus,
    confirmations uint64,
    receipt *types.Receipt,
) {
    t.mu.Lock()
    tx, exists := t.pending[hash]
    if !exists {
        t.mu.Unlock()
        return
    }

    tx.Status = status

    // Remove from pending if confirmed or failed
    if status == TxStatusConfirmed || status == TxStatusFailed || status == TxStatusDropped {
        delete(t.pending, hash)
    }
    t.mu.Unlock()

    // Notify subscribers
    update := TxUpdate{
        Hash:          hash,
        Status:        status,
        Confirmations: confirmations,
        Receipt:       receipt,
    }
    if receipt != nil {
        update.BlockNumber = receipt.BlockNumber.Uint64()
    }

    t.notifySubscribers(update)
}

// Subscribe subscribes to transaction updates
func (t *PendingTxTracker) Subscribe() <-chan TxUpdate {
    t.mu.Lock()
    defer t.mu.Unlock()

    ch := make(chan TxUpdate, 100)
    t.subscribers = append(t.subscribers, ch)
    return ch
}

// notifySubscribers notifies all subscribers of an update
func (t *PendingTxTracker) notifySubscribers(update TxUpdate) {
    t.mu.RLock()
    defer t.mu.RUnlock()

    for _, ch := range t.subscribers {
        select {
        case ch <- update:
        default:
            // Channel full, skip
        }
    }
}

// GetStatus returns the current status of a transaction
func (t *PendingTxTracker) GetStatus(hash common.Hash) (TxStatus, bool) {
    t.mu.RLock()
    defer t.mu.RUnlock()

    tx, exists := t.pending[hash]
    if !exists {
        return TxStatusDropped, false
    }

    return tx.Status, true
}
```

### Transaction Retry Mechanism

The retry mechanism resubmits a stuck transaction with the same nonce but a bumped `maxFeePerGas`, which causes the mempool to replace the original, a technique called EIP-1559 replacement. The fee bump percentage must exceed 10% to satisfy the mempool's replacement threshold, otherwise the node rejects the replacement as insufficient.

```go
// pkg/web3/txmonitor/retry.go
package txmonitor

import (
    "context"
    "fmt"
    "math/big"
    "time"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/ethclient"
)

// TxRetryConfig represents retry configuration
type TxRetryConfig struct {
    MaxRetries        int
    InitialGasPrice   *big.Int
    GasPriceMultiplier float64
    RetryInterval     time.Duration
    Timeout           time.Duration
}

// TxRetryer handles transaction retries with gas price bumping
type TxRetryer struct {
    client *ethclient.Client
    config TxRetryConfig
}

// NewTxRetryer creates a new transaction retryer
func NewTxRetryer(client *ethclient.Client, config TxRetryConfig) *TxRetryer {
    return &TxRetryer{
        client: client,
        config: config,
    }
}

// SendWithRetry sends a transaction with retry logic
func (r *TxRetryer) SendWithRetry(
    ctx context.Context,
    tx *types.Transaction,
) (*types.Receipt, error) {
    ctx, cancel := context.WithTimeout(ctx, r.config.Timeout)
    defer cancel()

    var lastErr error
    gasPrice := r.config.InitialGasPrice

    for attempt := 0; attempt <= r.config.MaxRetries; attempt++ {
        if attempt > 0 {
            // Bump gas price
            multiplier := big.NewFloat(r.config.GasPriceMultiplier)
            gasPriceFloat := new(big.Float).SetInt(gasPrice)
            newGasPrice := new(big.Float).Mul(gasPriceFloat, multiplier)
            gasPrice, _ = newGasPrice.Int(nil)

            // Recreate transaction with new gas price
            tx = types.NewTx(&types.LegacyTx{
                Nonce:    tx.Nonce(),
                To:       tx.To(),
                Value:    tx.Value(),
                Gas:      tx.Gas(),
                GasPrice: gasPrice,
                Data:     tx.Data(),
            })

            time.Sleep(r.config.RetryInterval)
        }

        // Send transaction
        if err := r.client.SendTransaction(ctx, tx); err != nil {
            lastErr = err
            fmt.Printf("Attempt %d failed: %v\n", attempt+1, err)
            continue
        }

        // Wait for receipt
        receipt, err := r.waitForReceipt(ctx, tx.Hash())
        if err != nil {
            lastErr = err
            continue
        }

        return receipt, nil
    }

    return nil, fmt.Errorf("max retries exceeded: %w", lastErr)
}

// waitForReceipt waits for a transaction receipt
func (r *TxRetryer) waitForReceipt(
    ctx context.Context,
    txHash common.Hash,
) (*types.Receipt, error) {
    ticker := time.NewTicker(2 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return nil, ctx.Err()
        case <-ticker.C:
            receipt, err := r.client.TransactionReceipt(ctx, txHash)
            if err == nil {
                return receipt, nil
            }
        }
    }
}
```

### Junior → FAANG: Transaction Monitoring as Operational Awareness

Transaction monitoring is how your application stays aware of on-chain state changes relevant to its operation. Without monitoring, your application is operating blind: it does not know when transactions confirm, when they fail, or when unexpected on-chain activity affects its positions or balances.

The baseline transaction monitoring implementation for a Go application: after submitting a transaction, store the transaction hash and expected state in a database, run a background goroutine that polls `eth_getTransactionReceipt` for each pending transaction at intervals, and update the stored state when the receipt indicates success or failure. Add a timeout to detect transactions that remain pending beyond a reasonable window (typically 30 minutes for normal gas prices on Ethereum mainnet).

The pending transaction monitoring loop must handle three cases explicitly: receipt not yet available (transaction is in the mempool or not yet included), receipt available with success status (transaction was included and succeeded), and receipt available with failure status (transaction was included but reverted). A fourth case is when the transaction disappears from the mempool without a receipt (possible if the mempool drops the transaction due to low gas price or if the nonce is used by a replacement transaction). Handling all four cases correctly is the completeness requirement for transaction monitoring.

Interview entry point: explain how a transaction monitoring system detects that a confirmed transaction has been reorged out and must be re-submitted. The monitoring system must compare the block hash of the block that contained the confirmed transaction against the current canonical chain. If `eth_getBlockByNumber(confirmedBlockNumber, false).hash` does not match the stored block hash, the transaction's block was reorged and the transaction's finality must be re-evaluated.

### Senior @ FAANG: Transaction Monitoring as a Production Reliability System

At staff level, transaction monitoring is a reliability system that must itself be highly available. If the monitoring system goes down, the application loses awareness of transaction outcomes, which can lead to missed confirmations, incorrect state, and financial exposure. The monitoring system must be designed with the same reliability standards as the primary application.

A production transaction monitoring system has several components beyond the basic poll-and-update loop. A stuck transaction detector identifies transactions that have been pending for longer than the SLA-defined maximum and triggers automated fee bumping or cancellation. A reorg detector checks confirmed transaction blocks against the canonical chain and triggers re-processing for any confirmed transaction found to be on a fork. A receipt verification service cross-checks receipts against a second RPC provider to detect data inconsistencies (useful for detecting client-specific bugs).

MEV monitoring is a specialized form of transaction monitoring that detects when your submitted transactions are being front-run or sandwiched. By comparing the expected output of your transaction (computed before submission based on current state) against the actual output (from the confirmed receipt), you can detect systematic MEV extraction. A persistent large discrepancy between expected and actual outputs may indicate that your transaction submission pattern is being targeted by MEV bots, which should trigger a review of your submission strategy.

Transaction monitoring at scale requires efficient database querying. A system with millions of monitored transactions must efficiently query for pending transactions (those without a confirmed receipt), transactions that have been pending too long (for stuck detection), and confirmed transactions that have not yet reached the finalization threshold. Each of these queries benefits from specific database indexes. Staff engineers design the database schema for transaction monitoring with these query patterns in mind, not just the storage requirements.

Gas spend monitoring is a financial control embedded in the transaction monitoring system. For each confirmed transaction, the monitoring system records the actual gas used, the gas price, and the resulting ETH cost. Aggregated over time, this provides: total gas spend by transaction type, average gas cost per operation, and trend analysis for detecting changes in gas usage (which may indicate contract state changes that affect gas consumption). Staff engineers design gas spend reports that feed into the organization's cost management system.

Bar-raiser signals: designing a transaction monitoring system that correctly handles the Ethereum block finality model (a transaction should transition from "confirmed" to "finalized" only after the block containing it has been confirmed by Casper FFG as a finalized checkpoint, which can take 12-15 minutes from block inclusion), including alert thresholds that distinguish between "confirmed but not finalized" (safe for most business purposes) and "finalized" (safe for irreversible business actions like releasing withdrawal limits), or explaining how the monitoring system should handle a transaction that was replaced by a replacement transaction with the same nonce (the original transaction hash will never appear in a receipt, the monitoring system must detect this case and update the pending state to use the replacement transaction hash).

---
