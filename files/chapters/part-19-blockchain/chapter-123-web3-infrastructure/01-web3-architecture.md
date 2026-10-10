## 123.1 Web3 Architecture

### Overview of Web3 Infrastructure Components

A typical Web3 application relies on several infrastructure layers:

```
┌─────────────────────────────────────────────────────────────┐
│                     Application Layer                       │
│              (Smart Contract Interactions)                  │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │
┌─────────────────────────────────────────────────────────────┐
│                   Infrastructure Layer                      │
├─────────────────┬──────────────────┬────────────────────────┤
│   RPC Nodes     │  Indexing Service│  Decentralized Storage │
│   (Geth, etc)   │   (The Graph)    │      (IPFS)            │
└─────────────────┴──────────────────┴────────────────────────┘
                            ▲
                            │
┌─────────────────────────────────────────────────────────────┐
│                    Blockchain Network                       │
│              (Ethereum, Polygon, etc.)                      │
└─────────────────────────────────────────────────────────────┘
```

### Node Infrastructure

Blockchain nodes are the primary interface to blockchain networks. There are several types:

1. **Full Nodes**: Store the entire blockchain, validate all transactions and blocks
2. **Light Nodes**: Store only block headers, verify proofs from full nodes
3. **Archive Nodes**: Full nodes that store all historical state (required for historical queries)

### RPC Providers

RPC (Remote Procedure Call) providers allow applications to interact with blockchain nodes:

- **Self-hosted**: Run your own nodes (Geth, Erigon, etc.)
- **Managed services**: Infura, Alchemy, QuickNode, etc.
- **Hybrid**: Combination of self-hosted and managed services for redundancy

### Indexing Services

Blockchain data is optimized for writing, not querying. Indexing services solve this:

- **The Graph**: Decentralized indexing protocol using GraphQL
- **Custom indexers**: Application-specific event indexing
- **Database replicas**: Full blockchain state in SQL/NoSQL databases

### Decentralized Storage

Storing large files on-chain is prohibitively expensive. Decentralized storage solutions:

- **IPFS**: Content-addressed distributed file system
- **Arweave**: Permanent storage blockchain
- **Filecoin**: Incentivized storage network

The following infrastructure manager coordinates these components:

```go
// pkg/web3/infrastructure.go
package web3

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/ethereum/go-ethereum/ethclient"
    ipfs "github.com/ipfs/go-ipfs-api"
)

// NodeType represents different types of blockchain nodes
type NodeType int

const (
    NodeTypeFull NodeType = iota
    NodeTypeLight
    NodeTypeArchive
)

// NodeConfig represents configuration for a blockchain node
type NodeConfig struct {
    URL         string
    Type        NodeType
    ChainID     uint64
    Priority    int // Lower is higher priority
    MaxRetries  int
    Timeout     time.Duration
}

// StorageConfig represents decentralized storage configuration
type StorageConfig struct {
    IPFSEndpoint string
    Gateway      string
    PinataAPIKey string
}

// IndexerConfig represents indexing service configuration
type IndexerConfig struct {
    GraphQLEndpoint string
    SubgraphID      string
    APIKey          string
}

// InfrastructureConfig is the complete infrastructure configuration
type InfrastructureConfig struct {
    Nodes    []NodeConfig
    Storage  StorageConfig
    Indexer  IndexerConfig
}

// Infrastructure manages all Web3 infrastructure components
type Infrastructure struct {
    config      InfrastructureConfig
    rpcPool     *RPCPool
    ipfsClient  *ipfs.Shell
    indexer     *GraphIndexer
    health      *HealthChecker
    mu          sync.RWMutex
}

// NewInfrastructure creates a new infrastructure manager
func NewInfrastructure(config InfrastructureConfig) (*Infrastructure, error) {
    infra := &Infrastructure{
        config: config,
    }

    // Initialize RPC pool
    rpcPool, err := NewRPCPool(config.Nodes)
    if err != nil {
        return nil, fmt.Errorf("failed to create RPC pool: %w", err)
    }
    infra.rpcPool = rpcPool

    // Initialize IPFS client
    if config.Storage.IPFSEndpoint != "" {
        infra.ipfsClient = ipfs.NewShell(config.Storage.IPFSEndpoint)
    }

    // Initialize indexer
    if config.Indexer.GraphQLEndpoint != "" {
        infra.indexer = NewGraphIndexer(config.Indexer)
    }

    // Initialize health checker
    infra.health = NewHealthChecker(infra)

    return infra, nil
}

// Start starts all infrastructure services
func (i *Infrastructure) Start(ctx context.Context) error {
    // Start health checker
    go i.health.Run(ctx)

    // Start RPC pool monitoring
    go i.rpcPool.Monitor(ctx)

    return nil
}

// GetClient returns an RPC client from the pool
func (i *Infrastructure) GetClient() (*ethclient.Client, error) {
    return i.rpcPool.GetClient()
}

// GetIPFS returns the IPFS client
func (i *Infrastructure) GetIPFS() *ipfs.Shell {
    return i.ipfsClient
}

// GetIndexer returns the Graph indexer
func (i *Infrastructure) GetIndexer() *GraphIndexer {
    return i.indexer
}

// Health returns the current health status
func (i *Infrastructure) Health() HealthStatus {
    return i.health.Status()
}

// Shutdown gracefully shuts down all infrastructure components
func (i *Infrastructure) Shutdown(ctx context.Context) error {
    i.mu.Lock()
    defer i.mu.Unlock()

    var errors []error

    // Close RPC pool
    if err := i.rpcPool.Close(); err != nil {
        errors = append(errors, fmt.Errorf("RPC pool shutdown error: %w", err))
    }

    if len(errors) > 0 {
        return fmt.Errorf("shutdown errors: %v", errors)
    }

    return nil
}
```

### Junior → FAANG: Web3 Architecture Mental Model

Web3 architecture is the set of components that sit between your Go application and the Ethereum blockchain. Understanding this architecture at a conceptual level is prerequisite to understanding why specific components are needed and what failure modes each component introduces. The architecture has four layers: the node layer (Ethereum clients that maintain state and serve RPC), the indexing layer (services that make on-chain events queryable), the application layer (your Go backend that implements business logic), and the interface layer (APIs and WebSocket endpoints that your frontend consumes).

The most important architectural insight for junior engineers is that the blockchain is not a database: it has no join operations, no indexed queries, and no way to ask "give me all Transfer events for address X from the last 30 days" efficiently. These queries require the indexing layer, which listens to blockchain events and stores them in a relational or document database that supports efficient querying. Without the indexing layer, every query that touches historical data requires expensive, slow full-range log scanning.

For interview preparation, draw the Web3 architecture for a specific DApp (a decentralized exchange frontend, for example). The frontend requests a price quote from the aggregator API (application layer), which queries its indexed database for the most recent prices (indexing layer), which were populated from events emitted by the DEX contracts (node layer). Having this specific architecture in your head makes system design questions much easier to answer.

First-job habit: identify which layer is responsible for each piece of data in the systems you work on. Data from the node layer (direct RPC calls) is authoritative but slow. Data from the indexing layer is fast but may lag the chain by a few seconds. Data from a cache layer is fastest but may be stale. Knowing which layer your data comes from tells you how fresh and trustworthy it is.

### Senior @ FAANG: Web3 Architecture as a Trade-off Framework

At staff level, Web3 architecture decisions are trade-offs between latency, cost, consistency, and correctness. Running your own full node provides the freshest and most trustworthy data but costs more in infrastructure than a third-party provider. Using a third-party indexing service is cheaper and faster to implement than a custom indexer but less flexible. Each architectural choice has a specific trade-off profile that must match the application's requirements.

The layered caching architecture for Web3 is more complex than for traditional applications because different blockchain data has different immutability properties. Block data that is finalized can be cached indefinitely. Recent block data (within 128 blocks) is subject to reorg and should be cached with a short TTL or not cached at all. Smart contract state queries are subject to the state at the queried block and can be cached for finalized blocks. Staff engineers design caching strategies that exploit the immutability of finalized data while correctly handling the mutability of recent data.

Multi-client diversity is an architectural requirement for the highest-reliability Ethereum infrastructure. Running multiple execution client implementations (Geth plus Erigon, or Geth plus Nethermind) means that a bug specific to one client implementation will not affect the other. This is particularly important for validators (consensus diversity reduces correlated slashing risk) and for high-value applications that need to detect if one of their nodes is on a fork. Staff engineers design their infrastructure to run at least two different client implementations and to detect discrepancies between their outputs.

The separation between the indexing architecture and the serving architecture is a scaling decision. An indexer that writes to the database and a query service that reads from the same database compete for database I/O at high load. Separating them (the indexer writes to a primary database, the query service reads from a replica) allows both to scale independently and protects the indexer's write throughput from being affected by query load spikes. Staff engineers design this separation into the initial architecture rather than adding it under load as a panicked scaling fix.

Web3 architecture for multi-chain applications has an additional dimension: the trust and finality model of each chain differs, the RPC interfaces differ (Ethereum JSON-RPC is not identical across all EVM chains), and the event log semantics may differ (some chains have different log limits or different reorg depths). A unified multi-chain architecture must abstract over these differences while preserving the chain-specific correctness requirements. Staff engineers design the abstraction boundary carefully to avoid hiding semantically important differences behind a common interface.

Bar-raiser signals: designing a Web3 architecture for an application that needs real-time (<1 second) updates on Ethereum mainnet events while also providing historical query capability for events from the last two years (requires combining a WebSocket subscription for real-time events, an indexer for historical data, and an archive node for state queries at historical block numbers), or explaining the trade-off between using a pre-built indexing framework (SubQuery, Subsquid, Goldsky) versus building a custom indexer (custom gives control over the exact indexing logic, pre-built gives faster time-to-market but less flexibility for non-standard event schemas). These architectural choices are the substance of real senior engineering decisions.

---
