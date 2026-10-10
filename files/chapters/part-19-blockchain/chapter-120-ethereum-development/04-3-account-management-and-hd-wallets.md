## 120.3 Account Management and HD Wallets

### 3.1 Understanding Private Keys and Addresses

Ethereum uses ECDSA (Elliptic Curve Digital Signature Algorithm) with the secp256k1 curve:

```
Private Key (256 bits)
    ↓
Public Key (512 bits) = ECDSA(Private Key)
    ↓
Keccak256 Hash
    ↓
Take last 20 bytes
    ↓
Ethereum Address (160 bits / 20 bytes)
```

### 3.2 Generating Accounts

Account generation uses `crypto/rand` to produce a cryptographically secure private key, then derives the public key and Ethereum address through the secp256k1 ECDSA curve and Keccak-256 hash, the same derivation the EVM uses on-chain. The private key is never returned as a string. Callers receive it as `*ecdsa.PrivateKey` so Go's type system prevents accidental logging or serialization of the raw bytes.

```go
// pkg/accounts/generator.go
package accounts

import (
    "crypto/ecdsa"
    "crypto/rand"
    "fmt"

    "github.com/ethereum/go-ethereum/crypto"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/common/hexutil"
)

// Account represents an Ethereum account
type Account struct {
    PrivateKey *ecdsa.PrivateKey
    PublicKey  *ecdsa.PublicKey
    Address    common.Address
}

// GenerateAccount creates a new random Ethereum account
func GenerateAccount() (*Account, error) {
    // Generate private key using secp256k1 curve
    privateKey, err := ecdsa.GenerateKey(crypto.S256(), rand.Reader)
    if err != nil {
        return nil, fmt.Errorf("failed to generate private key: %w", err)
    }

    // Derive public key from private key
    publicKey := privateKey.Public()
    publicKeyECDSA, ok := publicKey.(*ecdsa.PublicKey)
    if !ok {
        return nil, fmt.Errorf("failed to cast public key to ECDSA")
    }

    // Derive Ethereum address from public key
    address := crypto.PubkeyToAddress(*publicKeyECDSA)

    return &Account{
        PrivateKey: privateKey,
        PublicKey:  publicKeyECDSA,
        Address:    address,
    }, nil
}

// PrivateKeyHex returns the private key as a hex string
func (a *Account) PrivateKeyHex() string {
    privateKeyBytes := crypto.FromECDSA(a.PrivateKey)
    return hexutil.Encode(privateKeyBytes)
}

// PublicKeyHex returns the public key as a hex string
func (a *Account) PublicKeyHex() string {
    publicKeyBytes := crypto.FromECDSAPub(a.PublicKey)
    return hexutil.Encode(publicKeyBytes)
}

// FromPrivateKeyHex creates an account from a private key hex string
func FromPrivateKeyHex(privateKeyHex string) (*Account, error) {
    // Remove 0x prefix if present
    if len(privateKeyHex) >= 2 && privateKeyHex[:2] == "0x" {
        privateKeyHex = privateKeyHex[2:]
    }

    privateKeyBytes, err := hexutil.Decode("0x" + privateKeyHex)
    if err != nil {
        return nil, fmt.Errorf("invalid private key hex: %w", err)
    }

    privateKey, err := crypto.ToECDSA(privateKeyBytes)
    if err != nil {
        return nil, fmt.Errorf("failed to parse private key: %w", err)
    }

    publicKey := privateKey.Public()
    publicKeyECDSA, ok := publicKey.(*ecdsa.PublicKey)
    if !ok {
        return nil, fmt.Errorf("failed to cast public key to ECDSA")
    }

    address := crypto.PubkeyToAddress(*publicKeyECDSA)

    return &Account{
        PrivateKey: privateKey,
        PublicKey:  publicKeyECDSA,
        Address:    address,
    }, nil
}

// Example usage
func ExampleGenerateAccount() {
    account, err := GenerateAccount()
    if err != nil {
        panic(err)
    }

    fmt.Printf("Address:     %s\n", account.Address.Hex())
    fmt.Printf("Private Key: %s\n", account.PrivateKeyHex())
    fmt.Printf("Public Key:  %s\n", account.PublicKeyHex())
}
```

### 3.3 HD Wallets (BIP-32/BIP-39/BIP-44)

HD (Hierarchical Deterministic) wallets generate multiple accounts from a single seed, enabling backup of unlimited accounts with one mnemonic phrase.

```go
// pkg/accounts/hdwallet.go
package accounts

import (
    "crypto/ecdsa"
    "fmt"

    "github.com/ethereum/go-ethereum/accounts"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/crypto"
    "github.com/tyler-smith/go-bip39"
    "github.com/tyler-smith/go-bip32"
)

// HDWallet represents a hierarchical deterministic wallet
type HDWallet struct {
    masterKey *bip32.Key
    mnemonic  string
}

// NewHDWallet creates a new HD wallet with a random mnemonic
func NewHDWallet(mnemonicSize int) (*HDWallet, error) {
    // Generate entropy (128, 160, 192, 224, 256 bits)
    // 128 bits = 12 words, 256 bits = 24 words
    entropy, err := bip39.NewEntropy(mnemonicSize)
    if err != nil {
        return nil, fmt.Errorf("failed to generate entropy: %w", err)
    }

    // Generate mnemonic from entropy
    mnemonic, err := bip39.NewMnemonic(entropy)
    if err != nil {
        return nil, fmt.Errorf("failed to generate mnemonic: %w", err)
    }

    return FromMnemonic(mnemonic, "")
}

// FromMnemonic creates an HD wallet from a mnemonic phrase
func FromMnemonic(mnemonic, password string) (*HDWallet, error) {
    // Validate mnemonic
    if !bip39.IsMnemonicValid(mnemonic) {
        return nil, fmt.Errorf("invalid mnemonic")
    }

    // Generate seed from mnemonic (512 bits)
    seed := bip39.NewSeed(mnemonic, password)

    // Generate master key from seed
    masterKey, err := bip32.NewMasterKey(seed)
    if err != nil {
        return nil, fmt.Errorf("failed to generate master key: %w", err)
    }

    return &HDWallet{
        masterKey: masterKey,
        mnemonic:  mnemonic,
    }, nil
}

// DeriveAccount derives an account at the given BIP-44 path
// Standard Ethereum path: m/44'/60'/0'/0/index
func (w *HDWallet) DeriveAccount(index uint32) (*Account, error) {
    // BIP-44 derivation path for Ethereum
    // m / purpose' / coin_type' / account' / change / address_index
    // 44' = BIP-44
    // 60' = Ethereum (coin type)
    // 0' = account 0
    // 0 = external chain (not change addresses)
    // index = address index

    path := []uint32{
        0x8000002C, // 44' (purpose = BIP-44)
        0x8000003C, // 60' (coin_type = Ethereum)
        0x80000000, // 0' (account = 0)
        0,          // 0 (change = external chain)
        index,      // address_index
    }

    key := w.masterKey
    for _, n := range path {
        var err error
        key, err = key.NewChildKey(n)
        if err != nil {
            return nil, fmt.Errorf("failed to derive child key: %w", err)
        }
    }

    // Convert BIP-32 key to ECDSA private key
    privateKey, err := crypto.ToECDSA(key.Key)
    if err != nil {
        return nil, fmt.Errorf("failed to convert to ECDSA: %w", err)
    }

    publicKey := privateKey.Public()
    publicKeyECDSA, ok := publicKey.(*ecdsa.PublicKey)
    if !ok {
        return nil, fmt.Errorf("failed to cast public key to ECDSA")
    }

    address := crypto.PubkeyToAddress(*publicKeyECDSA)

    return &Account{
        PrivateKey: privateKey,
        PublicKey:  publicKeyECDSA,
        Address:    address,
    }, nil
}

// Mnemonic returns the mnemonic phrase
func (w *HDWallet) Mnemonic() string {
    return w.mnemonic
}

// Example: Create HD wallet and derive multiple accounts
func ExampleHDWallet() {
    // Create new HD wallet with 12-word mnemonic
    wallet, err := NewHDWallet(128)
    if err != nil {
        panic(err)
    }

    fmt.Printf("Mnemonic: %s\n\n", wallet.Mnemonic())

    // Derive first 5 accounts
    for i := uint32(0); i < 5; i++ {
        account, err := wallet.DeriveAccount(i)
        if err != nil {
            panic(err)
        }
        fmt.Printf("Account %d: %s\n", i, account.Address.Hex())
    }

    // Restore wallet from mnemonic
    mnemonic := wallet.Mnemonic()
    restoredWallet, err := FromMnemonic(mnemonic, "")
    if err != nil {
        panic(err)
    }

    // Verify restoration
    restoredAccount, _ := restoredWallet.DeriveAccount(0)
    originalAccount, _ := wallet.DeriveAccount(0)
    fmt.Printf("\nRestoration successful: %v\n",
        restoredAccount.Address == originalAccount.Address)
}
```

**Install dependencies**:
```bash
go get github.com/tyler-smith/go-bip39
go get github.com/tyler-smith/go-bip32
```

### 3.4 Secure Key Storage

Never hardcode private keys. Use environment variables or encrypted keystores:

```go
// pkg/accounts/keystore.go
package accounts

import (
    "crypto/ecdsa"
    "fmt"
    "os"
    "path/filepath"

    "github.com/ethereum/go-ethereum/accounts/keystore"
    "github.com/ethereum/go-ethereum/common"
    "github.com/ethereum/go-ethereum/crypto"
)

// KeystoreManager manages encrypted keystore files
type KeystoreManager struct {
    keystore *keystore.KeyStore
}

// NewKeystoreManager creates a new keystore manager
func NewKeystoreManager(keystoreDir string) *KeystoreManager {
    // Create keystore with standard scrypt parameters
    ks := keystore.NewKeyStore(
        keystoreDir,
        keystore.StandardScryptN,
        keystore.StandardScryptP,
    )

    return &KeystoreManager{keystore: ks}
}

// CreateAccount creates a new account and encrypts it with password
func (km *KeystoreManager) CreateAccount(password string) (common.Address, error) {
    account, err := km.keystore.NewAccount(password)
    if err != nil {
        return common.Address{}, fmt.Errorf("failed to create account: %w", err)
    }
    return account.Address, nil
}

// ImportPrivateKey imports a private key and encrypts it
func (km *KeystoreManager) ImportPrivateKey(privateKey *ecdsa.PrivateKey, password string) (common.Address, error) {
    account, err := km.keystore.ImportECDSA(privateKey, password)
    if err != nil {
        return common.Address{}, fmt.Errorf("failed to import private key: %w", err)
    }
    return account.Address, nil
}

// GetPrivateKey retrieves and decrypts a private key
func (km *KeystoreManager) GetPrivateKey(address common.Address, password string) (*ecdsa.PrivateKey, error) {
    // Find account
    account, err := km.keystore.Find(keystore.Account{Address: address})
    if err != nil {
        return nil, fmt.Errorf("account not found: %w", err)
    }

    // Read keystore file
    keyJSON, err := os.ReadFile(account.URL.Path)
    if err != nil {
        return nil, fmt.Errorf("failed to read keystore file: %w", err)
    }

    // Decrypt private key
    key, err := keystore.DecryptKey(keyJSON, password)
    if err != nil {
        return nil, fmt.Errorf("failed to decrypt key: %w", err)
    }

    return key.PrivateKey, nil
}

// Example: Environment-based key loading
func LoadPrivateKeyFromEnv() (*ecdsa.PrivateKey, error) {
    privateKeyHex := os.Getenv("ETHEREUM_PRIVATE_KEY")
    if privateKeyHex == "" {
        return nil, fmt.Errorf("ETHEREUM_PRIVATE_KEY not set")
    }

    privateKey, err := crypto.HexToECDSA(privateKeyHex)
    if err != nil {
        return nil, fmt.Errorf("invalid private key: %w", err)
    }

    return privateKey, nil
}
```

---

### Junior → FAANG: Account Management as the Foundation of Ethereum Interactions

Every Ethereum interaction starts with an account. Understanding the difference between an externally owned account (EOA, controlled by a private key) and a contract account (controlled by EVM code) is the foundational prerequisite for account management. Application code manages EOA private keys for signing transactions. Contract accounts are managed through their own logic, which may include multisig control, time locks, or governance mechanisms.

HD (hierarchical deterministic) wallets are the production standard for managing multiple addresses from a single seed. The BIP-39 mnemonic (12 or 24 words) generates a seed, BIP-32 derives a key tree from the seed, and BIP-44 specifies the derivation path for Ethereum: `m/44'/60'/account'/change/index`. The `go-bip39` and `go-bip32` packages provide the Go implementation, but understanding what each derivation step does (HMAC-SHA512 of the parent key and a child index, producing a child private key and chain code) is necessary before you use them in production.

Keystore management using the go-ethereum `accounts/keystore` package provides encrypted storage for private keys in the V3 keystore format used by Geth. The encryption uses AES-128-CTR with PBKDF2 or scrypt for key derivation. For development and low-security environments this is adequate. For production systems handling significant value, the keystore file format is not considered secure enough: HSM or MPC solutions are the production standard. Know the difference and be able to explain it in an interview.

First-job habit: never store a private key in a configuration file, environment variable, or source code. The minimum acceptable approach for a development environment is a go-ethereum keystore file with a strong passphrase stored in a secrets manager. For production, the private key must be in an HSM or MPC system. Any code review that introduces a private key in any other location should be blocked and treated as a security incident.

### Senior @ FAANG: Account Management Architecture for Institutional Scale

At staff level, account management is a custody architecture problem with regulatory, security, and operational dimensions. The account management system for an institutional crypto company must satisfy: security (private keys are protected against extraction, insider threats, and external attacks), availability (signing operations are available when needed, with defined SLOs), auditability (every signing event is logged with context), and compliance (transaction policies are enforced at the signing layer, not just the application layer).

The HD wallet architecture is valuable even in HSM-based systems because it provides a deterministic relationship between a single root secret and the unlimited set of derived addresses. The root secret lives in the HSM, and address derivation can be performed offline without exposing the root secret. This property is valuable for address pre-generation (you can generate millions of deposit addresses without any HSM interaction after the initial setup) and for disaster recovery (restoring from the root secret recovers all derived addresses).

Account abstraction (ERC-4337, live on Ethereum mainnet since March 2023) changes the account management landscape significantly. With ERC-4337, a "smart account" (a contract account) can be controlled by a variety of authentication schemes: ECDSA signatures (standard), WebAuthn passkeys, multisig thresholds, or even biometric authentication through a trusted oracle. The entry point contract handles signature verification and gas payment (possibly by a third-party "paymaster"). Staff engineers evaluating account abstraction must understand both the security model (the entry point contract is a new trust root) and the operational model (user operations flow through a separate mempool of "bundlers" rather than the standard transaction mempool).

Address derivation at scale requires careful management of the index space. A company that generates unique deposit addresses for users must track which derived addresses have been allocated, which have received funds, and which can be recycled. The address derivation index is a durable piece of state that must be backed up separately from the application database: losing the index means losing the ability to recover funds received at derived addresses unless you perform an expensive scan.

Multisig account management using Gnosis Safe (now "Safe") is the de facto standard for institutional control of smart contract accounts. Staff engineers who design systems around Gnosis Safe must understand the Safe SDK for transaction construction, the threshold signing workflow, the guard and module extensions for custom policy enforcement, and the delegate system for allowing automated signers to propose (but not execute) transactions. The Safe's upgrade mechanism (the Safe singleton is upgradeable via the proxy pattern) is a governance concern that requires formal sign-off from multiple key holders.

Bar-raiser signals: designing an address rotation system that migrates funds from old HD-derived addresses to new ones while maintaining accounting accuracy during the migration, or explaining the ERC-4337 user operation validation flow including the `validateUserOp` function's role in the entry point contract. These topics require both cryptographic understanding and smart contract literacy.

---
