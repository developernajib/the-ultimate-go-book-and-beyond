## 108.11 Production Pitfalls: Cryptographic Disasters

### Pitfall 1: Using ECB Mode for Encryption

**Incident Pattern**: A payment processor encrypted card numbers with AES-ECB. Security researchers noticed identical plaintexts produced identical ciphertexts, allowing them to identify cardholders who used the same card at different merchants by pattern analysis.

**The Anti-Pattern**:
```go
// WRONG: ECB mode reveals patterns
func encryptCardNumber(key, pan []byte) ([]byte, error) {
    block, _ := aes.NewCipher(key)

    // ECB: Same plaintext = Same ciphertext
    // Card "4111111111111111" always encrypts to same value
    ciphertext := make([]byte, len(pan))
    for i := 0; i < len(pan); i += aes.BlockSize {
        block.Encrypt(ciphertext[i:], pan[i:])
    }
    return ciphertext, nil
}
```

**The Better Approach**:
```go
// RIGHT: Use GCM for authenticated encryption
func encryptCardNumber(key, pan []byte) ([]byte, error) {
    block, err := aes.NewCipher(key)
    if err != nil {
        return nil, err
    }

    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }

    // Random nonce ensures same plaintext → different ciphertext
    nonce := make([]byte, gcm.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, err
    }

    // GCM provides encryption + authentication
    ciphertext := gcm.Seal(nonce, nonce, pan, nil)
    return ciphertext, nil
}
```

**Key Insight**: ECB mode should never be used for encrypting data larger than one block. GCM provides both confidentiality and integrity, plus unique ciphertexts for repeated plaintexts.

---

### Pitfall 2: Reusing Nonces in Stream Ciphers

**Incident Pattern**: A messaging app reused the same nonce for ChaCha20-Poly1305 encryption when resuming interrupted uploads. An attacker intercepted two messages with the same nonce and XORed them together to reveal both plaintexts.

**The Anti-Pattern**:
```go
// WRONG: Deterministic nonce generation
func encrypt(key []byte, messageID int64, plaintext []byte) ([]byte, error) {
    aead, _ := chacha20poly1305.NewX(key)

    // Nonce based on message ID - will repeat on retry/resume!
    nonce := make([]byte, aead.NonceSize())
    binary.BigEndian.PutUint64(nonce, uint64(messageID))

    return aead.Seal(nil, nonce, plaintext, nil), nil
}
```

**The Better Approach**:
```go
// RIGHT: Random nonce or unique counter with collision resistance
func encrypt(key []byte, plaintext []byte) ([]byte, error) {
    // XChaCha20 has 192-bit nonce - safe for random generation
    aead, err := chacha20poly1305.NewX(key)
    if err != nil {
        return nil, err
    }

    // Random nonce for each encryption
    nonce := make([]byte, aead.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, err
    }

    // Prepend nonce to ciphertext
    ciphertext := aead.Seal(nonce, nonce, plaintext, nil)
    return ciphertext, nil
}

// For counter-based nonces, use atomic operations
type SecureEncryptor struct {
    key     []byte
    counter atomic.Uint64
    mu      sync.Mutex
}

func (e *SecureEncryptor) Encrypt(plaintext []byte) ([]byte, error) {
    e.mu.Lock()
    defer e.mu.Unlock()

    // Get unique counter value
    count := e.counter.Add(1)
    if count == 0 {
        return nil, errors.New("nonce counter overflow - rotate key")
    }

    aead, _ := chacha20poly1305.New(e.key)
    nonce := make([]byte, aead.NonceSize())
    binary.BigEndian.PutUint64(nonce[4:], count)

    return aead.Seal(nonce, nonce, plaintext, nil), nil
}
```

**Key Insight**: Nonce reuse with the same key completely breaks stream cipher security. Use random nonces with extended algorithms (XChaCha20) or carefully managed counters that can never repeat.

---

### Pitfall 3: Using math/rand for Cryptographic Operations

**Incident Pattern**: A SaaS platform generated password reset tokens using `math/rand` seeded with the current Unix timestamp. An attacker calculated the seed from the email timestamp, predicted all tokens generated within that second, and compromised thousands of accounts.

**The Anti-Pattern**:
```go
// WRONG: math/rand is predictable
func generateResetToken() string {
    rand.Seed(time.Now().UnixNano()) // Predictable seed! (Also deprecated since Go 1.20)

    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    token := make([]byte, 32)
    for i := range token {
        token[i] = charset[rand.Intn(len(charset))]
    }
    return string(token)
}
```

**The Better Approach**:
```go
// RIGHT: crypto/rand for all security-sensitive random values
func generateResetToken() (string, error) {
    // 32 bytes = 256 bits of entropy
    bytes := make([]byte, 32)
    if _, err := cryptorand.Read(bytes); err != nil {
        return "", fmt.Errorf("failed to generate token: %w", err)
    }

    // URL-safe encoding
    return base64.RawURLEncoding.EncodeToString(bytes), nil
}

// For session IDs, API keys, etc.
func generateSecureID(length int) (string, error) {
    bytes := make([]byte, length)
    if _, err := cryptorand.Read(bytes); err != nil {
        return "", err
    }
    return hex.EncodeToString(bytes), nil
}
```

**Key Insight**: `math/rand` is a PRNG designed for speed, not security. Its output is predictable given the seed. All security tokens, session IDs, and cryptographic operations must use `crypto/rand`.

---

### Pitfall 4: Improper Key Derivation from Passwords

**Incident Pattern**: A backup encryption tool derived AES keys by SHA-256 hashing the password directly. Attackers used precomputed tables and cracked the majority of backups protected by common passwords within hours.

**The Anti-Pattern**:
```go
// WRONG: Direct hash for key derivation
func deriveKey(password string) []byte {
    hash := sha256.Sum256([]byte(password))
    return hash[:] // Vulnerable to rainbow tables
}

// Also wrong: Single iteration PBKDF2
func deriveKeyWeak(password string, salt []byte) []byte {
    return pbkdf2.Key([]byte(password), salt, 1, 32, sha256.New)
}
```

**The Better Approach**:
```go
// RIGHT: Use Argon2id for password-based key derivation
func deriveKey(password string, salt []byte) ([]byte, error) {
    if len(salt) < 16 {
        return nil, errors.New("salt must be at least 16 bytes")
    }

    // Argon2id parameters for 2023+ recommendations
    // Memory: 64MB, Iterations: 3, Parallelism: 4
    key := argon2.IDKey(
        []byte(password),
        salt,
        3,           // iterations
        64*1024,     // 64MB memory
        4,           // parallelism
        32,          // key length
    )
    return key, nil
}

// Generate proper salt
func generateSalt() ([]byte, error) {
    salt := make([]byte, 16)
    if _, err := cryptorand.Read(salt); err != nil {
        return nil, err
    }
    return salt, nil
}

// For older systems requiring PBKDF2
func deriveKeyPBKDF2(password string, salt []byte) []byte {
    // At least 600,000 iterations for SHA-256 as of 2023
    return pbkdf2.Key([]byte(password), salt, 600000, 32, sha256.New)
}
```

**Key Insight**: Password-based key derivation needs to be intentionally slow to resist brute-force attacks. Use Argon2id with memory-hard parameters or PBKDF2 with high iteration counts.

---

### Pitfall 5: Comparing Secrets with == Instead of Constant-Time

**Incident Pattern**: An API gateway validated webhook signatures using string comparison. Attackers measured response times and progressively guessed the signature byte-by-byte, eventually forging valid webhooks to trigger fraudulent payments.

**The Anti-Pattern**:
```go
// WRONG: Variable-time comparison
func validateWebhook(payload []byte, signature, secret string) bool {
    expected := computeHMAC(payload, secret)

    // This returns early on first mismatch - timing leak!
    return signature == expected
}

func validateAPIKey(provided, stored string) bool {
    return provided == stored // Each matching byte adds time
}
```

**The Better Approach**:
```go
// RIGHT: Constant-time comparison for all secrets
func validateWebhook(payload []byte, signature, secret string) bool {
    expected := computeHMAC(payload, secret)

    // hmac.Equal uses constant-time comparison
    sigBytes, _ := hex.DecodeString(signature)
    expBytes, _ := hex.DecodeString(expected)

    return hmac.Equal(sigBytes, expBytes)
}

func validateAPIKey(provided, stored string) bool {
    // subtle.ConstantTimeCompare returns immediately when lengths
    // differ, which would leak the key length. Hashing both inputs
    // first produces fixed-length values, so the comparison is
    // constant-time regardless of input lengths.
    providedHash := sha256.Sum256([]byte(provided))
    storedHash := sha256.Sum256([]byte(stored))
    return subtle.ConstantTimeCompare(providedHash[:], storedHash[:]) == 1
}

// For password verification, bcrypt handles this internally
func validatePassword(provided, hash string) bool {
    // bcrypt.CompareHashAndPassword is already constant-time
    err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(provided))
    return err == nil
}
```

**Key Insight**: String comparison operators short-circuit on first mismatch. For any secret comparison, use `subtle.ConstantTimeCompare` or `hmac.Equal` to prevent timing attacks.

---

### Cryptography Pitfall Quick Reference

| Pitfall | Attack Enabled | Fix |
|---------|---------------|-----|
| ECB mode | Pattern analysis | Use GCM or other authenticated modes |
| Nonce reuse | Plaintext recovery | Random nonces or safe counters |
| math/rand | Token prediction | Always use crypto/rand |
| Weak KDF | Rainbow tables | Argon2id or PBKDF2 with high iterations |
| Non-constant comparison | Timing attacks | subtle.ConstantTimeCompare |

### Junior → FAANG: Recognizing Cryptographic Disasters in Code Review

The pitfalls in this section have caused real, publicized cryptographic failures. Juniors who can recognize these patterns in a code review and articulate the specific risk are demonstrating senior-level code review skills at a junior level, which is a strong positive signal.

**Gap to close:** `math/rand` seeded with the current timestamp is predictable within a narrow window: an attacker who knows approximately when a token was generated can enumerate possible seeds and reproduce the token sequence. `crypto/rand` reads from the operating system's cryptographically secure random number generator and is not predictable. The API difference is small. The security difference is total.

**First-job habit:** When reviewing any PR that generates tokens, session IDs, API keys, or cryptographic keys, check the import list for `math/rand`. If it is present in a security context, flag it. This is a one-second review step that catches a critical vulnerability class.

**Interview framing:** When shown code that uses `math/rand` for token generation, identify the attack: predict the seed from the timestamp, enumerate the first N random numbers, find the one that matches the observed token, predict future tokens. Then describe the fix: replace with `crypto/rand`. This specific, concrete attack description is a strong interview signal.

### Senior @ FAANG: Systematic Cryptographic Disaster Prevention

At senior level, preventing cryptographic pitfalls requires systematic controls that catch mistakes before they reach production, regardless of individual engineer awareness.

**Static analysis as a mandatory gate:** `gosec` G404 flags `math/rand` usage in security contexts. `gosec` G401 flags use of MD5. `gosec` G402 flags TLS `InsecureSkipVerify`. These findings must be zero-tolerance CI gates. Any suppression requires documented justification and a security reviewer sign-off. Track suppression counts: a growing suppression list means the gate is being bypassed rather than the issue being fixed.

**Cryptographic code review checklist:** For any PR that touches crypto: (1) No `math/rand` in security contexts. (2) AES mode is GCM or another authenticated mode. (3) Nonce generation uses `crypto/rand`, fresh for each operation. (4) All crypto errors are checked and handled. (5) Secret comparisons use `subtle.ConstantTimeCompare`. (6) Keys are not hardcoded or in environment variables. (7) TLS `InsecureSkipVerify` is not set. This checklist is a PR template requirement for any PR touching the `crypto` package or any key management code.

**Post-mortem analysis for cryptographic incidents:** When a cryptographic failure occurs (in your org or in a public incident), run a post-mortem analysis against your own codebase: could this specific failure have occurred in your system? What controls do you have that would have prevented it? What gaps does this reveal? This proactive analysis is a staff-level security responsibility and produces improvement items for your security roadmap.

---
