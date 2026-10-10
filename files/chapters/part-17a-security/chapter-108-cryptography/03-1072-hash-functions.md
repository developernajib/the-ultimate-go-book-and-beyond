## 108.2 Hash Functions

Hash functions are the foundation of many cryptographic operations. They're deterministic (same input = same output), fast to compute, and computationally infeasible to reverse.

### SHA-256: The Industry Standard

SHA-256 is part of the SHA-2 family and is the most widely used cryptographic hash function. Use it for integrity checks, content addressing, and any general-purpose hashing.

```go
package main

import (
    "crypto/sha256"
    "encoding/hex"
    "fmt"
)

func main() {
    // Simple hashing
    data := []byte("The quick brown fox jumps over the lazy dog")
    hash := sha256.Sum256(data)

    // Sum256 returns [32]byte, convert to hex string for display
    fmt.Printf("SHA-256: %x\n", hash)
    fmt.Printf("SHA-256 (hex): %s\n", hex.EncodeToString(hash[:]))

    // For streaming data, use the hash.Hash interface
    h := sha256.New()
    h.Write([]byte("The quick brown fox "))
    h.Write([]byte("jumps over the lazy dog"))
    streamHash := h.Sum(nil)

    fmt.Printf("Stream hash: %x\n", streamHash)
}
```

### SHA-3: The Modern Alternative

SHA-3 (Keccak) was standardized in 2015 as an alternative to SHA-2. It uses a completely different internal structure, providing a hedge against potential SHA-2 vulnerabilities.

```go
package main

import (
    "crypto/sha3" // in the standard library since Go 1.24
    "encoding/hex"
    "fmt"
)

func main() {
    data := []byte("The quick brown fox jumps over the lazy dog")

    // SHA3-256
    hash := sha3.Sum256(data)
    fmt.Printf("SHA3-256: %x\n", hash)

    // For streaming
    h := sha3.New256()
    h.Write(data)
    streamHash := h.Sum(nil)
    fmt.Printf("Stream SHA3-256: %x\n", streamHash)

    // SHAKE256 - extendable-output function (XOF)
    // Can produce arbitrary-length output
    shake := sha3.NewSHAKE256()
    shake.Write(data)
    output := make([]byte, 64) // Get 64 bytes of output
    shake.Read(output)
    fmt.Printf("SHAKE256 (64 bytes): %s\n", hex.EncodeToString(output))
}
```

**When to use SHA-3**: In systems requiring long-term security guarantees, or when you need extendable-output functions (SHAKE). For most applications, SHA-256 is sufficient and more widely supported.

### HMAC: Hash-Based Message Authentication

HMAC combines a hash function with a secret key to provide both integrity and authenticity. It proves that a message came from someone who knows the secret key.

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
)

func main() {
    // Secret key - in production, load from secure storage
    key := []byte("super-secret-key-min-32-bytes-long!!")
    message := []byte("The message to authenticate")

    // Create HMAC-SHA256
    mac := hmac.New(sha256.New, key)
    mac.Write(message)
    messageMAC := mac.Sum(nil)

    fmt.Printf("Message: %s\n", message)
    fmt.Printf("HMAC: %s\n", hex.EncodeToString(messageMAC))

    // Verify HMAC
    receivedMAC, _ := hex.DecodeString(hex.EncodeToString(messageMAC))
    if verifyHMAC(message, receivedMAC, key) {
        fmt.Println("HMAC verification: SUCCESS")
    } else {
        fmt.Println("HMAC verification: FAILED")
    }
}

// verifyHMAC securely compares MACs using constant-time comparison
func verifyHMAC(message, messageMAC, key []byte) bool {
    mac := hmac.New(sha256.New, key)
    mac.Write(message)
    expectedMAC := mac.Sum(nil)
    return hmac.Equal(messageMAC, expectedMAC)
}
```

**Critical**: Always use `hmac.Equal()` for comparing MACs. It performs constant-time comparison, preventing timing attacks.

### Junior → FAANG: Hash Functions and Their Misuse

Hash functions are simple to call and easy to misuse. The most common junior mistake is using a hash function for a purpose it cannot fulfill.

**Gap to close:** A hash function is not encryption. It is one-way: you can hash data but cannot unhash it. This makes hashes suitable for integrity verification (did this file change?) and for password storage (store the hash, verify by hashing the input and comparing), but not for data that you ever need to recover. If you need to recover the original value, you need encryption, not hashing.

**The HMAC distinction:** A plain hash (SHA-256) does not prove who created it. An attacker who knows your hash function can compute hashes. HMAC (hash-based message authentication code) uses a secret key to produce a tag that only someone who knows the key can produce or verify. Use plain hashes for integrity. Use HMAC for authentication. This distinction is tested in every serious security interview.

**Interview framing:** When asked "how do you verify that an API request has not been tampered with?", describe HMAC-SHA256: the client signs the request body with a shared secret using HMAC, includes the signature in a header, and the server recomputes the HMAC and compares using constant-time comparison. This is the AWS Signature Version 4 model and is a concrete, recognizable answer.

### Senior @ FAANG: Hash Function Governance and Collision Resistance

At senior level, hash function choices have multi-year implications. SHA-1 collisions were demonstrated in practice by Google in 2017 (SHAttered). MD5 collisions have been practically exploitable since 2004. Systems that used these algorithms in long-lived contexts (certificate signatures, code signing, file integrity databases) required expensive migrations.

**Migration planning:** Audit all usages of hash functions in your codebase and classify them by security requirement. Non-security uses (hash table keys, fast checksums for caching) can use any fast hash. Integrity verification must use SHA-256+. Authentication must use HMAC-SHA256+. Password storage must use bcrypt or argon2id. Any usage of MD5 or SHA-1 in a security context is a finding that requires remediation with a documented timeline.

**Algorithm agility in hash usage:** When storing hashed values that you will need to verify long-term (file hashes in an integrity database, signature verification in a build system), store the algorithm identifier alongside the hash. When you migrate to a stronger algorithm, you can verify old entries with the old algorithm and new entries with the new algorithm during a transition period, then require re-hashing of old entries before the old algorithm is retired.

**HMAC key management:** The security of HMAC depends entirely on the key. HMAC keys must be generated with `crypto/rand`, stored in a secrets manager (not in code or environment variables), rotated on a schedule, and revocable in the event of compromise. An HMAC with a weak or exposed key provides no authentication guarantee. Document the HMAC key management lifecycle in your service's security documentation.

---
