## 108.15 Cryptography Quick Reference

### Cryptography Checklist

| Operation | Recommended Algorithm | Go Package |
|-----------|----------------------|------------|
| Hashing (general) | SHA-256 or SHA-3 | crypto/sha256, crypto/sha3 |
| Password hashing | Argon2id or bcrypt | golang.org/x/crypto/argon2, bcrypt |
| Symmetric encryption | AES-256-GCM | crypto/aes, crypto/cipher |
| Asymmetric encryption | RSA-OAEP (2048+) or ECDH | crypto/rsa, crypto/ecdh |
| Digital signatures | ECDSA or RSA-PSS | crypto/ecdsa, crypto/rsa |
| Key derivation | HKDF or Argon2 | crypto/hkdf, golang.org/x/crypto/argon2 |
| MAC | HMAC-SHA256 | crypto/hmac |
| Random generation | crypto/rand | crypto/rand |

### Quick Reference: Common Operations

Go's standard library and the `golang.org/x/crypto` extension package cover every common cryptographic operation without requiring third-party C bindings. The snippets below use `crypto/rand` as the sole source of randomness, never `math/rand`, which is deterministic and unsuitable for security-sensitive values. Pay particular attention to the AES-GCM pattern: the nonce is prepended to the ciphertext so that decryption can recover it from the same byte slice, and `gcm.Seal` authenticates the message, preventing silent tampering.

```go
package quickref

import (
    "crypto/aes"
    "crypto/cipher"
    "crypto/hmac"
    "crypto/rand"
    "crypto/sha256"
    "crypto/subtle"
    "io"

    "golang.org/x/crypto/bcrypt"
)

// Common cryptographic patterns:
func ReferenceExamples(password, message string, a, b, receivedMAC, plaintext []byte) {
    // Generate random bytes
    key := make([]byte, 32)
    io.ReadFull(rand.Reader, key)

    // Hash password
    hash, _ := bcrypt.GenerateFromPassword([]byte(password), 12)
    _ = bcrypt.CompareHashAndPassword(hash, []byte(password))

    // Encrypt with AES-GCM
    block, _ := aes.NewCipher(key)
    gcm, _ := cipher.NewGCM(block)
    nonce := make([]byte, gcm.NonceSize())
    io.ReadFull(rand.Reader, nonce)
    ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)
    _ = ciphertext

    // HMAC verification
    mac := hmac.New(sha256.New, key)
    mac.Write([]byte(message))
    _ = hmac.Equal(mac.Sum(nil), receivedMAC)

    // Constant-time comparison
    _ = subtle.ConstantTimeCompare(a, b) == 1
}
```

### Junior → FAANG: Making the Checklist Habitual

A cryptography checklist is a forcing function for correct implementation. Juniors who use it consistently produce cryptographically sound code even when they are not thinking explicitly about security.

**Gap to close:** Take the checklist above and implement it as a comment block in your cryptographic code template. Every time you write a function that touches a crypto primitive, paste the checklist, work through each item, and remove the comment block before submitting. This takes 2 minutes and catches the majority of cryptographic mistakes.

**Interview self-check:** Before answering any cryptographic design question in an interview, mentally run through the checklist. Did I mention authentication (GCM or HMAC)? Did I address randomness (`crypto/rand`)? Did I address constant-time comparison for any output that is compared? Did I address key management? An answer that covers all four checklist areas is a complete answer.

### Senior @ FAANG: From Checklist to Enforcement Infrastructure

At senior level, the checklist becomes the specification for automated enforcement. Every item on the checklist maps to a linter rule, a code generation template, or a wrapper library that makes the correct behavior automatic.

**Enforcement mapping:** `crypto/rand` requirement maps to gosec G404. Authenticated mode requirement maps to a custom AST analyzer that flags direct use of `cipher.NewCBC` or similar. Constant-time comparison maps to gosec and a custom rule that flags `==` between byte slices in cryptographic contexts. Error checking maps to `errcheck` linter. Key management maps to gosec G101 (hardcoded credentials). When all items are enforcement-backed, the checklist becomes a verification tool for the enforcement, not a manual gate.

---
