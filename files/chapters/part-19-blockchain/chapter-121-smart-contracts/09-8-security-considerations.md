## 121.8 Security Considerations

Smart contract security is paramount - mistakes can lead to loss of funds.

### 8.1 Reentrancy Protection

Reentrancy is when a contract calls back into your contract before the first call completes:

```solidity
// Vulnerable contract
contract Vulnerable {
    mapping(address => uint256) public balances;

    function withdraw() external {
        uint256 amount = balances[msg.sender];

        // DANGEROUS: External call before state update
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success);

        balances[msg.sender] = 0; // Too late!
    }
}

// Protected contract (Checks-Effects-Interactions pattern)
contract Protected {
    mapping(address => uint256) public balances;

    function withdraw() external {
        uint256 amount = balances[msg.sender];

        // Update state BEFORE external call
        balances[msg.sender] = 0;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success);
    }
}

// Better: Use ReentrancyGuard
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract BestPractice is ReentrancyGuard {
    mapping(address => uint256) public balances;

    function withdraw() external nonReentrant {
        uint256 amount = balances[msg.sender];
        balances[msg.sender] = 0;

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success);
    }
}
```

**Go Integration**: When interacting with contracts, be aware of reentrancy risks, especially when calling unknown contracts.

### 8.2 Integer Overflow (Pre-Solidity 0.8)

Before Solidity 0.8, integer operations could overflow/underflow:

```solidity
// Solidity < 0.8 (vulnerable)
contract OldContract {
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b; // Can overflow!
    }
}

// Solidity >= 0.8 (safe by default)
contract NewContract {
    function add(uint256 a, uint256 b) public pure returns (uint256) {
        return a + b; // Reverts on overflow
    }

    function unsafeAdd(uint256 a, uint256 b) public pure returns (uint256) {
        unchecked {
            return a + b; // Explicit opt-out
        }
    }
}
```

**Go Integration**: When interacting with old contracts, validate results in Go:

```go
package security

import (
    "fmt"
    "math/big"
)

// SafeAdd checks for overflow in big.Int addition
func SafeAdd(a, b *big.Int) (*big.Int, error) {
    result := new(big.Int).Add(a, b)

    // Check: result should be >= both inputs
    if result.Cmp(a) < 0 || result.Cmp(b) < 0 {
        return nil, fmt.Errorf("integer overflow detected")
    }

    return result, nil
}

// Max256 is the maximum uint256 value
var Max256 = new(big.Int).Sub(
    new(big.Int).Lsh(big.NewInt(1), 256),
    big.NewInt(1),
)

// ValidateUint256 checks if value fits in uint256
func ValidateUint256(value *big.Int) error {
    if value.Sign() < 0 {
        return fmt.Errorf("negative value not allowed")
    }

    if value.Cmp(Max256) > 0 {
        return fmt.Errorf("value exceeds uint256 max")
    }

    return nil
}
```

### 8.3 Access Control

Proper access control is critical:

```solidity
// Access control with OpenZeppelin
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract SecureContract is Ownable, AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor() {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function adminFunction() external onlyOwner {
        // Only owner can call
    }

    function mint(address to, uint256 amount) external {
        require(hasRole(MINTER_ROLE, msg.sender), "not minter");
        // Mint logic
    }
}
```

**Go Integration**: Verify your address has required permissions before calling:

```go
package access

import (
    "context"
    "fmt"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"

    "myproject/contracts/secured"
)

// CheckRole verifies if an address has a role
func CheckRole(
    ctx context.Context,
    contract *secured.Secured,
    role [32]byte,
    address common.Address,
) (bool, error) {
    hasRole, err := contract.HasRole(&bind.CallOpts{Context: ctx}, role, address)
    if err != nil {
        return false, fmt.Errorf("check role: %w", err)
    }

    return hasRole, nil
}

// EnsureRole ensures address has required role before proceeding
func EnsureRole(
    ctx context.Context,
    contract *secured.Secured,
    role [32]byte,
    address common.Address,
) error {
    hasRole, err := CheckRole(ctx, contract, role, address)
    if err != nil {
        return err
    }

    if !hasRole {
        return fmt.Errorf("address %s does not have required role", address.Hex())
    }

    return nil
}
```

### 8.4 Upgradeable Contracts

Upgradeable contracts use proxy patterns:

```
┌──────────────────┐
│  Proxy Contract  │  ← Users call this (address never changes)
│  - Storage       │
│  - delegatecall  │
└────────┬─────────┘
         │ delegatecall
         ▼
┌──────────────────┐
│ Implementation   │  ← Logic lives here (can be upgraded)
│ - No Storage     │
│ - Pure Logic     │
└──────────────────┘
```

**Go Integration**:

```go
package proxy

import (
    "context"
    "fmt"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"

    "myproject/contracts/proxy"
)

// ProxyManager handles upgradeable contract interactions
type ProxyManager struct {
    client    *ethclient.Client
    proxyAddr common.Address
    proxy     *proxy.TransparentUpgradeableProxy
}

// GetImplementation returns current implementation address
func (pm *ProxyManager) GetImplementation(ctx context.Context) (common.Address, error) {
    impl, err := pm.proxy.Implementation(&bind.CallOpts{Context: ctx})
    if err != nil {
        return common.Address{}, fmt.Errorf("get implementation: %w", err)
    }

    return impl, nil
}

// UpgradeTo upgrades to new implementation
func (pm *ProxyManager) UpgradeTo(
    ctx context.Context,
    auth *bind.TransactOpts,
    newImplementation common.Address,
) error {
    tx, err := pm.proxy.UpgradeTo(auth, newImplementation)
    if err != nil {
        return fmt.Errorf("upgrade: %w", err)
    }

    receipt, err := bind.WaitMined(ctx, pm.client, tx)
    if err != nil {
        return fmt.Errorf("wait upgrade: %w", err)
    }

    if receipt.Status != 1 {
        return fmt.Errorf("upgrade failed")
    }

    return nil
}
```

### 8.5 Security Checklist for Go Integration

A production Go integration requires rigorous pre-flight validation before broadcasting transactions to Ethereum. The checklist below verifies contract verification status, account balance, gas price bounds, and emergency pause flags before submitting any on-chain operation.

```go
package security

import (
    "context"
    "fmt"
    "math/big"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/ethclient"
)

// Checklist represents security verification
type Checklist struct {
    items []CheckItem
}

type CheckItem struct {
    Name        string
    Description string
    Check       func() error
    Critical    bool
}

// SecurityAudit performs security checks before transaction
func SecurityAudit(
    ctx context.Context,
    client *ethclient.Client,
    contractAddr common.Address,
    auth *bind.TransactOpts,
) error {
    checklist := &Checklist{
        items: []CheckItem{
            {
                Name:        "Contract Code Verification",
                Description: "Verify contract is verified on Etherscan",
                Critical:    true,
                Check: func() error {
                    // Check if contract is verified
                    // Call Etherscan API or similar
                    return nil
                },
            },
            {
                Name:        "Balance Check",
                Description: "Ensure sender has sufficient balance",
                Critical:    true,
                Check: func() error {
                    balance, err := client.BalanceAt(ctx, auth.From, nil)
                    if err != nil {
                        return err
                    }

                    // Check against estimated gas cost
                    minRequired := big.NewInt(100000000000000000) // 0.1 ETH
                    if balance.Cmp(minRequired) < 0 {
                        return fmt.Errorf("insufficient balance")
                    }

                    return nil
                },
            },
            {
                Name:        "Gas Price Sanity Check",
                Description: "Ensure gas price is reasonable",
                Critical:    false,
                Check: func() error {
                    maxReasonable := big.NewInt(500000000000) // 500 Gwei
                    if auth.GasPrice != nil && auth.GasPrice.Cmp(maxReasonable) > 0 {
                        return fmt.Errorf("gas price seems too high")
                    }
                    return nil
                },
            },
            {
                Name:        "Contract Not Paused",
                Description: "Check if contract is paused",
                Critical:    true,
                Check: func() error {
                    // Call contract's paused() function if exists
                    return nil
                },
            },
        },
    }

    return checklist.Run()
}

// Run executes all checks
func (c *Checklist) Run() error {
    var criticalFailed []string
    var warningFailed []string

    for _, item := range c.items {
        if err := item.Check(); err != nil {
            if item.Critical {
                criticalFailed = append(criticalFailed, fmt.Sprintf("%s: %v", item.Name, err))
            } else {
                warningFailed = append(warningFailed, fmt.Sprintf("%s: %v", item.Name, err))
            }
        }
    }

    if len(criticalFailed) > 0 {
        return fmt.Errorf("critical checks failed: %v", criticalFailed)
    }

    if len(warningFailed) > 0 {
        fmt.Printf("Warnings: %v\n", warningFailed)
    }

    return nil
}
```

---

### Junior → FAANG: Smart Contract Security as Backend Engineering Responsibility

Smart contract security is not only a concern for Solidity developers: backend engineers who interact with contracts are part of the security perimeter. A backend that calls `transferFrom` without checking the current allowance, or that constructs transaction data from user-supplied inputs without validation, can be exploited even if the smart contract itself is correct.

The input validation requirements for Go code that interacts with smart contracts are more strict than for typical API code because the consequences of incorrect inputs are irreversible. Address validation must check that the address is a valid 20-byte hex string with a valid EIP-55 checksum. Amount validation must check for overflow (amounts that exceed `uint256.Max` will wrap around in the ABI encoding). Function selector validation (for contracts that use raw calldata) must verify that the encoded function matches the intended function.

The most important security pattern to understand is the checks-effects-interactions pattern. This applies to your Go code, not just to Solidity: check all preconditions before initiating any on-chain operation, update your local state only after you have received confirmation of the on-chain operation's success, and never rely on your local state being consistent with on-chain state between an operation's submission and its confirmation.

Interview entry point: describe the front-running vulnerability in a Go application that calls `eth_estimateGas` to check if a contract operation will succeed, then submits the transaction. An attacker who observes the `eth_estimateGas` call (via a mempool monitoring service or by watching the public node's RPC traffic) knows exactly what transaction you are about to submit and can front-run it. For high-value operations, avoid using RPC providers' logs as a security boundary.

### Senior @ FAANG: Smart Contract Security as Architectural Governance

At staff level, smart contract security is a governance responsibility: defining what reviews are required, who can approve integrations, and how security issues are disclosed and remediated. The standard for large DeFi protocols is a formal audit by at least two independent firms for each new contract or major contract upgrade. For application-layer Go code that interacts with contracts, internal security review is the minimum, with external audit reserved for code that manages high-value operations.

The threat model for smart contract integrations must explicitly address: external attacker (exploiting the integration's API to trigger unintended contract calls), insider threat (a rogue engineer who submits an unauthorized transaction from a service account), and supply chain attack (a compromised dependency that modifies transaction data before signing). Each threat requires specific architectural mitigations: access control and authentication for the external threat, multisig and approval workflows for the insider threat, and dependency pinning and code signing for supply chain attacks.

Oracle dependency risk is one of the most systemic security concerns in DeFi-adjacent systems. Any contract that uses a price feed, a random number, or any other data from outside the blockchain is vulnerable to oracle manipulation. The architectural mitigation at the application layer is to monitor oracle values and circuit-break the integration when oracle values deviate beyond expected bounds. A Go monitoring service that checks price feed values against external CEX prices and halts integration operations when the deviation exceeds a threshold is a practical defense in depth measure.

Incident response for smart contract security events requires pre-planning because the response window may be very short. A flash loan attack can drain a protocol's funds in a single transaction (one block, 12 seconds on Ethereum). An effective incident response plan for a smart contract integration includes: contact information for the contract team's security channel, a procedure for pausing the Go backend's interaction with the contract (circuit breaker), a procedure for submitting emergency pause transactions to the contract (if the contract supports pausing), and a communication template for internal and external stakeholders.

Formal verification of critical smart contract interaction logic is an emerging practice at security-conscious organizations. Certora Prover, Dafny, and similar tools allow specifying invariants (e.g., "the total token balance across all accounts must equal the contract's total supply") and verifying that they hold under all possible execution paths. Staff engineers evaluate formal verification tools for the highest-risk components of their smart contract integration and champion their adoption when the risk profile justifies the investment.

Bar-raiser signals: designing a defense against signature replay attacks in an off-chain signing system (a signature valid for action X on chain A must not be valid for the same action on chain B, the solution is including the chain ID and contract address in the signed message, as EIP-712 domain separators do), or explaining how the delegatecall vulnerability enables storage layout collision attacks in proxy patterns (if the implementation contract has a different storage layout than the proxy, delegatecall will overwrite proxy storage with implementation values, potentially corrupting the implementation address pointer). These deep security topics distinguish principal engineers.

---
