## Blockchain/Web3 Pitfalls

Developing Go services that interface with decentralized networks, EVM blockchains (via `go-ethereum`), and smart contracts presents unique concurrency, latency, and reliability risks. Unlike traditional ACID databases, blockchain state is asynchronous, transactions can be dropped or front-run in public mempools, and reorgs can invalidate transactions that previously appeared successful.

---

### 1. Concurrent Nonce Collision in High-Throughput Relayers

#### Root Cause Mechanics
On Ethereum and EVM-compatible chains, every transaction from a given account must include a monotonically increasing integer called a **nonce**. Transactions must be mined strictly in nonce order.
If multiple concurrent goroutines query the node's pending nonce via RPC (`PendingNonceAt`) simultaneously, they will receive the exact same nonce number. Both broadcast transactions with identical nonces; the network accepts only one, while the second fails with `replacement transaction underpriced` or remains dropped.

#### Production-Grade Solution
```go
package relayer

import (
    "context"
    "sync"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
)

// Thread-safe in-memory NonceManager
type NonceManager struct {
    mu          sync.Mutex
    client      *ethclient.Client
    account     common.Address
    currentNonce uint64
    initialized bool
}

func NewNonceManager(client *ethclient.Client, account common.Address) *NonceManager {
    return &NonceManager{
        client:  client,
        account: account,
    }
}

// NextNonce atomically reserves the next available nonce
func (m *NonceManager) NextNonce(ctx context.Context) (uint64, error) {
    m.mu.Lock()
    defer m.mu.Unlock()

    if !m.initialized {
        nonce, err := m.client.PendingNonceAt(ctx, m.account)
        if err != nil {
            return 0, err
        }
        m.currentNonce = nonce
        m.initialized = true
    }

    reserved := m.currentNonce
    m.currentNonce++ // Increment atomically for subsequent caller
    return reserved, nil
}
```

---

### 2. Premature Finality & Chain Reorganizations (Reorgs)

#### Root Cause Mechanics
EVM blockchains operate under probabilistic finality. Under network latency or consensus disputes, miners/validators produce competing blocks, resulting in **chain reorganizations** (reorgs). A transaction mined in block 100 may disappear if block 100 is orphaned in favor of a heavier fork.
If an application marks an order as "paid" or credits a customer balance after only 1 block confirmation, a 2-block reorg can reverse the payment while the goods have already been delivered (double-spend vulnerability).

#### Production-Grade Solution
```go
package tracker

import (
    "context"
    "fmt"
    "time"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
)

// WaitForConfirmations polls until a transaction has achieved requisite confirmation depth
func WaitForConfirmations(ctx context.Context, client *ethclient.Client, txHash common.Hash, requiredConfirmations uint64) error {
    ticker := time.NewTicker(3 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            receipt, err := client.TransactionReceipt(ctx, txHash)
            if err != nil {
                continue // Still pending in mempool
            }

            if receipt.Status == 0 {
                return fmt.Errorf("transaction reverted on-chain")
            }

            latestHeader, err := client.HeaderByNumber(ctx, nil)
            if err != nil {
                continue
            }

            if latestHeader.Number.Uint64() >= receipt.BlockNumber.Uint64()+requiredConfirmations {
                // Safely confirmed beyond deep reorg threshold
                return nil
            }
        }
    }
}
```

---

### 3. Dynamic EIP-1559 Gas Volatility & Stuck Transactions

#### Root Cause Mechanics
Under EIP-1559, transactions specify `MaxFeePerGas` and `MaxPriorityFeePerGas`. During sudden network congestion (NFT mints, market volatility), the base fee surges. If your Go service signed a transaction with the base fee from 30 seconds ago, miners ignore it.
Without an automated "gas bump" replacement routine, the transaction sits in the mempool indefinitely, blocking all subsequent transactions from that account due to nonce sequencing.

#### Production-Grade Solution
Enforce an automated replacement policy: if a transaction is not mined within 60 seconds, broadcast a replacement transaction with the **identical nonce** but with `MaxFeePerGas` bumped by at least 15% (the minimum threshold required by EVM nodes to replace an existing pending transaction).

---
