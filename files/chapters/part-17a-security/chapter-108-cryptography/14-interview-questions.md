## 108.13 Interview Questions

### Question 1: Explain the difference between encryption and hashing. When would you use each?

**What FAANG expects:** One-way (hashing) vs reversible (encryption). Named algorithms per use case: Argon2id (OWASP 2026 recommendation, superseded bcrypt in most new systems), AES-256-GCM for symmetric, X25519+AES-GCM or hybrid KEM (MLKEM post-quantum) for asymmetric. Go stdlib: `crypto/subtle.ConstantTimeCompare`, `golang.org/x/crypto/argon2`. Never roll your own crypto. Bonus for mentioning the 2024 NIST post-quantum standards (ML-KEM, ML-DSA) and Go 1.26's `crypto/hpke` with hybrid PQ modes.

**What interviewers are looking for**:
- Clear understanding of reversibility
- Practical application knowledge
- Security considerations

**Strong Answer Framework**:

```
"Hashing and encryption serve fundamentally different purposes:

HASHING:
- One-way function: Cannot recover original input
- Fixed output size regardless of input
- Deterministic: Same input always produces same output
- Use cases:
  * Password storage (with bcrypt/argon2)
  * Data integrity verification (checksums)
  * Content addressing (Git commits, IPFS)
  * Deduplication systems

ENCRYPTION:
- Two-way function: Can recover original data with key
- Output size proportional to input
- Can be deterministic or randomized depending on mode
- Use cases:
  * Data at rest protection
  * Data in transit (TLS)
  * Secure communication
  * Field-level encryption in databases

In production Go code, I'd use:
- crypto/sha256 or SHA-3 for integrity hashing
- bcrypt or argon2 for password hashing
- AES-GCM for symmetric encryption
- RSA or ECDH for asymmetric operations

A common mistake is using SHA-256 for passwords. While it's a hash,
it's too fast - bcrypt intentionally slows down to resist brute force."
```

**Follow-up Questions**:
- "Why is bcrypt better than SHA-256 for passwords?"
- "What's the difference between symmetric and asymmetric encryption?"
- "How does HMAC differ from regular hashing?"

---

### Question 2: "You're building an API that accepts webhooks from a payment provider. How would you verify webhook authenticity?"

**What interviewers are looking for**:
- HMAC understanding
- Timing attack awareness
- Practical implementation skills

**Strong Answer Framework**:

```go
// Production webhook verification implementation
package webhook

import (
    "context"
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "errors"
    "fmt"
    "io"
    "net/http"
    "strconv"
    "time"
)

var (
    ErrInvalidSignature = errors.New("invalid webhook signature")
    ErrExpiredTimestamp = errors.New("webhook timestamp expired")
)

type WebhookVerifier struct {
    secret          []byte
    maxAge          time.Duration
    allowedClockSkew time.Duration
}

func NewWebhookVerifier(secret string) *WebhookVerifier {
    return &WebhookVerifier{
        secret:          []byte(secret),
        maxAge:          5 * time.Minute,
        allowedClockSkew: 30 * time.Second,
    }
}

func (v *WebhookVerifier) Verify(r *http.Request) ([]byte, error) {
    // 1. Read and preserve body
    body, err := io.ReadAll(r.Body)
    if err != nil {
        return nil, fmt.Errorf("failed to read body: %w", err)
    }

    // 2. Extract signature components
    signature := r.Header.Get("X-Webhook-Signature")
    timestamp := r.Header.Get("X-Webhook-Timestamp")

    if signature == "" || timestamp == "" {
        return nil, ErrInvalidSignature
    }

    // 3. Validate timestamp to prevent replay attacks
    ts, err := strconv.ParseInt(timestamp, 10, 64)
    if err != nil {
        return nil, ErrInvalidSignature
    }

    webhookTime := time.Unix(ts, 0)
    now := time.Now()

    // Check if timestamp is within acceptable range
    if now.Sub(webhookTime) > v.maxAge {
        return nil, ErrExpiredTimestamp
    }
    if webhookTime.Sub(now) > v.allowedClockSkew {
        return nil, ErrExpiredTimestamp // Future timestamps
    }

    // 4. Compute expected signature
    // Format: timestamp.body (prevents signature reuse)
    signedPayload := fmt.Sprintf("%s.%s", timestamp, string(body))

    mac := hmac.New(sha256.New, v.secret)
    mac.Write([]byte(signedPayload))
    expectedMAC := mac.Sum(nil)

    // 5. Constant-time comparison (CRITICAL!)
    providedMAC, err := hex.DecodeString(signature)
    if err != nil {
        return nil, ErrInvalidSignature
    }

    // hmac.Equal prevents timing attacks
    if !hmac.Equal(providedMAC, expectedMAC) {
        return nil, ErrInvalidSignature
    }

    return body, nil
}

// Handler middleware for webhook verification
func (v *WebhookVerifier) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        body, err := v.Verify(r)
        if err != nil {
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }

        // Store verified body in context for handler
        ctx := context.WithValue(r.Context(), "webhook_body", body)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

**Key Points to Mention**:
1. "I'd use HMAC-SHA256 with a shared secret"
2. "Constant-time comparison with hmac.Equal prevents timing attacks"
3. "Include timestamp in signature to prevent replay attacks"
4. "Reject stale webhooks to limit replay window"
5. "Never log the signature or secret"

---

### Question 3: "Design a system to encrypt sensitive user data (like SSN or credit cards) in a database."

**What interviewers are looking for**:
- Envelope encryption understanding
- Key management awareness
- Practical security architecture

**Strong Answer Framework**:

```
"For field-level encryption of sensitive PII, I'd implement envelope encryption:

ARCHITECTURE:
┌─────────────────────────────────────────────────────────────┐
│                        Application                          │
├─────────────────────────────────────────────────────────────┤
│  1. Request DEK from KMS (cached locally for performance)   │
│  2. Encrypt field with DEK using AES-GCM                    │
│  3. Store: encrypted_data + encrypted_DEK + nonce           │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                      KMS (Vault/AWS KMS)                    │
│  - Master key never leaves KMS                              │
│  - Generates/encrypts Data Encryption Keys (DEKs)           │
│  - Audit logging of all key operations                      │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                        Database                             │
│  - Stores encrypted data + encrypted DEK                    │
│  - Knows nothing about plaintext                            │
│  - Regular backups don't expose data                        │
└─────────────────────────────────────────────────────────────┘
```

```go
// Production envelope encryption implementation
package encryption

import (
    "context"
    "crypto/aes"
    "crypto/cipher"
    "crypto/rand"
    "fmt"
    "io"
    "sync"
    "time"
)

type EncryptedField struct {
    Ciphertext   []byte `json:"ct"`   // Encrypted data
    EncryptedDEK []byte `json:"edek"` // DEK encrypted by KMS
    KeyVersion   string `json:"kv"`   // For key rotation tracking
}

type KMSClient interface {
    GenerateDataKey(ctx context.Context, keyID string) (plaintext, encrypted []byte, err error)
    DecryptDataKey(ctx context.Context, encrypted []byte) ([]byte, error)
}

type FieldEncryptor struct {
    kms        KMSClient
    masterKeyID string

    // DEK cache to minimize KMS calls
    cache      map[string]cachedDEK
    cacheMu    sync.RWMutex
    cacheTTL   time.Duration
}

type cachedDEK struct {
    plaintext []byte
    encrypted []byte
    expiresAt time.Time
}

func NewFieldEncryptor(kms KMSClient, masterKeyID string) *FieldEncryptor {
    return &FieldEncryptor{
        kms:         kms,
        masterKeyID: masterKeyID,
        cache:       make(map[string]cachedDEK),
        cacheTTL:    5 * time.Minute,
    }
}

func (e *FieldEncryptor) Encrypt(ctx context.Context, plaintext []byte) (*EncryptedField, error) {
    // Get or generate DEK
    dek, encryptedDEK, err := e.getOrGenerateDEK(ctx)
    if err != nil {
        return nil, fmt.Errorf("failed to get DEK: %w", err)
    }

    // Encrypt with AES-GCM
    block, err := aes.NewCipher(dek)
    if err != nil {
        return nil, err
    }

    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }

    nonce := make([]byte, gcm.NonceSize())
    if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
        return nil, err
    }

    // nonce is prepended to ciphertext
    ciphertext := gcm.Seal(nonce, nonce, plaintext, nil)

    return &EncryptedField{
        Ciphertext:   ciphertext,
        EncryptedDEK: encryptedDEK,
        KeyVersion:   e.masterKeyID,
    }, nil
}

func (e *FieldEncryptor) Decrypt(ctx context.Context, field *EncryptedField) ([]byte, error) {
    // Decrypt DEK using KMS
    dek, err := e.kms.DecryptDataKey(ctx, field.EncryptedDEK)
    if err != nil {
        return nil, fmt.Errorf("failed to decrypt DEK: %w", err)
    }

    // Decrypt data
    block, err := aes.NewCipher(dek)
    if err != nil {
        return nil, err
    }

    gcm, err := cipher.NewGCM(block)
    if err != nil {
        return nil, err
    }

    nonceSize := gcm.NonceSize()
    if len(field.Ciphertext) < nonceSize {
        return nil, fmt.Errorf("ciphertext too short")
    }

    nonce, ciphertext := field.Ciphertext[:nonceSize], field.Ciphertext[nonceSize:]

    plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
    if err != nil {
        return nil, fmt.Errorf("decryption failed: %w", err)
    }

    return plaintext, nil
}

func (e *FieldEncryptor) getOrGenerateDEK(ctx context.Context) ([]byte, []byte, error) {
    e.cacheMu.RLock()
    if cached, ok := e.cache[e.masterKeyID]; ok && time.Now().Before(cached.expiresAt) {
        e.cacheMu.RUnlock()
        return cached.plaintext, cached.encrypted, nil
    }
    e.cacheMu.RUnlock()

    // Generate new DEK from KMS
    plainDEK, encDEK, err := e.kms.GenerateDataKey(ctx, e.masterKeyID)
    if err != nil {
        return nil, nil, err
    }

    e.cacheMu.Lock()
    e.cache[e.masterKeyID] = cachedDEK{
        plaintext: plainDEK,
        encrypted: encDEK,
        expiresAt: time.Now().Add(e.cacheTTL),
    }
    e.cacheMu.Unlock()

    return plainDEK, encDEK, nil
}
```

**Key Points to Mention**:
1. "Envelope encryption: DEKs encrypt data, KEK encrypts DEKs"
2. "Master key never leaves KMS/HSM"
3. "Cache DEKs locally to reduce KMS latency/cost"
4. "Store key version for rotation support"
5. "Each record can have its own DEK for granular access control"
6. "Audit logging on all key operations"

---

### Question 4: "A security audit found that your application stores passwords using SHA-256. How would you migrate to bcrypt without requiring all users to reset passwords?"

**What interviewers are looking for**:
- Understanding of password hashing security
- Migration strategy thinking
- Backwards compatibility handling

**Strong Answer Framework**:

```go
// Gradual password hash migration strategy
package auth

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "errors"
    "fmt"
    "log"
    "strings"

    "golang.org/x/crypto/bcrypt"
)

type PasswordHasher struct {
    bcryptCost int
}

func NewPasswordHasher() *PasswordHasher {
    return &PasswordHasher{
        bcryptCost: 12, // Adjust based on hardware
    }
}

// HashPassword creates a new bcrypt hash (for new passwords)
func (h *PasswordHasher) HashPassword(password string) (string, error) {
    hash, err := bcrypt.GenerateFromPassword([]byte(password), h.bcryptCost)
    if err != nil {
        return "", err
    }
    return "bcrypt:" + string(hash), nil
}

// VerifyAndMigrate verifies password and migrates if needed
// Returns: (valid bool, newHash string, error)
func (h *PasswordHasher) VerifyAndMigrate(password, storedHash string) (bool, string, error) {
    // Detect hash type by prefix
    if strings.HasPrefix(storedHash, "bcrypt:") {
        // Already using bcrypt
        hash := strings.TrimPrefix(storedHash, "bcrypt:")
        err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
        if err != nil {
            return false, "", nil // Invalid password
        }
        return true, "", nil // Valid, no migration needed
    }

    if strings.HasPrefix(storedHash, "sha256:") {
        // Legacy SHA-256 hash - verify then migrate
        hash := strings.TrimPrefix(storedHash, "sha256:")

        computed := sha256.Sum256([]byte(password))
        computedHex := hex.EncodeToString(computed[:])

        if computedHex != hash {
            return false, "", nil // Invalid password
        }

        // Password valid - generate new bcrypt hash
        newHash, err := h.HashPassword(password)
        if err != nil {
            return true, "", err // Valid but migration failed
        }

        return true, newHash, nil // Valid with new hash to store
    }

    // Unknown format - treat as legacy sha256 without prefix
    computed := sha256.Sum256([]byte(password))
    computedHex := hex.EncodeToString(computed[:])

    if computedHex != storedHash {
        return false, "", nil
    }

    newHash, err := h.HashPassword(password)
    if err != nil {
        return true, "", err
    }

    return true, newHash, nil
}

// Usage in authentication flow
type User struct {
    ID           string
    Username     string
    PasswordHash string
}

type UserRepository interface {
    GetByUsername(ctx context.Context, username string) (*User, error)
    UpdatePasswordHash(ctx context.Context, userID, newHash string) error
}

type AuthService struct {
    hasher *PasswordHasher
    repo   UserRepository
}

func (s *AuthService) Authenticate(ctx context.Context, username, password string) (*User, error) {
    user, err := s.repo.GetByUsername(ctx, username)
    if err != nil {
        return nil, errors.New("invalid credentials") // Don't leak user existence
    }

    valid, newHash, err := s.hasher.VerifyAndMigrate(password, user.PasswordHash)
    if err != nil {
        return nil, fmt.Errorf("authentication error: %w", err)
    }

    if !valid {
        return nil, errors.New("invalid credentials")
    }

    // Migrate hash if needed (background or inline)
    if newHash != "" {
        // Update password hash in database
        if err := s.repo.UpdatePasswordHash(ctx, user.ID, newHash); err != nil {
            // Log error but don't fail authentication
            log.Printf("Failed to migrate password hash for user %s: %v", user.ID, err)
        }
    }

    return user, nil
}
```

**Migration Strategy**:
```
Phase 1: Deploy code that supports both formats
- New passwords use bcrypt
- Old passwords verified against SHA-256
- On successful login, transparently rehash with bcrypt

Phase 2: Monitor migration progress
- Track percentage of users on bcrypt
- Monitor login frequency to estimate migration timeline

Phase 3: Force migration for inactive users
- After N months, require password reset for unmigrated accounts
- Alternatively, batch migrate by wrapping: bcrypt(sha256(password))

Phase 4: Remove legacy support
- Once >99% migrated
- Force password reset for remaining users
- Remove SHA-256 verification code
```

**Key Points to Mention**:
1. "Don't force mass password resets - bad UX and security risk"
2. "Transparently migrate on successful authentication"
3. "Use prefix to identify hash algorithm"
4. "Background update to avoid login latency"
5. "Track migration progress metrics"
6. "Eventually force reset for long-inactive users"

### Junior → FAANG: Answering Cryptography Interview Questions With Precision

Cryptography interview questions are designed to distinguish engineers who understand the underlying model from those who have memorized API calls. Precision in terminology matters.

**Gap to close:** Practice the Question 1 distinction (encryption vs hashing) until you can deliver it in 60 seconds without hesitation. It is the most common cryptography interview question and the most commonly answered imprecisely. Key points: encryption is reversible (requires a key to encrypt and decrypt). Hashing is one-way (cannot reverse without the preimage). Use encryption when you need to recover the original value. Use hashing when you only need to verify a value (passwords, file integrity).

**Structured answer technique:** For each question in this section, practice a three-part answer: (1) what the concept is, (2) what the consequence of getting it wrong is, (3) what the correct Go implementation looks like. Interviewers give full marks for answers that connect the concept to real consequence and to concrete code.

### Senior @ FAANG: Cryptography Design Interviews at L6+

Senior cryptography interviews at FAANG are system design questions, not knowledge recall questions. The questions test your ability to design cryptographic systems that are correct, operational, and scalable.

**System design framing:** For any cryptographic system design question, address four dimensions: (1) Algorithm selection and rationale. (2) Key management: where keys are stored, how they are rotated, who has access. (3) Failure modes: what happens when a key is compromised, when a KMS is unavailable, when a certificate expires. (4) Observability: how do you know the system is working correctly, and how do you detect attacks. Answers that cover all four dimensions demonstrate L6 depth.

**Cross-cutting concerns:** Strong senior answers connect cryptographic system design to adjacent concerns: compliance requirements (which algorithms are PCI DSS approved?), performance (what is the latency cost of envelope encryption per request?), and operational cost (what is the KMS API cost at your request volume?). These cross-cutting concerns demonstrate that you design systems for real-world deployment, not just for technical correctness.

---
