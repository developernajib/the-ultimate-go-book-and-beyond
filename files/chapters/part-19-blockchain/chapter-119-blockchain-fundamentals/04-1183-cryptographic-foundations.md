## 119.3 Cryptographic Foundations

### 3.1 SHA-256 Hashing

SHA-256 (Secure Hash Algorithm 256-bit) is the cryptographic hash function used in Bitcoin and many blockchains. It has crucial properties:

- **Deterministic**: Same input always produces same output
- **Fast to compute**: Can hash gigabytes quickly
- **Avalanche effect**: Tiny input change produces completely different output
- **One-way**: Computationally infeasible to reverse
- **Collision-resistant**: Nearly impossible to find two inputs with same hash

```go
// crypto.go
package blockchain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// Hash256 computes SHA-256 hash of data
func Hash256(data []byte) []byte {
	hash := sha256.Sum256(data)
	return hash[:]
}

// DoubleHash256 computes double SHA-256 (Bitcoin standard)
func DoubleHash256(data []byte) []byte {
	first := sha256.Sum256(data)
	second := sha256.Sum256(first[:])
	return second[:]
}

// Example demonstrating avalanche effect
func DemonstrateAvalanche() {
	data1 := []byte("Hello, Blockchain!")
	data2 := []byte("Hello, Blockchain?") // One character different

	hash1 := Hash256(data1)
	hash2 := Hash256(data2)

	fmt.Printf("Data 1: %s\n", data1)
	fmt.Printf("Hash 1: %s\n\n", hex.EncodeToString(hash1))

	fmt.Printf("Data 2: %s\n", data2)
	fmt.Printf("Hash 2: %s\n\n", hex.EncodeToString(hash2))

	// Count differing bits
	diffBits := 0
	for i := 0; i < len(hash1); i++ {
		xor := hash1[i] ^ hash2[i]
		for xor != 0 {
			diffBits++
			xor &= xor - 1
		}
	}

	fmt.Printf("Differing bits: %d out of 256 (%.1f%%)\n",
		diffBits, float64(diffBits)/256*100)
}
```

### 3.2 ECDSA (Elliptic Curve Digital Signature Algorithm)

ECDSA provides digital signatures for transaction authentication. It's more efficient than RSA for the same security level.

```go
// wallet.go
package blockchain

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"math/big"
)

// Wallet represents a cryptocurrency wallet
type Wallet struct {
	PrivateKey *ecdsa.PrivateKey
	PublicKey  []byte
}

// NewWallet creates a new wallet with keypair
func NewWallet() (*Wallet, error) {
	private, public := newKeyPair()
	wallet := &Wallet{
		PrivateKey: private,
		PublicKey:  public,
	}

	return wallet, nil
}

// newKeyPair generates ECDSA keypair
func newKeyPair() (*ecdsa.PrivateKey, []byte) {
	curve := elliptic.P256() // NIST P-256 curve

	private, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		log.Panic(err)
	}

	// Compress public key: concatenate X and Y coordinates
	pubKey := append(private.PublicKey.X.Bytes(), private.PublicKey.Y.Bytes()...)

	return private, pubKey
}

// GetAddress derives wallet address from public key
func (w *Wallet) GetAddress() string {
	// Hash public key
	pubKeyHash := HashPubKey(w.PublicKey)

	// Add version byte (0x00 for Bitcoin)
	versionedPayload := append([]byte{0x00}, pubKeyHash...)

	// Calculate checksum (first 4 bytes of double hash)
	checksum := Checksum(versionedPayload)

	// Combine version + hash + checksum
	fullPayload := append(versionedPayload, checksum...)

	// Base58 encode
	address := Base58Encode(fullPayload)

	return address
}

// HashPubKey hashes public key for address generation
func HashPubKey(pubKey []byte) []byte {
	// SHA-256 then RIPEMD-160 (Bitcoin standard)
	publicSHA256 := sha256.Sum256(pubKey)

	// For simplicity, we'll use SHA-256 again instead of RIPEMD-160
	// In production, use golang.org/x/crypto/ripemd160
	publicHash := sha256.Sum256(publicSHA256[:])

	return publicHash[:]
}

// Checksum generates a checksum for payload
func Checksum(payload []byte) []byte {
	first := sha256.Sum256(payload)
	second := sha256.Sum256(first[:])

	return second[:4]
}

// Sign creates a digital signature for data
func (w *Wallet) Sign(data []byte) ([]byte, error) {
	// Hash the data
	hash := sha256.Sum256(data)

	// Sign the hash
	r, s, err := ecdsa.Sign(rand.Reader, w.PrivateKey, hash[:])
	if err != nil {
		return nil, fmt.Errorf("signing failed: %w", err)
	}

	// Serialize signature (r || s)
	signature := append(r.Bytes(), s.Bytes()...)

	return signature, nil
}

// Verify validates a signature
func Verify(pubKey, data, signature []byte) bool {
	// Parse public key
	curve := elliptic.P256()
	keyLen := len(pubKey)
	x := big.Int{}
	y := big.Int{}
	x.SetBytes(pubKey[:keyLen/2])
	y.SetBytes(pubKey[keyLen/2:])

	rawPubKey := ecdsa.PublicKey{Curve: curve, X: &x, Y: &y}

	// Parse signature
	r := big.Int{}
	s := big.Int{}
	sigLen := len(signature)
	r.SetBytes(signature[:sigLen/2])
	s.SetBytes(signature[sigLen/2:])

	// Hash data
	hash := sha256.Sum256(data)

	// Verify
	return ecdsa.Verify(&rawPubKey, hash[:], &r, &s)
}

// Base58Encode encodes bytes to base58 (simplified version)
func Base58Encode(input []byte) string {
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

	// Convert to big int
	x := big.NewInt(0)
	x.SetBytes(input)

	// Divide by 58 repeatedly
	base := big.NewInt(58)
	zero := big.NewInt(0)
	mod := &big.Int{}

	var encoded []byte
	for x.Cmp(zero) > 0 {
		x.DivMod(x, base, mod)
		encoded = append(encoded, alphabet[mod.Int64()])
	}

	// Reverse
	for i, j := 0, len(encoded)-1; i < j; i, j = i+1, j-1 {
		encoded[i], encoded[j] = encoded[j], encoded[i]
	}

	// Handle leading zeros
	for _, b := range input {
		if b == 0x00 {
			encoded = append([]byte{alphabet[0]}, encoded...)
		} else {
			break
		}
	}

	return string(encoded)
}

// ExportPrivateKey exports private key as hex string
func (w *Wallet) ExportPrivateKey() string {
	return hex.EncodeToString(w.PrivateKey.D.Bytes())
}

// ImportPrivateKey imports private key from hex string
func ImportPrivateKey(keyHex string) (*Wallet, error) {
	keyBytes, err := hex.DecodeString(keyHex)
	if err != nil {
		return nil, fmt.Errorf("decode hex: %w", err)
	}

	curve := elliptic.P256()
	private := &ecdsa.PrivateKey{}
	private.PublicKey.Curve = curve
	private.D = new(big.Int).SetBytes(keyBytes)
	private.PublicKey.X, private.PublicKey.Y = curve.ScalarBaseMult(keyBytes)

	pubKey := append(private.PublicKey.X.Bytes(), private.PublicKey.Y.Bytes()...)

	return &Wallet{
		PrivateKey: private,
		PublicKey:  pubKey,
	}, nil
}
```

---

### Junior → FAANG: Cryptographic Foundations Every Blockchain Engineer Must Own

Blockchain systems rest entirely on three cryptographic primitives: hash functions, digital signatures, and public key cryptography. A junior engineer who treats these as black boxes will eventually make a security error that is catastrophic and irreversible because blockchain state cannot be rolled back. Close this gap before anything else.

The specific gap that causes the most first-job mistakes is the difference between `crypto/sha256` (used in Bitcoin and many other chains) and `golang.org/x/crypto/sha3` with the Keccak variant (used in Ethereum). These are different hash functions and produce different outputs for the same input. Using `sha3.New256()` from the standard library will not produce Ethereum-compatible hashes because the standard library implements the NIST SHA3 standard, which differs from the Keccak-256 that Ethereum finalized before NIST published its standard. The correct package is `github.com/ethereum/go-ethereum/crypto` which wraps the correct Keccak implementation.

For ECDSA digital signatures, the key prerequisite is understanding that the secp256k1 curve used by Ethereum and Bitcoin is not the curve used by Go's standard library `crypto/elliptic` package (which provides P-224, P-256, P-384, P-521). Any code that tries to use the standard library for Ethereum address derivation from a public key will produce incorrect results. The go-ethereum library provides the correct secp256k1 implementation.

Interview entry point: be able to walk through how an Ethereum address is derived from a private key. Private key is a random 32-byte integer. Public key is the secp256k1 elliptic curve point at `private_key * G`. Ethereum address is the last 20 bytes of the Keccak-256 hash of the 64-byte public key (uncompressed, without the `04` prefix byte). This derivation chain should be producible from memory.

### Senior @ FAANG: Cryptographic Governance and Risk Management

At staff level, cryptographic choices in blockchain systems are irreversible by design. A public key committed to a smart contract, an address used in a multisig configuration, or a hash function hardcoded into a proof verification circuit cannot be changed without a migration that may be impossible if the system manages real economic value. This irreversibility demands that cryptographic decisions go through formal architectural review before any code reaches production.

Algorithm agility, a principle well-established in TLS design, is largely absent in blockchain systems and for good reason: changing the signature scheme of a chain requires a hard fork. Staff engineers must understand the current state of quantum resistance planning for the chains their systems depend on. NIST finalized its first post-quantum signature standards in 2024 (ML-DSA, SLH-DSA). Ethereum's roadmap includes quantum resistance at the consensus level but the timeline is measured in years. Any system that will hold economic value for more than five years should have a documented plan for the migration path.

Key management is the dominant source of irreversible loss in blockchain systems. A junior engineer's job is to use the key correctly. A staff engineer's job is to design the key management system: which keys live in HSMs, which keys use threshold signing (Shamir Secret Sharing or multi-party computation), how key rotation works without breaking on-chain references, and what the incident response procedure is for suspected key compromise. The Fireblocks and Fordefi products exist specifically because this problem is hard enough that most organizations cannot solve it in-house.

Multisig and MPC (Multi-Party Computation) are two distinct approaches to threshold key management with very different trust and operational properties. Multisig (on-chain, as in Gnosis Safe) is transparent and auditable but requires on-chain transactions for configuration changes and has higher gas cost per operation. MPC (off-chain, as in GG18/GG20 protocols) has lower on-chain cost and hides the threshold structure from observers but requires careful implementation of the MPC protocol itself and has had implementation vulnerabilities in practice. ADRs for key management systems must compare these trade-offs explicitly.

Cryptographic audit requirements at FAANG-adjacent blockchain companies include: every custom cryptographic operation must be reviewed by a cryptographer, not just a security engineer. "Cryptographer" here means someone with published research or demonstrated deep expertise in the specific primitive being used, not someone who knows how to call `crypto.Sign`. Staff engineers are responsible for routing code for this specialized review and for not shipping cryptographic implementations before that review is complete.

Bar-raiser interview signals in cryptography: explaining why using a random nonce in ECDSA without a hardware random source is dangerous (k-reuse attack can expose the private key), describing what a hash commitment scheme is and how it is used in zero-knowledge proof systems, or designing a system that proves knowledge of a preimage without revealing it. These questions test foundational understanding that cannot be faked with terminology.

Regulatory dimensions of cryptography in blockchain systems include export control for cryptographic software (EAR regulations in the US), requirements under FIPS 140-2/140-3 for government-adjacent applications, and the intersection of data privacy law (GDPR's right to erasure) with the immutability of cryptographic commitments on a public chain. A staff engineer who owns a blockchain platform must understand these constraints and design systems that satisfy them without compromising security.

---
