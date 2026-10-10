## 108.3 Symmetric Encryption with AES-GCM

AES (Advanced Encryption Standard) is the symmetric encryption algorithm. AES-GCM (Galois/Counter Mode) provides both encryption and authentication, preventing tampering.

### AES-GCM: Authenticated Encryption

AES-GCM provides authenticated encryption: it simultaneously encrypts the plaintext and computes an authentication tag over the ciphertext, so any tampering with the ciphertext causes `Open` to return an error before the plaintext is ever returned. The nonce (number used once) must be unique for every encryption operation under the same key, the implementation generates it with `crypto/rand.Read` and prepends it to the ciphertext so the recipient can extract it without a separate channel. Using a 256-bit key (32 bytes) rather than 128-bit provides a security margin against future cryptanalytic advances, at negligible performance cost on modern AES-NI-equipped CPUs.

```go
package main

import (
    "crypto/aes"
    "crypto/cipher"
    "crypto/rand"
    "encoding/hex"
    "fmt"
    "io"
)

// encrypt encrypts plaintext using AES-GCM
func encrypt(plaintext, key []byte) ([]byte, error) {
    // Create AES cipher block
    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, fmt.Errorf("failed to create cipher: %w", err)
    }

    // Create GCM mode
    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, fmt.Errorf("failed to create GCM: %w", err)
    }

    // Generate nonce (number used once)
    // CRITICAL: Nonce must be unique for each encryption with the same key
    nonce := make([]byte, gcm.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, fmt.Errorf("failed to generate nonce: %w", err)
    }

    // Encrypt and authenticate
    // Seal appends: nonce + ciphertext + authentication tag
    ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
    return ciphertext, nil
}

// decrypt decrypts ciphertext using AES-GCM
func decrypt(ciphertext, key []byte) ([]byte, error) {
    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, fmt.Errorf("failed to create cipher: %w", err)
    }

    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, fmt.Errorf("failed to create GCM: %w", err)
    }

    nonceSize := gcm.NonceSize()
    if len(ciphertext) < nonceSize {
        return nil, fmt.Errorf("ciphertext too short")
    }

    // Extract nonce and ciphertext
    nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]

    // Decrypt and verify
    plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
    if err != nil {
        return nil, fmt.Errorf("failed to decrypt: %w", err)
    }

    return plaintext, nil
}

func main() {
    // Key must be 16, 24, or 32 bytes for AES-128, AES-192, AES-256
    key := make([]byte, 32) // AES-256
    if _, err := io.ReadFull(rand.Reader, key); err != nil {
        panic(err)
    }

    plaintext := []byte("Secret message that needs encryption")

    // Encrypt
    ciphertext, err := encrypt(plaintext, key)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Encrypted (hex): %s\n", hex.EncodeToString(ciphertext))

    // Decrypt
    decrypted, err := decrypt(ciphertext, key)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Decrypted: %s\n", decrypted)

    // Tampering detection
    ciphertext[20] ^= 0xff // Flip some bits
    if _, err := decrypt(ciphertext, key); err != nil {
        fmt.Printf("Tampering detected: %v\n", err)
    }
}
```

**Key Points**:
- Use AES-256 (32-byte keys) for sensitive data
- Never reuse nonces with the same key
- GCM provides authenticated encryption - tampering is detected
- Store nonces with ciphertext (they're not secret)

### Junior → FAANG: The Nonce Reuse Problem

The nonce reuse problem in AES-GCM is the most common practical symmetric encryption mistake and a frequent interview topic. Understanding it concretely is required knowledge.

**Gap to close:** GCM (Galois/Counter Mode) uses a nonce (number used once) to produce unique ciphertext for each encryption, even with the same key and same plaintext. If you reuse a nonce with the same key, an attacker who observes both ciphertexts can XOR them to cancel out the keystream and recover both plaintexts. This completely breaks confidentiality. In Go, always use `crypto/rand` to generate a fresh 12-byte nonce for every encryption operation.

**Common mistake:** Storing the nonce in a counter that is reset when the service restarts. After a restart, the counter begins at zero again and reuses nonces from the previous session. Use `crypto/rand` instead of counters unless you have explicit infrastructure to persist the counter and ensure uniqueness across restarts and across multiple instances.

**Interview framing:** When asked "how do you encrypt data at rest in Go?", describe the full AES-256-GCM flow: generate the key once with `crypto/rand`, generate a fresh nonce with `crypto/rand` for each encryption, prepend the nonce to the ciphertext for storage (nonces are not secret), and on decryption extract the nonce prefix and use it to decrypt. This complete answer with nonce handling demonstrates practical knowledge.

### Senior @ FAANG: AES-GCM at Scale: Key Rotation and Envelope Encryption

At senior level, AES-GCM questions become questions about key management, key rotation, and encryption at scale. The cryptographic primitive is a solved problem. The operational challenge is what distinguishes senior from junior answers.

**Envelope encryption pattern:** In production systems, you never encrypt user data directly with a master key. Instead, use envelope encryption: generate a unique data encryption key (DEK) with `crypto/rand` for each item or each batch, encrypt the data with the DEK using AES-GCM, encrypt the DEK with a key encryption key (KEK) stored in a KMS (AWS KMS, Google Cloud KMS, HashiCorp Vault), and store the encrypted DEK alongside the encrypted data. To decrypt, first decrypt the DEK using the KMS, then decrypt the data using the DEK. This pattern allows key rotation (replace the KEK, re-encrypt the DEKs) without re-encrypting all data.

**Key rotation operational design:** Define the key rotation schedule in your security policy: KEK rotation annually or on compromise, DEK rotation on re-encryption events. Implement rotation as an online operation: new data uses the new key, old data is re-encrypted on read or on a background migration. Track the fraction of data encrypted under each key version. When 100% of data is encrypted under the current key version, the old key version can be retired.

**Nonce uniqueness at scale:** At very high encryption volumes, even random nonces have non-trivial collision probability (GCM's 96-bit nonce has a collision probability of approximately 1/2^32 after 2^32 encryptions with the same key, which is about 4 billion operations). For very high-volume encryption, use a key hierarchy that rotates DEKs frequently (every 1 million encryptions) to keep the per-key nonce space well below the collision threshold.

**Auditing encryption coverage:** Know what data in your system is encrypted at rest and what is not. Maintain a data inventory that classifies each data store by sensitivity and encryption status. Any sensitive data store that is not encrypted at rest is a finding. Track encryption coverage as a compliance metric and report it in your security posture reviews.

---
