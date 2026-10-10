## 120.8 Building a DApp Backend

### 8.1 Complete DApp Backend Structure

The DApp entry point starts both the Ethereum event indexer and the HTTP server as concurrent goroutines, each running until an OS signal triggers a context cancellation that propagates through both subsystems. Graceful shutdown gives in-flight HTTP requests time to complete while the event subscriber closes its WebSocket connection cleanly, preventing gaps in the event index.

```go
// cmd/dapp/main.go
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/gin-gonic/gin"
    "yourmodule/internal/ethereum"
    "yourmodule/internal/handlers"
)

func main() {
    // Load configuration
    config := ethereum.Config{
        RPCEndpoint:    os.Getenv("ETHEREUM_RPC"),
        PrivateKey:     os.Getenv("ETHEREUM_PRIVATE_KEY"),
        ContractAddr:   os.Getenv("CONTRACT_ADDRESS"),
    }

    // Initialize Ethereum service
    ethService, err := ethereum.NewService(config)
    if err != nil {
        log.Fatalf("Failed to initialize Ethereum service: %v", err)
    }
    defer ethService.Close()

    // Start event listener in background
    go ethService.StartEventListener()

    // Setup HTTP server
    router := gin.Default()

    h := handlers.NewHandler(ethService)

    // Routes
    router.GET("/health", h.Health)
    router.GET("/balance/:address", h.GetBalance)
    router.GET("/token/info", h.GetTokenInfo)
    router.POST("/transfer", h.Transfer)
    router.GET("/transfers/:address", h.GetTransferHistory)

    server := &http.Server{
        Addr:    ":8080",
        Handler: router,
    }

    // Graceful shutdown
    go func() {
        if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("Server error: %v", err)
        }
    }()

    log.Println("Server started on :8080")

    // Wait for interrupt signal
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    log.Println("Shutting down server...")

    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        log.Fatal("Server forced to shutdown:", err)
    }

    log.Println("Server exited")
}
```

### 8.2 Ethereum Service Layer

The service layer owns the Ethereum client lifecycle and contract binding, exposing domain methods like `GetBalance` and `Transfer` that hide RPC details from HTTP handlers. A `sync.RWMutex` guards nonce management so concurrent transaction submissions from different HTTP requests do not use the same nonce, which would cause all but one to be dropped by the mempool.

```go
// internal/ethereum/service.go
package ethereum

import (
    "context"
    "crypto/ecdsa"
    "fmt"
    "math/big"
    "sync"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/crypto"
    "github.com/ethereum/go-ethereum/ethclient"

    "yourmodule/pkg/token"
)

type Config struct {
    RPCEndpoint  string
    PrivateKey   string
    ContractAddr string
}

type Service struct {
    client       *ethclient.Client
    contract     *token.SimpleToken
    privateKey   *ecdsa.PrivateKey
    address      common.Address
    contractAddr common.Address
    chainID      *big.Int
    mu           sync.RWMutex
}

func NewService(cfg Config) (*Service, error) {
    client, err := ethclient.Dial(cfg.RPCEndpoint)
    if err != nil {
        return nil, fmt.Errorf("failed to connect: %w", err)
    }

    privateKey, err := crypto.HexToECDSA(cfg.PrivateKey)
    if err != nil {
        return nil, fmt.Errorf("invalid private key: %w", err)
    }

    publicKey := privateKey.Public().(*ecdsa.PublicKey)
    address := crypto.PubkeyToAddress(*publicKey)

    contractAddr := common.HexToAddress(cfg.ContractAddr)
    contract, err := token.NewSimpleToken(contractAddr, client)
    if err != nil {
        return nil, fmt.Errorf("failed to load contract: %w", err)
    }

    chainID, err := client.ChainID(context.Background())
    if err != nil {
        return nil, fmt.Errorf("failed to get chain ID: %w", err)
    }

    return &Service{
        client:       client,
        contract:     contract,
        privateKey:   privateKey,
        address:      address,
        contractAddr: contractAddr,
        chainID:      chainID,
    }, nil
}

func (s *Service) GetBalance(address common.Address) (*big.Int, error) {
    return s.contract.BalanceOf(nil, address)
}

func (s *Service) GetTokenInfo() (name, symbol string, decimals uint8, totalSupply *big.Int, err error) {
    name, err = s.contract.Name(nil)
    if err != nil {
        return
    }

    symbol, err = s.contract.Symbol(nil)
    if err != nil {
        return
    }

    decimals, err = s.contract.Decimals(nil)
    if err != nil {
        return
    }

    totalSupply, err = s.contract.TotalSupply(nil)
    return
}

func (s *Service) Transfer(to common.Address, amount *big.Int) (common.Hash, error) {
    s.mu.Lock()
    defer s.mu.Unlock()

    auth, err := bind.NewKeyedTransactorWithChainID(s.privateKey, s.chainID)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to create transactor: %w", err)
    }

    tx, err := s.contract.Transfer(auth, to, amount)
    if err != nil {
        return common.Hash{}, fmt.Errorf("failed to send transaction: %w", err)
    }

    return tx.Hash(), nil
}

func (s *Service) StartEventListener() {
    // Implementation from section 7.1
}

func (s *Service) Close() {
    s.client.Close()
}
```

### 8.3 HTTP Handlers

The HTTP handlers translate between the Gin request model and the Ethereum service layer, parsing address strings and amount values from JSON before calling into the service. Returning the transaction hash immediately after submission lets the frontend poll for confirmation rather than blocking the HTTP connection for the 12+ seconds a block confirmation takes.

```go
// internal/handlers/handlers.go
package handlers

import (
    "math/big"
    "net/http"

    "github.com/ethereum/go-ethereum/common"
    "github.com/gin-gonic/gin"

    "yourmodule/internal/ethereum"
)

type Handler struct {
    eth *ethereum.Service
}

func NewHandler(eth *ethereum.Service) *Handler {
    return &Handler{eth: eth}
}

func (h *Handler) Health(c *gin.Context) {
    c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func (h *Handler) GetBalance(c *gin.Context) {
    address := common.HexToAddress(c.Param("address"))

    balance, err := h.eth.GetBalance(address)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }

    c.JSON(http.StatusOK, gin.H{
        "address": address.Hex(),
        "balance": balance.String(),
    })
}

func (h *Handler) GetTokenInfo(c *gin.Context) {
    name, symbol, decimals, totalSupply, err := h.eth.GetTokenInfo()
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }

    c.JSON(http.StatusOK, gin.H{
        "name":        name,
        "symbol":      symbol,
        "decimals":    decimals,
        "totalSupply": totalSupply.String(),
    })
}

type TransferRequest struct {
    To     string `json:"to" binding:"required"`
    Amount string `json:"amount" binding:"required"`
}

func (h *Handler) Transfer(c *gin.Context) {
    var req TransferRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }

    to := common.HexToAddress(req.To)
    amount, ok := new(big.Int).SetString(req.Amount, 10)
    if !ok {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid amount"})
        return
    }

    txHash, err := h.eth.Transfer(to, amount)
    if err != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
        return
    }

    c.JSON(http.StatusOK, gin.H{
        "txHash": txHash.Hex(),
    })
}

func (h *Handler) GetTransferHistory(c *gin.Context) {
    address := c.Param("address")

    // Implementation depends on your event storage strategy
    c.JSON(http.StatusOK, gin.H{
        "address":   address,
        "transfers": []any{},
    })
}
```

---

### Junior → FAANG: DApp Backend Architecture Fundamentals

A DApp (decentralized application) backend is a hybrid system: it uses Ethereum for the trustless, immutable, and decentralized parts of the application, and uses traditional backend infrastructure (databases, APIs, queues) for the parts that benefit from higher throughput, lower latency, or rich querying capability. Understanding where to put each piece of logic is the core design challenge of DApp backend development.

The prerequisite gap for junior engineers is understanding why most DApps need a backend at all, given that smart contracts can store state on-chain. The answer is practical: reading complex aggregated state from a smart contract requires many expensive RPC calls, on-chain storage is expensive per byte, event-driven architecture for frontend updates requires a backend to bridge Ethereum's push notifications to web clients, and regulatory requirements often mandate off-chain record keeping. The backend fills these gaps without compromising the core trust properties of the smart contract.

For interview preparation, be able to design a minimal DApp backend architecture: an event listener that monitors the smart contract, a database that maintains an indexed view of the contract state for efficient querying, an API layer that serves the indexed data to the frontend, and a transaction submission service that signs and broadcasts transactions on behalf of users. This four-component architecture appears in almost every DApp backend design question.

First-job habits for DApp backend development: never treat the blockchain as your primary database (query it only for authoritative truth, not for every user request), always replay events from genesis (or a trusted snapshot) when initializing a new database, and build your frontend on your indexed API layer rather than on raw RPC calls (which are slow and rate-limited at scale).

### Senior @ FAANG: DApp Backend as a Platform Engineering Challenge

At staff level, the DApp backend is a distributed system that must maintain consistency between off-chain state (the database) and on-chain state (the smart contract) in the presence of network partitions, reorgs, and processing errors. This consistency requirement is more demanding than a traditional backend because the authoritative source of truth (the blockchain) is append-only, eventually consistent, and cannot be queried with the richness of a relational database.

The architectural pattern that best handles this consistency requirement is the event sourcing model: the database is derived entirely from the event log, not from direct state synchronization. Every state in the database is the result of applying a deterministic function to a sequence of on-chain events. This pattern enables rebuilding the entire database from scratch by replaying the event log, which is invaluable for incident recovery, data migrations, and correctness verification.

ADRs for DApp backends must address the indexer architecture: should the event indexer be a separate service, or embedded in the API service? A separate indexer service is more resilient (API availability is independent of indexer health) and easier to scale independently, but requires inter-service communication and a well-defined data contract between indexer and API. An embedded indexer is simpler but creates a single point of failure for both indexing and serving. Most production DApps use a separate indexer service once they have reached meaningful scale.

The Graph protocol provides an alternative to building a custom indexer: you write a subgraph definition (a mapping from events to entities in GraphQL schema), deploy it to The Graph's hosted service or your own Graph Node, and query indexed data via GraphQL. This dramatically reduces the development cost of event indexing at the expense of flexibility: if your query requirements go beyond what GraphQL can express, or if your events require complex business logic to normalize, a custom indexer is necessary. Staff engineers evaluate this build-versus-use trade-off explicitly in their DApp backend ADRs.

WebSocket and Server-Sent Events (SSE) for real-time frontend updates from the DApp backend require a push notification infrastructure that bridges from the blockchain event stream to the web client. A common architecture uses Redis pub/sub: the event indexer publishes to a Redis channel, and the API server subscribes and relays to connected WebSocket clients. This decoupling allows the indexer and API server to scale independently and allows the API server to serve cached state for initial page load while subscribing for real-time updates.

Bar-raiser signals: designing a DApp backend that maintains correct state during a 100-block reorg (requires tracking the last N block hashes in the database, detecting the reorg by comparing incoming block hashes against stored ones, reverting database state to the fork point, and replaying from the fork), or explaining how the subgraph entity cache invalidation model in The Graph differs from traditional database cache invalidation (The Graph uses a block-based invalidation model where all entities written in a specific block are invalidated together when a reorg occurs at that block height). These topics require genuine DApp development experience.

---
