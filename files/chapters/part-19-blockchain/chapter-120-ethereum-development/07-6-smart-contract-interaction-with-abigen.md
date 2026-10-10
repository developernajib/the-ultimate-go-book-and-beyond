## 120.6 Smart Contract Interaction with abigen

### 6.1 Understanding abigen

`abigen` generates type-safe Go bindings from Solidity contract ABI (Application Binary Interface). This eliminates manual encoding/decoding and provides compile-time safety.

### 6.2 Simple ERC-20 Example

First, create a simple ERC-20 contract:

```solidity
// contracts/SimpleToken.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SimpleToken {
    string public name = "SimpleToken";
    string public symbol = "STK";
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) public returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(allowance[from][msg.sender] >= amount, "Insufficient allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
```

Compile and generate ABI:

```bash
# Install solc compiler
npm install -g solc

# Compile contract
solc --abi --bin contracts/SimpleToken.sol -o build/

# Generate Go bindings
abigen --abi=build/SimpleToken.abi --bin=build/SimpleToken.bin --pkg=token --out=pkg/token/simple_token.go
```

### 6.3 Using Generated Bindings

Generated `abigen` bindings expose each contract function as a typed Go method, replacing raw ABI encoding with compile-time checked calls where the argument types match the Solidity function signature. State-changing calls require a `bind.TransactOpts` with a signer and nonce, while read-only (`view`) functions use `bind.CallOpts` and return decoded Go values directly without broadcasting a transaction.

```go
// cmd/contract/main.go
package main

import (
    "context"
    "crypto/ecdsa"
    "fmt"
    "log"
    "math/big"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/crypto"
    "github.com/ethereum/go-ethereum/ethclient"

    "yourmodule/pkg/token" // Generated bindings
)

func main() {
    // Connect to network
    client, err := ethclient.Dial("https://eth-sepolia.g.alchemy.com/v2/YOUR-API-KEY")
    if err != nil {
        log.Fatal(err)
    }
    defer client.Close()

    // Load private key
    privateKey, err := crypto.HexToECDSA("your-private-key")
    if err != nil {
        log.Fatal(err)
    }

    publicKey := privateKey.Public().(*ecdsa.PublicKey)
    from := crypto.PubkeyToAddress(*publicKey)

    // Get chain ID
    chainID, err := client.ChainID(context.Background())
    if err != nil {
        log.Fatal(err)
    }

    // Create transactor
    auth, err := bind.NewKeyedTransactorWithChainID(privateKey, chainID)
    if err != nil {
        log.Fatal(err)
    }

    // Deploy contract
    initialSupply := new(big.Int)
    initialSupply.SetString("1000000000000000000000000", 10) // 1 million tokens

    address, tx, instance, err := token.DeploySimpleToken(auth, client, initialSupply)
    if err != nil {
        log.Fatal(err)
    }

    fmt.Printf("Contract deployed to: %s\n", address.Hex())
    fmt.Printf("Transaction hash: %s\n", tx.Hash().Hex())

    // Wait for deployment
    receipt, err := bind.WaitMined(context.Background(), client, tx)
    if err != nil {
        log.Fatal(err)
    }

    if receipt.Status == 0 {
        log.Fatal("Transaction failed")
    }

    fmt.Println("Contract deployed successfully!")

    // Read contract data
    name, err := instance.Name(nil)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Token name: %s\n", name)

    balance, err := instance.BalanceOf(nil, from)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Balance: %s\n", balance)

    // Send tokens
    recipient := common.HexToAddress("0x...")
    amount := big.NewInt(1000000000000000000) // 1 token

    tx, err = instance.Transfer(auth, recipient, amount)
    if err != nil {
        log.Fatal(err)
    }

    fmt.Printf("Transfer transaction: %s\n", tx.Hash().Hex())
}
```

### 6.4 Interacting with Existing Contracts

For already-deployed contracts, you only need the ABI:

```go
// pkg/contracts/interact.go
package contracts

import (
    "context"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"

    "yourmodule/pkg/token"
)

// TokenReader reads ERC-20 token data
type TokenReader struct {
    client   *ethclient.Client
    instance *token.SimpleToken
    address  common.Address
}

// NewTokenReader creates a new token reader
func NewTokenReader(client *ethclient.Client, tokenAddress common.Address) (*TokenReader, error) {
    instance, err := token.NewSimpleToken(tokenAddress, client)
    if err != nil {
        return nil, fmt.Errorf("failed to instantiate contract: %w", err)
    }

    return &TokenReader{
        client:   client,
        instance: instance,
        address:  tokenAddress,
    }, nil
}

// GetBalance returns the token balance for an address
func (tr *TokenReader) GetBalance(address common.Address) (*big.Int, error) {
    balance, err := tr.instance.BalanceOf(&bind.CallOpts{}, address)
    if err != nil {
        return nil, fmt.Errorf("failed to get balance: %w", err)
    }
    return balance, nil
}

// GetTokenInfo returns basic token information
func (tr *TokenReader) GetTokenInfo() (name, symbol string, decimals uint8, totalSupply *big.Int, err error) {
    name, err = tr.instance.Name(nil)
    if err != nil {
        return
    }

    symbol, err = tr.instance.Symbol(nil)
    if err != nil {
        return
    }

    decimals, err = tr.instance.Decimals(nil)
    if err != nil {
        return
    }

    totalSupply, err = tr.instance.TotalSupply(nil)
    return
}
```

---

### Junior → FAANG: Using abigen for Type-Safe Contract Interaction

`abigen` is the go-ethereum tool that generates type-safe Go bindings for Ethereum smart contracts from their ABI (Application Binary Interface) and optionally their bytecode. Using abigen is strongly preferred over manual ABI encoding because the generated code is correct by construction for the specific contract interface, and because type mismatches between your Go code and the contract interface are caught at compile time rather than at runtime when the transaction reverts.

The prerequisite for using abigen effectively is understanding the ABI format: it is a JSON array of function and event descriptors, each specifying the name, input types, output types, and for functions the state mutability. Every Solidity compiler output includes the ABI, and it is available for verified contracts on Etherscan. For unverified contracts, you must either obtain the ABI from the contract author or reverse-engineer it from the bytecode (which is difficult and often not complete).

A worked first-job workflow: obtain the ABI JSON for a contract (e.g., the Uniswap V2 router from Etherscan), run `abigen --abi UniswapV2Router02.json --pkg uniswap --out uniswap.go` to generate the binding, import the generated package, create a binding instance with `uniswap.NewUniswapV2Router02(address, client)`, and call contract read functions directly as Go method calls. The entire process from ABI to working Go code should take less than five minutes once you have the ABI.

Interview entry point: explain what happens if the ABI you use to generate bindings does not match the actual deployed contract's interface. Read calls will silently decode returned data incorrectly (Go will not error, it will just interpret the bytes according to the wrong type). Write calls will revert with "function not found" or similar errors. This mismatch is a common debugging scenario in production: the contract was upgraded via a proxy but the ABI in the codebase was not updated.

### Senior @ FAANG: Contract Interaction Standards and ABI Management

At staff level, abigen-generated bindings are platform infrastructure: they need version management, testing, and a defined update process. Every contract your organization interacts with should have its ABI stored in a central repository, with a version history that tracks which ABI was used at which contract address on which network. When a contract is upgraded, the ABI update must go through a review process that checks for breaking changes in function signatures or event schemas.

ABI management at scale requires tooling. A monorepo that contains all contract ABIs, the abigen-generated bindings for each, and integration tests that verify the bindings against a fork of mainnet (using `go test` with a mainnet fork URL from Alchemy or Infura) provides the highest confidence that production code will interact correctly with live contracts. This setup is common in DeFi protocol companies that integrate with dozens of external contracts.

Event log decoding is a critical function that the ABI binding provides: given the raw log bytes from a transaction receipt, the binding's `ParseXxx` methods decode the event parameters into typed Go structs. The prerequisite for correct event decoding is understanding the ABI encoding of indexed versus non-indexed event parameters: indexed parameters are encoded in the topic list (up to 3 topics, each 32 bytes), while non-indexed parameters are ABI-encoded in the data field. A binding generated from an incorrect ABI will silently decode events into incorrect values.

The ERC-165 interface detection standard allows contracts to declare which interfaces they implement. Production code that interacts with multiple contract types (e.g., a system that handles both ERC-20 and ERC-777 tokens) should use ERC-165 to detect the contract's interface before deciding which interaction methods to use. This is preferable to relying on the contract address being from a known list, which becomes brittle as new contract deployments occur.

Proxy contract patterns (ERC-1967 transparent proxy, UUPS proxy) add complexity to ABI management: the proxy contract's ABI is minimal (it just forwards calls to the implementation), but the implementation contract's ABI is what your code actually uses. When calling functions on a proxy, you use the implementation ABI with the proxy's address. This is handled correctly by abigen as long as you generate bindings from the implementation ABI but deploy with the proxy address, which is a detail that confuses juniors and causes incorrect bindings to be generated.

Bar-raiser signals: explaining the EIP-712 typed structured data encoding that abigen generates for `permit`-style functions (used in ERC-2612 and many DeFi protocols for gasless approvals), or designing an ABI registry service that automatically detects contract upgrades by monitoring `Upgraded` events from UUPS proxies and triggering ABI binding regeneration and deployment. These topics reveal genuine production DeFi integration experience.

---
