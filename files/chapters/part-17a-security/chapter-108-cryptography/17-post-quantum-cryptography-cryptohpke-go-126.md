## 108.16 Post-Quantum Cryptography: crypto/hpke (Go 1.26)

Go 1.26 introduces `crypto/hpke` implementing Hybrid Public Key Encryption (RFC 9180) with support for post-quantum hybrid Key Encapsulation Mechanisms (KEM).

### Why Post-Quantum Now?

NIST finalized ML-KEM (formerly CRYSTALS-Kyber) as a post-quantum standard in 2024. The threat model is **"harvest now, decrypt later"**: adversaries record encrypted traffic today to decrypt when quantum computers arrive. For data with long confidentiality requirements (medical, financial, legal), migrating now is prudent.

### HPKE Architecture

HPKE (Hybrid Public Key Encryption) combines asymmetric key encapsulation with symmetric authenticated encryption, providing both efficiency and forward secrecy for large payloads. The following Go implementation uses the standard library's `crypto/hpke` API introduced in Go 1.26 for post-quantum-hybrid key exchange.

```
Sender                          Recipient
  │                                  │
  ├── Generate ephemeral key pair     │
  ├── KEM: encapsulate(recipient_pub) │
  │    → encapsulated_key            │
  │    → shared_secret               │
  │                                  │
  ├── KDF: derive AEAD key from       │
  │    shared_secret + context        │
  │                                  │
  ├── AEAD: encrypt(plaintext, key)   │
  │                                  │
  └── Send: encapsulated_key +        │
       ciphertext                     │
                              ├── KEM: decapsulate(encapsulated_key, priv)
                              ├── KDF: derive same AEAD key
                              └── AEAD: decrypt(ciphertext)
```

### Using crypto/hpke in Go 1.26

The example below walks through the full HPKE flow with the standard library API: pick a ciphersuite (KEM, KDF, AEAD), generate the recipient key pair, encapsulate on the sender side, and open on the recipient side. The application context string binds the derived keys to a specific use, so ciphertext produced for one purpose cannot be replayed into another.

```go
package crypto_demo

import (
	"crypto/ecdh"
	"crypto/hpke"
	"fmt"
	"log"
)

func HPKEExample() {
	// Choose: KEM (key exchange) + KDF (key derivation) + AEAD (encryption)
	kem := hpke.DHKEM(ecdh.P256()) // Or hpke.MLKEM768P256() for post-quantum hybrid
	kdf := hpke.HKDFSHA256()
	aead := hpke.AES256GCM()

	// Recipient generates a long-lived key pair
	privKey, err := kem.GenerateKey()
	if err != nil {
		log.Fatal(err)
	}
	pubKey := privKey.PublicKey()

	// Application context binds sender and recipient identities
	appContext := []byte("myapp-v1-user-data-encryption")

	// Sender encrypts
	encappedKey, sender, err := hpke.NewSender(pubKey, kdf, aead, appContext)
	if err != nil {
		log.Fatal(err)
	}

	plaintext := []byte("sensitive financial data")
	aad := []byte("transaction-id-12345") // associated authenticated data
	ciphertext, err := sender.Seal(aad, plaintext)
	if err != nil {
		log.Fatal(err)
	}

	// Recipient decrypts
	recipient, err := hpke.NewRecipient(encappedKey, privKey, kdf, aead, appContext)
	if err != nil {
		log.Fatal(err)
	}
	decrypted, err := recipient.Open(aad, ciphertext)
	if err != nil {
		log.Fatal("decryption failed:", err)
	}
	fmt.Println(string(decrypted)) // "sensitive financial data"
}

// For post-quantum resistance: use ML-KEM hybrid KEM
// pqKem := hpke.MLKEM768P256()
// This requires breaking BOTH ECDH and ML-KEM - quantum-safe today
```

### Migration Strategy

| Data Sensitivity | Action |
|-----------------|--------|
| Long-term secrets (>10 years) | Migrate to ML-KEM hybrid now |
| Medium-term (5-10 years) | Plan migration within 2 years |
| Short-term (<5 years) | Monitor NIST standards, no urgency |
| In-transit only | Standard TLS 1.3 with PQ groups when supported |

### Junior → FAANG: Post-Quantum Cryptography as Career-Long Context

Post-quantum cryptography is not an urgent implementation concern for most juniors today. It is a context to carry throughout your career: the algorithms you are choosing now have a security lifetime, and some of that lifetime may overlap with the availability of practical quantum computers.

**Gap to close:** Understand "harvest now, decrypt later" attacks. An adversary who can record encrypted traffic today and has access to a quantum computer in 10-15 years can retroactively decrypt communications that were encrypted with RSA or ECC key exchange. Data with a sensitivity lifetime exceeding the estimated quantum advantage timeline is at risk today, even though quantum computers capable of breaking RSA do not exist yet. This motivates proactive migration for long-lived sensitive data.

**First-job context:** When you see TLS configurations or key exchange decisions in code, note whether they are post-quantum hybrid capable. Go 1.24+ supports X25519MLKEM768 hybrid key exchange in TLS, enabled by default. Enabling it costs nothing in compatibility (hybrid means it falls back to X25519 with clients that do not support the post-quantum component) and provides protection against future quantum attacks on today's traffic.

### Senior @ FAANG: Leading the Post-Quantum Migration

At senior level, post-quantum cryptography is a roadmap item requiring organizational planning. The migration is multi-year, touches every service that performs cryptographic operations, and requires coordination with compliance teams, vendors, and customers.

**Migration prioritization by data lifetime:** Classify your encrypted data by sensitivity and lifetime. Encryption of a session token that expires in 1 hour has no post-quantum risk: even if decrypted later, the session is gone. Encryption of long-term user data, private keys, or regulated information (PII, PHI, financial records) has a sensitivity lifetime measured in years or decades. Prioritize post-quantum migration by data lifetime and sensitivity.

**Hybrid approach as the migration path:** The NIST-recommended migration path is hybrid cryptography: use classical and post-quantum algorithms simultaneously, so security degrades to the stronger of the two if either is broken. For TLS, this means advertising post-quantum hybrid key exchange groups. For application-layer encryption, this means HPKE with a post-quantum KEM alongside a classical KEM. Document your hybrid migration plan in an ADR with explicit milestones.

**Vendor and library readiness:** Post-quantum migration depends on the readiness of your dependencies: TLS libraries, KMS vendors, HSM firmware, and language standard libraries. Track readiness for each dependency in your migration plan. Go 1.26's `crypto/hpke` is a major enabler. Verify that your KMS vendor supports post-quantum key wrapping before planning a migration that depends on it.

**Organizational communication:** Post-quantum migration requires executive awareness because it is a multi-year, resource-intensive program. Staff engineers prepare the business case: what is the risk, what is the timeline, what resources are needed, and what is the cost of inaction. This communication skill, translating cryptographic migration planning into business risk language, is a defining characteristic of L7 engineers.

---
