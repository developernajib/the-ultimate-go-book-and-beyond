## 121.9 Multi-signature Wallet Integration

Multi-sig wallets require multiple approvals for transactions - critical for managing significant funds.

### 9.1 Gnosis Safe Overview

Gnosis Safe is the industry-standard multi-sig wallet:

```
┌────────────────────────────────────────┐
│  Multi-Sig Wallet (Gnosis Safe)        │
│  - Owners: [0xA..., 0xB..., 0xC...]    │
│  - Threshold: 2 of 3                   │
└────────────────┬───────────────────────┘
                 │
                 ▼
  Transaction Lifecycle:
  1. Owner A proposes transaction
  2. Owner B approves (threshold met)
  3. Anyone executes transaction
```

### 9.2 Gnosis Safe Integration

The Gnosis Safe client computes the EIP-712 typed-data hash of the Safe transaction struct before signing, ensuring signatures cannot be replayed across different Safe instances or networks due to the domain separator encoding the chain ID and Safe address. Each owner's signature is appended in sorted order by address, as the Safe contract requires signatures to be in ascending signer address order to verify them efficiently.

```go
package multisig

import (
    "context"
    "crypto/ecdsa"
    "fmt"
    "math/big"
    "strings"

    "github.com/ethereum/go-ethereum/accounts/abi"
    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/core/types"
    "github.com/ethereum/go-ethereum/crypto"
    "github.com/ethereum/go-ethereum/ethclient"

    "myproject/contracts/gnosis"
)

// SafeClient wraps Gnosis Safe interactions
type SafeClient struct {
    safe    *gnosis.GnosisSafe
    client  *ethclient.Client
    address common.Address
}

// NewSafeClient creates a Gnosis Safe client
func NewSafeClient(
    ctx context.Context,
    client *ethclient.Client,
    safeAddr common.Address,
) (*SafeClient, error) {
    safe, err := gnosis.NewGnosisSafe(safeAddr, client)
    if err != nil {
        return nil, fmt.Errorf("create safe binding: %w", err)
    }

    return &SafeClient{
        safe:    safe,
        client:  client,
        address: safeAddr,
    }, nil
}

// GetOwners returns the list of owners
func (sc *SafeClient) GetOwners(ctx context.Context) ([]common.Address, error) {
    owners, err := sc.safe.GetOwners(&bind.CallOpts{Context: ctx})
    if err != nil {
        return nil, fmt.Errorf("get owners: %w", err)
    }

    return owners, nil
}

// GetThreshold returns the signature threshold
func (sc *SafeClient) GetThreshold(ctx context.Context) (*big.Int, error) {
    threshold, err := sc.safe.GetThreshold(&bind.CallOpts{Context: ctx})
    if err != nil {
        return nil, fmt.Errorf("get threshold: %w", err)
    }

    return threshold, nil
}

// Transaction represents a Safe transaction
type Transaction struct {
    To             common.Address
    Value          *big.Int
    Data           []byte
    Operation      uint8 // 0 = Call, 1 = DelegateCall
    SafeTxGas      *big.Int
    BaseGas        *big.Int
    GasPrice       *big.Int
    GasToken       common.Address
    RefundReceiver common.Address
    Nonce          *big.Int
}

// GetTransactionHash calculates transaction hash for signing
func (sc *SafeClient) GetTransactionHash(
    ctx context.Context,
    tx *Transaction,
) (common.Hash, error) {
    hash, err := sc.safe.GetTransactionHash(
        &bind.CallOpts{Context: ctx},
        tx.To,
        tx.Value,
        tx.Data,
        tx.Operation,
        tx.SafeTxGas,
        tx.BaseGas,
        tx.GasPrice,
        tx.GasToken,
        tx.RefundReceiver,
        tx.Nonce,
    )
    if err != nil {
        return common.Hash{}, fmt.Errorf("get tx hash: %w", err)
    }

    return hash, nil
}

// SignTransaction signs a transaction hash
func SignTransaction(txHash common.Hash, privateKey *ecdsa.PrivateKey) ([]byte, error) {
    // EIP-191 prefix for personal_sign
    prefix := []byte("\x19Ethereum Signed Message:\n32")
    prefixedHash := crypto.Keccak256Hash(append(prefix, txHash.Bytes()...))

    signature, err := crypto.Sign(prefixedHash.Bytes(), privateKey)
    if err != nil {
        return nil, fmt.Errorf("sign: %w", err)
    }

    // Adjust V for Ethereum signature format
    signature[64] += 27

    return signature, nil
}

// ExecuteTransaction executes a multi-sig transaction
func (sc *SafeClient) ExecuteTransaction(
    ctx context.Context,
    auth *bind.TransactOpts,
    tx *Transaction,
    signatures []byte, // Concatenated signatures
) (*types.Transaction, error) {
    ethTx, err := sc.safe.ExecTransaction(
        auth,
        tx.To,
        tx.Value,
        tx.Data,
        tx.Operation,
        tx.SafeTxGas,
        tx.BaseGas,
        tx.GasPrice,
        tx.GasToken,
        tx.RefundReceiver,
        signatures,
    )
    if err != nil {
        return nil, fmt.Errorf("execute transaction: %w", err)
    }

    return ethTx, nil
}

// ProposeTokenTransfer proposes an ERC-20 transfer
func (sc *SafeClient) ProposeTokenTransfer(
    ctx context.Context,
    tokenAddr common.Address,
    to common.Address,
    amount *big.Int,
) (*Transaction, common.Hash, error) {
    // Encode transfer function call
    parsed, err := abi.JSON(strings.NewReader(erc20.ERC20ABI))
    if err != nil {
        return nil, common.Hash{}, fmt.Errorf("parse abi: %w", err)
    }

    data, err := parsed.Pack("transfer", to, amount)
    if err != nil {
        return nil, common.Hash{}, fmt.Errorf("pack transfer: %w", err)
    }

    // Get next nonce
    nonce, err := sc.safe.Nonce(&bind.CallOpts{Context: ctx})
    if err != nil {
        return nil, common.Hash{}, fmt.Errorf("get nonce: %w", err)
    }

    // Create transaction
    tx := &Transaction{
        To:             tokenAddr,
        Value:          big.NewInt(0),
        Data:           data,
        Operation:      0, // Call
        SafeTxGas:      big.NewInt(0),
        BaseGas:        big.NewInt(0),
        GasPrice:       big.NewInt(0),
        GasToken:       common.Address{},
        RefundReceiver: common.Address{},
        Nonce:          nonce,
    }

    // Get transaction hash
    txHash, err := sc.GetTransactionHash(ctx, tx)
    if err != nil {
        return nil, common.Hash{}, err
    }

    return tx, txHash, nil
}
```

### 9.3 Complete Multi-Sig Workflow

The complete workflow loads private keys for each required signer, collects their signatures in-process, and submits the multi-signed execution transaction in one call. In a real deployment the signing step happens off-chain across separate key holders, the aggregation shown here is for local testing where all keys are available simultaneously.

```go
package main

import (
    "bytes"
    "context"
    "crypto/ecdsa"
    "fmt"
    "log"
    "math/big"

    "github.com/ethereum/go-ethereum/accounts/abi/bind"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/crypto"
    "github.com/ethereum/go-ethereum/ethclient"

    "myproject/multisig"
)

func multiSigExample() {
    ctx := context.Background()

    // Connect to node
    client, err := ethclient.Dial("https://mainnet.infura.io/v3/YOUR-KEY")
    if err != nil {
        log.Fatal(err)
    }
    defer client.Close()

    // Gnosis Safe address
    safeAddr := common.HexToAddress("0x...")

    // Create Safe client
    safeClient, err := multisig.NewSafeClient(ctx, client, safeAddr)
    if err != nil {
        log.Fatal(err)
    }

    // Check configuration
    owners, err := safeClient.GetOwners(ctx)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Safe owners: %v\n", owners)

    threshold, err := safeClient.GetThreshold(ctx)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Signature threshold: %s of %d\n", threshold.String(), len(owners))

    // Propose token transfer
    tokenAddr := common.HexToAddress("0x...") // USDC
    recipient := common.HexToAddress("0x...")
    amount := big.NewInt(1000000) // 1 USDC

    tx, txHash, err := safeClient.ProposeTokenTransfer(ctx, tokenAddr, recipient, amount)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Transaction hash to sign: %s\n", txHash.Hex())

    // Owner 1 signs
    owner1Key, err := crypto.HexToECDSA("owner1-private-key")
    if err != nil {
        log.Fatal(err)
    }

    sig1, err := multisig.SignTransaction(txHash, owner1Key)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Owner 1 signature: %x\n", sig1)

    // Owner 2 signs
    owner2Key, err := crypto.HexToECDSA("owner2-private-key")
    if err != nil {
        log.Fatal(err)
    }

    sig2, err := multisig.SignTransaction(txHash, owner2Key)
    if err != nil {
        log.Fatal(err)
    }
    fmt.Printf("Owner 2 signature: %x\n", sig2)

    // Combine signatures (must be sorted by signer address)
    signatures := combineSignatures(sig1, sig2, owner1Key, owner2Key)

    // Execute transaction (can be done by anyone)
    executorKey, err := crypto.HexToECDSA("executor-private-key")
    if err != nil {
        log.Fatal(err)
    }

    auth, err := bind.NewKeyedTransactorWithChainID(executorKey, big.NewInt(1))
    if err != nil {
        log.Fatal(err)
    }

    ethTx, err := safeClient.ExecuteTransaction(ctx, auth, tx, signatures)
    if err != nil {
        log.Fatal(err)
    }

    fmt.Printf("Execution transaction: %s\n", ethTx.Hash().Hex())

    // Wait for confirmation
    receipt, err := bind.WaitMined(ctx, client, ethTx)
    if err != nil {
        log.Fatal(err)
    }

    if receipt.Status == 1 {
        fmt.Println("Multi-sig transaction executed successfully!")
    } else {
        fmt.Println("Multi-sig transaction failed!")
    }
}

// combineSignatures combines and sorts signatures
func combineSignatures(sig1, sig2 []byte, key1, key2 *ecdsa.PrivateKey) []byte {
    addr1 := crypto.PubkeyToAddress(key1.PublicKey)
    addr2 := crypto.PubkeyToAddress(key2.PublicKey)

    // Sort by address (Gnosis Safe requirement)
    if bytes.Compare(addr1.Bytes(), addr2.Bytes()) < 0 {
        return append(sig1, sig2...)
    }
    return append(sig2, sig1...)
}
```

---

### Junior → FAANG: Multi-Signature Wallets as Institutional Security Primitives

Multi-signature wallets (multisigs) are the de facto standard for securing institutional control of smart contracts and on-chain treasuries. A multisig requires M-of-N key holders to approve a transaction before it is executed, ensuring that no single compromised key can drain a wallet or execute an unauthorized action. Gnosis Safe (now "Safe") is the dominant multisig implementation, securing hundreds of billions of dollars across Ethereum and EVM-compatible chains.

The conceptual prerequisite for junior engineers is understanding that a multisig is a smart contract, not a wallet in the traditional sense. Each "signer" has an EOA that they use to sign transactions approving or rejecting a proposed action. The Safe contract itself holds the funds and executes approved transactions only when the required threshold is met. Signing a Safe transaction is not the same as signing and broadcasting an Ethereum transaction: it produces an off-chain signature that is collected by the Safe SDK and stored until the threshold is reached.

The Safe SDK in Go (or via the Safe Transaction Service REST API) provides the interface for interacting with multisigs programmatically. The workflow for proposing a multisig transaction: construct the Safe transaction data (including the target contract address, value, and calldata), compute the Safe transaction hash, sign the hash with the proposer's key, and submit the signed proposal to the Safe Transaction Service. Other signers then review and countersign the proposal, and when the threshold is reached, any signer can submit the execution transaction.

Interview entry point: explain the difference between the Safe contract's threshold (the number of signers required to approve execution) and the number of owners (the total set of approved signers). A 3-of-5 multisig requires 3 approvals from among 5 owners. Adding or removing an owner is itself a Safe transaction that requires the current threshold of approvals, which prevents a single compromised owner from unilaterally modifying the signer set.

### Senior @ FAANG: Multisig Architecture and Governance at Institutional Scale

At staff level, multisig architecture is a governance design problem as much as a technical one. Choosing the threshold (M-of-N) involves trading off security (higher M means harder to exploit any single key compromise) against availability (higher M means a higher risk of operational failure if signers are unavailable). The right threshold depends on the value at stake, the operational cadence (how often approvals are needed), and the geographic and organizational distribution of the signers.

Safe modules and guards extend the multisig's capabilities beyond simple threshold approval. A module can enable automated execution of certain transaction types without requiring manual signer approval (for example, a rebalancing module that automatically distributes funds according to a policy). A guard can enforce additional checks on each transaction before it is executed (for example, a guard that prevents transfers to sanctioned addresses). Staff engineers design the module and guard architecture as part of the overall multisig governance framework.

Time locks are a critical component of multisig security for high-value or high-impact operations. A time lock adds a mandatory delay between the approval of a transaction and its execution, giving stakeholders time to detect and respond to malicious or erroneous approved transactions. The OpenZeppelin TimelockController is the standard implementation. The time lock delay for a protocol's upgrade governance actions is typically set at 48 hours to 7 days, providing a meaningful response window for the community and the protocol team.

Key management for multisig signers at institutional scale requires the same HSM or MPC infrastructure as direct key management, but with additional complexity: each signer must have a hardware or cryptographic boundary around their signing key, the signing workflow must be auditable (who signed what and when), and the signing process must be accessible to signers who may be in different time zones or who may need to sign from secure devices that are not always connected to the internet.

Automated multisig interactions via bots (for example, a bot that auto-signs treasury management transactions within defined parameters) require careful security design. The bot's key must have limited authority (it can sign certain transaction types but not all), the bot's signing logic must be auditable, and the bot must have rate limiting and sanity checks to prevent exploitation of its automation. Staff engineers design these systems with the assumption that the bot's private key may be compromised, and ensure that a compromised bot cannot cause more damage than the policy limits allow.

Bar-raiser signals: designing a key ceremony for adding a new signer to a production multisig (which requires submitting a Safe transaction that is approved by the current threshold of signers, ensuring the new signer's key is generated and stored securely, and verifying the signer set change is correctly reflected on-chain before trusting the new configuration), or explaining the Safe's delegate mechanism (which allows an address to propose transactions to the Safe on behalf of an owner, without having signing authority) and its security implications. These operational details reveal genuine production multisig experience.

---
