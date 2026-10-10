## 108.4 Asymmetric Encryption

Asymmetric encryption uses key pairs: public keys for encryption, private keys for decryption. This solves the key distribution problem but is much slower than symmetric encryption.

### RSA Encryption

RSA encryption in Go should always use OAEP padding via `rsa.EncryptOAEP`. The legacy PKCS#1 v1.5 padding is vulnerable to padding oracle attacks (Bleichenbacher-style) and exists in the standard library only for compatibility with old protocols. Remember that RSA can only encrypt messages smaller than the key size minus padding overhead, so in practice it encrypts symmetric keys, not bulk data.

```go
package main

import (
    "crypto/rand"
    "crypto/rsa"
    "crypto/sha256"
    "fmt"
)

func main() {
    // Generate RSA key pair
    // MINIMUM 2048 bits, prefer 4096 for long-term security
    privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
    if err != nil {
        panic(err)
    }
    publicKey := &privateKey.PublicKey

    message := []byte("Secret message")

    // Encrypt with public key using OAEP (Optimal Asymmetric Encryption Padding)
    // OAEP is the recommended padding scheme
    ciphertext, err := rsa.EncryptOAEP(
        sha256.New(),
        rand.Reader,
        publicKey,
        message,
        nil, // Optional label
    )
    if err != nil {
        panic(err)
    }
    fmt.Printf("Encrypted: %x\n", ciphertext)

    // Decrypt with private key
    plaintext, err := rsa.DecryptOAEP(
        sha256.New(),
        rand.Reader,
        privateKey,
        ciphertext,
        nil,
    )
    if err != nil {
        panic(err)
    }
    fmt.Printf("Decrypted: %s\n", plaintext)
}
```

### Elliptic Curve Diffie-Hellman (ECDH)

ECDH allows two parties to establish a shared secret over an insecure channel. It's more efficient than RSA and provides the same security with smaller keys.

```go
package main

import (
    "bytes"
    "crypto/ecdh"
    "crypto/rand"
    "fmt"
)

func main() {
    // Alice generates her key pair
    alicePrivate, err := ecdh.P256().GenerateKey(rand.Reader)
    if err != nil {
        panic(err)
    }
    alicePublic := alicePrivate.PublicKey()

    // Bob generates his key pair
    bobPrivate, err := ecdh.P256().GenerateKey(rand.Reader)
    if err != nil {
        panic(err)
    }
    bobPublic := bobPrivate.PublicKey()

    // Alice computes shared secret using Bob's public key
    aliceShared, err := alicePrivate.ECDH(bobPublic)
    if err != nil {
        panic(err)
    }

    // Bob computes shared secret using Alice's public key
    bobShared, err := bobPrivate.ECDH(alicePublic)
    if err != nil {
        panic(err)
    }

    // Both computed the same shared secret
    fmt.Printf("Alice's shared secret: %x\n", aliceShared)
    fmt.Printf("Bob's shared secret: %x\n", bobShared)
    fmt.Printf("Secrets match: %v\n", bytes.Equal(aliceShared, bobShared))

    // Use this shared secret as a key for symmetric encryption
}
```

### Junior → FAANG: Asymmetric Encryption in Practice

Asymmetric encryption is commonly misunderstood as a replacement for symmetric encryption. It is not. It is a key distribution mechanism that enables symmetric encryption to work between parties who have never shared a secret.

**Gap to close:** Understand ECIES (Elliptic Curve Integrated Encryption Scheme) as the modern replacement for RSA-OAEP for bulk hybrid encryption. ECDH P-256 key exchange is faster than RSA, produces shorter keys, and provides equivalent security with smaller computational overhead. For new systems, prefer elliptic curve approaches over RSA.

**Common mistake:** Using the private key to encrypt and the public key to decrypt. This is backwards. Public keys encrypt (anyone can send you a secret message). Private keys decrypt (only you can read it). Private keys sign (only you can create a signature). Public keys verify (anyone can check the signature). Mixing these up in an interview is an immediate red flag.

**Interview framing:** When asked "how do two services securely exchange a symmetric key without a pre-shared secret?", describe ECDH key agreement: each service generates an ephemeral key pair, exchanges public keys, and computes the same shared secret using their private key and the other party's public key. Neither service ever transmits the shared secret. This is the principle behind TLS handshakes.

### Senior @ FAANG: Asymmetric Key Infrastructure at Scale

At senior level, asymmetric cryptography connects to public key infrastructure (PKI), certificate management, key rotation, and trust hierarchies. These are organizational concerns, not individual coding decisions.

**Internal PKI design:** Large organizations maintain an internal certificate authority (CA) for issuing certificates to internal services. This enables mTLS (mutual TLS) between services and workload identity at scale. Decisions about CA hierarchy (root CA offline, intermediate CAs online), certificate lifetime (shorter is safer, but requires more frequent rotation), and revocation mechanism (CRL vs OCSP vs OCSP stapling) are staff-level architectural decisions with multi-year operational implications.

**Key ceremony and HSM:** Private keys for root CAs are generated and stored in hardware security modules (HSMs) using a formal key ceremony with multiple witnesses and an audit log. This procedure prevents the private key from ever existing in plaintext in memory on a general-purpose computer. Staff engineers design the key ceremony procedure, select the HSM vendor, and own the operational runbook. This is the highest-assurance operational practice in cryptography.

**Forward secrecy:** Perfect Forward Secrecy (PFS) ensures that compromise of a long-term private key does not expose past communications. TLS 1.3 mandates PFS by requiring ephemeral key exchange. For your own asymmetric cryptographic protocols, design them to use ephemeral key pairs for each session rather than reusing long-term keys for encryption. Compromised long-term keys should only affect future communications, never past ones.

---
