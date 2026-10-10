## 39.11 Exercises with Solutions

### Exercise 1: Implement Refresh Token Rotation with Reuse Detection

**Problem:** Build a secure refresh token system that rotates tokens and detects potential theft through reuse.

**Solution:**

```go
// ... imports omitted for brevity (context, crypto/rand, encoding/hex, errors, sync, time)

var (
    ErrTokenReused   = errors.New("refresh token was reused - possible theft")
    ErrTokenNotFound = errors.New("refresh token not found")
    ErrTokenExpired  = errors.New("refresh token expired")
    ErrFamilyRevoked = errors.New("token family has been revoked")
)

// RefreshToken represents a refresh token with family tracking
type RefreshToken struct {
    ID           string
    FamilyID     string    // All tokens from same login share a family
    UserID       string
    Used         bool
    UsedAt       *time.Time
    CreatedAt    time.Time
    ExpiresAt    time.Time
    NextTokenID  string    // ID of token that replaced this one
}

// TokenFamily tracks all tokens from a single login session
type TokenFamily struct {
    ID        string
    UserID    string
    Revoked   bool
    RevokedAt *time.Time
    CreatedAt time.Time
}

// RefreshTokenStore manages refresh tokens
type RefreshTokenStore struct {
    mu       sync.RWMutex
    tokens   map[string]*RefreshToken
    families map[string]*TokenFamily

    // Configuration
    tokenTTL      time.Duration
    reuseWindow   time.Duration // Grace period for network issues
}

func NewRefreshTokenStore() *RefreshTokenStore {
    return &RefreshTokenStore{
        tokens:      make(map[string]*RefreshToken),
        families:    make(map[string]*TokenFamily),
        tokenTTL:    7 * 24 * time.Hour, // 7 days
        reuseWindow: 60 * time.Second,   // 1 minute grace period
    }
}

// CreateFamily creates a new token family for a login session
func (s *RefreshTokenStore) CreateFamily(userID string) *TokenFamily {
    s.mu.Lock()
    defer s.mu.Unlock()

    family := &TokenFamily{
        ID:        generateID(),
        UserID:    userID,
        CreatedAt: time.Now(),
    }
    s.families[family.ID] = family
    return family
}

// IssueToken creates a new refresh token in a family
func (s *RefreshTokenStore) IssueToken(familyID, userID string) (string, error) {
    s.mu.Lock()
    defer s.mu.Unlock()

    // Check family exists and isn't revoked
    family, ok := s.families[familyID]
    if !ok {
        return "", ErrTokenNotFound
    }
    if family.Revoked {
        return "", ErrFamilyRevoked
    }

    tokenID := generateID()
    tokenValue := generateSecureToken()

    token := &RefreshToken{
        ID:        tokenID,
        FamilyID:  familyID,
        UserID:    userID,
        CreatedAt: time.Now(),
        ExpiresAt: time.Now().Add(s.tokenTTL),
    }
    s.tokens[tokenValue] = token

    return tokenValue, nil
}

// RotateToken validates a refresh token and issues a new one
func (s *RefreshTokenStore) RotateToken(ctx context.Context, tokenValue string) (string, error) {
    s.mu.Lock()
    defer s.mu.Unlock()

    token, ok := s.tokens[tokenValue]
    if !ok {
        return "", ErrTokenNotFound
    }

    // Check expiration
    if time.Now().After(token.ExpiresAt) {
        return "", ErrTokenExpired
    }

    // Check family revocation
    family := s.families[token.FamilyID]
    if family.Revoked {
        return "", ErrFamilyRevoked
    }

    // Check for reuse
    if token.Used {
        // Token was already used!
        // Check if within reuse window (network retry)
        if token.UsedAt != nil && time.Since(*token.UsedAt) < s.reuseWindow {
            // Within grace period - return the next token
            if token.NextTokenID != "" {
                for val, t := range s.tokens {
                    if t.ID == token.NextTokenID {
                        return val, nil
                    }
                }
            }
        }

        // Outside grace period - this is potential theft!
        // Revoke entire family
        s.revokeFamily(token.FamilyID)

        // Log security event
        logSecurityEvent("refresh_token_reuse", map[string]any{
            "family_id": token.FamilyID,
            "user_id":   token.UserID,
            "token_id":  token.ID,
        })

        return "", ErrTokenReused
    }

    // Mark current token as used
    now := time.Now()
    token.Used = true
    token.UsedAt = &now

    // Issue new token
    newTokenValue := generateSecureToken()
    newToken := &RefreshToken{
        ID:        generateID(),
        FamilyID:  token.FamilyID,
        UserID:    token.UserID,
        CreatedAt: time.Now(),
        ExpiresAt: time.Now().Add(s.tokenTTL),
    }
    s.tokens[newTokenValue] = newToken
    token.NextTokenID = newToken.ID

    return newTokenValue, nil
}

// RevokeFamily revokes all tokens in a family
func (s *RefreshTokenStore) revokeFamily(familyID string) {
    family, ok := s.families[familyID]
    if !ok {
        return
    }

    now := time.Now()
    family.Revoked = true
    family.RevokedAt = &now
}

// RevokeAllUserTokens revokes all token families for a user
func (s *RefreshTokenStore) RevokeAllUserTokens(userID string) {
    s.mu.Lock()
    defer s.mu.Unlock()

    for _, family := range s.families {
        if family.UserID == userID {
            s.revokeFamily(family.ID)
        }
    }
}

// Logout revokes the specific token family
func (s *RefreshTokenStore) Logout(tokenValue string) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    token, ok := s.tokens[tokenValue]
    if !ok {
        return ErrTokenNotFound
    }

    s.revokeFamily(token.FamilyID)
    return nil
}

func generateID() string {
    b := make([]byte, 16)
    rand.Read(b)
    return hex.EncodeToString(b)
}

func generateSecureToken() string {
    b := make([]byte, 32)
    rand.Read(b)
    return hex.EncodeToString(b)
}

func logSecurityEvent(event string, data map[string]any) {
    // Implementation: send to security monitoring system
}
```

### Exercise 2: Implement TOTP-Based Two-Factor Authentication

**Problem:** Add Time-based One-Time Password (TOTP) support for two-factor authentication.

**Solution:**

```go
// ... imports omitted for brevity (crypto/hmac, crypto/rand, crypto/sha1, encoding/base32, encoding/binary, fmt, net/url, time)

// TOTPConfig holds TOTP configuration
type TOTPConfig struct {
    Issuer    string
    Period    int // Time step in seconds (default 30)
    Digits    int // Number of digits (default 6)
    Algorithm string // SHA1, SHA256, SHA512
}

func DefaultTOTPConfig() TOTPConfig {
    return TOTPConfig{
        Issuer:    "MyApp",
        Period:    30,
        Digits:    6,
        Algorithm: "SHA1",
    }
}

// TOTPSecret represents a user's TOTP secret
type TOTPSecret struct {
    UserID    string
    Secret    string // Base32 encoded secret
    Verified  bool
    CreatedAt time.Time
}

// TOTPService handles TOTP operations
type TOTPService struct {
    config TOTPConfig
    store  TOTPStore
}

func NewTOTPService(config TOTPConfig, store TOTPStore) *TOTPService {
    return &TOTPService{
        config: config,
        store:  store,
    }
}

// GenerateSecret creates a new TOTP secret for a user
func (s *TOTPService) GenerateSecret(userID, accountName string) (*TOTPSecret, string, error) {
    // Generate 20 random bytes (160 bits)
    secret := make([]byte, 20)
    if _, err := rand.Read(secret); err != nil {
        return nil, "", err
    }

    // Encode as base32 (standard for TOTP)
    secretBase32 := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret)

    totpSecret := &TOTPSecret{
        UserID:    userID,
        Secret:    secretBase32,
        Verified:  false,
        CreatedAt: time.Now(),
    }

    // Generate QR code URI
    uri := s.generateURI(accountName, secretBase32)

    return totpSecret, uri, nil
}

// generateURI creates an otpauth:// URI for QR codes
func (s *TOTPService) generateURI(accountName, secret string) string {
    // otpauth://totp/Issuer:Account?secret=XXX&issuer=Issuer&algorithm=SHA1&digits=6&period=30
    params := url.Values{}
    params.Set("secret", secret)
    params.Set("issuer", s.config.Issuer)
    params.Set("algorithm", s.config.Algorithm)
    params.Set("digits", fmt.Sprintf("%d", s.config.Digits))
    params.Set("period", fmt.Sprintf("%d", s.config.Period))

    label := url.PathEscape(fmt.Sprintf("%s:%s", s.config.Issuer, accountName))

    return fmt.Sprintf("otpauth://totp/%s?%s", label, params.Encode())
}

// ValidateCode validates a TOTP code
func (s *TOTPService) ValidateCode(secret, code string) bool {
    // Decode the secret
    secretBytes, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
    if err != nil {
        return false
    }

    // Get current time counter
    now := time.Now().Unix()
    counter := now / int64(s.config.Period)

    // Check current, previous, and next time windows (clock skew tolerance)
    for i := int64(-1); i <= 1; i++ {
        expectedCode := s.generateCode(secretBytes, counter+i)
        if expectedCode == code {
            return true
        }
    }

    return false
}

// generateCode generates a TOTP code for a given counter
func (s *TOTPService) generateCode(secret []byte, counter int64) string {
    // Convert counter to 8 bytes, big-endian
    buf := make([]byte, 8)
    binary.BigEndian.PutUint64(buf, uint64(counter))

    // HMAC-SHA1
    mac := hmac.New(sha1.New, secret)
    mac.Write(buf)
    hash := mac.Sum(nil)

    // Dynamic truncation
    offset := hash[len(hash)-1] & 0x0F
    truncated := binary.BigEndian.Uint32(hash[offset:offset+4]) & 0x7FFFFFFF

    // Get last n digits
    code := truncated % pow10(s.config.Digits)

    return fmt.Sprintf("%0*d", s.config.Digits, code)
}

func pow10(n int) uint32 {
    result := uint32(1)
    for i := 0; i < n; i++ {
        result *= 10
    }
    return result
}

// EnableMFA enables MFA for a user after verifying initial code
func (s *TOTPService) EnableMFA(userID, code string) error {
    secret, err := s.store.GetPending(userID)
    if err != nil {
        return err
    }

    if !s.ValidateCode(secret.Secret, code) {
        return fmt.Errorf("invalid verification code")
    }

    secret.Verified = true
    return s.store.Save(secret)
}

// VerifyMFA verifies an MFA code for login
func (s *TOTPService) VerifyMFA(userID, code string) (bool, error) {
    secret, err := s.store.Get(userID)
    if err != nil {
        return false, err
    }

    if !secret.Verified {
        return false, fmt.Errorf("MFA not enabled")
    }

    return s.ValidateCode(secret.Secret, code), nil
}

// GenerateRecoveryCodes creates backup codes for MFA recovery
func (s *TOTPService) GenerateRecoveryCodes(userID string, count int) ([]string, error) {
    codes := make([]string, count)

    for i := 0; i < count; i++ {
        code := make([]byte, 4)
        rand.Read(code)
        // Format: XXXX-XXXX (8 characters)
        codes[i] = fmt.Sprintf("%04X-%04X",
            binary.BigEndian.Uint16(code[:2]),
            binary.BigEndian.Uint16(code[2:]),
        )
    }

    // Hash and store the codes
    if err := s.store.SaveRecoveryCodes(userID, codes); err != nil {
        return nil, err
    }

    return codes, nil
}

// UseRecoveryCode validates and consumes a recovery code
func (s *TOTPService) UseRecoveryCode(userID, code string) (bool, error) {
    return s.store.UseRecoveryCode(userID, code)
}

// TOTPStore interface for persistence
type TOTPStore interface {
    GetPending(userID string) (*TOTPSecret, error)
    Get(userID string) (*TOTPSecret, error)
    Save(secret *TOTPSecret) error
    Delete(userID string) error
    SaveRecoveryCodes(userID string, codes []string) error
    UseRecoveryCode(userID, code string) (bool, error)
}
```

### Junior → FAANG: Extending the Exercises to Production Quality

The two exercises above are correct but deliberately minimal. A junior candidate who ships either of them straight to production will have a bad quarter. Use the following extensions to turn them into interview-ready portfolio code.

Extension 1a: persistence for the refresh token store. The exercise uses an in-memory map. Production systems need a database or Redis with replication. Use Redis with `SET NX EX` to atomically mark a token as used, so that concurrent reuse attempts collapse to a single winner and the loser triggers the family revocation. The key `refresh:{tokenID}:used` with a TTL matching the absolute expiration prevents orphaned keys.

Extension 1b: observability. Add structured logs for every token event (issued, rotated, reused, revoked), emit Prometheus counters (`refresh_tokens_issued_total`, `refresh_tokens_reused_total`), and fire a pager alert if `reused_total` exceeds a threshold over a five-minute window. Reuse is the earliest signal of account compromise.

Extension 1c: tests. Property-based tests using `gopter` or `rapid` to verify that after any valid sequence of rotations the only valid token is the latest. Table-driven tests for the grace period, family revocation, and clock skew. A fuzz test that attempts to present arbitrary byte strings as tokens and confirms constant-time rejection.

Extension 2a: WebAuthn over TOTP. TOTP is better than SMS but strictly worse than WebAuthn/passkeys. For your second revision, swap the exercise for a WebAuthn registration and authentication flow using the `go-webauthn/webauthn` library. This matches where the industry is going in 2026.

Extension 2b: recovery code hygiene. The exercise generates recovery codes but does not define how they are stored. They must be hashed (argon2id or at minimum sha256), single-use, and generated in a batch of 10 shown exactly once. On use, invalidate and prompt the user to regenerate if fewer than three remain.

Worked example: "why did this fail" reflex for the TOTP exercise. If a user reports that their authenticator generates codes that are rejected, the debugging ladder is: (1) clock skew between server and phone (check NTP on both, expand the validation window), (2) secret mismatch from base32 encoding confusion (padding vs no-padding), (3) algorithm mismatch (SHA1 vs SHA256), (4) digits mismatch (6 vs 8). The exercise supports clock skew of one period. Production should support two.

Interview entry point. When an interviewer asks "walk me through a refresh token design," do not read the code. Whiteboard the state diagram: issued, used, rotated, reused-detected, revoked. Describe the transitions and the guard conditions. That is a staff-level signal.

### Senior @ FAANG: Staff Extensions and the ReBAC, Webhook, and Cache Exercises

At staff and principal level, the exercises expand into three additional systems. Each has a canonical open-source reference and a known set of failure modes.

Staff Extension A: build an OpenFGA-style ReBAC service.

Scope. A service that stores relationship tuples `(object, relation, user)`, evaluates authorization queries `Check(user, relation, object) -> bool`, and supports schema-defined userset rewrites (union, intersection, difference, computed, tuple-to-userset).

Target API. Modeled after OpenFGA 1.x.

- `POST /stores` create a store.
- `POST /stores/{id}/authorization-models` upload a schema.
- `POST /stores/{id}/write` write tuples.
- `POST /stores/{id}/check` check a tuple.
- `POST /stores/{id}/list-objects` list objects a user has access to.
- `POST /stores/{id}/expand` return the evaluation tree for a check.

Data model. PostgreSQL table `tuples (store_id, object_type, object_id, relation, user_type, user_id, user_relation, inserted_at)` with partial indexes for each access pattern. Add a `consistency_token` column that is monotonically increasing within a store to support zookie-style bounded consistency.

Evaluation. Recursive tuple expansion with memoization, bounded by a per-request depth limit (say 25) and a per-request tuple-read budget (say 10,000). Cache check results keyed by `(check, min_consistency_token)` with a TTL tied to the next tuple write.

Failure modes to test. (1) Cycles in usersets (user A in group B in group A). (2) Deep hierarchies that exceed the depth limit. (3) Stale cache after a write (invalidate by consistency token). (4) Tuple-to-userset expansion that fans out to millions of tuples. (5) Cross-store queries (should be rejected).

Staff bar. Your implementation handles 10K check QPS at p99 sub-10 ms on a single node with 10 million tuples. Add a load test with `k6` or `vegeta` demonstrating this.

Staff Extension B: webhook signature verification library with timing-safe compare.

Scope. A library that lets webhook senders sign payloads and receivers verify them, matching Stripe, GitHub, and Shopify conventions.

Signing. HMAC-SHA256 over `timestamp.payload` with a shared secret, header format `t=1713808800,v1=hex_signature`. Sender includes the timestamp to bound replay.

Verification. Parse the header, reject if `|now - timestamp| > 5 minutes`, compute the expected signature, compare with `crypto/subtle.ConstantTimeCompare`, succeed only if the signature matches. Support multiple signatures in the header for secret rotation (`v1=sig_old,v1=sig_new`).

API surface.

```go
type Signer struct { Secret []byte; Now func() time.Time }
func (s *Signer) Sign(payload []byte) string

type Verifier struct { Secrets [][]byte; Tolerance time.Duration; Now func() time.Time }
func (v *Verifier) Verify(header string, payload []byte) error
```

Failure modes to test. (1) Expired timestamp. (2) Payload tampering. (3) Signature reuse across endpoints (fix with scoped secrets). (4) Header forgery with extra fields. (5) Constant-time property: test that `Verify` takes the same time for a correct signature and a wrong-at-byte-0 signature, using `testing.B` and statistical comparison.

Staff bar. Library is under 500 LOC, zero external dependencies beyond the standard library, fuzz-tested for at least one million iterations, documented with an ADR explaining the choice of HMAC-SHA256 over Ed25519 (HMAC: simpler key management, symmetric trust model, matches industry precedent. Ed25519: asymmetric, good for public verification, needed for open ecosystems like PASETO).

Staff Extension C: permission caching layer with invalidation.

Scope. A caching layer in front of an authorization service that reduces p99 check latency to sub-millisecond while maintaining correctness under tuple writes.

Design. Two-layer cache. L1 is an in-process LRU per service instance, sized to fit in CPU cache lines for hot keys. L2 is a shared Redis with a pub/sub invalidation channel. Keys are `check:{principal}:{relation}:{object}` with a value of `allow|deny` plus an `as_of` consistency token.

Invalidation. On tuple write, the authorization service publishes the affected tuples to a Redis pub/sub channel, each subscriber evicts matching keys from L1 and L2. For tuple writes that affect many keys (group membership changes), use a bump-epoch strategy: a global epoch counter is incremented, all cached entries with a lower epoch are treated as stale on read.

Consistency model. Bounded staleness with explicit API opt-in. `Check(principal, relation, object, options{MinEpoch: e})` refuses to serve from a cache entry with epoch below `e`. This matches Zanzibar's zookie.

Failure modes to test. (1) Cache stampede on popular keys (use singleflight). (2) Negative cache poisoning (cache a false deny after a revocation, then the tuple is restored but the cache still denies). Solve with TTL plus invalidation. (3) Redis outage (fail open to authority with exponential backoff, or fail closed depending on threat model). (4) Clock skew between cache and authority (pin to monotonic epoch, not wall clock). (5) Partial invalidation delivery (pub/sub is best-effort, add periodic full reconciliation).

Staff bar. Measured on a 10K QPS benchmark, p50 under 100 microseconds, p99 under 1 ms, cache hit rate above 95% at steady state, correct under a chaos test that writes tuples at 100 QPS and verifies no stale allow is served more than 500 ms after the write.

ADR template for all three. Context (why this exists), decision (chosen design), alternatives (at least three with trade-offs), consequences (what was given up), observability (metrics and alerts), rollback plan, review date.

Maturity model for exercise-driven learning. L1 copies the code. L2 runs the tests. L3 extends with persistence and observability. L4 writes the ADR and stress-tests the design. L5 publishes the library as open source and responds to issues in a public backlog.

---
