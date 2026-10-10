## 123.8 Multi-Chain Support

### Chain Abstraction Layer

The chain abstraction layer maintains a registry of chain ID to RPC client, allowing operations like `GetBalance` to accept a chain ID parameter and dispatch to the correct node without the caller managing multiple client instances. A `sync.RWMutex` on the chain registry supports concurrent reads across chains while serializing the rare case of adding a new chain at runtime.

```go
// pkg/web3/multichain/chain.go
package multichain

import (
    "context"
    "fmt"
    "math/big"
    "sync"

    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
)

// ChainID represents different blockchain networks
type ChainID uint64

const (
    Ethereum ChainID = 1
    Polygon  ChainID = 137
    BSC      ChainID = 56
    Arbitrum ChainID = 42161
    Optimism ChainID = 10
)

// ChainConfig represents configuration for a blockchain
type ChainConfig struct {
    ChainID     ChainID
    Name        string
    RPC         []string
    Explorer    string
    NativeToken string
    Confirmations uint64
}

// ChainManager manages multiple blockchain connections
type ChainManager struct {
    chains map[ChainID]*Chain
    mu     sync.RWMutex
}

// Chain represents a blockchain connection
type Chain struct {
    config ChainConfig
    client *ethclient.Client
    pool   *RPCPool
}

// NewChainManager creates a new multi-chain manager
func NewChainManager() *ChainManager {
    return &ChainManager{
        chains: make(map[ChainID]*Chain),
    }
}

// AddChain adds a blockchain to the manager
func (cm *ChainManager) AddChain(config ChainConfig) error {
    cm.mu.Lock()
    defer cm.mu.Unlock()

    // Create RPC pool
    nodeConfigs := make([]NodeConfig, len(config.RPC))
    for i, rpc := range config.RPC {
        nodeConfigs[i] = NodeConfig{
            URL:     rpc,
            ChainID: uint64(config.ChainID),
        }
    }

    pool, err := NewRPCPool(nodeConfigs)
    if err != nil {
        return fmt.Errorf("failed to create RPC pool: %w", err)
    }

    client, err := pool.GetClient()
    if err != nil {
        return fmt.Errorf("failed to get client: %w", err)
    }

    chain := &Chain{
        config: config,
        client: client,
        pool:   pool,
    }

    cm.chains[config.ChainID] = chain

    return nil
}

// GetChain returns a chain by ID
func (cm *ChainManager) GetChain(chainID ChainID) (*Chain, error) {
    cm.mu.RLock()
    defer cm.mu.RUnlock()

    chain, exists := cm.chains[chainID]
    if !exists {
        return nil, fmt.Errorf("chain %d not found", chainID)
    }

    return chain, nil
}

// GetClient returns an Ethereum client for a chain
func (cm *ChainManager) GetClient(chainID ChainID) (*ethclient.Client, error) {
    chain, err := cm.GetChain(chainID)
    if err != nil {
        return nil, err
    }

    return chain.client, nil
}

// ExecuteOnAll executes a function on all chains
func (cm *ChainManager) ExecuteOnAll(
    ctx context.Context,
    fn func(context.Context, ChainID, *ethclient.Client) error,
) error {
    cm.mu.RLock()
    chains := make(map[ChainID]*Chain)
    for id, chain := range cm.chains {
        chains[id] = chain
    }
    cm.mu.RUnlock()

    var wg sync.WaitGroup
    errors := make(chan error, len(chains))

    for chainID, chain := range chains {
        wg.Add(1)
        go func(id ChainID, c *Chain) {
            defer wg.Done()
            if err := fn(ctx, id, c.client); err != nil {
                errors <- fmt.Errorf("chain %d: %w", id, err)
            }
        }(chainID, chain)
    }

    wg.Wait()
    close(errors)

    // Collect errors
    var errs []error
    for err := range errors {
        errs = append(errs, err)
    }

    if len(errs) > 0 {
        return fmt.Errorf("errors: %v", errs)
    }

    return nil
}

// GetBalanceMultiChain gets balance across all chains
func (cm *ChainManager) GetBalanceMultiChain(
    ctx context.Context,
    address common.Address,
) (map[ChainID]*big.Int, error) {
    balances := make(map[ChainID]*big.Int)
    var mu sync.Mutex

    err := cm.ExecuteOnAll(ctx, func(
        ctx context.Context,
        chainID ChainID,
        client *ethclient.Client,
    ) error {
        balance, err := client.BalanceAt(ctx, address, nil)
        if err != nil {
            return err
        }

        mu.Lock()
        balances[chainID] = balance
        mu.Unlock()

        return nil
    })

    if err != nil {
        return nil, err
    }

    return balances, nil
}
```

### Cross-Chain Messaging

The bridge client submits the source-chain lock transaction, then polls the destination chain for the corresponding mint event emitted by the bridge relayer. The two-transaction flow is fundamentally asynchronous, the source confirmation and destination mint happen in separate blocks on separate networks, so the client tracks bridge message IDs to correlate them.

```go
// pkg/web3/multichain/bridge.go
package multichain

import (
    "context"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
)

// BridgeMessage represents a cross-chain message
type BridgeMessage struct {
    SourceChain      ChainID
    DestinationChain ChainID
    Sender           common.Address
    Recipient        common.Address
    Data             []byte
    Nonce            uint64
}

// BridgeContract represents a bridge contract interface
type BridgeContract interface {
    SendMessage(
        opts *bind.TransactOpts,
        destinationChain uint64,
        recipient common.Address,
        data []byte,
    ) (*types.Transaction, error)

    ReceiveMessage(
        opts *bind.CallOpts,
        sourceChain uint64,
        nonce uint64,
    ) (BridgeMessage, error)
}

// Bridge manages cross-chain messaging
type Bridge struct {
    chainManager *ChainManager
    contracts    map[ChainID]BridgeContract
}

// NewBridge creates a new bridge
func NewBridge(chainManager *ChainManager) *Bridge {
    return &Bridge{
        chainManager: chainManager,
        contracts:    make(map[ChainID]BridgeContract),
    }
}

// SendCrossChainMessage sends a message from one chain to another
func (b *Bridge) SendCrossChainMessage(
    ctx context.Context,
    auth *bind.TransactOpts,
    msg BridgeMessage,
) (*types.Transaction, error) {
    // Get source chain contract
    contract, exists := b.contracts[msg.SourceChain]
    if !exists {
        return nil, fmt.Errorf("bridge contract not found for chain %d", msg.SourceChain)
    }

    // Send message
    tx, err := contract.SendMessage(
        auth,
        uint64(msg.DestinationChain),
        msg.Recipient,
        msg.Data,
    )
    if err != nil {
        return nil, fmt.Errorf("failed to send message: %w", err)
    }

    return tx, nil
}
```

### Junior → FAANG: Multi-Chain Support as a Design Challenge

Multi-chain support means your application works with more than one blockchain network: Ethereum mainnet, Arbitrum, Optimism, Base, Polygon, and others. The challenge is that these chains share the same JSON-RPC interface format but differ in important ways: chain ID, native currency, block time, finality model, and gas economics. A multi-chain application must abstract over these differences without hiding semantically important distinctions.

The most important distinction to encode in your multi-chain architecture is the chain ID. Chain IDs prevent transaction replay across chains: a transaction signed with chain ID 1 (Ethereum mainnet) cannot be valid on chain ID 137 (Polygon) because the signature includes the chain ID in its hashing. Always verify the chain ID of your connected node against the expected chain ID at startup and reject the connection if they differ. Connecting to the wrong chain is a common mistake when configuring multi-chain applications.

For interview preparation, describe the chain-specific configuration you would maintain for each supported chain: chain ID, RPC endpoint URL, chain name (for display), native currency symbol and decimals, block explorer URL, and finality depth (how many confirmations are needed for your application's use case). This configuration table is the starting point for any multi-chain architecture.

First-job habit: never hardcode contract addresses in code for multi-chain applications. Each contract is deployed to a different address on each chain. Maintain a configuration map of `{chainID: {contractName: address}}` and look up addresses at runtime. This allows adding new chain support by updating configuration, not code.

### Senior @ FAANG: Multi-Chain Architecture as a Platform Engineering Discipline

At staff level, multi-chain support is a platform engineering challenge that goes beyond simple configuration management. The chains your platform supports have different trust models, different operational requirements, and different risk profiles that must be reflected in the platform's architecture and risk management framework.

Chain abstraction is the architectural pattern that allows applications to interact with multiple chains through a unified interface while preserving chain-specific correctness. The abstraction layer handles: RPC connection management per chain, chain-specific transaction construction (EIP-1559 on Ethereum mainnet, different gas models on some L2s), chain-specific event monitoring (different block times mean different polling frequencies), and chain-specific finality waiting (Ethereum requires more confirmations than Optimism for the same safety level). Implementing this abstraction correctly requires deep knowledge of each supported chain's properties.

Cross-chain bridge integration is the most complex component of multi-chain architecture. Bridges transfer assets between chains by locking them on the source chain and minting wrapped versions on the destination chain. The trust model of each bridge is distinct: some bridges use multisig control (trust a committee of signers), others use optimistic proofs (trust is based on fraud proof windows), and others use zero-knowledge proofs (cryptographic verification without trusted parties). Staff engineers evaluate bridge trust models before integrating and match the integration's value limits to the bridge's security level.

The cross-chain message latency problem affects applications that need to coordinate actions across chains. An action on Ethereum that triggers a corresponding action on Arbitrum has a latency of at least the time for the Ethereum transaction to finalize (12-15 minutes) plus the bridge relay time (minutes to hours depending on the bridge). Applications that need sub-minute cross-chain coordination must either use a bridge with faster finality (optimistic rollup sequencer-based bridges can relay in seconds but without fraud proof guarantees) or redesign to avoid cross-chain synchronization requirements.

Multi-chain gas management is an operational concern that affects every application that submits transactions on multiple chains. Each chain has its own native gas token (ETH on Ethereum and most L2s, MATIC on Polygon, etc.) and its own gas price dynamics. The system that manages transaction submission must maintain sufficient balances of each chain's gas token in its operational wallets and must monitor and replenish those balances as they are consumed. Staff engineers design gas management systems that alert when balances fall below minimum thresholds and that automate replenishment through bridge operations or DEX swaps.

Bar-raiser signals: designing a multi-chain event aggregation system that maintains a consistent global ordering of events across chains with different finality models (Ethereum's probabilistic finality and Cosmos IBC's deterministic finality, for example), or explaining the security model difference between a canonical bridge (operated by the chain's own team, typically the highest security bridge for an L2) and a third-party bridge (operated independently, with variable security models) and under what circumstances you would choose each for a specific value transfer scenario. These choices reveal genuine multi-chain platform engineering experience.

---
