## 119.9 Transaction Signing and Verification

Transaction signing in a UTXO blockchain requires fetching the referenced previous transactions so their output scripts can be serialized into the signing hash, ensuring the signature commits to the exact coins being spent. ECDSA over `elliptic.P256` produces a `(r, s)` pair that any node can verify using only the sender's public key and the serialized transaction data, without any shared secret.

```go
// transaction_signing.go
package blockchain

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"math/big"
)

// Sign signs transaction inputs
func (bc *Blockchain) SignTransaction(tx *Transaction, privKey string) {
	prevTXs := make(map[string]Transaction)

	for _, vin := range tx.Vin {
		prevTX, err := bc.FindTransaction(vin.Txid)
		if err != nil {
			log.Panic(err)
		}
		prevTXs[hex.EncodeToString(prevTX.ID)] = *prevTX
	}

	tx.Sign(privKey, prevTXs)
}

// Sign signs each input of a transaction
func (tx *Transaction) Sign(privKeyHex string, prevTXs map[string]Transaction) {
	if tx.IsCoinbase() {
		return
	}

	// Import private key
	wallet, err := ImportPrivateKey(privKeyHex)
	if err != nil {
		log.Panic(err)
	}

	txCopy := tx.TrimmedCopy()

	for inID, vin := range txCopy.Vin {
		prevTx := prevTXs[hex.EncodeToString(vin.Txid)]
		txCopy.Vin[inID].Signature = nil
		txCopy.Vin[inID].PubKey = prevTx.Vout[vin.Vout].PubKeyHash

		// Hash to sign
		dataToSign := fmt.Sprintf("%x\n", txCopy)

		// Sign
		r, s, err := ecdsa.Sign(rand.Reader, wallet.PrivateKey, []byte(dataToSign))
		if err != nil {
			log.Panic(err)
		}
		signature := append(r.Bytes(), s.Bytes()...)

		tx.Vin[inID].Signature = signature
		txCopy.Vin[inID].PubKey = nil
	}
}

// Verify verifies transaction signatures
func (tx *Transaction) Verify(prevTXs map[string]Transaction) bool {
	if tx.IsCoinbase() {
		return true
	}

	txCopy := tx.TrimmedCopy()
	curve := elliptic.P256()

	for inID, vin := range tx.Vin {
		prevTx := prevTXs[hex.EncodeToString(vin.Txid)]
		txCopy.Vin[inID].Signature = nil
		txCopy.Vin[inID].PubKey = prevTx.Vout[vin.Vout].PubKeyHash

		// Reconstruct data that was signed
		dataToVerify := fmt.Sprintf("%x\n", txCopy)

		// Parse signature
		r := big.Int{}
		s := big.Int{}
		sigLen := len(vin.Signature)
		r.SetBytes(vin.Signature[:(sigLen / 2)])
		s.SetBytes(vin.Signature[(sigLen / 2):])

		// Parse public key
		x := big.Int{}
		y := big.Int{}
		keyLen := len(vin.PubKey)
		x.SetBytes(vin.PubKey[:(keyLen / 2)])
		y.SetBytes(vin.PubKey[(keyLen / 2):])

		rawPubKey := ecdsa.PublicKey{Curve: curve, X: &x, Y: &y}

		if !ecdsa.Verify(&rawPubKey, []byte(dataToVerify), &r, &s) {
			return false
		}

		txCopy.Vin[inID].PubKey = nil
	}

	return true
}

// VerifyTransaction verifies a transaction
func (bc *Blockchain) VerifyTransaction(tx *Transaction) bool {
	if tx.IsCoinbase() {
		return true
	}

	prevTXs := make(map[string]Transaction)

	for _, vin := range tx.Vin {
		prevTX, err := bc.FindTransaction(vin.Txid)
		if err != nil {
			return false
		}
		prevTXs[hex.EncodeToString(prevTX.ID)] = *prevTX
	}

	return tx.Verify(prevTXs)
}

// FindTransaction finds a transaction by ID
func (bc *Blockchain) FindTransaction(ID []byte) (*Transaction, error) {
	bci := bc.Iterator()

	for bci.HasNext() {
		block := bci.Next()

		for _, tx := range block.Transactions {
			if bytes.Equal(tx.ID, ID) {
				return tx, nil
			}
		}
	}

	return nil, fmt.Errorf("transaction not found")
}

// TrimmedCopy creates a trimmed copy for signing
func (tx *Transaction) TrimmedCopy() Transaction {
	var inputs []TXInput
	var outputs []TXOutput

	for _, vin := range tx.Vin {
		inputs = append(inputs, TXInput{
			Txid:      vin.Txid,
			Vout:      vin.Vout,
			Signature: nil,
			PubKey:    nil,
		})
	}

	for _, vout := range tx.Vout {
		outputs = append(outputs, TXOutput{
			Value:      vout.Value,
			PubKeyHash: vout.PubKeyHash,
		})
	}

	txCopy := Transaction{
		ID:   tx.ID,
		Vin:  inputs,
		Vout: outputs,
	}

	return txCopy
}
```

---

### Junior → FAANG: Transaction Signing as a Security-Critical Operation

Transaction signing is where private key security and business logic correctness intersect. Every junior engineer working on blockchain systems must internalize one rule before writing any signing code: the private key must never be serialized to a string, logged, or included in any data structure that might be persisted or transmitted. Violations of this rule have caused catastrophic losses at multiple production companies.

The Go-specific prerequisite is understanding how to work with `ecdsa.PrivateKey` from the go-ethereum crypto package. The private key is a `*ecdsa.PrivateKey` wrapping a `big.Int` scalar. To sign an Ethereum transaction in Go: create the transaction with `types.NewTransaction` or the newer `types.NewTx` with EIP-1559 fields, call `types.SignTx` with the appropriate signer (use `types.NewLondonSigner(chainID)` for post-EIP-1559 transactions), and then serialize the signed transaction with `rlp.EncodeToBytes` or `tx.MarshalBinary` before broadcasting.

Verification is the complementary skill that is equally important. Recovering the signer's address from a signed transaction allows you to verify that a transaction was signed by the expected key without having access to the private key. This is used in auditing, forensics, and in some smart contract patterns (EIP-712 typed data signing for off-chain approvals). Practice implementing `crypto.SigToPub` to recover a public key from a message hash and signature, then derive the Ethereum address from the recovered public key.

Interview entry point: walk through what happens if you sign the same transaction twice with the same private key using ECDSA with a different random nonce `k` each time. You get different signatures, both valid. Now walk through what happens if the nonce `k` is the same for two different messages: an attacker can recover your private key using only arithmetic on the two signatures. This is the reason hardware wallets use RFC 6979 deterministic nonce generation, and it is a question that comes up in security-focused blockchain interviews.

### Senior @ FAANG: Signing Infrastructure and Authorization Policy Enforcement

At staff level, transaction signing infrastructure is a security boundary that must be designed with defense in depth. The signing system is the last line of defense before an unauthorized transaction reaches the chain. If application-layer authorization is bypassed by a bug or a compromised service, the signing system's policy enforcement is what prevents financial loss. This dual-layer authorization model is an architectural requirement, not an optional enhancement.

ADRs for signing infrastructure must address the signing policy: which transaction types are permitted, what are the destination address constraints, what are the value limits per transaction and per time window, and what is the approval workflow for transactions that exceed policy limits? These policies must be enforced at the signing layer, not just at the application layer, because the signing layer is the only part of the system that is cryptographically accountable.

EIP-712 typed data signing introduces a structured approach to off-chain signatures that are then submitted to smart contracts. The typed data schema must be hashed according to a specific canonicalization that is distinct from standard RLP encoding. Implementing EIP-712 signing incorrectly is a common source of signature verification failures in production integrations. Staff engineers reviewing EIP-712 implementations verify the domain separator construction (chain ID, contract address, and version must all be correct) and the type hash encoding for each custom struct type in the schema.

Batch signing at high throughput requires careful design of the signing pipeline. A naive approach serializes signing (one transaction at a time through the HSM or MPC protocol) and will bottleneck at a few transactions per second. Production-grade systems parallelize transaction preparation (serialization, hash computation, policy checking) and submit signing requests to the hardware boundary in batches, accepting that the signing operation itself is the throughput bottleneck and optimizing around it.

Signature malleability is a subtle correctness issue in ECDSA: for every valid signature (r, s, v), there is an alternative valid signature (r, n-s, v^1) where n is the curve order. Both signatures are cryptographically valid for the same message, but some systems use the signature bytes as a unique identifier for a transaction or approval, and signature malleability breaks that uniqueness assumption. Ethereum addresses this in smart contracts by requiring `s` to be in the lower half of the curve order (EIP-2). Staff engineers verify that any system that uses signatures as unique identifiers applies this normalization.

Bar-raiser signals: explaining how EIP-2098 compact signature encoding reduces signature size from 65 bytes to 64 bytes and what systems need to be updated to accept both formats, or describing the difference between `personal_sign` (which prepends a fixed prefix before hashing) and `eth_signTypedData` (EIP-712) and why using the wrong one in a smart contract integration causes signature verification to fail even when the key and message are correct. These details distinguish engineers with production debugging experience from those with only tutorial exposure.

At the L7 level, signing infrastructure feeds directly into audit and compliance systems. Every signing event must be logged with: the pre-image (transaction hash), the signer identity (which key pair was used), the policy evaluation result, the timestamp, and a reference to the business event that authorized the signing. These logs must be immutable, tamper-evident, and retained according to the organization's record-keeping policy (which may be five to seven years for financial records). Designing the audit log infrastructure as a first-class component of the signing system, not an afterthought, is a distinguishing characteristic of staff-level work in this domain.

---
