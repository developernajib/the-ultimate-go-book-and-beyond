## 108.6 Password Hashing

**Never** store passwords in plaintext or hash them with general-purpose hash functions like SHA-256. Password hashing requires specialized algorithms designed to be slow and memory-hard.

### bcrypt: The Battle-Tested Choice

bcrypt is designed to be computationally expensive: the cost factor (default 10, each increment doubles work) means an attacker with a stolen hash database must spend orders of magnitude more compute to crack passwords than a fast SHA-256 hash would require. The `bcrypt.GenerateFromPassword` function generates a random salt internally and encodes it into the output hash string, so callers never need to manage salts separately, and `bcrypt.CompareHashAndPassword` uses constant-time comparison to prevent timing side-channels. The cost factor should be tuned upward over time as hardware improves, targeting a hash time of approximately 100-300ms on the deployment hardware.

```go
package main

import (
    "fmt"
    "golang.org/x/crypto/bcrypt"
)

func main() {
    password := []byte("user-password-123")

    // Hash password
    // Cost factor controls computational cost (2^cost iterations)
    // 10-12 for web apps, higher for sensitive systems
    hashedPassword, err := bcrypt.GenerateFromPassword(password, bcrypt.DefaultCost)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Hashed password: %s\n", hashedPassword)

    // Verify password
    err = bcrypt.CompareHashAndPassword(hashedPassword, password)
    if err != nil {
        fmt.Println("Password incorrect")
    } else {
        fmt.Println("Password correct")
    }

    // Wrong password
    wrongPassword := []byte("wrong-password")
    err = bcrypt.CompareHashAndPassword(hashedPassword, wrongPassword)
    if err != nil {
        fmt.Println("Wrong password detected")
    }
}
```

### argon2: The Modern Standard

Argon2 won the Password Hashing Competition in 2015. It's more resistant to GPU/ASIC attacks than bcrypt.

```go
package main

import (
    "crypto/rand"
    "crypto/subtle"
    "encoding/base64"
    "fmt"
    "golang.org/x/crypto/argon2"
    "strings"
)

type ArgonParams struct {
    Memory      uint32 // Memory in KB
    Iterations  uint32 // Number of iterations
    Parallelism uint8  // Degree of parallelism
    SaltLength  uint32 // Length of salt
    KeyLength   uint32 // Length of generated key
}

// Recommended parameters for web applications
var defaultParams = &ArgonParams{
    Memory:      64 * 1024, // 64 MB
    Iterations:  3,
    Parallelism: 2,
    SaltLength:  16,
    KeyLength:   32,
}

func hashPassword(password string, params *ArgonParams) (string, error) {
    // Generate random salt
    salt := make([]byte, params.SaltLength)
    if _, err := rand.Read(salt); err != nil {
        return "", err
    }

    // Hash password
    hash := argon2.IDKey(
        []byte(password),
        salt,
        params.Iterations,
        params.Memory,
        params.Parallelism,
        params.KeyLength,
    )

    // Encode as: $argon2id$v=19$m=65536,t=3,p=2$salt$hash
    b64Salt := base64.RawStdEncoding.EncodeToString(salt)
    b64Hash := base64.RawStdEncoding.EncodeToString(hash)

    encoded := fmt.Sprintf(
        "$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
        argon2.Version,
        params.Memory,
        params.Iterations,
        params.Parallelism,
        b64Salt,
        b64Hash,
    )

    return encoded, nil
}

func verifyPassword(password, encodedHash string) (bool, error) {
    // Parse encoded hash
    parts := strings.Split(encodedHash, "$")
    if len(parts) != 6 {
        return false, fmt.Errorf("invalid hash format")
    }

    var version int
    var params ArgonParams
    _, err := fmt.Sscanf(
        parts[3],
        "m=%d,t=%d,p=%d",
        &params.Memory,
        &params.Iterations,
        &params.Parallelism,
    )
    if err != nil {
        return false, err
    }
    fmt.Sscanf(parts[2], "v=%d", &version)

    salt, err := base64.RawStdEncoding.DecodeString(parts[4])
    if err != nil {
        return false, err
    }

    hash, err := base64.RawStdEncoding.DecodeString(parts[5])
    if err != nil {
        return false, err
    }

    params.KeyLength = uint32(len(hash))

    // Hash input password
    inputHash := argon2.IDKey(
        []byte(password),
        salt,
        params.Iterations,
        params.Memory,
        params.Parallelism,
        params.KeyLength,
    )

    // Constant-time comparison
    return subtle.ConstantTimeCompare(hash, inputHash) == 1, nil
}

func main() {
    password := "super-secret-password"

    // Hash password
    hash, err := hashPassword(password, defaultParams)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Hash: %s\n", hash)

    // Verify correct password
    match, err := verifyPassword(password, hash)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Password match: %v\n", match)

    // Verify wrong password
    match, err = verifyPassword("wrong-password", hash)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Wrong password match: %v\n", match)
}
```

**When to use which**:
- **bcrypt**: Mature, widely supported, good for most web applications
- **argon2**: Better GPU resistance, configurable memory hardness, use for high-security systems

### Junior → FAANG: Password Hashing Is Not Optional

Password hashing is the most consequential security control in any application that stores user credentials. Getting it wrong results in a breach that exposes every user's password. This is a career-defining mistake for the engineers responsible.

**Gap to close:** Understand why bcrypt is different from SHA-256. SHA-256 is fast: a GPU can compute billions of SHA-256 hashes per second. This means an attacker with a password hash database and a GPU can crack most common passwords in hours. bcrypt is intentionally slow: its cost factor determines how many iterations are performed. At cost 12, bcrypt takes approximately 250ms per hash. That 250ms is a feature, not a bug: it reduces offline cracking speed by 8-9 orders of magnitude compared to SHA-256.

**Common mistake:** Using a low bcrypt cost factor for performance reasons. Do not reduce the cost below 12 without a documented security analysis. The 250ms per authentication request is acceptable for login flows. If authentication performance is a bottleneck, the correct solution is authentication caching (short-lived authenticated sessions), not weaker password hashing.

**Interview framing:** When asked "how do you store passwords securely in Go?", describe bcrypt or argon2id, explain the built-in salt (bcrypt generates it automatically), explain the cost factor and why it matters, and mention that you verify with the library's `CompareHashAndPassword` function using constant-time comparison. Do not mention SHA-256, MD5, or any custom hashing approach.

### Senior @ FAANG: Password Hash Migrations and Breach Response

At senior level, password hashing involves operational concerns: migrating existing users to stronger algorithms, responding to breaches, and designing credential storage for multi-tenant systems.

**Online hash migration:** When migrating from a weaker hash (bcrypt cost 10 to cost 12, or MD5 to bcrypt) without forcing all users to reset their passwords, use an online migration: on each successful login, re-hash the password with the new algorithm and store the new hash. After the migration window (typically 90 days), users who have not logged in can be forced to reset. Track the migration progress per user in a `password_hash_version` column. When 100% of active users are on the new algorithm, remove support for the old one.

**Breach response procedure:** If your password hash database is stolen, you need to act within hours, not days. Your runbook should specify: immediate password reset force for all users, customer notification within 72 hours (required by GDPR for EU users), regulatory notification if applicable, public disclosure timeline, and technical remediation (how did the breach occur, what is the fix). The runbook exists before the breach, not during it. Staff engineers own the runbook and the breach response process.

**Multi-tenant password storage:** In multi-tenant SaaS systems, verify that the tenant ID is incorporated into any password hashing context (either as additional data in the hash or as a query filter that prevents cross-tenant credential validation). This prevents an attacker who compromises one tenant's credentials from using them to authenticate as a different tenant. This is an easy mistake to make when password verification logic does not include tenant scoping.

**Argon2id parameter selection:** Argon2id has three tunable parameters: memory cost, time cost, and parallelism. RFC 9106 recommends memory 64MB, time cost 3, parallelism 4 as its memory-constrained option, and the OWASP cheat sheet's minimum baseline is lower (19MB, time cost 2, parallelism 1). Tune these parameters against your authentication server's hardware to achieve at least 100ms per verification on your production hardware. Document the benchmark methodology and results so the parameters can be recalibrated when hardware changes.

---
