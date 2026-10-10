## 123.11 Complete Example: Production Web3 Infrastructure

Let's build a complete example that ties everything together:

```go
// cmd/web3-infra/main.go
package main

import (
    "context"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/gorilla/mux"
    "yourproject/pkg/web3"
    "yourproject/pkg/explorer"
)

func main() {
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    // Load configuration
    config := loadConfig()

    // Initialize infrastructure
    infra, err := initializeInfrastructure(config)
    if err != nil {
        log.Fatalf("Failed to initialize infrastructure: %v", err)
    }

    // Start infrastructure services
    if err := infra.Start(ctx); err != nil {
        log.Fatalf("Failed to start infrastructure: %v", err)
    }

    // Set up HTTP server
    router := mux.NewRouter()

    // Health check endpoint
    router.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        health := infra.Health()
        if health.Healthy {
            w.WriteHeader(http.StatusOK)
        } else {
            w.WriteHeader(http.StatusServiceUnavailable)
        }
        json.NewEncoder(w).Encode(health)
    })

    // Start HTTP server
    srv := &http.Server{
        Addr:         ":8080",
        Handler:      router,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
        IdleTimeout:  60 * time.Second,
    }

    go func() {
        log.Printf("Starting server on %s", srv.Addr)
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("Server error: %v", err)
        }
    }()

    // Wait for interrupt signal
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
    <-sigChan

    log.Println("Shutting down gracefully...")

    // Shutdown with timeout
    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    // Shutdown HTTP server
    if err := srv.Shutdown(shutdownCtx); err != nil {
        log.Printf("Server shutdown error: %v", err)
    }

    // Shutdown infrastructure
    if err := infra.Shutdown(shutdownCtx); err != nil {
        log.Printf("Infrastructure shutdown error: %v", err)
    }

    log.Println("Shutdown complete")
}

func loadConfig() web3.InfrastructureConfig {
    return web3.InfrastructureConfig{
        Nodes: []web3.NodeConfig{
            {
                URL:      "https://mainnet.infura.io/v3/YOUR_KEY",
                Type:     web3.NodeTypeFull,
                ChainID:  1,
                Priority: 1,
                Timeout:  10 * time.Second,
            },
            {
                URL:      "https://eth-mainnet.alchemyapi.io/v2/YOUR_KEY",
                Type:     web3.NodeTypeFull,
                ChainID:  1,
                Priority: 2,
                Timeout:  10 * time.Second,
            },
        },
        Storage: web3.StorageConfig{
            IPFSEndpoint: "localhost:5001",
            Gateway:      "https://ipfs.io",
        },
        Indexer: web3.IndexerConfig{
            GraphQLEndpoint: "https://api.thegraph.com/subgraphs/name/YOUR_SUBGRAPH",
        },
    }
}

func initializeInfrastructure(config web3.InfrastructureConfig) (*web3.Infrastructure, error) {
    infra, err := web3.NewInfrastructure(config)
    if err != nil {
        return nil, fmt.Errorf("failed to create infrastructure: %w", err)
    }

    return infra, nil
}
```

---

### Junior → FAANG: Complete Production Infrastructure Examples as Capstone Learning

A complete production Web3 infrastructure example is the capstone of blockchain engineering learning. Unlike isolated component examples, a complete example shows how all the pieces fit together: how the node feeds the indexer, how the indexer feeds the API, how monitoring wraps the whole thing, and how reorg handling is coordinated across components. Running and understanding this example is more valuable than any certification.

The most important thing to verify when running a complete infrastructure example is the reorg recovery path. On a local devmode node, trigger a simulated reorg by using Geth's `debug_setHead` to roll back the chain a few blocks, observe how your indexer detects the reorg (via block hash mismatch), reverses the database state, and replays the correct events. Testing this path explicitly, before any real value is at risk, is the junior engineer's responsibility.

For interview preparation, being able to describe a complete production infrastructure stack from memory demonstrates a level of systems understanding that distinguishes strong candidates. Practice narrating the complete flow: user submits a transaction through the frontend, the frontend calls your API, the API submits the transaction via a managed RPC connection, the transaction is monitored for confirmation, the indexer picks up the confirmation event, the database is updated, and the API serves the updated state to the frontend. This end-to-end narrative is the substance of a strong "design a Web3 backend" interview answer.

Infrastructure debugging skills are developed through running complete examples: when the indexer falls behind, you need to check node sync status, RPC error logs, and database write performance simultaneously to identify the bottleneck. This multi-component debugging skill is exactly what on-call engineers exercise during production incidents, and having practiced it in a safe environment makes you significantly more effective when the same issues arise in production.

### Senior @ FAANG: Complete Infrastructure Examples as Organizational Standards

At staff level, the complete production Web3 infrastructure example is the baseline reference implementation that the organization uses as the starting point for new projects. Its quality directly determines the quality floor for all derived work: if the reference implementation has correct reorg handling, all projects derived from it inherit correct reorg handling. If it lacks monitoring, all derived projects start without monitoring.

The reference implementation should be maintained as a living codebase, not a static document. Updates to the reference implementation (for new protocol features, performance improvements, or security patches) should propagate to derived projects through a defined update mechanism: a base library that projects depend on, a generator that produces scaffolding from the reference implementation, or a documented migration guide that teams follow when updating their projects to the current standard.

ADRs for new Web3 infrastructure projects should explicitly state how they differ from the reference implementation and why. "This project uses a custom event indexing approach instead of the reference implementation's approach because the event volume requires batched database writes that the reference implementation does not support" is a concrete and justified deviation. "We just used a different approach" is not.

The complete example's operational runbooks are as important as its code. Every failure mode that the code handles should have a corresponding runbook entry: what does the alert mean, what are the diagnostic steps, what is the remediation, and what is the escalation path. Staff engineers produce these runbooks alongside the code, not after the first production incident reveals that they are needed.

Bar-raiser signals: extending the complete production example to support a canary deployment model (running the new version of the indexer against a small fraction of block processing, verifying correctness against the existing version, before rolling out the new version to full production), or designing a blue-green deployment procedure for the indexer that allows zero-downtime upgrades by running the new indexer in parallel with the old one, verifying their outputs match, and then switching the API to the new indexer's database. These deployment engineering concerns reveal operational maturity.

---
