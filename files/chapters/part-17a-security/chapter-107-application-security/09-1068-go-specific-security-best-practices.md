## 107.8 Go-Specific Security Best Practices

### Secure Random Number Generation

```go
package security

import (
    "crypto/rand"
    "encoding/hex"
    "math/big"
)

// GenerateSecureToken creates cryptographically secure random token
func GenerateSecureToken(length int) (string, error) {
    bytes := make([]byte, length)
    if _, err := rand.Read(bytes); err != nil {
        return "", err
    }
    return hex.EncodeToString(bytes), nil
}

// WRONG: Using math/rand for security
func InsecureToken() string {
    // DON'T DO THIS - math/rand is not cryptographically secure
    // return fmt.Sprintf("%d", rand.Int())

    // Use crypto/rand instead
    token, _ := GenerateSecureToken(32)
    return token
}

// SecureRandomInt generates random int in range [0, max)
func SecureRandomInt(max int64) (int64, error) {
    n, err := rand.Int(rand.Reader, big.NewInt(max))
    if err != nil {
        return 0, err
    }
    return n.Int64(), nil
}
```

### Timing Attack Prevention

A timing attack exploits the fact that string comparison with `==` short-circuits on the first mismatched byte, leaking information about how many leading characters match through measurable differences in response time. An attacker who can make thousands of requests can statistically determine a secret token one character at a time. `crypto/subtle.ConstantTimeCompare` eliminates this by always iterating over every byte of both slices regardless of where the first difference occurs, making execution time independent of the input values.

```go
import (
    "crypto/subtle"
)

// CompareTokens safely compares two secrets (API keys, session tokens,
// HMAC values) to prevent timing attacks
func CompareTokens(expected, provided string) bool {
    // WRONG: Using == allows timing attacks
    // return expected == provided

    // RIGHT: Use constant-time comparison
    return subtle.ConstantTimeCompare(
        []byte(expected),
        []byte(provided),
    ) == 1
}
```

Note that `ConstantTimeCompare` returns 0 immediately when the two inputs have different lengths, so it does not hide length differences. Compare fixed-length values (or compare hashes of the inputs) when the secret's length itself must not leak. For passwords, do not use this function at all: `bcrypt.CompareHashAndPassword` or the argon2 verification flow performs the correct comparison as part of hash verification.

### Junior → FAANG: Go's Security Properties Are Not Magic

Go's memory safety eliminates buffer overflows and use-after-free. It does not eliminate logic errors, timing side channels, or incorrect use of cryptographic APIs. Juniors who believe "Go is memory safe so I don't need to think about security" fail code review.

**Gap to close:** Know which properties Go provides by language design (memory safety, garbage collection eliminates dangling pointers, bounds checking eliminates buffer overflows) and which require explicit care (correct use of `crypto/rand` vs `math/rand`, constant-time comparisons for secrets, safe handling of `unsafe` package usage). The `unsafe` package bypasses all of Go's safety guarantees and should be treated as requiring security review.

**First-job habit:** Never use `math/rand` for any security-sensitive value: tokens, session IDs, API keys, nonces, salts. Use `crypto/rand`. The distinction matters because `math/rand` is deterministic given a seed and can be predicted by an attacker. If you see `math/rand` used for a security-sensitive value in a code review, block it.

**Interview framing:** When asked about Go-specific security considerations, mention: `crypto/rand` for randomness, `crypto/subtle` for constant-time comparisons, correct use of `html/template` for output escaping, and the `gosec` tool for static analysis. These four points demonstrate that you understand Go's security model at a practical level.

### Senior @ FAANG: Encoding Go Security Properties in Team Standards

At senior level, Go-specific security best practices become team engineering standards, enforced by tooling rather than memory.

**Linting and static analysis policy:** `gosec` covers a wide range of Go-specific security findings: use of `math/rand` in security contexts (G404), weak TLS configuration (G402), hardcoded credentials (G101), use of `unsafe` (G103), and more. Run `gosec` in CI as a required gate. Define a suppression policy: any suppressed finding requires a comment explaining why it is a false positive and a sign-off from a security-aware engineer. Track suppression counts over time. A growing suppression list is a risk signal.

**`unsafe` usage governance:** Any use of the `unsafe` package in a production service should be documented in a security exception register. The register captures: what the `unsafe` usage does, why it is necessary (alternatives that use safe Go are not sufficient), who approved the exception, and when it will be reviewed. Staff engineers own the review process. This is not bureaucracy: it is the mechanism that prevents unsafe usage from proliferating informally.

**Cryptographic primitive selection:** At org scale, define a cryptographic algorithm policy: approved algorithms and key sizes, deprecated algorithms with a migration timeline, forbidden algorithms. For Go services: `AES-256-GCM` for symmetric encryption, `RSA-2048+` or `ECDSA P-256+` for asymmetric, `SHA-256+` for hashing, `bcrypt` or `argon2id` for password hashing. The policy is a living document reviewed annually or when a new vulnerability is disclosed. Services that use algorithms outside the policy show up in a compliance audit.

**Timing attack surface:** Constant-time comparison is required any time you compare a secret (password hash, HMAC, token). But the requirement extends further: any control flow that exits early based on a secret value creates a timing side channel. For example, comparing a token character by character and returning false on the first mismatch leaks the correct prefix length. `crypto/subtle.ConstantTimeCompare` handles this correctly. Encode this in a team guideline: "Never use `==` to compare secrets. Always use `subtle.ConstantTimeCompare`." Add a `gosec` rule or custom analyzer to enforce it.

---
