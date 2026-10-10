## 119.12 Production Pitfalls: Blockchain Integration Failures

### Pitfall 1: Trusting a Single RPC Endpoint

**Real Incident Report**: A DeFi protocol used a single Infura endpoint. When Infura had an outage, the protocol couldn't process withdrawals for 4 hours. Users panicked, token price dropped 30%.

**The Anti-Pattern**:
```go
// WRONG: Single point of failure
func NewClient() *ethclient.Client {
    client, _ := ethclient.Dial("https://mainnet.infura.io/v3/YOUR_KEY")
    return client
}
```

**The Better Approach**:
```go
// RIGHT: Multiple providers with failover
type ResilientClient struct {
    clients        []*ethclient.Client
    healthChecks   []bool
    currentIdx     int
    mu             sync.RWMutex
}

func NewResilientClient(endpoints []string) (*ResilientClient, error) {
    clients := make([]*ethclient.Client, len(endpoints))
    for i, endpoint := range endpoints {
        client, err := ethclient.Dial(endpoint)
        if err != nil {
            continue // Try next endpoint
        }
        clients[i] = client
    }

    rc := &ResilientClient{
        clients:      clients,
        healthChecks: make([]bool, len(clients)),
    }

    go rc.monitorHealth()
    return rc, nil
}

func (c *ResilientClient) Call(ctx context.Context, fn func(*ethclient.Client) error) error {
    c.mu.RLock()
    startIdx := c.currentIdx
    c.mu.RUnlock()

    for i := 0; i < len(c.clients); i++ {
        idx := (startIdx + i) % len(c.clients)
        client := c.clients[idx]

        if client == nil || !c.healthChecks[idx] {
            continue
        }

        err := fn(client)
        if err == nil {
            return nil
        }

        // Mark as unhealthy and try next
        c.healthChecks[idx] = false
    }

    return errors.New("all endpoints failed")
}
```

**Key Insight**: Always use multiple RPC providers with health monitoring and automatic failover.

---

### Pitfall 2: Not Handling Chain Reorgs

**Real Incident Report**: An exchange credited deposits after 1 confirmation. A 2-block reorg orphaned the deposit transaction. The user had already withdrawn, causing a $50K loss.

**The Anti-Pattern**:
```go
// WRONG: Trusting 1 confirmation
func HandleDeposit(txHash string) error {
    receipt, _ := client.TransactionReceipt(ctx, txHash)
    if receipt.Status == 1 {
        creditUser(receipt) // Immediately credited!
    }
    return nil
}
```

**The Better Approach**:
```go
// RIGHT: Wait for sufficient confirmations
const RequiredConfirmations = 12 // ~3 minutes on Ethereum

type DepositTracker struct {
    pendingDeposits map[string]*PendingDeposit
    client          *ethclient.Client
}

func (t *DepositTracker) TrackDeposit(txHash common.Hash) {
    t.pendingDeposits[txHash.Hex()] = &PendingDeposit{
        TxHash:    txHash,
        FirstSeen: time.Now(),
        BlockSeen: 0,
    }
}

func (t *DepositTracker) ProcessConfirmations(ctx context.Context) {
    currentBlock, _ := t.client.BlockNumber(ctx)

    for hash, deposit := range t.pendingDeposits {
        receipt, err := t.client.TransactionReceipt(ctx, deposit.TxHash)
        if err != nil {
            continue
        }

        // Check if still in chain
        block, err := t.client.BlockByNumber(ctx, receipt.BlockNumber)
        if err != nil || block == nil {
            // Transaction might have been reorged
            delete(t.pendingDeposits, hash)
            continue
        }

        confirmations := currentBlock - receipt.BlockNumber.Uint64()

        if confirmations >= RequiredConfirmations {
            // Safe to credit
            t.creditDeposit(deposit)
            delete(t.pendingDeposits, hash)
        }
    }
}
```

**Key Insight**: Wait for 12+ confirmations before considering transactions final. Re-verify that transactions still exist in the canonical chain.

---

### Pitfall 3: Gas Price Stuck Transactions

**Real Incident Report**: A bot submitted transactions with yesterday's gas price during a congestion spike. Transactions sat in mempool for 6 hours. By then, the arbitrage opportunity was long gone.

**The Anti-Pattern**:
```go
// WRONG: Static gas price
func SendTransaction(to common.Address, value *big.Int) error {
    gasPrice := big.NewInt(20_000_000_000) // 20 gwei - might be too low!
    tx := types.NewTransaction(nonce, to, value, 21000, gasPrice, nil)
    return client.SendTransaction(ctx, tx)
}
```

**The Better Approach**:
```go
// RIGHT: Dynamic gas pricing with EIP-1559
type GasPricer struct {
    client      *ethclient.Client
    maxPriority *big.Int // Max priority fee willing to pay
    maxFee      *big.Int // Absolute max fee
}

func (p *GasPricer) SuggestGas(ctx context.Context, urgency string) (*GasSuggestion, error) {
    // Get base fee from latest block
    block, err := p.client.BlockByNumber(ctx, nil)
    if err != nil {
        return nil, err
    }
    baseFee := block.BaseFee()

    // Get priority fee suggestions
    tip, err := p.client.SuggestGasTipCap(ctx)
    if err != nil {
        return nil, err
    }

    // Adjust based on urgency
    var multiplier int64
    switch urgency {
    case "urgent":
        multiplier = 150 // 50% above suggested
    case "normal":
        multiplier = 100
    case "slow":
        multiplier = 80
    }

    adjustedTip := new(big.Int).Mul(tip, big.NewInt(multiplier))
    adjustedTip.Div(adjustedTip, big.NewInt(100))

    // Calculate max fee (2x base + tip for headroom)
    maxFee := new(big.Int).Mul(baseFee, big.NewInt(2))
    maxFee.Add(maxFee, adjustedTip)

    return &GasSuggestion{
        MaxPriorityFee: adjustedTip,
        MaxFee:         maxFee,
        EstimatedFee:   new(big.Int).Add(baseFee, adjustedTip),
    }, nil
}

// Cancel or speed up stuck transaction
func (p *GasPricer) SpeedUpTransaction(ctx context.Context, tx *types.Transaction, privateKey *ecdsa.PrivateKey) error {
    // Send same nonce with higher gas
    suggestion, _ := p.SuggestGas(ctx, "urgent")

    newTx := types.NewTx(&types.DynamicFeeTx{
        Nonce:     tx.Nonce(),
        To:        tx.To(),
        Value:     tx.Value(),
        Gas:       tx.Gas(),
        GasTipCap: suggestion.MaxPriorityFee,
        GasFeeCap: suggestion.MaxFee,
        Data:      tx.Data(),
    })

    signedTx, _ := types.SignTx(newTx, types.LatestSignerForChainID(tx.ChainId()), privateKey)
    return p.client.SendTransaction(ctx, signedTx)
}
```

**Key Insight**: Use EIP-1559 dynamic gas pricing. Monitor pending transactions and speed up or cancel if they get stuck.

---

### Pitfall 4: Nonce Management Chaos

**Real Incident Report**: A high-frequency trading bot submitted 100 transactions rapidly. Without proper nonce management, 80 failed with "nonce too low" errors while 15 others got stuck due to gaps.

**The Anti-Pattern**:
```go
// WRONG: Getting nonce for each transaction
func SendTransaction(tx *types.Transaction) error {
    nonce, _ := client.PendingNonceAt(ctx, fromAddress)
    tx = tx.WithNonce(nonce) // Race condition!
    return client.SendTransaction(ctx, tx)
}
```

**The Better Approach**:
```go
// RIGHT: Local nonce management
type NonceManager struct {
    client    *ethclient.Client
    address   common.Address
    mu        sync.Mutex
    current   uint64
    pending   map[uint64]*PendingTx
    synced    bool
}

func NewNonceManager(client *ethclient.Client, addr common.Address) *NonceManager {
    nm := &NonceManager{
        client:  client,
        address: addr,
        pending: make(map[uint64]*PendingTx),
    }
    nm.sync(context.Background())
    return nm
}

func (nm *NonceManager) sync(ctx context.Context) error {
    nm.mu.Lock()
    defer nm.mu.Unlock()

    onChainNonce, err := nm.client.NonceAt(ctx, nm.address, nil)
    if err != nil {
        return err
    }

    pendingNonce, err := nm.client.PendingNonceAt(ctx, nm.address)
    if err != nil {
        return err
    }

    nm.current = pendingNonce
    nm.synced = true

    // Clear confirmed transactions
    for nonce := range nm.pending {
        if nonce < onChainNonce {
            delete(nm.pending, nonce)
        }
    }

    return nil
}

func (nm *NonceManager) GetNonce() uint64 {
    nm.mu.Lock()
    defer nm.mu.Unlock()

    nonce := nm.current
    nm.current++
    return nonce
}

func (nm *NonceManager) TrackTransaction(nonce uint64, txHash common.Hash) {
    nm.mu.Lock()
    defer nm.mu.Unlock()

    nm.pending[nonce] = &PendingTx{
        Nonce:  nonce,
        Hash:   txHash,
        SentAt: time.Now(),
    }
}

func (nm *NonceManager) HandleFailure(nonce uint64) {
    nm.mu.Lock()
    defer nm.mu.Unlock()

    // Don't reuse nonce if already used on chain
    // Sync to get accurate state
    nm.synced = false
}
```

**Key Insight**: Track nonces locally, handle failures gracefully, and periodically sync with chain state to recover from inconsistencies.

---

### Pitfall 5: Not Verifying Contract Addresses

**Real Incident Report**: A protocol integrated with what they thought was USDC. The address was actually a phishing token with the same name/symbol. Users deposited $2M into the fake token contract.

**The Anti-Pattern**:
```go
// WRONG: Trusting user-provided token addresses
func HandleDeposit(tokenAddress string, amount *big.Int) error {
    token, _ := NewERC20(common.HexToAddress(tokenAddress), client)
    token.TransferFrom(userAddr, vaultAddr, amount)
    return nil
}
```

**The Better Approach**:
```go
// RIGHT: Allowlist verified contract addresses
type TokenRegistry struct {
    verified map[common.Address]*VerifiedToken
}

type VerifiedToken struct {
    Address   common.Address
    Symbol    string
    Decimals  uint8
    ChainID   int64
    Source    string // "coingecko", "etherscan_verified", etc.
}

func NewTokenRegistry() *TokenRegistry {
    return &TokenRegistry{
        verified: map[common.Address]*VerifiedToken{
            common.HexToAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"): {
                Symbol:   "USDC",
                Decimals: 6,
                ChainID:  1,
                Source:   "hardcoded",
            },
            // Add other verified tokens...
        },
    }
}

func (r *TokenRegistry) GetToken(addr common.Address) (*VerifiedToken, error) {
    token, ok := r.verified[addr]
    if !ok {
        return nil, fmt.Errorf("token not verified: %s", addr.Hex())
    }
    return token, nil
}

func HandleDeposit(tokenAddress common.Address, amount *big.Int) error {
    // Verify token is in registry
    token, err := tokenRegistry.GetToken(tokenAddress)
    if err != nil {
        return fmt.Errorf("unverified token: %w", err)
    }

    // Verify on-chain properties match
    contract, _ := NewERC20(tokenAddress, client)

    onChainSymbol, _ := contract.Symbol(nil)
    onChainDecimals, _ := contract.Decimals(nil)

    if onChainSymbol != token.Symbol || onChainDecimals != token.Decimals {
        return fmt.Errorf("token metadata mismatch - possible phishing")
    }

    return processDeposit(tokenAddress, amount)
}
```

**Key Insight**: Never trust user-provided contract addresses. Maintain an allowlist of verified contracts and validate on-chain properties match expected values.

---

### Blockchain Pitfall Quick Reference

| Pitfall | Consequence | Fix |
|---------|-------------|-----|
| Single RPC endpoint | Outage = downtime | Multiple providers with failover |
| Trusting 1 confirmation | Loss from reorgs | Wait 12+ confirmations |
| Static gas prices | Stuck transactions | EIP-1559 dynamic pricing |
| Race condition nonces | Failed transactions | Local nonce management |
| Unverified contracts | Phishing attacks | Allowlist + on-chain validation |

---

### Junior → FAANG: Recognizing and Avoiding the Classic Integration Pitfalls

Production pitfalls in blockchain integration follow predictable patterns, and a junior who studies them before their first job can avoid months of painful debugging. The most common first-year pitfall is insufficient confirmation depth: treating a transaction as final after one block when the business logic requires irreversibility. On Ethereum, one block provides weak assurance. Six blocks provides strong assurance. Waiting for a finalized checkpoint provides deterministic assurance for most threat models.

The second classic pitfall is ignoring transaction failure modes beyond "success" or "out of gas." An Ethereum transaction can succeed at the protocol level (gas was consumed, nonce was incremented) while the smart contract's business logic reverted. The status field in the transaction receipt (1 for success, 0 for revert) is the correct indicator, not the absence of an error from `eth_sendRawTransaction`. Many junior implementations only check for RPC errors and miss contract reverts, leading to incorrect state in application databases.

A worked example of the nonce pitfall: you have a system that submits transactions in response to user requests, and two requests arrive simultaneously. Both goroutines call `eth_getTransactionCount` and get nonce 42. Both construct transactions with nonce 42. The second one to arrive at the mempool replaces the first. One user's action is silently lost. The fix is a server-side nonce manager that atomically increments a counter, never fetching the on-chain nonce except on startup or after a gap is detected.

For interview preparation, be able to describe three blockchain-specific failure modes and their mitigations: nonce conflicts (single nonce manager), missed events (event replay from block on restart), and RPC provider downtime (multiple providers with automatic failover). These are the exact scenarios that come up in "design an ETH withdrawal system" interview questions.

### Senior @ FAANG: Systemic Pitfall Prevention Through Architecture and Process

At staff level, production pitfalls are not just technical failures but process failures: the absence of code review standards, testing requirements, or deployment checklists that would have caught the issue before it reached production. Staff engineers respond to pitfalls by closing both the technical gap and the process gap, and by ensuring the organization learns from the failure through a blameless post-mortem process.

The most expensive pitfalls in blockchain integration are irreversible: private key exposure (funds are lost and cannot be recovered), insufficient gas causing a contract upgrade to fail mid-execution (leaving the contract in an inconsistent state), and incorrect smart contract address hardcoding (funds sent to the wrong contract on a network where contract state cannot be forcibly changed). ADRs for blockchain integrations must explicitly identify which decisions are irreversible and require additional review steps for those decisions specifically.

Gas estimation pitfalls deserve particular attention because they are both common and difficult to debug. `eth_estimateGas` estimates gas based on current blockchain state, but the actual gas consumed may differ if state changes between estimation and execution. For smart contract calls that are sensitive to state (e.g., a liquidation function that checks a price feed), the estimate may be stale by the time the transaction is included. The mitigation is to add a gas buffer (typically 20-30 percent above the estimate) and to write integration tests that exercise the function under boundary state conditions.

Event replay correctness is a systemic pitfall that affects most event-driven blockchain integrations. When a service restarts, it must replay events from the last processed block, not from the current block. But the last processed block must be the last block for which all events were fully processed and committed to the application database, not merely the last block that was fetched. A system that tracks the "last fetched" block rather than the "last committed" block will miss events during restarts. Staff engineers audit event processing code for this distinction and add integration tests that simulate restart scenarios.

The dependency on a single RPC provider is a systemic availability risk that appears in post-mortems repeatedly. Infura had a significant outage in November 2020 that took down every dApp that had a hard dependency on it. Alchemy had rate limit incidents in 2021 and 2022. Production blockchain infrastructure must have at least two independent RPC provider relationships and automated failover logic. Staff engineers document the provider SLAs, measure actual uptime, and propose budget for backup providers when the primary provider's reliability does not meet requirements.

Smart contract ABI compatibility pitfalls affect any system that decodes contract events or calls contract functions using a generated ABI binding. When a contract is upgraded via a proxy pattern and the ABI changes, any application that cached the old ABI will silently decode events incorrectly or fail to call new functions. Staff engineers design ABI version management: each deployment of a contract version is tracked with its ABI in a registry, and event processing code uses the ABI version active at the block height of the event, not the current ABI version.

Bar-raiser signals: designing a rollback procedure for a failed contract upgrade that left the proxy pointing at a broken implementation (requires having a rollback target pre-deployed and tested before the upgrade), or explaining why a system that uses `eth_getLogs` for event monitoring may miss events on chains with reorganizations if it does not check the `removed` field in each log entry. These failure modes reveal deep familiarity with production blockchain systems.

At the L7 level, pitfall prevention extends to vendor and protocol risk management. Depending on a single oracle provider for price feeds (Chainlink is common but not infallible), a single bridge for cross-chain transfers, or a single sequencer for Layer 2 transactions creates systemic risk that is organizational, not just technical. Staff engineers at L7 contribute to risk registers that identify these dependencies and advocate for diversification or fallback mechanisms that reduce single-point-of-failure exposure at the protocol level.

---
