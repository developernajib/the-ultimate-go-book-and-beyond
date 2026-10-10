## 123.2 Running Ethereum Nodes

### Geth Full Node Setup

Running your own Ethereum node provides maximum decentralization and reliability. Here's how to manage Geth nodes from Go:

```go
// pkg/web3/node/geth.go
package node

import (
    "context"
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "syscall"
    "time"

    "github.com/ethereum/go-ethereum/ethclient"
    "github.com/ethereum/go-ethereum/rpc"
)

// GethConfig represents Geth node configuration
type GethConfig struct {
    DataDir         string
    NetworkID       uint64
    SyncMode        string // "snap", "full", "light"
    HTTPPort        int
    WSPort          int
    MaxPeers        int
    CacheSize       int // MB
    GCMode          string // "full", "archive"
    Metrics         bool
    MetricsPort     int
}

// GethNode manages a Geth Ethereum node
type GethNode struct {
    config  GethConfig
    cmd     *exec.Cmd
    client  *ethclient.Client
    rpcURL  string
    wsURL   string
}

// NewGethNode creates a new Geth node manager
func NewGethNode(config GethConfig) *GethNode {
    return &GethNode{
        config: config,
        rpcURL: fmt.Sprintf("http://localhost:%d", config.HTTPPort),
        wsURL:  fmt.Sprintf("ws://localhost:%d", config.WSPort),
    }
}

// Start starts the Geth node
func (g *GethNode) Start(ctx context.Context) error {
    // Ensure data directory exists
    if err := os.MkdirAll(g.config.DataDir, 0755); err != nil {
        return fmt.Errorf("failed to create data directory: %w", err)
    }

    // Build Geth command
    args := g.buildGethArgs()
    g.cmd = exec.CommandContext(ctx, "geth", args...)

    // Set up logging
    logFile, err := os.OpenFile(
        filepath.Join(g.config.DataDir, "geth.log"),
        os.O_CREATE|os.O_WRONLY|os.O_APPEND,
        0644,
    )
    if err != nil {
        return fmt.Errorf("failed to create log file: %w", err)
    }

    g.cmd.Stdout = logFile
    g.cmd.Stderr = logFile

    // Start the process
    if err := g.cmd.Start(); err != nil {
        return fmt.Errorf("failed to start geth: %w", err)
    }

    // Wait for node to be ready
    return g.waitForReady(ctx, 60*time.Second)
}

// buildGethArgs constructs Geth command-line arguments
func (g *GethNode) buildGethArgs() []string {
    args := []string{
        "--datadir", g.config.DataDir,
        "--networkid", fmt.Sprintf("%d", g.config.NetworkID),
        "--syncmode", g.config.SyncMode,
        "--http",
        "--http.addr", "0.0.0.0",
        "--http.port", fmt.Sprintf("%d", g.config.HTTPPort),
        "--http.api", "eth,net,web3,txpool",
        "--ws",
        "--ws.addr", "0.0.0.0",
        "--ws.port", fmt.Sprintf("%d", g.config.WSPort),
        "--ws.api", "eth,net,web3",
        "--maxpeers", fmt.Sprintf("%d", g.config.MaxPeers),
        "--cache", fmt.Sprintf("%d", g.config.CacheSize),
    }

    if g.config.GCMode == "archive" {
        args = append(args, "--gcmode", "archive")
        args = append(args, "--syncmode", "full")
    }

    if g.config.Metrics {
        args = append(args,
            "--metrics",
            "--metrics.addr", "0.0.0.0",
            "--metrics.port", fmt.Sprintf("%d", g.config.MetricsPort),
        )
    }

    return args
}

// waitForReady waits for the node to be ready to accept connections
func (g *GethNode) waitForReady(ctx context.Context, timeout time.Duration) error {
    ctx, cancel := context.WithTimeout(ctx, timeout)
    defer cancel()

    ticker := time.NewTicker(2 * time.Second)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return fmt.Errorf("timeout waiting for node to be ready")
        case <-ticker.C:
            // Try to connect
            client, err := ethclient.Dial(g.rpcURL)
            if err != nil {
                continue
            }

            // Test connection
            _, err = client.ChainID(context.Background())
            if err != nil {
                client.Close()
                continue
            }

            g.client = client
            return nil
        }
    }
}

// Client returns the Ethereum client
func (g *GethNode) Client() *ethclient.Client {
    return g.client
}

// Stop gracefully stops the Geth node
func (g *GethNode) Stop() error {
    if g.cmd == nil || g.cmd.Process == nil {
        return nil
    }

    // Close client connection
    if g.client != nil {
        g.client.Close()
    }

    // Send SIGTERM for graceful shutdown
    if err := g.cmd.Process.Signal(syscall.SIGTERM); err != nil {
        return fmt.Errorf("failed to send SIGTERM: %w", err)
    }

    // Wait for process to exit (with timeout)
    done := make(chan error, 1)
    go func() {
        done <- g.cmd.Wait()
    }()

    select {
    case <-time.After(30 * time.Second):
        // Force kill if graceful shutdown fails
        if err := g.cmd.Process.Kill(); err != nil {
            return fmt.Errorf("failed to kill process: %w", err)
        }
        return fmt.Errorf("forced kill after timeout")
    case err := <-done:
        return err
    }
}

// SyncProgress returns the current sync progress
func (g *GethNode) SyncProgress(ctx context.Context) (*SyncProgress, error) {
    var result any

    client, err := rpc.DialContext(ctx, g.rpcURL)
    if err != nil {
        return nil, fmt.Errorf("failed to dial RPC: %w", err)
    }
    defer client.Close()

    if err := client.CallContext(ctx, &result, "eth_syncing"); err != nil {
        return nil, fmt.Errorf("failed to get sync status: %w", err)
    }

    // If result is false, node is synced
    if syncing, ok := result.(bool); ok && !syncing {
        return &SyncProgress{
            Synced: true,
        }, nil
    }

    // Parse sync progress
    data, ok := result.(map[string]any)
    if !ok {
        return nil, fmt.Errorf("unexpected sync status format")
    }

    progress := &SyncProgress{
        Synced: false,
    }

    if current, ok := data["currentBlock"].(string); ok {
        fmt.Sscanf(current, "%d", &progress.CurrentBlock)
    }
    if highest, ok := data["highestBlock"].(string); ok {
        fmt.Sscanf(highest, "%d", &progress.HighestBlock)
    }

    if progress.HighestBlock > 0 {
        progress.Percentage = float64(progress.CurrentBlock) / float64(progress.HighestBlock) * 100
    }

    return progress, nil
}

// SyncProgress represents node synchronization progress
type SyncProgress struct {
    Synced       bool
    CurrentBlock uint64
    HighestBlock uint64
    Percentage   float64
}
```

### Light Client Implementation

Light clients provide a lightweight way to verify blockchain data without storing the full chain:

```go
// pkg/web3/node/light.go
package node

import (
    "context"
    "fmt"
    "time"

    "github.com/ethereum/go-ethereum/ethclient"
    "github.com/ethereum/go-ethereum/light"
)

// LightClientConfig represents light client configuration
type LightClientConfig struct {
    BootstrapNodes []string
    TrustedCheckpoint string
    MaxPeers       int
    DataDir        string
}

// LightClient manages an Ethereum light client
type LightClient struct {
    config LightClientConfig
    client *ethclient.Client
}

// NewLightClient creates a new light client
func NewLightClient(config LightClientConfig) (*LightClient, error) {
    return &LightClient{
        config: config,
    }, nil
}

// Start starts the light client
func (l *LightClient) Start(ctx context.Context) error {
    // Light clients connect to full nodes for data
    // In production, you'd implement the full light client protocol
    // For this example, we'll connect to a light client endpoint

    client, err := ethclient.Dial("http://localhost:8545") // Light node endpoint
    if err != nil {
        return fmt.Errorf("failed to connect to light client: %w", err)
    }

    l.client = client
    return nil
}

// Client returns the Ethereum client
func (l *LightClient) Client() *ethclient.Client {
    return l.client
}

// Stop stops the light client
func (l *LightClient) Stop() error {
    if l.client != nil {
        l.client.Close()
    }
    return nil
}
```

### Archive Node Management

Archive nodes are essential for historical state queries:

```go
// pkg/web3/node/archive.go
package node

import (
    "context"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
)

// ArchiveNode manages an archive node with historical state access
type ArchiveNode struct {
    client *ethclient.Client
    url    string
}

// NewArchiveNode creates a new archive node connection
func NewArchiveNode(url string) (*ArchiveNode, error) {
    client, err := ethclient.Dial(url)
    if err != nil {
        return nil, fmt.Errorf("failed to connect to archive node: %w", err)
    }

    return &ArchiveNode{
        client: client,
        url:    url,
    }, nil
}

// GetBalanceAt returns the balance of an account at a specific block
func (a *ArchiveNode) GetBalanceAt(
    ctx context.Context,
    account common.Address,
    blockNumber *big.Int,
) (*big.Int, error) {
    balance, err := a.client.BalanceAt(ctx, account, blockNumber)
    if err != nil {
        return nil, fmt.Errorf("failed to get balance at block %s: %w", blockNumber, err)
    }
    return balance, nil
}

// GetCodeAt returns the contract code at a specific block
func (a *ArchiveNode) GetCodeAt(
    ctx context.Context,
    contract common.Address,
    blockNumber *big.Int,
) ([]byte, error) {
    code, err := a.client.CodeAt(ctx, contract, blockNumber)
    if err != nil {
        return nil, fmt.Errorf("failed to get code at block %s: %w", blockNumber, err)
    }
    return code, nil
}

// IsArchiveNode verifies if the connected node is an archive node
func (a *ArchiveNode) IsArchiveNode(ctx context.Context) (bool, error) {
    // Try to query a very old block's state
    // If it's not an archive node, this will fail
    oldBlock := big.NewInt(1000000) // An old block number

    _, err := a.client.BalanceAt(
        ctx,
        common.HexToAddress("0x0000000000000000000000000000000000000000"),
        oldBlock,
    )

    if err != nil {
        return false, nil
    }

    return true, nil
}

// Close closes the archive node connection
func (a *ArchiveNode) Close() {
    a.client.Close()
}
```

### Node Monitoring

Monitoring node health and performance is critical:

```go
// pkg/web3/node/monitor.go
package node

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/ethereum/go-ethereum/ethclient"
)

// NodeMetrics represents node performance metrics
type NodeMetrics struct {
    BlockNumber      uint64
    PeerCount        uint64
    SyncProgress     *SyncProgress
    LatestBlockTime  time.Time
    ResponseTime     time.Duration
    ErrorRate        float64
    IsHealthy        bool
    LastChecked      time.Time
}

// NodeMonitor monitors node health and performance
type NodeMonitor struct {
    client       *ethclient.Client
    metrics      NodeMetrics
    mu           sync.RWMutex
    checkInterval time.Duration
    alertChan    chan Alert
}

// Alert represents a monitoring alert
type Alert struct {
    Level   string // "warning", "critical"
    Message string
    Time    time.Time
}

// NewNodeMonitor creates a new node monitor
func NewNodeMonitor(client *ethclient.Client, checkInterval time.Duration) *NodeMonitor {
    return &NodeMonitor{
        client:        client,
        checkInterval: checkInterval,
        alertChan:     make(chan Alert, 100),
    }
}

// Start starts the monitoring loop
func (m *NodeMonitor) Start(ctx context.Context) {
    ticker := time.NewTicker(m.checkInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            m.check(ctx)
        }
    }
}

// check performs a health check
func (m *NodeMonitor) check(ctx context.Context) {
    start := time.Now()

    metrics := NodeMetrics{
        LastChecked: start,
        IsHealthy:   true,
    }

    // Check block number
    blockNumber, err := m.client.BlockNumber(ctx)
    if err != nil {
        m.sendAlert(Alert{
            Level:   "critical",
            Message: fmt.Sprintf("Failed to get block number: %v", err),
            Time:    time.Now(),
        })
        metrics.IsHealthy = false
    } else {
        metrics.BlockNumber = blockNumber
    }

    // Check peer count
    var peerCount uint64
    // Note: This requires the net_peerCount RPC method
    // metrics.PeerCount = peerCount

    // Measure response time
    metrics.ResponseTime = time.Since(start)
    if metrics.ResponseTime > 5*time.Second {
        m.sendAlert(Alert{
            Level:   "warning",
            Message: fmt.Sprintf("High response time: %v", metrics.ResponseTime),
            Time:    time.Now(),
        })
    }

    // Check if blocks are being produced
    m.mu.RLock()
    lastBlockNumber := m.metrics.BlockNumber
    m.mu.RUnlock()

    if blockNumber == lastBlockNumber {
        m.sendAlert(Alert{
            Level:   "warning",
            Message: "Block number hasn't changed",
            Time:    time.Now(),
        })
    }

    // Update metrics
    m.mu.Lock()
    m.metrics = metrics
    m.mu.Unlock()
}

// sendAlert sends a monitoring alert
func (m *NodeMonitor) sendAlert(alert Alert) {
    select {
    case m.alertChan <- alert:
    default:
        // Alert channel full, skip
    }
}

// GetMetrics returns current node metrics
func (m *NodeMonitor) GetMetrics() NodeMetrics {
    m.mu.RLock()
    defer m.mu.RUnlock()
    return m.metrics
}

// Alerts returns the alert channel
func (m *NodeMonitor) Alerts() <-chan Alert {
    return m.alertChan
}
```

### Junior → FAANG: Running Ethereum Nodes as Operational Infrastructure

Running your own Ethereum node gives you full control over your RPC access, eliminates third-party rate limits, and provides the freshest possible data. But it also makes you responsible for synchronization, updates, disk management, and availability. Before deciding to run your own node, understand what you are signing up for: an Ethereum full node requires approximately 1 TB of disk space (for Geth with pruning), 16 GB of RAM, a fast SSD (NVMe recommended), and a stable internet connection with 8+ Mbps bandwidth.

The initial sync is the most resource-intensive phase. Snap sync (the default for Geth) downloads the current state snapshot and then catches up with recent blocks, taking 1-3 days for a typical setup. Full sync (replaying every block from genesis) takes weeks. Use snap sync unless you have a specific reason to replay all transactions from genesis. An archive node (which stores all historical state, not just the pruned current state) requires 12+ TB of disk space and is needed only for applications that query historical state beyond the last 128 blocks.

For interview preparation, be able to describe the configuration for a production-ready Geth node: relevant command-line flags (`--syncmode snap`, `--gcmode full` for non-archive or `--gcmode archive` for archive, `--authrpc.addr` for Engine API, `--http.api` to limit exposed namespaces), monitoring configuration (pprof for profiling, metrics for Prometheus export), and the operational runbook for common issues (out of sync, out of disk space, peer count dropping to zero).

First-job habit: when your node is running, subscribe to the go-ethereum GitHub releases and the Ethereum client notification channels (Discord, mailing lists). Node client vulnerabilities and required upgrades are announced through these channels, and failing to upgrade before a hard fork or after a critical security fix can leave your infrastructure in a degraded or vulnerable state.

### Senior @ FAANG: Ethereum Node Infrastructure at Production Scale

At staff level, running Ethereum nodes is a distributed systems operational problem. A production deployment of Ethereum nodes has: a load balancer that distributes read traffic across multiple nodes, a dedicated node or set of nodes for transaction submission (to avoid read traffic affecting submission latency), health checks that detect when a node is out of sync or has insufficient peers, automated failover when a node fails its health check, and alerting for disk usage, peer count, and block lag.

Multi-client strategy for production Ethereum node infrastructure is a best practice for resilience and for detecting client-specific bugs. Running Geth and Erigon (or Nethermind) in parallel allows cross-client response validation: if the two clients return different results for the same RPC call, one of them has a bug or is on a fork. Staff engineers implement cross-client validation for critical read operations (block hash verification, receipt status confirmation) and alert when clients diverge.

Engine API configuration and security is a specific concern for post-Merge Ethereum nodes. The Engine API is the interface between the execution client (Geth) and the consensus client (Prysm, Lighthouse, etc.). It must be accessible to the consensus client but not exposed publicly. The authentication uses a JWT secret (a 32-byte random value shared between the two clients). Staff engineers manage the JWT secret rotation (Ethereum clients support hot rotation without restart), ensure the Engine API is accessible only on a private network interface, and monitor for unauthorized access attempts.

Disk management for Ethereum nodes requires ongoing attention. Geth's offline pruning command (`geth snapshot prune-state`) reclaims disk space occupied by old state snapshots but requires the node to be offline during the operation. Planning for regular pruning cycles, maintaining enough free disk space for the pruning operation to complete (typically 50-100 GB headroom required), and coordinating pruning with the load balancer failover (to avoid downtime during pruning) is an operational discipline that staff engineers codify in runbooks.

Node monitoring at production scale requires a custom Prometheus metrics pipeline that tracks: block height (with comparison to a trusted external source to detect forks), peer count (fewer than 10 peers indicates connectivity issues), block processing time (anomalous spikes indicate the node is struggling), pending transaction count in the mempool (large backlogs indicate network congestion), and disk usage trend (to predict when expansion is needed before the node fills the disk). Staff engineers design dashboards that surface these metrics alongside application-level metrics for holistic observability.

Bar-raiser signals: designing an Ethereum node upgrade procedure for a production cluster that achieves zero downtime (by upgrading one node at a time, with health checks before removing each node from the load balancer rotation, and rolling back if the new version shows anomalous behavior), or explaining the difference between Geth's full sync and archive sync at the level of the LevelDB storage layout (full sync prunes historical state records that are no longer referenced by the current state trie, while archive sync retains all historical state records referenced by any historical state trie). These operational details reveal genuine hands-on experience.

---
