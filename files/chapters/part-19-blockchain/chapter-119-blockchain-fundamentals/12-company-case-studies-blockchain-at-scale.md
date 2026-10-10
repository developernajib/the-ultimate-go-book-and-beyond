## 119.11 Company Case Studies: Blockchain at Scale

### Coinbase: Blockchain Infrastructure

Coinbase processes billions in crypto transactions with Go:

```go
// Coinbase-style blockchain infrastructure
package blockchain

import (
    "context"
    "sync"
    "time"
)

// NodeManager manages connections to blockchain nodes
type NodeManager struct {
    mu          sync.RWMutex
    nodes       map[string]*NodeConnection
    healthCheck *HealthChecker
    loadBalancer *LoadBalancer
}

type NodeConnection struct {
    URL         string
    Chain       string
    Priority    int
    Status      string
    LastHealthy time.Time
    Latency     time.Duration
}

// GetHealthyNode returns a healthy node for the chain
func (m *NodeManager) GetHealthyNode(chain string) (*NodeConnection, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()

    // Get nodes for chain
    var candidates []*NodeConnection
    for _, node := range m.nodes {
        if node.Chain == chain && node.Status == "healthy" {
            candidates = append(candidates, node)
        }
    }

    if len(candidates) == 0 {
        return nil, fmt.Errorf("no healthy nodes for chain: %s", chain)
    }

    // Use load balancer to select node
    return m.loadBalancer.Select(candidates), nil
}

// TransactionProcessor handles transaction lifecycle
type TransactionProcessor struct {
    nodeManager   *NodeManager
    mempool       *Mempool
    confirmTracker *ConfirmationTracker
    metrics       *Metrics
}

// ProcessTransaction handles a new transaction
func (p *TransactionProcessor) ProcessTransaction(
    ctx context.Context,
    tx *Transaction,
) (*TransactionResult, error) {
    // Validate transaction
    if err := p.validateTransaction(tx); err != nil {
        return nil, err
    }

    // Get healthy node
    node, err := p.nodeManager.GetHealthyNode(tx.Chain)
    if err != nil {
        return nil, err
    }

    // Submit to mempool
    txHash, err := p.submitTransaction(ctx, node, tx)
    if err != nil {
        // Retry with different node
        node, _ = p.nodeManager.GetHealthyNode(tx.Chain)
        txHash, err = p.submitTransaction(ctx, node, tx)
        if err != nil {
            return nil, err
        }
    }

    // Track confirmations
    p.confirmTracker.Track(txHash, tx.Chain, tx.RequiredConfirmations)

    return &TransactionResult{
        Hash:   txHash,
        Status: "pending",
    }, nil
}
```

### Stripe: Crypto Payment Integration

Stripe integrates blockchain payments with traditional rails:

```go
// Stripe-style crypto payment integration
package crypto

import (
    "context"
    "fmt"
    "time"
)

// CryptoPaymentService handles cryptocurrency payments
type CryptoPaymentService struct {
    walletService   *WalletService
    exchangeService *ExchangeService
    blockchainClient *BlockchainClient
    webhookService  *WebhookService
}

type CryptoPayment struct {
    ID              string
    Amount          float64
    Currency        string  // BTC, ETH, USDC
    FiatEquivalent  float64
    FiatCurrency    string
    DepositAddress  string
    Status          string
    Confirmations   int
    RequiredConf    int
    ExpiresAt       time.Time
}

// CreateCryptoPayment creates a new crypto payment
func (s *CryptoPaymentService) CreateCryptoPayment(
    ctx context.Context,
    amount float64,
    fiatCurrency string,
    cryptoCurrency string,
) (*CryptoPayment, error) {
    // Get current exchange rate
    rate, err := s.exchangeService.GetRate(cryptoCurrency, fiatCurrency)
    if err != nil {
        return nil, err
    }

    // Calculate crypto amount
    cryptoAmount := amount / rate

    // Generate unique deposit address
    address, err := s.walletService.GenerateDepositAddress(cryptoCurrency)
    if err != nil {
        return nil, err
    }

    payment := &CryptoPayment{
        ID:             generatePaymentID(),
        Amount:         cryptoAmount,
        Currency:       cryptoCurrency,
        FiatEquivalent: amount,
        FiatCurrency:   fiatCurrency,
        DepositAddress: address,
        Status:         "awaiting_payment",
        RequiredConf:   getRequiredConfirmations(cryptoCurrency),
        ExpiresAt:      time.Now().Add(30 * time.Minute),
    }

    // Start monitoring for payment
    go s.monitorPayment(ctx, payment)

    return payment, nil
}

// monitorPayment watches blockchain for incoming payment
func (s *CryptoPaymentService) monitorPayment(ctx context.Context, payment *CryptoPayment) {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            // Check if expired
            if time.Now().After(payment.ExpiresAt) && payment.Status == "awaiting_payment" {
                payment.Status = "expired"
                s.webhookService.Send(payment, "payment.expired")
                return
            }

            // Check for payment on chain
            tx, err := s.blockchainClient.GetTransactionToAddress(
                payment.Currency,
                payment.DepositAddress,
            )
            if err != nil || tx == nil {
                continue
            }

            // Update confirmations
            payment.Confirmations = tx.Confirmations
            payment.Status = "confirming"

            if payment.Confirmations >= payment.RequiredConf {
                payment.Status = "confirmed"
                s.webhookService.Send(payment, "payment.confirmed")
                return
            }
        }
    }
}
```

### OpenSea: NFT Marketplace Infrastructure

OpenSea-style NFT platform patterns:

```go
// OpenSea-style NFT marketplace
package nft

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// NFTIndexer indexes NFT data from blockchains
type NFTIndexer struct {
    blockchainClient *MultiChainClient
    storage          *NFTStorage
    eventProcessor   *EventProcessor
}

type NFT struct {
    ContractAddress string
    TokenID         string
    Chain           string
    Owner           string
    Metadata        *NFTMetadata
    LastTransfer    time.Time
}

type NFTMetadata struct {
    Name        string
    Description string
    Image       string
    Attributes  []Attribute
}

// IndexCollection indexes all NFTs in a collection
func (i *NFTIndexer) IndexCollection(
    ctx context.Context,
    chain string,
    contractAddress string,
) error {
    // Get total supply
    totalSupply, err := i.blockchainClient.GetTotalSupply(chain, contractAddress)
    if err != nil {
        return err
    }

    // Index in batches
    batchSize := 100
    for start := 0; start < totalSupply; start += batchSize {
        end := start + batchSize
        if end > totalSupply {
            end = totalSupply
        }

        batch, err := i.indexBatch(ctx, chain, contractAddress, start, end)
        if err != nil {
            return err
        }

        if err := i.storage.SaveBatch(batch); err != nil {
            return err
        }
    }

    return nil
}

// SubscribeToTransfers listens for NFT transfer events
func (i *NFTIndexer) SubscribeToTransfers(ctx context.Context, chain string) error {
    events := make(chan *TransferEvent, 100)

    // Subscribe to Transfer events
    go i.blockchainClient.SubscribeToEvents(ctx, chain, "Transfer", events)

    for event := range events {
        if err := i.processTransfer(ctx, event); err != nil {
            // Log error but continue processing
            continue
        }
    }

    return nil
}

// OrderBook manages NFT orders
type OrderBook struct {
    mu     sync.RWMutex
    orders map[string]*Order
}

type Order struct {
    ID           string
    NFT          *NFT
    Maker        string
    Price        float64
    Currency     string
    Signature    string
    ExpiresAt    time.Time
    Status       string
}

// CreateOrder creates a new sell order
func (o *OrderBook) CreateOrder(order *Order) error {
    // Verify signature
    if !verifyOrderSignature(order) {
        return fmt.Errorf("invalid signature")
    }

    // Verify ownership
    if !verifyOwnership(order.NFT, order.Maker) {
        return fmt.Errorf("maker does not own NFT")
    }

    o.mu.Lock()
    o.orders[order.ID] = order
    o.mu.Unlock()

    return nil
}

// FulfillOrder executes an order
func (o *OrderBook) FulfillOrder(
    ctx context.Context,
    orderID string,
    buyer string,
    buyerSignature string,
) error {
    o.mu.Lock()
    order, ok := o.orders[orderID]
    if !ok {
        o.mu.Unlock()
        return fmt.Errorf("order not found")
    }
    o.mu.Unlock()

    // Execute atomic swap on-chain
    // This transfers NFT and payment in single transaction
    txHash, err := executeAtomicSwap(ctx, order, buyer, buyerSignature)
    if err != nil {
        return err
    }

    order.Status = "fulfilled"
    return nil
}
```

### Chainlink: Oracle Network Patterns

Chainlink-style oracle patterns in Go:

```go
// Chainlink-style oracle network
package oracle

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "sort"
    "sync"
    "time"
)

// OracleNetwork aggregates data from multiple sources
type OracleNetwork struct {
    nodes       []*OracleNode
    aggregator  *DataAggregator
    onChainContract *Contract
}

type OracleNode struct {
    ID          string
    URL         string
    Reputation  float64
    StakeAmount float64
}

type PriceReport struct {
    NodeID    string
    Price     float64
    Timestamp time.Time
    Signature string
}

// FetchPrice gets aggregated price from oracle network
func (n *OracleNetwork) FetchPrice(ctx context.Context, pair string) (*AggregatedPrice, error) {
    // Collect reports from nodes in parallel
    reports := make(chan *PriceReport, len(n.nodes))
    var wg sync.WaitGroup

    for _, node := range n.nodes {
        wg.Add(1)
        go func(node *OracleNode) {
            defer wg.Done()
            report, err := n.fetchFromNode(ctx, node, pair)
            if err == nil {
                reports <- report
            }
        }(node)
    }

    wg.Wait()
    close(reports)

    // Collect valid reports
    var validReports []*PriceReport
    for report := range reports {
        if n.validateReport(report) {
            validReports = append(validReports, report)
        }
    }

    // Need minimum number of reports
    if len(validReports) < n.minimumReports() {
        return nil, fmt.Errorf("insufficient oracle responses")
    }

    // Aggregate price
    return n.aggregator.Aggregate(validReports), nil
}

// DataAggregator combines multiple price reports
type DataAggregator struct {
    method string // median, mean, weighted
}

func (a *DataAggregator) Aggregate(reports []*PriceReport) *AggregatedPrice {
    prices := make([]float64, len(reports))
    for i, r := range reports {
        prices[i] = r.Price
    }

    var finalPrice float64
    switch a.method {
    case "median":
        slices.Sort(prices)
        mid := len(prices) / 2
        if len(prices)%2 == 0 {
            finalPrice = (prices[mid-1] + prices[mid]) / 2
        } else {
            finalPrice = prices[mid]
        }
    case "mean":
        sum := 0.0
        for _, p := range prices {
            sum += p
        }
        finalPrice = sum / float64(len(prices))
    }

    return &AggregatedPrice{
        Price:       finalPrice,
        Timestamp:   time.Now(),
        NumReports:  len(reports),
        Confidence:  calculateConfidence(prices),
    }
}

// UpdateOnChain submits aggregated price to blockchain
func (n *OracleNetwork) UpdateOnChain(ctx context.Context, price *AggregatedPrice) error {
    // Encode price data
    data := encodePriceData(price)

    // Create transaction
    tx, err := n.onChainContract.UpdatePrice(ctx, data)
    if err != nil {
        return err
    }

    // Wait for confirmation
    return n.waitForConfirmation(ctx, tx)
}
```

### Uniswap: DEX Integration

Uniswap-style decentralized exchange patterns:

```go
// Uniswap-style DEX integration
package dex

import (
    "context"
    "fmt"
    "math/big"
)

// UniswapClient interacts with Uniswap protocol
type UniswapClient struct {
    routerContract *Contract
    factoryContract *Contract
    quoter         *Contract
    chainClient    *ChainClient
}

type SwapParams struct {
    TokenIn     string
    TokenOut    string
    AmountIn    *big.Int
    MinAmountOut *big.Int
    Recipient   string
    Deadline    int64
    Slippage    float64
}

// GetQuote gets expected output for a swap
func (c *UniswapClient) GetQuote(
    ctx context.Context,
    tokenIn, tokenOut string,
    amountIn *big.Int,
) (*Quote, error) {
    // Get best route
    routes, err := c.findRoutes(ctx, tokenIn, tokenOut)
    if err != nil {
        return nil, err
    }

    // Quote each route
    var bestQuote *Quote
    for _, route := range routes {
        quote, err := c.quoter.QuoteExactInput(ctx, route.Path, amountIn)
        if err != nil {
            continue
        }

        if bestQuote == nil || quote.AmountOut.Cmp(bestQuote.AmountOut) > 0 {
            bestQuote = quote
            bestQuote.Route = route
        }
    }

    if bestQuote == nil {
        return nil, fmt.Errorf("no route found")
    }

    return bestQuote, nil
}

// ExecuteSwap performs a token swap
func (c *UniswapClient) ExecuteSwap(
    ctx context.Context,
    params SwapParams,
    privateKey string,
) (*SwapResult, error) {
    // Get quote
    quote, err := c.GetQuote(ctx, params.TokenIn, params.TokenOut, params.AmountIn)
    if err != nil {
        return nil, err
    }

    // Calculate minimum output with slippage
    slippageMultiplier := 1.0 - params.Slippage
    minOut := new(big.Int).Mul(quote.AmountOut, big.NewInt(int64(slippageMultiplier*10000)))
    minOut = minOut.Div(minOut, big.NewInt(10000))

    // Check approval
    allowance, err := c.getTokenAllowance(ctx, params.TokenIn, params.Recipient, c.routerContract.Address)
    if err != nil {
        return nil, err
    }

    if allowance.Cmp(params.AmountIn) < 0 {
        // Approve router to spend tokens
        if err := c.approveToken(ctx, params.TokenIn, c.routerContract.Address, privateKey); err != nil {
            return nil, err
        }
    }

    // Execute swap
    tx, err := c.routerContract.ExactInputSingle(ctx, RouterParams{
        TokenIn:      params.TokenIn,
        TokenOut:     params.TokenOut,
        Fee:          quote.Route.Fee,
        Recipient:    params.Recipient,
        Deadline:     params.Deadline,
        AmountIn:     params.AmountIn,
        AmountOutMin: minOut,
        SqrtPriceLimit: big.NewInt(0),
    }, privateKey)
    if err != nil {
        return nil, err
    }

    // Wait for confirmation
    receipt, err := c.chainClient.WaitForReceipt(ctx, tx.Hash)
    if err != nil {
        return nil, err
    }

    return &SwapResult{
        TxHash:    tx.Hash,
        AmountIn:  params.AmountIn,
        AmountOut: parseAmountFromReceipt(receipt),
        GasUsed:   receipt.GasUsed,
    }, nil
}
```

---

### Junior → FAANG: Learning from Scale-Up Failures and Successes

Case studies from companies operating blockchains at scale are among the most valuable study materials for blockchain engineering interviews because they provide the "why" behind decisions that might otherwise seem arbitrary. When Coinbase describes why they run their own Ethereum nodes rather than relying on Infura, or when Polygon explains their transaction ordering architecture, they are revealing the failure modes that drove those decisions.

The prerequisite gap for a junior studying these case studies is the ability to read an incident post-mortem or technical blog post and identify the root cause in terms of specific engineering primitives: nonce management failure, RPC provider rate limit, reorg depth exceeded confirmation threshold, gas price estimation lag during network spike. This analytical skill transfers directly to interviews where you are asked "tell me about a production incident you worked on."

For interview preparation, prepare two or three case study stories that you can tell in a structured way: what was the system, what was the scale, what went wrong, what was the root cause, what was the fix, and what did you learn. Even if you have not personally worked at Coinbase scale, reading their engineering blog and being able to discuss their architectural decisions fluently signals the right level of engagement with the field.

First-job habit: subscribe to blockchain engineering blogs (Coinbase Engineering, Ethereum Research, Paradigm Research, a16z Crypto Engineering) and read at least one post per week. The field moves fast enough that a junior who stops learning after their initial onboarding will be significantly behind within a year. Build the reading habit early and maintain it throughout your career.

### Senior @ FAANG: Extracting Architectural Patterns from Case Studies

At staff level, reading blockchain case studies is a form of competitive intelligence and architectural research. When Binance describes how they handle 1 million daily active users with blockchain withdrawals, or when Uniswap explains their subgraph architecture for historical price data, there are transferable architectural patterns that can inform your team's design decisions. The staff engineer's job is to extract the pattern, understand its applicability to your context, and document whether it is or is not appropriate in an ADR.

The most common pattern that emerges across blockchain case studies at scale is the decoupling of the submission path from the confirmation path. High-throughput systems do not wait for confirmation before acknowledging a user action. Instead, they submit the transaction asynchronously, store its pending state, and update business records when a confirmation event arrives through a monitoring pipeline. This pattern has a specific failure mode (the monitoring pipeline can fall behind, leading to delayed state updates) that must be addressed through SLA-bound retry logic and alerts.

State reconciliation patterns appear in almost every blockchain case study that involves real money. At some point, the application's model of "what has been confirmed on-chain" diverges from the actual on-chain state, usually due to a reorg, a missed event, or an RPC node returning stale data. The architecture for detecting and correcting this divergence is a recurring design challenge. Staff engineers codify the reconciliation pattern: a periodic job that compares application state against on-chain truth and triggers corrective actions for any discrepancy.

The "thundering herd" failure mode appears frequently in blockchain infrastructure case studies: a network-wide event (a highly anticipated NFT mint, a sudden market move triggering mass liquidations) generates a spike in transaction volume that overwhelms both the Ethereum mempool and the infrastructure of every team trying to submit transactions during the same window. Case studies from Opensea, Compound, and Aave all describe variations of this failure. Staff engineers design for this by implementing priority queues, gas auction logic, and circuit breakers that prevent a load spike from causing cascading failures in dependent systems.

ADRs that reference case studies are more persuasive than ADRs that are purely theoretical. Linking to a Coinbase post-mortem that describes why a specific nonce management approach failed at scale is a more compelling argument for a different approach than abstract reasoning alone. Staff engineers build the habit of linking external evidence to architectural decisions throughout their ADR writing practice.

Bar-raiser signals: describing how Etherscan's architecture differs from a simple event listener (they run multiple archive nodes with redundancy, an indexer that backfills historical data, and a read replica that serves their API layer independently of the indexer), or explaining the architectural trade-off that caused a specific DeFi protocol to fail during a gas price spike (static gas limits in bot logic, not adaptive to network conditions). The ability to reason about other organizations' architectures reveals systems thinking depth.

At the L7 level, case studies inform strategy documents. A principal engineer who can synthesize five case studies of blockchain infrastructure failures into a "known failure modes and mitigations" document for the organization's CTO or security team is providing organizational value that goes far beyond individual coding contributions. Writing these synthesis documents, getting them reviewed and endorsed by senior leadership, and updating them as new case studies emerge is a form of technical leadership that distinguishes L7 engineers.

---
