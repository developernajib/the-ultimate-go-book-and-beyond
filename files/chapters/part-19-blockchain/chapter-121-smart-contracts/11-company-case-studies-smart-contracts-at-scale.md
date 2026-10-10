## 121.10 Company Case Studies: Smart Contracts at Scale

### Aave: DeFi Lending Protocol

Integrating with Aave's lending protocol (Solidity on-chain) from a Go backend:

```go
// Aave-style lending protocol integration
package lending

import (
    "context"
    "fmt"
    "math/big"
)

// LendingPoolClient interacts with Aave lending pool
type LendingPoolClient struct {
    poolContract      *Contract
    dataProvider      *Contract
    priceOracle       *Contract
    chainClient       *ChainClient
}

type DepositParams struct {
    Asset       string
    Amount      *big.Int
    OnBehalfOf  string
    ReferralCode uint16
}

type BorrowParams struct {
    Asset       string
    Amount      *big.Int
    InterestRateMode int // 1=Stable, 2=Variable
    ReferralCode uint16
    OnBehalfOf  string
}

// Deposit supplies assets to the lending pool
func (c *LendingPoolClient) Deposit(
    ctx context.Context,
    params DepositParams,
    privateKey string,
) (*DepositResult, error) {
    // Check approval
    allowance, err := c.getTokenAllowance(ctx, params.Asset, params.OnBehalfOf, c.poolContract.Address)
    if err != nil {
        return nil, err
    }

    if allowance.Cmp(params.Amount) < 0 {
        if err := c.approveToken(ctx, params.Asset, c.poolContract.Address, privateKey); err != nil {
            return nil, err
        }
    }

    // Execute deposit
    tx, err := c.poolContract.Deposit(ctx, params.Asset, params.Amount, params.OnBehalfOf, params.ReferralCode, privateKey)
    if err != nil {
        return nil, err
    }

    receipt, err := c.chainClient.WaitForReceipt(ctx, tx.Hash)
    if err != nil {
        return nil, err
    }

    return &DepositResult{
        TxHash:      tx.Hash,
        Amount:      params.Amount,
        ATokensMinted: parseATokensMinted(receipt),
    }, nil
}

// GetUserAccountData retrieves user's position
func (c *LendingPoolClient) GetUserAccountData(
    ctx context.Context,
    user string,
) (*UserAccountData, error) {
    result, err := c.poolContract.GetUserAccountData(ctx, user)
    if err != nil {
        return nil, err
    }

    return &UserAccountData{
        TotalCollateralETH:        result.TotalCollateralETH,
        TotalDebtETH:              result.TotalDebtETH,
        AvailableBorrowsETH:       result.AvailableBorrowsETH,
        CurrentLiquidationThreshold: result.CurrentLiquidationThreshold,
        LTV:                       result.Ltv,
        HealthFactor:              result.HealthFactor,
    }, nil
}

// CheckLiquidationOpportunity finds liquidatable positions
func (c *LendingPoolClient) CheckLiquidationOpportunity(
    ctx context.Context,
    users []string,
) ([]LiquidationOpportunity, error) {
    var opportunities []LiquidationOpportunity

    for _, user := range users {
        data, err := c.GetUserAccountData(ctx, user)
        if err != nil {
            continue
        }

        // Health factor < 1 means liquidatable
        one := big.NewInt(1e18)
        if data.HealthFactor.Cmp(one) < 0 {
            opportunity := LiquidationOpportunity{
                User:          user,
                HealthFactor:  data.HealthFactor,
                TotalDebt:     data.TotalDebtETH,
                TotalCollateral: data.TotalCollateralETH,
            }

            // Calculate max liquidation amount (50% of debt)
            halfDebt := new(big.Int).Div(data.TotalDebtETH, big.NewInt(2))
            opportunity.MaxLiquidation = halfDebt

            opportunities = append(opportunities, opportunity)
        }
    }

    return opportunities, nil
}
```

### Compound: Interest Rate Model

Compound's interest rate model integration:

```go
// Compound-style interest rate model
package compound

import (
    "context"
    "math/big"
)

// InterestRateModel calculates supply and borrow rates
type InterestRateModel struct {
    baseRatePerBlock      *big.Int
    multiplierPerBlock    *big.Int
    jumpMultiplierPerBlock *big.Int
    kink                  *big.Int
}

// GetBorrowRate calculates current borrow rate
func (m *InterestRateModel) GetBorrowRate(
    cash, borrows, reserves *big.Int,
) *big.Int {
    utilization := m.getUtilizationRate(cash, borrows, reserves)

    // If utilization <= kink
    if utilization.Cmp(m.kink) <= 0 {
        // baseRate + utilization * multiplier
        rate := new(big.Int).Mul(utilization, m.multiplierPerBlock)
        rate = rate.Div(rate, big.NewInt(1e18))
        rate = rate.Add(rate, m.baseRatePerBlock)
        return rate
    }

    // Jump rate model
    // normalRate = baseRate + kink * multiplier
    normalRate := new(big.Int).Mul(m.kink, m.multiplierPerBlock)
    normalRate = normalRate.Div(normalRate, big.NewInt(1e18))
    normalRate = normalRate.Add(normalRate, m.baseRatePerBlock)

    // excessUtil = utilization - kink
    excessUtil := new(big.Int).Sub(utilization, m.kink)

    // jumpRate = normalRate + excessUtil * jumpMultiplier
    jumpRate := new(big.Int).Mul(excessUtil, m.jumpMultiplierPerBlock)
    jumpRate = jumpRate.Div(jumpRate, big.NewInt(1e18))
    jumpRate = jumpRate.Add(jumpRate, normalRate)

    return jumpRate
}

func (m *InterestRateModel) getUtilizationRate(
    cash, borrows, reserves *big.Int,
) *big.Int {
    // If no borrows, utilization is 0
    if borrows.Sign() == 0 {
        return big.NewInt(0)
    }

    // utilization = borrows / (cash + borrows - reserves)
    denom := new(big.Int).Add(cash, borrows)
    denom = denom.Sub(denom, reserves)

    // Scale by 1e18
    util := new(big.Int).Mul(borrows, big.NewInt(1e18))
    util = util.Div(util, denom)

    return util
}

// CTokenClient interacts with cToken contracts
type CTokenClient struct {
    contract    *Contract
    underlying  *Contract
    chainClient *ChainClient
}

// Mint supplies underlying and receives cTokens
func (c *CTokenClient) Mint(
    ctx context.Context,
    amount *big.Int,
    privateKey string,
) (*MintResult, error) {
    // Get exchange rate before
    exchangeRateBefore, err := c.contract.ExchangeRateCurrent(ctx)
    if err != nil {
        return nil, err
    }

    // Approve and mint
    if err := c.underlying.Approve(ctx, c.contract.Address, amount, privateKey); err != nil {
        return nil, err
    }

    tx, err := c.contract.Mint(ctx, amount, privateKey)
    if err != nil {
        return nil, err
    }

    receipt, err := c.chainClient.WaitForReceipt(ctx, tx.Hash)
    if err != nil {
        return nil, err
    }

    // Calculate cTokens minted
    cTokensMinted := new(big.Int).Mul(amount, big.NewInt(1e18))
    cTokensMinted = cTokensMinted.Div(cTokensMinted, exchangeRateBefore)

    return &MintResult{
        TxHash:        tx.Hash,
        Underlying:    amount,
        CTokensMinted: cTokensMinted,
        ExchangeRate:  exchangeRateBefore,
    }, nil
}
```

### MakerDAO: Vault Management

MakerDAO vault patterns:

```go
// MakerDAO-style vault management
package maker

import (
    "context"
    "fmt"
    "math/big"
)

// VaultManager manages MakerDAO vaults (CDPs)
type VaultManager struct {
    vaultEngine    *Contract  // Vat
    daiJoin        *Contract
    collateralJoin *Contract
    priceOracle    *Contract
    chainClient    *ChainClient
}

type Vault struct {
    ID              *big.Int
    Owner           string
    CollateralType  string
    CollateralLocked *big.Int
    DebtGenerated   *big.Int
    CollateralRatio *big.Int
}

// OpenVault creates a new vault
func (m *VaultManager) OpenVault(
    ctx context.Context,
    collateralType string,
    collateralAmount *big.Int,
    daiAmount *big.Int,
    privateKey string,
) (*Vault, error) {
    // Open new vault
    tx, err := m.vaultEngine.Open(ctx, collateralType, privateKey)
    if err != nil {
        return nil, err
    }

    receipt, err := m.chainClient.WaitForReceipt(ctx, tx.Hash)
    if err != nil {
        return nil, err
    }

    vaultID := parseVaultID(receipt)

    // Lock collateral
    if err := m.lockCollateral(ctx, vaultID, collateralAmount, privateKey); err != nil {
        return nil, err
    }

    // Generate DAI
    if err := m.generateDAI(ctx, vaultID, daiAmount, privateKey); err != nil {
        return nil, err
    }

    return &Vault{
        ID:               vaultID,
        Owner:            getAddressFromKey(privateKey),
        CollateralType:   collateralType,
        CollateralLocked: collateralAmount,
        DebtGenerated:    daiAmount,
    }, nil
}

// GetVaultStatus retrieves vault health
func (m *VaultManager) GetVaultStatus(
    ctx context.Context,
    vaultID *big.Int,
) (*VaultStatus, error) {
    // Get vault data
    vault, err := m.vaultEngine.Urns(ctx, vaultID)
    if err != nil {
        return nil, err
    }

    // Get collateral price
    price, err := m.priceOracle.Peek(ctx, vault.CollateralType)
    if err != nil {
        return nil, err
    }

    // Calculate collateral value
    collateralValue := new(big.Int).Mul(vault.CollateralLocked, price)
    collateralValue = collateralValue.Div(collateralValue, big.NewInt(1e18))

    // Calculate collateral ratio
    if vault.DebtGenerated.Sign() == 0 {
        return &VaultStatus{
            CollateralRatio: nil, // No debt
            Safe:            true,
        }, nil
    }

    ratio := new(big.Int).Mul(collateralValue, big.NewInt(100))
    ratio = ratio.Div(ratio, vault.DebtGenerated)

    // Get minimum ratio (liquidation ratio)
    minRatio, err := m.vaultEngine.GetLiquidationRatio(ctx, vault.CollateralType)
    if err != nil {
        return nil, err
    }

    return &VaultStatus{
        CollateralValue:  collateralValue,
        DebtValue:        vault.DebtGenerated,
        CollateralRatio:  ratio,
        LiquidationRatio: minRatio,
        Safe:             ratio.Cmp(minRatio) >= 0,
    }, nil
}
```

### OpenZeppelin: Access Control Patterns

OpenZeppelin access control in Go:

```go
// OpenZeppelin-style access control
package access

import (
    "context"
    "crypto/sha256"
    "fmt"
)

// AccessControl manages role-based permissions
type AccessControl struct {
    contract    *Contract
    chainClient *ChainClient
}

// Common roles
var (
    DEFAULT_ADMIN_ROLE = [32]byte{0}
    MINTER_ROLE       = keccak256("MINTER_ROLE")
    PAUSER_ROLE       = keccak256("PAUSER_ROLE")
    UPGRADER_ROLE     = keccak256("UPGRADER_ROLE")
)

// HasRole checks if account has role
func (a *AccessControl) HasRole(
    ctx context.Context,
    role [32]byte,
    account string,
) (bool, error) {
    return a.contract.HasRole(ctx, role, account)
}

// GrantRole grants a role to account
func (a *AccessControl) GrantRole(
    ctx context.Context,
    role [32]byte,
    account string,
    adminKey string,
) error {
    // Verify caller has admin role
    hasAdmin, err := a.HasRole(ctx, a.getRoleAdmin(role), getAddressFromKey(adminKey))
    if err != nil {
        return err
    }
    if !hasAdmin {
        return fmt.Errorf("caller is not role admin")
    }

    tx, err := a.contract.GrantRole(ctx, role, account, adminKey)
    if err != nil {
        return err
    }

    _, err = a.chainClient.WaitForReceipt(ctx, tx.Hash)
    return err
}

// AccessControlled wraps contracts with permission checks
type AccessControlledContract struct {
    contract      *Contract
    accessControl *AccessControl
    requiredRoles map[string][32]byte  // method -> role
}

// Call executes a method with permission check
func (c *AccessControlledContract) Call(
    ctx context.Context,
    method string,
    params []any,
    privateKey string,
) (any, error) {
    // Check if method requires role
    if role, needsRole := c.requiredRoles[method]; needsRole {
        caller := getAddressFromKey(privateKey)
        hasRole, err := c.accessControl.HasRole(ctx, role, caller)
        if err != nil {
            return nil, err
        }
        if !hasRole {
            return nil, fmt.Errorf("access denied: missing role for %s", method)
        }
    }

    return c.contract.Call(ctx, method, params, privateKey)
}
```

### Gnosis: Multi-Signature Wallet

Gnosis Safe patterns:

```go
// Gnosis Safe-style multi-sig wallet
package multisig

import (
    "context"
    "fmt"
    "math/big"
)

// SafeClient interacts with Gnosis Safe
type SafeClient struct {
    safeContract *Contract
    proxyFactory *Contract
    chainClient  *ChainClient
}

type SafeTransaction struct {
    To             string
    Value          *big.Int
    Data           []byte
    Operation      uint8   // 0=Call, 1=DelegateCall
    SafeTxGas      *big.Int
    BaseGas        *big.Int
    GasPrice       *big.Int
    GasToken       string
    RefundReceiver string
    Nonce          *big.Int
}

type SafeSignature struct {
    Signer    string
    Signature []byte
}

// CreateSafe deploys a new Gnosis Safe
func (c *SafeClient) CreateSafe(
    ctx context.Context,
    owners []string,
    threshold int,
    privateKey string,
) (string, error) {
    // Encode setup call
    setupData := c.encodeSetup(owners, threshold)

    // Deploy proxy
    tx, err := c.proxyFactory.CreateProxy(ctx, c.safeContract.Address, setupData, privateKey)
    if err != nil {
        return "", err
    }

    receipt, err := c.chainClient.WaitForReceipt(ctx, tx.Hash)
    if err != nil {
        return "", err
    }

    return parseProxyAddress(receipt), nil
}

// ProposeTransaction creates a transaction proposal
func (c *SafeClient) ProposeTransaction(
    ctx context.Context,
    safeAddress string,
    tx *SafeTransaction,
) (string, error) {
    // Get current nonce
    nonce, err := c.safeContract.Nonce(ctx, safeAddress)
    if err != nil {
        return "", err
    }
    tx.Nonce = nonce

    // Calculate transaction hash
    txHash := c.calculateTransactionHash(safeAddress, tx)

    return txHash, nil
}

// SignTransaction signs a pending transaction
func (c *SafeClient) SignTransaction(
    ctx context.Context,
    safeAddress string,
    txHash string,
    privateKey string,
) (*SafeSignature, error) {
    // Sign the transaction hash
    signature, err := signEthMessage(txHash, privateKey)
    if err != nil {
        return nil, err
    }

    return &SafeSignature{
        Signer:    getAddressFromKey(privateKey),
        Signature: signature,
    }, nil
}

// ExecuteTransaction executes a signed transaction
func (c *SafeClient) ExecuteTransaction(
    ctx context.Context,
    safeAddress string,
    tx *SafeTransaction,
    signatures []SafeSignature,
    privateKey string,
) (string, error) {
    // Verify enough signatures
    threshold, err := c.safeContract.GetThreshold(ctx, safeAddress)
    if err != nil {
        return "", err
    }

    if len(signatures) < int(threshold) {
        return "", fmt.Errorf("not enough signatures: %d/%d", len(signatures), threshold)
    }

    // Sort signatures by signer address
    sortedSigs := sortSignatures(signatures)

    // Encode signatures
    encodedSigs := encodeSignatures(sortedSigs)

    // Execute
    execTx, err := c.safeContract.ExecTransaction(
        ctx,
        safeAddress,
        tx.To,
        tx.Value,
        tx.Data,
        tx.Operation,
        tx.SafeTxGas,
        tx.BaseGas,
        tx.GasPrice,
        tx.GasToken,
        tx.RefundReceiver,
        encodedSigs,
        privateKey,
    )
    if err != nil {
        return "", err
    }

    receipt, err := c.chainClient.WaitForReceipt(ctx, execTx.Hash)
    if err != nil {
        return "", err
    }

    return execTx.Hash, nil
}
```

---

### Junior → FAANG: Smart Contract Scale Case Studies as Learning Accelerators

Case studies of smart contracts operating at scale provide the most concentrated source of real-world design decisions available to junior engineers. When OpenZeppelin describes how their governor contract handles edge cases in voting quorum calculation, or when Compound describes the governor bravo upgrade that fixed a critical governance vulnerability, they are sharing lessons that took years of production operation and millions of dollars of value at risk to discover.

The most instructive case studies for junior smart contract integration engineers are those that involve integration failures: the Harvest Finance flash loan attack that exploited price oracle manipulation in USDC and USDT pools, the Rari Fuse reentrancy attack that allowed attackers to drain lending pools, and the Euler Finance attack that exploited a flawed liquidation logic assumption. Each of these provides a clear engineering lesson about a class of vulnerability that must be checked for in any new smart contract integration.

For interview preparation, be able to describe one smart contract integration failure at a technical level: what was the system, what was the vulnerability, how was it exploited, and what would have prevented it. The Compound oracle incident (when a Coinbase price feed reported a \$1000 DAI price, triggering mass unexpected liquidations) is a well-documented example that illustrates the oracle dependency risk in lending protocols and the importance of price feed validation.

First-job habit from case studies: before integrating with any DeFi protocol, read their security documentation, their audit reports, and any post-mortems from incidents they have experienced. This research should be a required step in any integration project, with the findings documented in the integration ADR.

### Senior @ FAANG: Extracting Governance and Architecture Lessons from Scale Case Studies

At staff level, smart contract scale case studies are the primary input to the organization's smart contract risk management framework. A systematic review of the major DeFi exploits from 2020-2025 (over \$6 billion in losses, according to DeFiLlama's hack tracker) produces a taxonomy of failure modes: oracle manipulation, reentrancy, integer overflow (before SafeMath), access control misconfiguration, flash loan amplification, and governance attacks. Each category in this taxonomy should map to a specific architectural mitigation in the organization's integration standards.

The governance attack case study category is particularly relevant for organizations that participate in DeFi governance (as token holders, delegates, or protocol contributors). The Beanstalk governance attack (April 2022) used a flash loan to acquire a super-majority of governance tokens, immediately pass a malicious governance proposal, and drain the protocol's treasury in a single transaction. The attack was possible because Beanstalk lacked a time lock on governance execution. This case study drove widespread adoption of governance time locks across DeFi protocols.

Composability risk, illustrated by multiple case studies, is the systemic risk that smart contract ecosystems create through their interdependencies. When Protocol A integrates with Protocol B, Protocol A inherits all of Protocol B's risks. When Protocol C integrates with both A and B, it inherits all of their risks and any new risks that emerge from their interaction. At the principal engineer level, mapping and quantifying this composability risk for every integration decision is a required step in the due diligence process.

The MakerDAO case studies provide the richest material for understanding governance at scale. MakerDAO's evolution from founder-controlled to community governance (through the Maker Improvement Proposal process), its handling of multiple emergency situations (the Black Thursday liquidation cascade in March 2020, the DAI peg instability during various market events), and its current multi-collateral architecture provide a comprehensive example of how a complex DeFi protocol governs itself over time. Staff engineers who understand this history can apply its lessons to any governance system they design or contribute to.

Upgrade mechanism case studies reveal the hidden complexity of contract upgradeability. Every proxy upgrade in a live system is a potential upgrade failure. The Compound governance upgrade that accidentally gave COMP tokens to the wrong recipients, the Synthetix upgrade that caused incorrect oracle reading, and the various reentrancy bugs introduced in upgrades all illustrate that the upgrade mechanism itself is a significant attack surface. ADRs for upgradeable contract integrations must document the upgrade risk assessment and the testing requirements for any upgrade.

Bar-raiser signals: designing a monitoring system that would have detected the Euler Finance attack in real time (the attack involved multiple transactions over several hours before the main exploit, a monitoring system that tracked the suspicious accumulation of donateToReserves calls and the growing bad debt position could have enabled early intervention), or explaining the constitutional choices that Uniswap's governance makes regarding upgrade rights and protocol fees, and comparing them to Compound's governance model. These detailed case study analyses reveal ecosystem-level depth.

---
