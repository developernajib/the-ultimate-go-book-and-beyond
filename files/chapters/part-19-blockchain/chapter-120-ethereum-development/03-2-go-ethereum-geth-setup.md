## 120.2 Go-Ethereum (Geth) Setup

### 2.1 Installing go-ethereum

The go-ethereum library is the official Go implementation of the Ethereum protocol.

```bash
# Install go-ethereum package
go get github.com/ethereum/go-ethereum@latest

# For CLI tools (geth, abigen, bootnode, etc.)
git clone https://github.com/ethereum/go-ethereum.git
cd go-ethereum
make all

# Verify installation
geth version
abigen --version
```

### 2.2 Connecting to Ethereum Networks

**Available Networks**:
- **Mainnet**: Production Ethereum network (Chain ID: 1)
- **Sepolia**: Recommended testnet (Chain ID: 11155111)
- **Holesky**: Consensus layer testnet (Chain ID: 17000)
- **Local**: Ganache, Hardhat, or local Geth development node

**Connection Methods**:
- **IPC**: Fast local connection via Unix socket
- **HTTP/HTTPS**: Remote connection via RPC
- **WebSocket**: Bidirectional connection for subscriptions

### 2.3 Creating an Ethereum Client

The client factory selects IPC, WebSocket, or HTTP transport based on the endpoint URL prefix so the same setup code works in local development against Geth and in production against a managed node provider like Infura. A connection health check immediately after `Dial` surfaces misconfigured endpoints at startup rather than on the first actual RPC call minutes later.

```go
// cmd/ethclient/main.go
package main

import (
    "context"
    "fmt"
    "log"
    "math/big"
    "time"

    "github.com/ethereum/go-ethereum/ethclient"
)

func main() {
    // Connect to Ethereum node
    // Use Infura, Alchemy, or your own node
    client, err := ethclient.Dial("https://eth-sepolia.g.alchemy.com/v2/YOUR-API-KEY")
    if err != nil {
        log.Fatalf("Failed to connect to Ethereum client: %v", err)
    }
    defer client.Close()

    // Verify connection by getting latest block number
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    blockNumber, err := client.BlockNumber(ctx)
    if err != nil {
        log.Fatalf("Failed to get block number: %v", err)
    }

    fmt.Printf("Connected to Ethereum! Latest block: %d\n", blockNumber)

    // Get network chain ID
    chainID, err := client.ChainID(ctx)
    if err != nil {
        log.Fatalf("Failed to get chain ID: %v", err)
    }

    fmt.Printf("Chain ID: %d\n", chainID)

    // Check network syncing status
    syncProgress, err := client.SyncProgress(ctx)
    if err != nil {
        log.Fatalf("Failed to get sync progress: %v", err)
    }

    if syncProgress == nil {
        fmt.Println("Node is fully synced")
    } else {
        fmt.Printf("Node syncing: %d/%d blocks\n",
            syncProgress.CurrentBlock, syncProgress.HighestBlock)
    }
}
```

### 2.4 Production-Ready Client with Retry Logic

Real-world applications need reliable error handling and retries:

```go
// pkg/ethclient/client.go
package ethclient

import (
    "context"
    "errors"
    "fmt"
    "math/big"
    "sync"
    "time"

    "github.com/ethereum/go-ethereum/ethclient"
)

// Config holds Ethereum client configuration
type Config struct {
    RPCEndpoints      []string      // Multiple endpoints for failover
    MaxRetries        int           // Maximum retry attempts
    RetryDelay        time.Duration // Delay between retries
    RequestTimeout    time.Duration // Timeout for individual requests
    HealthCheckInterval time.Duration // How often to check endpoint health
}

// Client wraps go-ethereum client with production features
type Client struct {
    config    Config
    clients   []*ethclient.Client
    current   int           // Current active client index
    mu        sync.RWMutex
    chainID   *big.Int
}

// NewClient creates a new production-ready Ethereum client
func NewClient(cfg Config) (*Client, error) {
    if len(cfg.RPCEndpoints) == 0 {
        return nil, errors.New("at least one RPC endpoint required")
    }

    // Set defaults
    if cfg.MaxRetries == 0 {
        cfg.MaxRetries = 3
    }
    if cfg.RetryDelay == 0 {
        cfg.RetryDelay = 1 * time.Second
    }
    if cfg.RequestTimeout == 0 {
        cfg.RequestTimeout = 30 * time.Second
    }
    if cfg.HealthCheckInterval == 0 {
        cfg.HealthCheckInterval = 1 * time.Minute
    }

    c := &Client{
        config:  cfg,
        clients: make([]*ethclient.Client, len(cfg.RPCEndpoints)),
    }

    // Connect to all endpoints
    for i, endpoint := range cfg.RPCEndpoints {
        client, err := ethclient.Dial(endpoint)
        if err != nil {
            return nil, fmt.Errorf("failed to connect to %s: %w", endpoint, err)
        }
        c.clients[i] = client
    }

    // Get and verify chain ID
    ctx, cancel := context.WithTimeout(context.Background(), cfg.RequestTimeout)
    defer cancel()

    chainID, err := c.clients[0].ChainID(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to get chain ID: %w", err)
    }
    c.chainID = chainID

    // Verify all endpoints are on the same chain
    for i := 1; i < len(c.clients); i++ {
        ctx, cancel := context.WithTimeout(context.Background(), cfg.RequestTimeout)
        id, err := c.clients[i].ChainID(ctx)
        cancel()
        if err != nil || id.Cmp(chainID) != 0 {
            return nil, fmt.Errorf("endpoint %s has different chain ID", cfg.RPCEndpoints[i])
        }
    }

    // Start health monitoring
    go c.healthCheck()

    return c, nil
}

// healthCheck periodically checks endpoint health and switches if needed
func (c *Client) healthCheck() {
    ticker := time.NewTicker(c.config.HealthCheckInterval)
    defer ticker.Stop()

    for range ticker.C {
        ctx, cancel := context.WithTimeout(context.Background(), c.config.RequestTimeout)
        _, err := c.getClient().BlockNumber(ctx)
        cancel()

        if err != nil {
            // Current client unhealthy, try to switch
            c.switchClient()
        }
    }
}

// getClient returns the currently active client
func (c *Client) getClient() *ethclient.Client {
    c.mu.RLock()
    defer c.mu.RUnlock()
    return c.clients[c.current]
}

// switchClient switches to next available client
func (c *Client) switchClient() {
    c.mu.Lock()
    defer c.mu.Unlock()

    original := c.current
    for i := 0; i < len(c.clients); i++ {
        c.current = (c.current + 1) % len(c.clients)
        if c.current != original {
            // Test new client
            ctx, cancel := context.WithTimeout(context.Background(), c.config.RequestTimeout)
            _, err := c.clients[c.current].BlockNumber(ctx)
            cancel()
            if err == nil {
                // Healthy client found
                return
            }
        }
    }
    // All clients unhealthy, stay on current
}

// withRetry executes a function with retry logic
func (c *Client) withRetry(ctx context.Context, fn func() error) error {
    var lastErr error
    for attempt := 0; attempt <= c.config.MaxRetries; attempt++ {
        if attempt > 0 {
            // Exponential backoff
            delay := c.config.RetryDelay * time.Duration(1<<uint(attempt-1))
            select {
            case <-time.After(delay):
            case <-ctx.Done():
                return ctx.Err()
            }
        }

        lastErr = fn()
        if lastErr == nil {
            return nil
        }

        // Try next client on error
        c.switchClient()
    }
    return fmt.Errorf("max retries exceeded: %w", lastErr)
}

// BlockNumber returns the latest block number with retry logic
func (c *Client) BlockNumber(ctx context.Context) (uint64, error) {
    var blockNum uint64
    err := c.withRetry(ctx, func() error {
        var err error
        blockNum, err = c.getClient().BlockNumber(ctx)
        return err
    })
    return blockNum, err
}

// ChainID returns the chain ID
func (c *Client) ChainID() *big.Int {
    return new(big.Int).Set(c.chainID)
}

// Close closes all client connections
func (c *Client) Close() {
    c.mu.Lock()
    defer c.mu.Unlock()
    for _, client := range c.clients {
        client.Close()
    }
}
```

---

### Junior → FAANG: Setting Up Go-Ethereum Correctly from the Start

Setting up go-ethereum correctly is a prerequisite that blocks all subsequent Ethereum development in Go. The most common setup mistake for juniors is importing `github.com/ethereum/go-ethereum` at a specific version and then discovering that other packages they need (like a specific DeFi protocol's generated bindings) have dependency conflicts with their go-ethereum version. Always check the go-ethereum version requirements of your other dependencies before pinning.

The second common setup mistake is using `go get github.com/ethereum/go-ethereum` and getting the latest version without considering breaking changes. go-ethereum uses semantic versioning but has made breaking API changes in minor versions in the past. Review the go-ethereum changelog for any version you are adopting and pay particular attention to changes in the `ethclient`, `accounts/abi`, and `crypto` packages, which are the most commonly used in application code.

For connecting to Ethereum, the correct setup uses `ethclient.Dial` for HTTP connections and `ethclient.DialContext` with a `context.Context` for connections that should respect cancellation. The `ethclient.Client` object is safe for concurrent use: share a single client instance across all goroutines rather than creating one per goroutine, as each dial creates a new connection.

Interview entry point: explain the difference between a WebSocket connection (`wss://`) and an HTTP connection for Ethereum RPC. WebSocket connections support `eth_subscribe` for push-based event notifications. HTTP connections require polling. For applications that monitor blockchain events in real time (transaction confirmations, smart contract events), WebSocket subscriptions are dramatically more efficient than polling but require more careful connection management (handling disconnections and reconnecting with missed event replay).

### Senior @ FAANG: Go-Ethereum as Platform Infrastructure

At staff level, go-ethereum is not just a library in your application's dependency list: it is a platform component whose version, configuration, and usage patterns must be standardized across the organization. Running different teams on different versions of go-ethereum creates maintenance burden and can produce subtle behavioral differences if the RLP encoding or transaction signing behavior differs between versions.

The ADR for go-ethereum standardization across a multi-team organization should address: the version pinning and upgrade cadence, the internal wrapper package that all teams use rather than calling go-ethereum APIs directly (this wrapper is the place where organizational conventions like structured logging and metrics are enforced), the approved subset of go-ethereum features that are considered stable for production use, and the process for evaluating and rolling out major version upgrades.

Running an embedded Geth node (using go-ethereum as a library to run an in-process Ethereum node) is a valid architecture for certain use cases: development environments, private chains, and testing. The setup for an embedded node is significantly more complex than using `ethclient.Dial` to connect to an external node: you need to configure the genesis block, the chain database, the p2p network, the consensus engine, and the RPC server. Staff engineers who design systems using embedded nodes must account for the resource consumption (the in-process node consumes significant memory and CPU) and the upgrade complexity (upgrading the embedded node version may require a data migration).

Geth setup for production validators involves configuration concerns beyond application development: JWT authentication for the Engine API (a shared secret between the execution client and consensus client), the `--authrpc` interface configuration, pprof for profiling, and proper log rotation. Staff engineers maintain infrastructure-as-code templates for Geth deployment that are version-controlled and reviewed like application code.

Monitoring go-ethereum's health from application code requires using the admin and debug namespaces (which must be explicitly enabled and should not be exposed on public interfaces): `admin_peers` for peer count and quality, `debug_gcStats` for memory pressure, and `eth_syncing` for sync status. Staff engineers implement monitoring dashboards that display these metrics alongside application-level metrics, so that node health and application health are visible in the same place.

Bar-raiser signals: explaining the Snap sync protocol and why it is significantly faster than the older fast sync for initial node bootstrapping (Snap sync downloads a snapshot of the current state rather than re-executing all transactions from genesis), or designing a Geth deployment that can serve both the application's RPC needs and the consensus client's Engine API needs while maintaining appropriate access control between the two interfaces. These operational details reveal hands-on production experience.

---
