## 123.12 Company Case Studies: Web3 Infrastructure at Scale

### The Graph: Decentralized Indexing

The Graph patterns for blockchain indexing:

```go
// The Graph-style decentralized indexing
package graph

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// SubgraphIndexer indexes blockchain data for subgraphs
type SubgraphIndexer struct {
    schema       *GraphSchema
    handlers     map[string]EventHandler
    store        *IndexStore
    blockSource  *BlockSource
    ipfsClient   *IPFSClient
}

type GraphSchema struct {
    Name     string
    Version  string
    Entities []EntityDefinition
    Sources  []DataSource
}

type EntityDefinition struct {
    Name   string
    Fields []FieldDefinition
    Derived []DerivedField
}

// StartIndexing begins processing blocks
func (i *SubgraphIndexer) StartIndexing(ctx context.Context, startBlock uint64) error {
    blocks := i.blockSource.Subscribe(ctx, startBlock)

    for block := range blocks {
        if err := i.processBlock(ctx, block); err != nil {
            // Log error but continue
            continue
        }
    }

    return nil
}

func (i *SubgraphIndexer) processBlock(ctx context.Context, block *Block) error {
    // Get all logs in block
    for _, log := range block.Logs {
        // Find matching handler
        handler, ok := i.handlers[log.Topics[0]]
        if !ok {
            continue
        }

        // Decode and process event
        event, err := decodeEvent(log, handler.ABI)
        if err != nil {
            continue
        }

        // Create entity store for handler
        store := &HandlerStore{
            store:   i.store,
            context: EventContext{
                Block:       block,
                Transaction: block.Transactions[log.TxIndex],
                Log:         log,
            },
        }

        // Execute handler
        if err := handler.Handle(event, store); err != nil {
            return err
        }
    }

    return nil
}

// HandlerStore provides entity operations for handlers
type HandlerStore struct {
    store   *IndexStore
    context EventContext
}

func (s *HandlerStore) Load(entityType, id string) (map[string]any, error) {
    return s.store.Get(entityType, id)
}

func (s *HandlerStore) Save(entityType string, entity map[string]any) error {
    return s.store.Put(entityType, entity["id"].(string), entity)
}

// GraphQL query handler
type QueryHandler struct {
    store  *IndexStore
    schema *GraphSchema
}

func (h *QueryHandler) Query(ctx context.Context, query string) (any, error) {
    // Parse GraphQL query
    parsed, err := parseGraphQL(query)
    if err != nil {
        return nil, err
    }

    // Execute query against store
    return h.executeQuery(ctx, parsed)
}
```

### Alchemy: Enhanced APIs

Alchemy-style enhanced blockchain APIs:

```go
// Alchemy-style enhanced APIs
package enhanced

import (
    "context"
    "sync"
    "time"
)

// EnhancedAPIService provides advanced blockchain APIs
type EnhancedAPIService struct {
    nodeCluster  *NodeCluster
    tokenAPI     *TokenAPI
    nftAPI       *NFTAPI
    webhookService *WebhookService
    analytics    *Analytics
}

// GetTokenBalances returns all token balances for address
func (s *EnhancedAPIService) GetTokenBalances(
    ctx context.Context,
    address string,
) (*TokenBalances, error) {
    // Get all token transfers to/from address
    transfers, err := s.tokenAPI.GetTransfers(ctx, address)
    if err != nil {
        return nil, err
    }

    // Calculate current balances
    balances := make(map[string]*TokenBalance)
    for _, transfer := range transfers {
        token := transfer.ContractAddress
        if _, ok := balances[token]; !ok {
            balances[token] = &TokenBalance{
                Contract: token,
                Balance:  big.NewInt(0),
            }
        }

        if transfer.To == address {
            balances[token].Balance.Add(balances[token].Balance, transfer.Value)
        } else {
            balances[token].Balance.Sub(balances[token].Balance, transfer.Value)
        }
    }

    // Enrich with token metadata
    var result []*TokenBalance
    for _, balance := range balances {
        if balance.Balance.Sign() > 0 {
            metadata, _ := s.tokenAPI.GetMetadata(ctx, balance.Contract)
            balance.Name = metadata.Name
            balance.Symbol = metadata.Symbol
            balance.Decimals = metadata.Decimals
            result = append(result, balance)
        }
    }

    return &TokenBalances{Address: address, Balances: result}, nil
}

// GetNFTsForOwner returns all NFTs owned by address
func (s *EnhancedAPIService) GetNFTsForOwner(
    ctx context.Context,
    owner string,
    options *NFTOptions,
) (*NFTCollection, error) {
    // Get all ERC721 and ERC1155 transfers
    nfts, err := s.nftAPI.GetNFTsForOwner(ctx, owner)
    if err != nil {
        return nil, err
    }

    // Fetch metadata in parallel
    var wg sync.WaitGroup
    for _, nft := range nfts {
        wg.Add(1)
        go func(n *NFT) {
            defer wg.Done()
            metadata, err := s.nftAPI.GetMetadata(ctx, n.Contract, n.TokenID)
            if err == nil {
                n.Metadata = metadata
            }
        }(nft)
    }
    wg.Wait()

    return &NFTCollection{
        Owner:      owner,
        NFTs:       nfts,
        TotalCount: len(nfts),
    }, nil
}

// Webhooks for real-time notifications
type WebhookService struct {
    subscriptions map[string]*Subscription
    eventProcessor *EventProcessor
}

type Subscription struct {
    ID          string
    Type        string  // address_activity, mined_transaction, dropped_transaction
    Address     string
    WebhookURL  string
    Network     string
    CreatedAt   time.Time
}

func (w *WebhookService) Subscribe(sub *Subscription) error {
    w.subscriptions[sub.ID] = sub

    // Start monitoring
    go w.monitor(sub)

    return nil
}

func (w *WebhookService) monitor(sub *Subscription) {
    switch sub.Type {
    case "address_activity":
        events := w.eventProcessor.SubscribeAddress(sub.Address)
        for event := range events {
            w.sendWebhook(sub.WebhookURL, event)
        }
    case "mined_transaction":
        w.eventProcessor.SubscribePendingTx(sub.Address, func(tx *Transaction) {
            w.sendWebhook(sub.WebhookURL, tx)
        })
    }
}
```

### Moralis: Cross-Chain Data

Moralis-style cross-chain data platform:

```go
// Moralis-style cross-chain platform
package crosschain

import (
    "context"
    "sync"
)

// CrossChainService aggregates data across chains
type CrossChainService struct {
    chains       map[string]*ChainClient
    unifiedStore *UnifiedStore
    resolver     *AddressResolver
}

type ChainClient struct {
    Name        string
    ChainID     int
    RPCClient   *RPCClient
    IndexClient *IndexClient
}

// GetWalletHistory returns unified history across chains
func (s *CrossChainService) GetWalletHistory(
    ctx context.Context,
    address string,
    chains []string,
) (*UnifiedHistory, error) {
    var wg sync.WaitGroup
    results := make(chan *ChainHistory, len(chains))

    for _, chainName := range chains {
        chain, ok := s.chains[chainName]
        if !ok {
            continue
        }

        wg.Add(1)
        go func(c *ChainClient) {
            defer wg.Done()

            history, err := c.IndexClient.GetHistory(ctx, address)
            if err != nil {
                return
            }

            results <- &ChainHistory{
                Chain:        c.Name,
                Transactions: history,
            }
        }(chain)
    }

    wg.Wait()
    close(results)

    // Aggregate and sort by timestamp
    unified := &UnifiedHistory{Address: address}
    for result := range results {
        unified.Chains = append(unified.Chains, result)
    }

    unified.Sort()
    return unified, nil
}

// ResolveAddress resolves ENS, Unstoppable domains across chains
func (s *CrossChainService) ResolveAddress(
    ctx context.Context,
    nameOrAddress string,
) (*ResolvedAddress, error) {
    return s.resolver.Resolve(ctx, nameOrAddress)
}

// AddressResolver handles name resolution
type AddressResolver struct {
    ensClient   *ENSClient
    udClient    *UnstoppableClient
    cache       *ResolutionCache
}

func (r *AddressResolver) Resolve(ctx context.Context, input string) (*ResolvedAddress, error) {
    // Check cache
    if cached, ok := r.cache.Get(input); ok {
        return cached, nil
    }

    result := &ResolvedAddress{Input: input}

    // Try ENS (.eth)
    if isENSDomain(input) {
        addr, err := r.ensClient.Resolve(ctx, input)
        if err == nil {
            result.Address = addr
            result.Source = "ENS"
        }
    }

    // Try Unstoppable Domains
    if isUDDomain(input) {
        addr, err := r.udClient.Resolve(ctx, input)
        if err == nil {
            result.Address = addr
            result.Source = "UD"
        }
    }

    // Reverse lookup if address provided
    if isAddress(input) {
        result.Address = input
        name, err := r.ensClient.ReverseLookup(ctx, input)
        if err == nil {
            result.ENSName = name
        }
    }

    r.cache.Set(input, result)
    return result, nil
}
```

### QuickNode: Node Infrastructure

QuickNode-style node infrastructure:

```go
// QuickNode-style node infrastructure
package nodes

import (
    "context"
    "sync"
    "time"
)

// NodeInfrastructure manages distributed node network
type NodeInfrastructure struct {
    regions      map[string]*Region
    loadBalancer *GlobalLoadBalancer
    healthMonitor *HealthMonitor
    metrics      *InfraMetrics
}

type Region struct {
    Name    string
    Nodes   []*Node
    Primary *Node
}

type Node struct {
    ID          string
    Endpoint    string
    Chain       string
    Type        string // full, archive, light
    Status      string
    LastHealthy time.Time
    Latency     time.Duration
    Load        float64
}

// RouteRequest finds best node for request
func (i *NodeInfrastructure) RouteRequest(
    ctx context.Context,
    chain string,
    method string,
    clientRegion string,
) (*Node, error) {
    // Get nodes for chain in closest region
    nodes := i.getNodesInRegion(chain, clientRegion)
    if len(nodes) == 0 {
        // Fall back to any region
        nodes = i.getAllNodes(chain)
    }

    // Filter healthy nodes
    var healthy []*Node
    for _, n := range nodes {
        if n.Status == "healthy" && n.Load < 0.9 {
            healthy = append(healthy, n)
        }
    }

    if len(healthy) == 0 {
        return nil, fmt.Errorf("no healthy nodes available")
    }

    // Select based on method requirements
    if requiresArchive(method) {
        for _, n := range healthy {
            if n.Type == "archive" {
                return n, nil
            }
        }
        return nil, fmt.Errorf("no archive nodes available")
    }

    // Select by lowest latency and load
    return i.loadBalancer.Select(healthy), nil
}

// HealthMonitor continuously checks node health
type HealthMonitor struct {
    nodes    []*Node
    interval time.Duration
    alerter  *Alerter
}

func (m *HealthMonitor) Start(ctx context.Context) {
    ticker := time.NewTicker(m.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            m.checkAll(ctx)
        }
    }
}

func (m *HealthMonitor) checkAll(ctx context.Context) {
    var wg sync.WaitGroup

    for _, node := range m.nodes {
        wg.Add(1)
        go func(n *Node) {
            defer wg.Done()

            healthy, latency := m.checkNode(ctx, n)

            if healthy {
                n.Status = "healthy"
                n.LastHealthy = time.Now()
                n.Latency = latency
            } else {
                n.Status = "unhealthy"
                m.alerter.NodeUnhealthy(n)
            }
        }(node)
    }

    wg.Wait()
}

func (m *HealthMonitor) checkNode(ctx context.Context, node *Node) (bool, time.Duration) {
    start := time.Now()

    // Try basic RPC call
    client, err := rpc.Dial(node.Endpoint)
    if err != nil {
        return false, 0
    }
    defer client.Close()

    var blockNumber string
    err = client.CallContext(ctx, &blockNumber, "eth_blockNumber")
    if err != nil {
        return false, 0
    }

    return true, time.Since(start)
}
```

### Tenderly: Development Platform

Tenderly-style development and debugging:

```go
// Tenderly-style development platform
package devtools

import (
    "context"
    "fmt"
)

// SimulationService simulates transactions
type SimulationService struct {
    forkManager   *ForkManager
    traceDecoder  *TraceDecoder
    stateManager  *StateManager
}

// SimulateTransaction simulates a transaction
func (s *SimulationService) SimulateTransaction(
    ctx context.Context,
    tx *SimulationRequest,
) (*SimulationResult, error) {
    // Create temporary fork
    fork, err := s.forkManager.CreateFork(tx.NetworkID, tx.BlockNumber)
    if err != nil {
        return nil, err
    }
    defer fork.Cleanup()

    // Apply any state overrides
    if len(tx.StateOverrides) > 0 {
        if err := s.stateManager.ApplyOverrides(fork, tx.StateOverrides); err != nil {
            return nil, err
        }
    }

    // Execute transaction
    trace, err := fork.Execute(tx.From, tx.To, tx.Value, tx.Data, tx.Gas)
    if err != nil {
        return nil, err
    }

    // Decode trace
    decoded, err := s.traceDecoder.Decode(trace)
    if err != nil {
        return nil, err
    }

    return &SimulationResult{
        Success:       trace.Success,
        GasUsed:       trace.GasUsed,
        ReturnValue:   trace.ReturnValue,
        Trace:         decoded,
        StateChanges:  trace.StateChanges,
        Logs:          trace.Logs,
    }, nil
}

// ForkManager manages network forks for testing
type ForkManager struct {
    forks map[string]*Fork
}

type Fork struct {
    ID          string
    NetworkID   int
    BlockNumber uint64
    State       *StateDB
}

func (m *ForkManager) CreateFork(networkID int, blockNumber uint64) (*Fork, error) {
    // Get state at block
    state, err := m.getStateAt(networkID, blockNumber)
    if err != nil {
        return nil, err
    }

    fork := &Fork{
        ID:          generateForkID(),
        NetworkID:   networkID,
        BlockNumber: blockNumber,
        State:       state,
    }

    m.forks[fork.ID] = fork
    return fork, nil
}

// AlertService monitors contracts and transactions
type AlertService struct {
    rules       []*AlertRule
    subscribers map[string][]string
}

type AlertRule struct {
    ID          string
    Name        string
    Type        string  // transaction, function_call, event, state_change
    Condition   string  // Expression to evaluate
    Contracts   []string
    Enabled     bool
}

func (s *AlertService) Evaluate(ctx context.Context, tx *Transaction) []*Alert {
    var alerts []*Alert

    for _, rule := range s.rules {
        if !rule.Enabled {
            continue
        }

        if s.matchesRule(tx, rule) {
            alert := &Alert{
                RuleID:      rule.ID,
                RuleName:    rule.Name,
                Transaction: tx.Hash,
                Timestamp:   time.Now(),
            }
            alerts = append(alerts, alert)

            // Notify subscribers
            s.notifySubscribers(rule.ID, alert)
        }
    }

    return alerts
}
```

---

### Junior → FAANG: Infrastructure at Scale Case Studies as Career Accelerators

Web3 infrastructure at scale case studies provide the most direct view of what your career trajectory looks like in blockchain engineering. When Chainlink describes how they maintain oracle data feeds with high uptime across dozens of networks, or when Alchemy describes how they scaled their RPC platform to serve billions of requests per day, they are describing the engineering challenges that senior roles in Web3 infrastructure require you to solve.

The most instructive infrastructure scale case studies for junior engineers focus on the transition from "works on testnet" to "works at production scale": the Opensea scaling challenge during the NFT boom of 2021, when their event processing pipeline struggled to keep up with millions of new events per day. The Infura November 2020 outage that revealed the single-point-of-failure risk of centralized RPC providers. And the Chainlink 2022 performance improvements that reduced oracle update latency by 90 percent through off-chain aggregation. Each case study reveals a specific production engineering lesson.

For interview preparation, select one infrastructure scale case study and prepare to discuss it at depth: what was the scale challenge, what was the technical root cause, what was the solution, and what architectural principle does the solution represent? The Infura outage case study is particularly valuable because it led to a widespread architectural shift toward RPC provider redundancy and self-hosted node infrastructure across the industry.

First-job wisdom from case studies: every scale case study began with infrastructure that worked fine at 10x smaller scale. The patterns that are appropriate at small scale (single RPC node, synchronous event processing, simple database schema) break at production scale. Understanding why they break helps you design with scale in mind from the start.

### Senior @ FAANG: Infrastructure Scale Case Studies as Strategic Intelligence

At staff level, infrastructure scale case studies are strategic intelligence: they reveal the technical and organizational approaches that have successfully scaled to levels your organization aspires to reach. A systematic review of the engineering blogs from Coinbase, Consensys, Alchemy, Quicknode, and major DeFi protocols provides a continuous stream of case studies that should inform your team's technical roadmap.

The Coinbase infrastructure case studies are particularly relevant for teams that manage large-scale cryptocurrency custody and trading infrastructure. Coinbase's engineering blog documents their approach to: hot wallet management at scale (using HSMs, threshold signing, and geographic distribution), blockchain node infrastructure (running dozens of full nodes per chain for redundancy and load balancing), and incident response for blockchain-specific failures (blockchain forks, consensus issues, and smart contract exploits). These case studies reveal the operational practices that a mature crypto infrastructure team has developed over years.

The Ethereum Foundation's and Protocol Labs' infrastructure case studies reveal the challenges of operating core blockchain infrastructure: running the Ethereum beacon chain bootnodes, maintaining the IPFS bootstrap nodes, and coordinating global infrastructure upgrades for hard forks. These organizations face unique challenges (they are running infrastructure that the entire ecosystem depends on, with very limited ability to take downtime) that produce architectural solutions with wide applicability.

The "going multi-cloud" case study pattern appears in several blockchain infrastructure companies' engineering blogs: initially single-cloud, then adding a second cloud provider for redundancy, and eventually building a cloud-agnostic infrastructure that can run on any provider. The blockchain-specific dimension of this transition is that different cloud providers have different network topologies relative to Ethereum's p2p network, and geographic distribution affects both latency to peers and latency to end users.

Scaling event indexing infrastructure is a common theme across blockchain infrastructure case studies. The pattern that emerges consistently: start with a single indexer process, hit scaling limits due to single-threaded processing, add parallelism at the block level or the event level, hit database write contention limits, switch to bulk insert patterns, hit storage limits, implement data partitioning by time or by contract. Understanding this scaling journey allows staff engineers to design ahead of the current scale rather than reactively.

Bar-raiser signals: describing the specific infrastructure changes that Alchemy implemented to handle the CryptoKitties congestion event in 2017 (before they were Alchemy), or explaining how the Optimism Bedrock upgrade changed the infrastructure requirements for Optimism indexers (Bedrock changed the block production model and the transaction fee mechanism, requiring significant updates to any existing indexer's block processing and fee calculation logic). This level of historical infrastructure detail reveals deep ecosystem engagement.

---
