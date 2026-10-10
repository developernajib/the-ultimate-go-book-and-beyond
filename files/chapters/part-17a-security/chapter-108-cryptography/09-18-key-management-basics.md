## 108.8 Key Management Basics

The strongest encryption is useless if your keys are compromised. Key management is often the weakest link in cryptographic systems.

### Key Generation Best Practices

Cryptographic key generation must use a cryptographically secure random number generator with sufficient entropy, and keys must be sized appropriately for the chosen algorithm's security level. The following examples demonstrate correct key generation for symmetric, asymmetric, and HMAC use cases using Go's `crypto/rand` package.

```go
package main

import (
    "crypto/rand"
    "encoding/base64"
    "fmt"
    "io"
)

// generateKey generates a cryptographically secure random key
func generateKey(size int) ([]byte, error) {
    key := make([]byte, size)
    if _, err := io.ReadFull(rand.Reader, key); err != nil {
        return nil, fmt.Errorf("failed to generate key: %w", err)
    }
    return key, nil
}

func main() {
    // Generate 256-bit (32-byte) key
    key, err := generateKey(32)
    if err != nil {
        panic(err)
    }

    fmt.Printf("Generated key (base64): %s\n", base64.StdEncoding.EncodeToString(key))

    // NEVER:
    // - Hard-code keys in source code
    // - Store keys in version control
    // - Use predictable key generation
    // - Reuse keys across environments

    // ALWAYS:
    // - Use crypto/rand for key generation
    // - Store keys in secure key management systems (Vault, KMS)
    // - Rotate keys regularly
    // - Use different keys for different purposes
    // - Use environment-specific keys
}
```

### Key Derivation Functions (KDF)

Derive multiple keys from a single master key using HKDF, in the standard library as `crypto/hkdf` since Go 1.24:

```go
package main

import (
    "crypto/hkdf"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
)

func deriveKey(masterKey, salt []byte, info string, length int) ([]byte, error) {
    return hkdf.Key(sha256.New, masterKey, salt, info, length)
}

func main() {
    masterKey := []byte("master-secret-key-must-be-32-bytes!!")

    // Derive encryption key
    encKey, _ := deriveKey(masterKey, nil, "encryption", 32)
    fmt.Printf("Encryption key: %s\n", hex.EncodeToString(encKey))

    // Derive authentication key
    authKey, _ := deriveKey(masterKey, nil, "authentication", 32)
    fmt.Printf("Authentication key: %s\n", hex.EncodeToString(authKey))

    // Different info contexts produce different keys from the same master
}
```

### Junior → FAANG: Key Management Is the Hard Part of Cryptography

The most common cryptographic system failure is not a broken algorithm: it is a well-chosen algorithm with poorly managed keys. Key management is where junior engineers most often introduce real vulnerabilities.

**Gap to close:** Know the three failure modes for keys: hardcoded keys in source code (exposed in git history, shared with every developer who clones the repo), keys in environment variables (better, but still exposed in process listings, CI logs, and container inspection), keys in a secrets manager (correct). Any interview answer about cryptographic key storage should name a secrets manager (HashiCorp Vault, AWS KMS, Google Cloud KMS) as the correct location.

**First-job habit:** Never commit any key material to version control, even for tests. Use randomly generated keys in tests that are generated in the test setup and discarded after the test. The habit of never committing key material must be reflexive, not situational.

**Interview framing:** When asked "where do you store encryption keys?", answer with the layered model: data encryption keys (DEKs) in memory during operation, key encryption keys (KEKs) in a KMS, master keys in an HSM (for the highest-assurance requirements). Explain why this hierarchy works: compromising a DEK exposes only the data encrypted with that key. Compromising a KEK requires re-wrapping all DEKs but does not directly expose data. Compromising an HSM-stored master key is operationally prevented by the HSM design.

### Senior @ FAANG: Key Management as Organizational Infrastructure

At senior level, key management is an organizational program with governance, tooling, and operational procedures. It is not a decision made by individual engineers per service.

**Key inventory and ownership:** Maintain a centralized registry of all cryptographic keys used in production: key identifier, algorithm, key size, purpose, owning team, creation date, rotation schedule, and status (active, rotating, deprecated, revoked). Every key in production must have an entry in the registry. Keys without registry entries are a compliance finding. Staff engineers own the registry and the process for adding new keys.

**Rotation automation:** Key rotation must be automated. Manual rotation is error-prone and gets skipped under deadline pressure. For each key type, implement automated rotation: the rotation process generates a new key version, makes it available for new encryptions, re-encrypts data encrypted under old versions on a background schedule, and marks old versions as deprecated after a configured transition period. Alert when rotation is overdue. Document the expected rotation time and alert threshold for each key type.

**Key compromise response:** When a key is potentially compromised, the response must happen faster than an attacker can exploit the key. Pre-write the response runbook: revoke the compromised key version immediately in the KMS, identify all data encrypted under the compromised key version (use the key version metadata you stored with each encrypted record), re-encrypt that data under a new key, audit access logs to determine if the key was used to decrypt data, and assess the exposure scope for breach notification purposes. The runbook is tested annually by simulating a key revocation.

---
