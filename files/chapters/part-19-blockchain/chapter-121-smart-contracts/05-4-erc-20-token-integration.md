## 121.4 ERC-20 Token Integration

ERC-20 is the standard interface for fungible tokens on Ethereum. Any DeFi integration requires working with ERC-20 contracts.

### 4.1 ERC-20 Standard Interface

The ERC-20 Solidity interface defines the nine functions and two events every compliant token must implement, providing the shared contract surface that wallets, DEXes, and lending protocols depend on. The `allowance` and `approve` functions enable delegated spending patterns where protocols deduct tokens on behalf of a user without requiring private key access.

```solidity
// ERC-20 Standard (excerpt)
interface IERC20 {
    // Returns the total token supply
    function totalSupply() external view returns (uint256);

    // Returns the account balance
    function balanceOf(address account) external view returns (uint256);

    // Transfers tokens
    function transfer(address to, uint256 amount) external returns (bool);

    // Returns the remaining number of tokens that spender is allowed to spend
    function allowance(address owner, address spender) external view returns (uint256);

    // Sets amount as the allowance of spender over the caller's tokens
    function approve(address spender, uint256 amount) external returns (bool);

    // Transfers tokens from one address to another using allowance
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    // Events
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}
```

### 4.2 Complete ERC-20 Implementation in Go

The Go ERC-20 client wraps the `abigen`-generated bindings in a domain-level struct that converts raw `*big.Int` amounts to human-readable decimals using the token's `decimals()` return value. Token amounts are kept as `*big.Int` internally throughout to avoid floating-point rounding errors that would silently corrupt on-chain values.

```go
package erc20

import (
    "context"
    "fmt"
    "math/big"
    "time"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/ethclient"
    "github.com/ethereum/go-ethereum/event"
)

// Client wraps ERC-20 token interactions
type Client struct {
    contract *erc20.ERC20 // Generated binding
    client   *ethclient.Client
    address  common.Address
}

// NewClient creates an ERC-20 client
func NewClient(ctx context.Context, rpcURL string, tokenAddr common.Address) (*Client, error) {
    client, err := ethclient.DialContext(ctx, rpcURL)
    if err != nil {
        return nil, fmt.Errorf("dial: %w", err)
    }

    contract, err := erc20.NewERC20(tokenAddr, client)
    if err != nil {
        client.Close()
        return nil, fmt.Errorf("create binding: %w", err)
    }

    return &Client{
        contract: contract,
        client:   client,
        address:  tokenAddr,
    }, nil
}

// EthClient returns the underlying ethclient instance
func (c *Client) EthClient() *ethclient.Client {
    return c.client
}

// Close closes the client
func (c *Client) Close() {
    if c.client != nil {
        c.client.Close()
    }
}

// TokenInfo holds token metadata
type TokenInfo struct {
    Name        string
    Symbol      string
    Decimals    uint8
    TotalSupply *big.Int
}

// GetTokenInfo retrieves token metadata
func (c *Client) GetTokenInfo(ctx context.Context) (*TokenInfo, error) {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    opts := &bind.CallOpts{Context: ctx}

    // Get all info concurrently
    type result struct {
        name        string
        symbol      string
        decimals    uint8
        totalSupply *big.Int
        err         error
    }

    ch := make(chan result, 1)

    go func() {
        var r result
        r.name, r.err = c.contract.Name(opts)
        if r.err != nil {
            ch <- r
            return
        }

        r.symbol, r.err = c.contract.Symbol(opts)
        if r.err != nil {
            ch <- r
            return
        }

        r.decimals, r.err = c.contract.Decimals(opts)
        if r.err != nil {
            ch <- r
            return
        }

        r.totalSupply, r.err = c.contract.TotalSupply(opts)
        ch <- r
    }()

    select {
    case r := <-ch:
        if r.err != nil {
            return nil, fmt.Errorf("get token info: %w", r.err)
        }
        return &TokenInfo{
            Name:        r.name,
            Symbol:      r.symbol,
            Decimals:    r.decimals,
            TotalSupply: r.totalSupply,
        }, nil
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}

// BalanceOf returns the token balance of an address
func (c *Client) BalanceOf(ctx context.Context, address common.Address) (*big.Int, error) {
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    balance, err := c.contract.BalanceOf(&bind.CallOpts{Context: ctx}, address)
    if err != nil {
        return nil, fmt.Errorf("balance of: %w", err)
    }

    return balance, nil
}

// Transfer sends tokens
func (c *Client) Transfer(
    ctx context.Context,
    auth *bind.TransactOpts,
    to common.Address,
    amount *big.Int,
) (*types.Transaction, error) {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()
    auth.Context = ctx

    tx, err := c.contract.Transfer(auth, to, amount)
    if err != nil {
        return nil, fmt.Errorf("transfer: %w", err)
    }

    return tx, nil
}

// Approve sets allowance
func (c *Client) Approve(
    ctx context.Context,
    auth *bind.TransactOpts,
    spender common.Address,
    amount *big.Int,
) (*types.Transaction, error) {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()
    auth.Context = ctx

    tx, err := c.contract.Approve(auth, spender, amount)
    if err != nil {
        return nil, fmt.Errorf("approve: %w", err)
    }

    return tx, nil
}

// Allowance returns the allowance
func (c *Client) Allowance(
    ctx context.Context,
    owner common.Address,
    spender common.Address,
) (*big.Int, error) {
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    allowance, err := c.contract.Allowance(&bind.CallOpts{Context: ctx}, owner, spender)
    if err != nil {
        return nil, fmt.Errorf("allowance: %w", err)
    }

    return allowance, nil
}

// TransferFrom transfers tokens using allowance
func (c *Client) TransferFrom(
    ctx context.Context,
    auth *bind.TransactOpts,
    from common.Address,
    to common.Address,
    amount *big.Int,
) (*types.Transaction, error) {
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()
    auth.Context = ctx

    tx, err := c.contract.TransferFrom(auth, from, to, amount)
    if err != nil {
        return nil, fmt.Errorf("transfer from: %w", err)
    }

    return tx, nil
}

// WatchTransfers watches for Transfer events
func (c *Client) WatchTransfers(
    ctx context.Context,
    from *common.Address,
    to *common.Address,
) (chan *erc20.ERC20Transfer, event.Subscription, error) {
    opts := &bind.WatchOpts{Context: ctx}

    transferChan := make(chan *erc20.ERC20Transfer)

    sub, err := c.contract.WatchTransfer(opts, transferChan, []common.Address{*from}, []common.Address{*to})
    if err != nil {
        return nil, nil, fmt.Errorf("watch transfers: %w", err)
    }

    return transferChan, sub, nil
}

// GetPastTransfers retrieves historical Transfer events
func (c *Client) GetPastTransfers(
    ctx context.Context,
    from *common.Address,
    to *common.Address,
    startBlock *big.Int,
    endBlock *big.Int,
) ([]*erc20.ERC20Transfer, error) {
    var fromAddrs []common.Address
    if from != nil {
        fromAddrs = []common.Address{*from}
    }

    var toAddrs []common.Address
    if to != nil {
        toAddrs = []common.Address{*to}
    }

    opts := &bind.FilterOpts{
        Context: ctx,
        Start:   startBlock.Uint64(),
        End:     &endBlock.Uint64(),
    }

    iter, err := c.contract.FilterTransfer(opts, fromAddrs, toAddrs)
    if err != nil {
        return nil, fmt.Errorf("filter transfers: %w", err)
    }
    defer iter.Close()

    var transfers []*erc20.ERC20Transfer
    for iter.Next() {
        transfers = append(transfers, iter.Event)
    }

    if err := iter.Error(); err != nil {
        return nil, fmt.Errorf("iterate transfers: %w", err)
    }

    return transfers, nil
}
```

### 4.3 Practical ERC-20 Usage Example

The practical usage example shows the approve-then-transfer pattern required for DEX and protocol interactions: the owner first calls `Approve` to grant the spender an allowance, and the spender's contract then calls `TransferFrom` to move tokens without another signature. Skipping the approval step causes the protocol's `TransferFrom` call to revert with an insufficient allowance error.

```go
package main

import (
    "context"
    "fmt"
    "log"
    "math/big"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/crypto"

    "myproject/erc20"
)

func main() {
    ctx := context.Background()

    // Create ERC-20 client (USDC on Ethereum mainnet)
    usdcAddress := common.HexToAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
    client, err := erc20.NewClient(ctx, "https://mainnet.infura.io/v3/YOUR-KEY", usdcAddress)
    if err != nil {
        log.Fatal(err)
    }
    defer client.Close()

    // Get token info
    info, err := client.GetTokenInfo(ctx)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Token: %s (%s)\n", info.Name, info.Symbol)
    fmt.Printf("Decimals: %d\n", info.Decimals)
    fmt.Printf("Total Supply: %s\n", info.TotalSupply.String())

    // Check balance
    address := common.HexToAddress("0x...")
    balance, err := client.BalanceOf(ctx, address)
    if err != nil {
        log.Fatal(err)
    }

    // Convert to human-readable (divide by 10^decimals)
    decimals := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(info.Decimals)), nil)
    humanBalance := new(big.Float).Quo(
        new(big.Float).SetInt(balance),
        new(big.Float).SetInt(decimals),
    )
    fmt.Printf("Balance: %s %s\n", humanBalance.String(), info.Symbol)

    // Transfer example (requires private key)
    privateKey, err := crypto.HexToECDSA("your-private-key")
    if err != nil {
        log.Fatal(err)
    }

    chainID := big.NewInt(1) // Ethereum mainnet
    auth, err := bind.NewKeyedTransactorWithChainID(privateKey, chainID)
    if err != nil {
        log.Fatal(err)
    }

    // Transfer 100 USDC (6 decimals)
    recipient := common.HexToAddress("0x...")
    amount := big.NewInt(100000000) // 100 * 10^6

    tx, err := client.Transfer(ctx, auth, recipient, amount)
    if err != nil {
        log.Fatal(err)
    }

    fmt.Printf("Transfer transaction: %s\n", tx.Hash().Hex())

    // Approve and transferFrom pattern (for smart contract interactions)
    spenderContract := common.HexToAddress("0x...") // e.g., Uniswap router
    approveAmount := big.NewInt(1000000000) // 1000 USDC

    // Step 1: Approve
    approveTx, err := client.Approve(ctx, auth, spenderContract, approveAmount)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Approve transaction: %s\n", approveTx.Hash().Hex())

    // Wait for approval
    receipt, err := bind.WaitMined(ctx, client.EthClient(), approveTx)
    if err != nil {
        log.Fatal(err)
    }
    if receipt.Status != 1 {
        log.Fatal("Approval failed")
    }

    // Step 2: Check allowance
    allowance, err := client.Allowance(ctx, auth.From, spenderContract)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Allowance: %s\n", allowance.String())

    // Watch for transfer events
    fromAddr := auth.From
    transferChan, sub, err := client.WatchTransfers(ctx, &fromAddr, nil)
    if err != nil {
        log.Fatal(err)
    }
    defer sub.Unsubscribe()

    go func() {
        for {
            select {
            case event := <-transferChan:
                fmt.Printf("Transfer detected: from=%s to=%s amount=%s\n",
                    event.From.Hex(),
                    event.To.Hex(),
                    event.Value.String(),
                )
            case err := <-sub.Err():
                log.Printf("Event subscription error: %v", err)
                return
            }
        }
    }()
}
```

### 4.4 Handling Token Decimals

Critical for displaying amounts correctly:

```go
package tokenutil

import (
    "fmt"
    "math/big"
)

// ToHumanReadable converts token amount from wei to human-readable format
func ToHumanReadable(amount *big.Int, decimals uint8) string {
    divisor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)

    quotient := new(big.Int).Div(amount, divisor)
    remainder := new(big.Int).Mod(amount, divisor)

    // Format with decimals
    if remainder.Cmp(big.NewInt(0)) == 0 {
        return quotient.String()
    }

    // Pad remainder with leading zeros
    remainderStr := fmt.Sprintf("%0*s", decimals, remainder.String())

    // Trim trailing zeros
    remainderStr = trimTrailingZeros(remainderStr)

    if remainderStr == "" {
        return quotient.String()
    }

    return fmt.Sprintf("%s.%s", quotient.String(), remainderStr)
}

// FromHumanReadable converts human-readable amount to token amount
func FromHumanReadable(amount string, decimals uint8) (*big.Int, error) {
    // Parse float
    f, _, err := big.ParseFloat(amount, 10, 256, big.ToNearestEven)
    if err != nil {
        return nil, fmt.Errorf("parse amount: %w", err)
    }

    // Multiply by 10^decimals
    multiplier := new(big.Float).SetInt(
        new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil),
    )

    f.Mul(f, multiplier)

    // Convert to int
    result := new(big.Int)
    f.Int(result)

    return result, nil
}

func trimTrailingZeros(s string) string {
    for len(s) > 0 && s[len(s)-1] == '0' {
        s = s[:len(s)-1]
    }
    return s
}
```

---

### Junior → FAANG: ERC-20 Token Integration Fundamentals

ERC-20 is the most widely implemented token standard on Ethereum and the foundation for the majority of DeFi protocol interactions. Understanding the ERC-20 interface thoroughly is a baseline requirement for any Go engineer working with Ethereum. The nine standard functions (`totalSupply`, `balanceOf`, `transfer`, `transferFrom`, `approve`, `allowance`, `name`, `symbol`, `decimals`) and two standard events (`Transfer`, `Approval`) define the interface that all ERC-20 tokens must implement, though non-standard extensions are common.

The most important detail for junior engineers is the `decimals` field: ERC-20 tokens do not store fractional amounts. A token with 18 decimals stores amounts as integers where 1 token is represented as `10^18` (1,000,000,000,000,000,000) in the contract. USDC has 6 decimals, meaning 1 USDC is stored as `1,000,000`. Always use the token's `decimals` value when converting between human-readable amounts and on-chain integer amounts, and never use floating-point arithmetic for this conversion. Go's `math/big` package is the correct tool.

The `approve` and `transferFrom` pattern is the ERC-20 two-step mechanism for allowing a contract to spend tokens on behalf of a user. First, the user calls `approve(spender, amount)` to authorize the spender (typically a DeFi protocol contract) to spend up to `amount` tokens. Then the spender calls `transferFrom(user, recipient, amount)` to execute the transfer. Integrating with DeFi protocols that require token approvals means your Go code must manage this two-step flow correctly, including checking the current allowance before approving (to avoid double-approval scenarios).

Interview entry point: explain the approval race condition in ERC-20. If a user has approved a spender for 100 tokens and wants to change the approval to 50 tokens, they cannot do it safely in two steps: the spender can observe the approval-change transaction in the mempool and front-run it to spend the 100 tokens before the change takes effect. The safe approach is to first set the approval to 0, then to 50. This limitation is why ERC-2612 (permit) was created: it uses off-chain signatures to set approvals atomically.

### Senior @ FAANG: ERC-20 Token Integration at Production Scale

At staff level, ERC-20 token integration is complicated by the variability in how different tokens implement the standard. Tokens like USDT (Tether) do not return a boolean from `transfer`, violating the ERC-20 specification. Tokens like USDC have upgradeability and can change their behavior. Fee-on-transfer tokens (like some deflationary tokens) deduct a fee from each transfer, so the amount received is less than the amount sent. Rebasable tokens (like stETH) change balances without triggering `Transfer` events, through a global rebasing operation.

Handling token variability at scale requires defensive programming patterns: use `SafeERC20` equivalent patterns in Go that handle non-boolean-returning `transfer` calls (by ignoring the return value if the function doesn't return one), check that the received amount equals the expected amount for critical transfers (to detect fee-on-transfer tokens), and monitor for balance changes that are not explained by events (to detect rebasable tokens). Staff engineers document which tokens are known to have non-standard behavior and apply appropriate defensive patterns for each.

Token allowance management is an often-overlooked operational concern. Over time, accumulated approvals from users for a contract that is being decommissioned create a security risk: if the contract is later deployed to a different address that reuses the bytecode, or if the contract has a bug that allows unauthorized calls to `transferFrom`, the accumulated approvals can be exploited. Staff engineers track outstanding token approvals for important contracts and implement a revocation procedure as part of any contract decommission process.

EIP-2612 permit integration allows users to approve token spending via an off-chain EIP-712 signature rather than an on-chain `approve` transaction. This is commonly used in DeFi to enable "permit-and-swap" in a single transaction, reducing gas costs and improving user experience. Go integration with permit requires: fetching the token's domain separator and version from the contract, constructing the EIP-712 typed data structure for the permit message, signing the data using the user's private key, and including the signature in the permit call. abigen generates the correct permit types from the ERC-2612 ABI.

Large-scale token processing (for example, distributing rewards to thousands of token holders in a single operation) requires gas optimization techniques: Merkle drop patterns (where users claim their share by submitting a Merkle proof, rather than having the operator push tokens to each address), batch transfer contracts (that loop through a list of recipients in a single transaction), and meta-transaction patterns (where a relayer submits the transaction on behalf of the user who signed the message). Staff engineers evaluate these patterns against the gas savings, operational complexity, and trust trade-offs for each specific use case.

Bar-raiser signals: explaining the token approval phishing attack (a malicious DApp requests an unlimited approval, then the attacker drains the approved tokens later), what architectural mitigations exist at the wallet and smart contract level, and how a DApp backend can verify that approval amounts are appropriate for the intended use before requesting them. Alternatively, explaining how ERC-4626 tokenized vault shares differ from ERC-20 balances (vault shares represent a proportion of the total vault assets, so the redeemable value per share changes as vault assets accrue yield). These topics reveal genuine DeFi integration experience.

---
