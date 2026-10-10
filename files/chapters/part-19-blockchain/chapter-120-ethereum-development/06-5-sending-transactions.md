## 120.5 Sending Transactions

### 5.1 Sending ETH

ETH transfers require fetching the account's current nonce before signing so the transaction replaces the correct sequence position in the sender's transaction queue and cannot be replayed with an old nonce. The transaction is signed locally with `types.SignTx` before submission so the private key never leaves the application process, the node only receives the serialized signed transaction.

```go
// pkg/eth/send.go
package eth

import (
    "context"
    "crypto/ecdsa"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/crypto"
    "github.com/ethereum/go-ethereum/ethclient"
)

// SendETH sends ETH from one account to another
func SendETH(
    client *ethclient.Client,
    privateKey *ecdsa.PrivateKey,
    to common.Address,
    amount *big.Int,
) (common.Hash, error) {
    ctx := context.Background()

    // Get sender address
    publicKey := privateKey.Public()
    publicKeyECDSA, ok := publicKey.(*ecdsa.PublicKey)
    if !ok {
        return common.Hash{}, fmt.Errorf("failed to cast public key")
    }
    from := crypto.PubkeyToAddress(*publicKeyECDSA)

    // Get nonce (transaction count for sender)
    nonce, err := client.PendingNonceAt(ctx, from)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to get nonce: %w", err)
    }

    // Get gas price
    gasPrice, err := client.SuggestGasPrice(ctx)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to get gas price: %w", err)
    }

    // Get chain ID
    chainID, err := client.ChainID(ctx)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to get chain ID: %w", err)
    }

    // Create transaction (types.NewTransaction is deprecated - use types.NewTx)
    tx := types.NewTx(&types.LegacyTx{
        Nonce:    nonce,
        To:       &to,
        Value:    amount,
        Gas:      21000, // Standard gas limit for ETH transfer
        GasPrice: gasPrice,
        Data:     nil, // No data for simple ETH transfer
    })

    // Sign transaction
    signedTx, err := types.SignTx(tx, types.NewEIP155Signer(chainID), privateKey)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to sign transaction: %w", err)
    }

    // Send transaction
    err = client.SendTransaction(ctx, signedTx)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to send transaction: %w", err)
    }

    return signedTx.Hash(), nil
}
```

### 5.2 EIP-1559 Transactions (Dynamic Fees)

Post-London fork, Ethereum uses EIP-1559 fee market with base fee and priority fee:

```go
// SendETHWithEIP1559 sends ETH using EIP-1559 dynamic fee transaction
func SendETHWithEIP1559(
    client *ethclient.Client,
    privateKey *ecdsa.PrivateKey,
    to common.Address,
    amount *big.Int,
) (common.Hash, error) {
    ctx := context.Background()

    publicKey := privateKey.Public()
    publicKeyECDSA, ok := publicKey.(*ecdsa.PublicKey)
    if !ok {
        return common.Hash{}, fmt.Errorf("failed to cast public key")
    }
    from := crypto.PubkeyToAddress(*publicKeyECDSA)

    nonce, err := client.PendingNonceAt(ctx, from)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to get nonce: %w", err)
    }

    chainID, err := client.ChainID(ctx)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to get chain ID: %w", err)
    }

    // Get suggested gas tip cap (priority fee)
    gasTipCap, err := client.SuggestGasTipCap(ctx)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to get gas tip cap: %w", err)
    }

    // Get latest block to determine base fee
    block, err := client.BlockByNumber(ctx, nil)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to get latest block: %w", err)
    }

    // Calculate max fee per gas
    // MaxFeePerGas = (2 * BaseFee) + MaxPriorityFeePerGas
    baseFee := block.BaseFee()
    gasFeeCap := new(big.Int).Add(
        gasTipCap,
        new(big.Int).Mul(baseFee, big.NewInt(2)),
    )

    // Create EIP-1559 transaction
    tx := types.NewTx(&types.DynamicFeeTx{
        ChainID:   chainID,
        Nonce:     nonce,
        GasTipCap: gasTipCap,  // MaxPriorityFeePerGas
        GasFeeCap: gasFeeCap,  // MaxFeePerGas
        Gas:       21000,
        To:        &to,
        Value:     amount,
        Data:      nil,
    })

    // Sign transaction
    signedTx, err := types.SignTx(tx, types.LatestSignerForChainID(chainID), privateKey)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to sign transaction: %w", err)
    }

    // Send transaction
    err = client.SendTransaction(ctx, signedTx)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to send transaction: %w", err)
    }

    return signedTx.Hash(), nil
}
```

### 5.3 Waiting for Transaction Confirmation

`WaitForTransaction` polls `TransactionReceipt` every two seconds until the receipt is available, signaling that the transaction has been mined into a block. The `receipt.Status` field is either 1 (success) or 0 (revert), distinct from the network error path, so callers can differentiate a reverted smart contract call from a connectivity failure.

```go
// WaitForTransaction waits for a transaction to be mined
func WaitForTransaction(client *ethclient.Client, txHash common.Hash) (*types.Receipt, error) {
    ctx := context.Background()

    fmt.Printf("Waiting for transaction %s to be mined...\n", txHash.Hex())

    for {
        receipt, err := client.TransactionReceipt(ctx, txHash)
        if err == nil {
            // Transaction mined
            if receipt.Status == 1 {
                fmt.Println("Transaction successful!")
            } else {
                fmt.Println("Transaction failed!")
            }
            return receipt, nil
        }

        // Wait before checking again
        time.Sleep(2 * time.Second)
    }
}

// WaitForConfirmations waits for N block confirmations
func WaitForConfirmations(client *ethclient.Client, txHash common.Hash, confirmations uint64) error {
    ctx := context.Background()

    // Wait for transaction to be mined
    receipt, err := WaitForTransaction(client, txHash)
    if err != nil {
        return err
    }

    if receipt.Status != 1 {
        return fmt.Errorf("transaction failed")
    }

    txBlockNumber := receipt.BlockNumber.Uint64()
    fmt.Printf("Transaction mined in block %d, waiting for %d confirmations...\n",
        txBlockNumber, confirmations)

    for {
        currentBlock, err := client.BlockNumber(ctx)
        if err != nil {
            return fmt.Errorf("failed to get current block: %w", err)
        }

        confirmedBlocks := currentBlock - txBlockNumber
        if confirmedBlocks >= confirmations {
            fmt.Printf("Transaction confirmed with %d confirmations\n", confirmedBlocks)
            return nil
        }

        fmt.Printf("Confirmations: %d/%d\n", confirmedBlocks, confirmations)
        time.Sleep(2 * time.Second)
    }
}
```

### 5.4 Gas Estimation

`EstimateGas` simulates the transaction against the current chain state and returns the exact gas units the EVM would consume, which callers should multiply by a safety buffer (typically 1.2×) to absorb state changes between estimation and mining. For EIP-1559 transactions, `maxFeePerGas` must be at least `baseFee + maxPriorityFeePerGas`, and setting it too low causes the transaction to be dropped when the base fee spikes.

```go
// EstimateGas estimates gas for a transaction
func EstimateGas(client *ethclient.Client, from, to common.Address, value *big.Int, data []byte) (uint64, error) {
    ctx := context.Background()

    msg := ethereum.CallMsg{
        From:  from,
        To:    &to,
        Value: value,
        Data:  data,
    }

    gasLimit, err := client.EstimateGas(ctx, msg)
    if err != nil {
        return 0, fmt.Errorf("failed to estimate gas: %w", err)
    }

    // Add 10% buffer for safety
    gasLimit = uint64(float64(gasLimit) * 1.1)

    return gasLimit, nil
}

// CalculateTransactionCost calculates total transaction cost
func CalculateTransactionCost(gasLimit uint64, gasPrice *big.Int) *big.Int {
    gasCost := new(big.Int).Mul(big.NewInt(int64(gasLimit)), gasPrice)
    return gasCost
}

// Example: Send ETH with gas estimation
func ExampleSendWithEstimation() {
    client, _ := ethclient.Dial("https://eth-sepolia.g.alchemy.com/v2/YOUR-API-KEY")
    defer client.Close()

    privateKey, _ := crypto.HexToECDSA("your-private-key")
    publicKey := privateKey.Public().(*ecdsa.PublicKey)
    from := crypto.PubkeyToAddress(*publicKey)

    to := common.HexToAddress("0x...")
    amount := big.NewInt(1000000000000000000) // 1 ETH

    // Estimate gas
    gasLimit, err := EstimateGas(client, from, to, amount, nil)
    if err != nil {
        panic(err)
    }

    // Get gas price
    gasPrice, err := client.SuggestGasPrice(context.Background())
    if err != nil {
        panic(err)
    }

    // Calculate total cost
    gasCost := CalculateTransactionCost(gasLimit, gasPrice)
    totalCost := new(big.Int).Add(amount, gasCost)

    fmt.Printf("Amount:    %s ETH\n", WeiToEther(amount))
    fmt.Printf("Gas Cost:  %s ETH\n", WeiToEther(gasCost))
    fmt.Printf("Total:     %s ETH\n", WeiToEther(totalCost))

    // Send transaction
    txHash, err := SendETH(client, privateKey, to, amount)
    if err != nil {
        panic(err)
    }

    fmt.Printf("Transaction sent: %s\n", txHash.Hex())
}
```

---

### Junior → FAANG: Sending Transactions with Confidence

Sending transactions is the most anxiety-inducing operation in Ethereum development because mistakes are irreversible: you cannot cancel a confirmed transaction, you cannot recover funds sent to the wrong address, and you cannot undo a contract call that transferred tokens. This irreversibility makes transaction sending the most important area to have tested, reviewed, and correct before any code touches mainnet.

The prerequisite checklist for sending a transaction in Go: understand the chain ID (use `ethclient.NetworkID` to fetch it dynamically and construct the correct signer), understand the EIP-1559 fee parameters (`maxFeePerGas` and `maxPriorityFeePerGas`), understand the nonce requirement (fetch the current nonce with `ethclient.PendingNonceAt` for the first transaction from a new account, but maintain a server-side nonce counter for subsequent transactions), and understand the difference between gas limit (maximum gas you authorize) and gas price (the price per unit of gas).

A worked first-job exercise: write a function that sends ETH from one test account to another on a local Geth devmode node, handles all error cases from `eth_sendRawTransaction` (nonce too low, insufficient funds, replacement transaction underpriced), and then polls `eth_getTransactionReceipt` with exponential backoff until the transaction is confirmed or a timeout expires. This exercise covers the complete sending lifecycle and forces you to handle the cases that tutorials skip.

Interview entry point: walk through what happens when two threads call `eth_getTransactionCount` to get the current nonce and both get back the same value. They both construct transactions with the same nonce and broadcast them. The Ethereum mempool accepts the first and rejects the second (or replaces it if the second has a higher gas price). One transaction is silently lost. The fix is server-side nonce management. This scenario is a common interview question precisely because it catches engineers who have never managed concurrent transaction submission.

### Senior @ FAANG: Production Transaction Sending Infrastructure

At staff level, transaction sending infrastructure is a state machine that must handle every edge case correctly, because every incorrect state transition has a financial consequence. The state machine for a single transaction is: constructed, signed, submitted, pending, confirmed (or failed), finalized. The failure modes include: submission failure (network error, nonce conflict, insufficient gas), stuck pending (gas price too low during network congestion), failed on-chain (contract revert, out of gas), and orphaned (included in a block that was later reorged).

The transaction management service at production scale must handle all failure modes with defined recovery actions: automatic fee bumping for stuck transactions (using `eth_replaceTransaction` by submitting a new transaction with the same nonce and higher gas price), automatic nonce gap filling (if a transaction with nonce N fails and leaves a gap, a cancellation transaction with nonce N must be submitted before transactions with nonce N+1 and above can be included), and automatic resubmission after RPC provider failures.

EIP-1559 fee estimation is not a solved problem: the correct `maxFeePerGas` and `maxPriorityFeePerGas` values depend on current network conditions, which change every 12 seconds. Setting them too low results in transactions stuck in the mempool. Setting them too high wastes ETH. Production systems use a combination of: the `eth_feeHistory` API (which returns historical base fees and priority fees for the last N blocks) to estimate current conditions, a multiplier applied to the estimated base fee to provide headroom for the next several blocks, and monitoring of transaction inclusion time to tune the multiplier dynamically.

MEV protection for large transactions is a staff-level concern. A large token swap or liquidation submitted to the public mempool will be observed by MEV bots before it is included in a block. These bots can front-run the transaction (submit a similar transaction with higher gas to be included first), sandwich it (front-run and back-run to capture the price impact), or backrun it (capture arbitrage opportunities created by the transaction). Private mempool submission through Flashbots Protect or MEV Blocker prevents public visibility before inclusion, at the cost of potentially slower inclusion during periods of low block builder adoption.

Batch transaction management at scale (for example, processing 10,000 user withdrawals daily) requires a pipeline that can prioritize transactions, handle partial failures, and reconcile the batch state after each block. Staff engineers design this pipeline with: a priority queue that orders transactions by business priority (not just submission order), a checkpoint mechanism that records which transactions have been confirmed after each block, and a reconciliation job that runs daily to verify that the batch database state matches the on-chain state for every transaction in the batch.

Bar-raiser signals: designing a transaction cancellation system that can cancel a pending transaction even if the network is congested (requires submitting a zero-value transaction with the same nonce at a significantly higher gas price, then monitoring until either the original or the cancellation is included), or explaining the `eth_maxPriorityFeePerGas` method's semantics and when it may return inaccurate values (during network transitions or when the RPC provider has a stale fee estimate). These topics require depth beyond what tutorials cover.

At the L7 level, transaction sending infrastructure intersects with financial operations and audit requirements. Every transaction that moves value must be associated with a business reason, an authorization record, a signer identity, and a confirmation receipt. This audit trail must be maintained in a durable, tamper-evident store that satisfies the organization's record-keeping requirements. Designing this audit infrastructure as a first-class component of the transaction sending system, not an afterthought, is a distinguishing characteristic of staff-level work in this domain.

---
