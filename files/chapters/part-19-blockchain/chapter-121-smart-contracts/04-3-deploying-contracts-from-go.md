## 121.3 Deploying Contracts from Go

Deployment is a special transaction that creates a new contract on the blockchain.

### 3.1 Understanding Contract Deployment

Contract deployment is a special transaction whose `to` field is empty and whose `data` field contains the compiled bytecode followed by ABI-encoded constructor arguments. The Ethereum network executes the bytecode in the EVM, permanently stores the resulting contract code at the deterministically computed address, and returns that address in the transaction receipt.

```
┌──────────────────────────────────────────┐
│  Go Application                          │
│  1. Compile contract bytecode            │
│  2. Prepare constructor arguments        │
│  3. Estimate gas                         │
│  4. Create deployment transaction        │
└────────────┬─────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────┐
│  Ethereum Network                        │
│  1. Validate transaction                 │
│  2. Execute deployment                   │
│  3. Assign contract address              │
│  4. Store code and initial state         │
└────────────┬─────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────┐
│  Contract Address                        │
│  0x742d35Cc6634C0532925a3b844Bc9e7595f0  │
└──────────────────────────────────────────┘
```

### 3.2 Simple Contract Deployment

The generated `DeployToken` function accepts constructor arguments as typed Go parameters, encodes them into ABI format, and returns the contract address along with a transaction handle for waiting on confirmation. After submission, the code polls `WaitMined` to block until the deployment receipt arrives, at which point the address is guaranteed to be live on-chain and callable.

```go
package main

import (
    "context"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/crypto"
    "github.com/ethereum/go-ethereum/ethclient"

    "myproject/contracts/token"
)

func deployToken() (common.Address, error) {
    // Connect to node
    client, err := ethclient.Dial("http://localhost:8545")
    if err != nil {
        return common.Address{}, fmt.Errorf("dial: %w", err)
    }
    defer client.Close()

    // Load private key
    privateKey, err := crypto.HexToECDSA("your-private-key")
    if err != nil {
        return common.Address{}, fmt.Errorf("load key: %w", err)
    }

    // Get chain ID
    chainID, err := client.NetworkID(context.Background())
    if err != nil {
        return common.Address{}, fmt.Errorf("get chain ID: %w", err)
    }

    // Create transaction signer
    auth, err := bind.NewKeyedTransactorWithChainID(privateKey, chainID)
    if err != nil {
        return common.Address{}, fmt.Errorf("create transactor: %w", err)
    }

    // Constructor arguments
    initialSupply := big.NewInt(1000000000000000000) // 1 million tokens (18 decimals)

    // Deploy contract
    address, tx, _, err := token.DeployToken(auth, client, initialSupply)
    if err != nil {
        return common.Address{}, fmt.Errorf("deploy: %w", err)
    }

    fmt.Printf("Contract pending deployment: 0x%x\n", address)
    fmt.Printf("Transaction hash: 0x%x\n", tx.Hash())

    // Wait for deployment (bind.WaitDeployed returns the deployed contract address)
    ctx := context.Background()
    deployedAddr, err := bind.WaitDeployed(ctx, client, tx)
    if err != nil {
        return common.Address{}, fmt.Errorf("wait deployed: %w", err)
    }

    fmt.Printf("Contract deployed at: 0x%x\n", deployedAddr)

    return deployedAddr, nil
}
```

### 3.3 Gas Estimation for Deployment

Gas estimation is critical for production deployments:

```go
package deployment

import (
    "context"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum"
    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/crypto"
    "github.com/ethereum/go-ethereum/ethclient"

    "myproject/contracts/token"
)

// DeploymentConfig holds deployment parameters
type DeploymentConfig struct {
    RPCEndpoint    string
    PrivateKey     string
    InitialSupply  *big.Int
    GasLimitBuffer float64 // Multiplier for estimated gas (e.g., 1.2 for 20% buffer)
}

// Deployer handles contract deployment
type Deployer struct {
    client  *ethclient.Client
    config  *DeploymentConfig
    chainID *big.Int
}

// NewDeployer creates a new deployer instance
func NewDeployer(ctx context.Context, config *DeploymentConfig) (*Deployer, error) {
    client, err := ethclient.DialContext(ctx, config.RPCEndpoint)
    if err != nil {
        return nil, fmt.Errorf("dial rpc: %w", err)
    }

    chainID, err := client.NetworkID(ctx)
    if err != nil {
        client.Close()
        return nil, fmt.Errorf("get chain ID: %w", err)
    }

    return &Deployer{
        client:  client,
        config:  config,
        chainID: chainID,
    }, nil
}

// EstimateDeploymentGas estimates gas needed for deployment
func (d *Deployer) EstimateDeploymentGas(ctx context.Context, auth *bind.TransactOpts) (uint64, error) {
    // Create temporary auth without gas settings for estimation
    estimateAuth := &bind.TransactOpts{
        From:    auth.From,
        Signer:  auth.Signer,
        Context: ctx,
    }

    // Parse contract ABI and bytecode
    parsed, err := token.TokenMetaData.GetAbi()
    if err != nil {
        return 0, fmt.Errorf("parse abi: %w", err)
    }

    // Pack constructor arguments
    input, err := parsed.Pack("", d.config.InitialSupply)
    if err != nil {
        return 0, fmt.Errorf("pack constructor: %w", err)
    }

    // Combine bytecode with constructor arguments
    data := append(common.FromHex(token.TokenMetaData.Bin), input...)

    // Estimate gas
    gasLimit, err := d.client.EstimateGas(ctx, ethereum.CallMsg{
        From: estimateAuth.From,
        Data: data,
    })
    if err != nil {
        return 0, fmt.Errorf("estimate gas: %w", err)
    }

    // Apply buffer
    buffered := float64(gasLimit) * d.config.GasLimitBuffer
    return uint64(buffered), nil
}

// Deploy deploys the contract with proper gas estimation
func (d *Deployer) Deploy(ctx context.Context) (*DeploymentResult, error) {
    // Load private key
    privateKey, err := crypto.HexToECDSA(d.config.PrivateKey)
    if err != nil {
        return nil, fmt.Errorf("load private key: %w", err)
    }

    // Create transactor
    auth, err := bind.NewKeyedTransactorWithChainID(privateKey, d.chainID)
    if err != nil {
        return nil, fmt.Errorf("create transactor: %w", err)
    }
    auth.Context = ctx

    // Get suggested gas price
    gasPrice, err := d.client.SuggestGasPrice(ctx)
    if err != nil {
        return nil, fmt.Errorf("suggest gas price: %w", err)
    }
    auth.GasPrice = gasPrice

    // Estimate gas limit
    gasLimit, err := d.EstimateDeploymentGas(ctx, auth)
    if err != nil {
        return nil, fmt.Errorf("estimate gas: %w", err)
    }
    auth.GasLimit = gasLimit

    // Calculate deployment cost
    estimatedCost := new(big.Int).Mul(gasPrice, big.NewInt(int64(gasLimit)))

    fmt.Printf("Deployment parameters:\n")
    fmt.Printf("  Gas price: %s wei (%s Gwei)\n",
        gasPrice.String(),
        new(big.Int).Div(gasPrice, big.NewInt(1e9)).String())
    fmt.Printf("  Gas limit: %d\n", gasLimit)
    fmt.Printf("  Estimated cost: %s wei (%s ETH)\n",
        estimatedCost.String(),
        new(big.Float).Quo(
            new(big.Float).SetInt(estimatedCost),
            big.NewFloat(1e18),
        ).String())

    // Deploy
    address, tx, instance, err := token.DeployToken(
        auth,
        d.client,
        d.config.InitialSupply,
    )
    if err != nil {
        return nil, fmt.Errorf("deploy contract: %w", err)
    }

    fmt.Printf("Transaction hash: %s\n", tx.Hash().Hex())

    // Wait for deployment
    receipt, err := bind.WaitMined(ctx, d.client, tx)
    if err != nil {
        return nil, fmt.Errorf("wait mined: %w", err)
    }

    actualCost := new(big.Int).Mul(
        gasPrice,
        big.NewInt(int64(receipt.GasUsed)),
    )

    return &DeploymentResult{
        Address:       address,
        TxHash:        tx.Hash(),
        BlockNumber:   receipt.BlockNumber,
        GasUsed:       receipt.GasUsed,
        ActualCost:    actualCost,
        ContractInstance: instance,
    }, nil
}

// DeploymentResult contains deployment information
type DeploymentResult struct {
    Address          common.Address
    TxHash           common.Hash
    BlockNumber      *big.Int
    GasUsed          uint64
    ActualCost       *big.Int
    ContractInstance *token.Token
}

// Close closes the deployer's client connection
func (d *Deployer) Close() {
    if d.client != nil {
        d.client.Close()
    }
}
```

### 3.4 Deployment with Constructor Arguments

For contracts with complex constructor arguments:

```solidity
// ComplexToken.sol
contract ComplexToken {
    string public name;
    string public symbol;
    uint8 public decimals;
    address public owner;

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        address _owner
    ) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        owner = _owner;
    }
}
```

```go
// Deploy with multiple constructor arguments
func deployComplexToken(
    ctx context.Context,
    client *ethclient.Client,
    auth *bind.TransactOpts,
) (common.Address, error) {
    name := "MyToken"
    symbol := "MTK"
    decimals := uint8(18)
    owner := common.HexToAddress("0x...")

    address, tx, _, err := complextoken.DeployComplexToken(
        auth,
        client,
        name,
        symbol,
        decimals,
        owner,
    )
    if err != nil {
        return common.Address{}, err
    }

    deployedAddr, err := bind.WaitDeployed(ctx, client, tx)
    if err != nil {
        return common.Address{}, err
    }

    return deployedAddr, nil
}
```

---

### Junior → FAANG: Contract Deployment as a Controlled, Verified Operation

Deploying a smart contract from Go is conceptually straightforward: the bytecode is included as transaction data, the `to` field is nil (indicating a contract creation), and the returned contract address is derived from the deployer's address and nonce. However, production contract deployment has specific requirements that make it more complex than a simple transaction.

The first prerequisite to close is understanding how to obtain the deployment bytecode. The Solidity compiler (or Foundry, Hardhat) produces JSON output that includes the `bytecode` field (the deployment bytecode, which includes the constructor logic) and the `deployedBytecode` field (the runtime bytecode that is stored at the contract address after deployment). The `deployedBytecode` is what `eth_getCode` returns for a deployed contract. Using the wrong one for deployment will produce unexpected results.

Deterministic deployment addresses via CREATE2 are a critical production pattern. CREATE2 deploys a contract to an address that depends on the deployer's address, a salt value, and the bytecode, rather than the deployer's nonce. This enables counterfactual deployment (knowing the contract's address before it is deployed), which is required for cross-chain deployments to the same address on multiple chains and for certain smart contract wallet designs. Using the standard deployment factory (0x4e59b44847b379578588920cA78FbF26c0B4956C) is the de facto standard for CREATE2 deployment.

Interview entry point: explain the contract address computation for CREATE deployment: `keccak256(rlp([deployer_address, nonce]))[-20:]`. Now explain it for CREATE2: `keccak256(0xff + deployer_address + salt + keccak256(bytecode))[-20:]`. Being able to compute a deterministic contract address before deployment is a practical skill used in advanced DeFi integrations and in testing.

### Senior @ FAANG: Contract Deployment as a Governed, Auditable Process

At staff level, contract deployment is a governed process with defined approvals, a pre-deployment checklist, a deployment procedure, and a post-deployment verification procedure. Treating contract deployment as equivalent to a code deployment (push a button and monitor) is insufficient for smart contracts because errors may be non-reversible and because the deployed bytecode must match the audited source code.

The pre-deployment checklist for a production contract deployment covers: audit completion and sign-off by the required number of reviewers, bytecode verification (confirming that the compiled bytecode matches the audited source, which can be done via `forge verify-contract` or Etherscan verification), constructor argument verification (confirming that the initial parameters are correct for the target network), and address pre-computation (confirming that the deployed address will be as expected, especially for CREATE2 deployments).

Post-deployment verification is as important as pre-deployment preparation. After deployment, verify: that the contract bytecode at the deployed address matches the expected bytecode (`eth_getCode` compared against the compiled bytecode), that the initial state is correct (call all relevant view functions to confirm that the constructor arguments were applied correctly), that the contract's source is verified on Etherscan (for public contracts), and that any dependent systems (indexers, monitoring) have been updated with the new contract address.

Multi-stage deployment procedures are common for complex contract systems. The Gnosis Safe deployment pattern deploys: the Safe singleton (implementation), the Safe proxy factory, and the compatibility fallback handler, followed by deploying individual multisig proxies for each organization account. Each step depends on the previous step's success and address. Go deployment scripts that execute multi-stage deployments must be idempotent (safe to re-run if a step fails) and must record the deployed addresses for each step in a manifest file that is version-controlled alongside the contract source.

The constructor argument encoding is a common source of deployment errors. Constructor arguments are ABI-encoded and appended to the deployment bytecode. If the constructor takes an address parameter, and the address is for the wrong network (e.g., the Ethereum mainnet address of a contract that is being deployed to Arbitrum where the contract has a different address), the contract will be deployed with incorrect configuration. Staff engineers implement constructor argument verification as a required step in the deployment procedure.

Bar-raiser signals: designing a contract upgrade deployment procedure for a UUPS proxy that: (1) deploys the new implementation contract, (2) submits the upgrade transaction to a Gnosis Safe multisig for approval, (3) monitors for the required number of approvals, (4) executes the upgrade after approval, and (5) verifies the proxy now delegates to the new implementation. This end-to-end upgrade orchestration is a realistic production scenario that tests both technical and process depth.

---
