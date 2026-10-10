## 39.4 API Key Authentication

### API Key Management

API keys are stored as SHA-256 hashes rather than plaintext so a database breach does not immediately expose working credentials. The `Prefix` field retains the first eight characters in cleartext for identification in dashboards and audit logs, matching the pattern used by services like Stripe and GitHub.

```go
// ... imports omitted for brevity (context, crypto/rand, crypto/sha256, encoding/hex, errors, time)

// APIKey represents an API key
type APIKey struct {
    ID          string     `json:"id"`
    Name        string     `json:"name"`
    Prefix      string     `json:"prefix"` // First 8 chars for identification
    Hash        string     `json:"-"`      // SHA-256 hash of full key
    UserID      string     `json:"user_id"`
    Scopes      []string   `json:"scopes"`
    ExpiresAt   *time.Time `json:"expires_at,omitempty"`
    LastUsedAt  *time.Time `json:"last_used_at,omitempty"`
    CreatedAt   time.Time  `json:"created_at"`
    RevokedAt   *time.Time `json:"revoked_at,omitempty"`
}

// APIKeyStore manages API keys
type APIKeyStore interface {
    Create(ctx context.Context, key *APIKey) error
    GetByHash(ctx context.Context, hash string) (*APIKey, error)
    GetByID(ctx context.Context, id string) (*APIKey, error)
    ListByUser(ctx context.Context, userID string) ([]*APIKey, error)
    UpdateLastUsed(ctx context.Context, id string) error
    Revoke(ctx context.Context, id string) error
}

// APIKeyService manages API key operations
type APIKeyService struct {
    store APIKeyStore
}

func NewAPIKeyService(store APIKeyStore) *APIKeyService {
    return &APIKeyService{store: store}
}

// CreateKey generates a new API key
func (s *APIKeyService) CreateKey(ctx context.Context, userID, name string, scopes []string, expiresAt *time.Time) (string, *APIKey, error) {
    // Generate random key (32 bytes = 64 hex chars)
    keyBytes := make([]byte, 32)
    if _, err := rand.Read(keyBytes); err != nil {
        return "", nil, err
    }
    rawKey := hex.EncodeToString(keyBytes)

    // Create prefix (first 8 chars for identification)
    prefix := rawKey[:8]

    // Hash the full key
    hash := sha256.Sum256([]byte(rawKey))
    hashHex := hex.EncodeToString(hash[:])

    key := &APIKey{
        ID:        generateID(),
        Name:      name,
        Prefix:    prefix,
        Hash:      hashHex,
        UserID:    userID,
        Scopes:    scopes,
        ExpiresAt: expiresAt,
        CreatedAt: time.Now(),
    }

    if err := s.store.Create(ctx, key); err != nil {
        return "", nil, err
    }

    // Return the raw key (only time it's available)
    return rawKey, key, nil
}

// ValidateKey validates an API key and returns the associated key record
func (s *APIKeyService) ValidateKey(ctx context.Context, rawKey string) (*APIKey, error) {
    // Hash the provided key
    hash := sha256.Sum256([]byte(rawKey))
    hashHex := hex.EncodeToString(hash[:])

    // Look up by hash
    key, err := s.store.GetByHash(ctx, hashHex)
    if err != nil {
        return nil, errors.New("invalid API key")
    }

    // Check if revoked
    if key.RevokedAt != nil {
        return nil, errors.New("API key has been revoked")
    }

    // Check expiration
    if key.ExpiresAt != nil && time.Now().After(*key.ExpiresAt) {
        return nil, errors.New("API key has expired")
    }

    // Update last used
    go s.store.UpdateLastUsed(context.Background(), key.ID)

    return key, nil
}

// RevokeKey revokes an API key
func (s *APIKeyService) RevokeKey(ctx context.Context, id, userID string) error {
    key, err := s.store.GetByID(ctx, id)
    if err != nil {
        return err
    }

    // Verify ownership
    if key.UserID != userID {
        return errors.New("not authorized to revoke this key")
    }

    return s.store.Revoke(ctx, id)
}
```

### API Key Middleware

The API key middleware checks three locations in priority order: the `Authorization: Bearer` header, the `X-API-Key` header, and the `api_key` query parameter. Query parameter authentication is the least secure option because keys appear in server access logs and browser history, so it should only be used for webhook callbacks where header-based auth is not possible.

```go
// ... imports omitted for brevity (context, net/http, strings)

// APIKeyAuth middleware validates API keys
func APIKeyAuth(keyService *APIKeyService) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Try Authorization header first
            auth := r.Header.Get("Authorization")
            var rawKey string

            if strings.HasPrefix(auth, "Bearer ") {
                rawKey = auth[7:]
            } else {
                // Try X-API-Key header
                rawKey = r.Header.Get("X-API-Key")
            }

            if rawKey == "" {
                // Try query parameter (less secure, for webhooks)
                rawKey = r.URL.Query().Get("api_key")
            }

            if rawKey == "" {
                http.Error(w, "API key required", http.StatusUnauthorized)
                return
            }

            key, err := keyService.ValidateKey(r.Context(), rawKey)
            if err != nil {
                http.Error(w, err.Error(), http.StatusUnauthorized)
                return
            }

            // Create user context
            user := &User{
                ID:     key.UserID,
                Scopes: key.Scopes,
            }

            ctx := context.WithValue(r.Context(), UserContextKey, user)
            ctx = context.WithValue(ctx, APIKeyContextKey, key)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

### Junior → FAANG: API Key Basics and Entry-Point Framing

If you have never shipped an API key system, start with the mental model. An API key is a bearer token, which means possession equals authority. Whoever holds the key can call the API as the owner. There is no second factor. This one property drives every design decision below.

The code above uses SHA-256 to hash keys at rest. For a first job that ships a small SaaS this is acceptable because the raw key is already 256 bits of random entropy, so offline brute force is infeasible. Password hashing algorithms like bcrypt or argon2id are designed for low-entropy inputs (human passwords). A 32-byte random key does not need a memory-hard KDF. The trade-off you will be asked about in interviews is: "why not argon2id on keys?" The answer is latency. Validating every request through argon2id at 100ms per hash would destroy throughput. SHA-256 validates in microseconds, and the entropy of the raw key makes rainbow tables useless.

First-job worked example. A payments startup asks you to ship tenant-scoped API keys. You will want three things the above code does not yet have: a `sk_live_` / `sk_test_` prefix so ops can tell production from sandbox keys at a glance, a per-key scope list that the middleware enforces on each route, and a last-four-characters display field so support staff can confirm a key over a phone call without seeing the full secret. The Stripe dashboard is the canonical reference design.

Interview entry-point questions you should be able to answer:

1. Why return the raw key only once at creation? Because the server never stores it and cannot recover it. This is the same pattern as SSH key generation.
2. Why hash by lookup and not by comparison? Constant-time comparison matters when you iterate a list, but hashing the incoming key and doing an indexed DB lookup by hash is both faster and inherently timing-safe.
3. What happens if the DB leaks? Attacker gets hashes, not keys. They cannot authenticate. Contrast with a plaintext leak where every customer must rotate immediately.
4. Why track `LastUsedAt`? Dormant key cleanup. Keys unused for 90 days are strong rotation candidates, and sudden use of a dormant key is a compromise signal.

Common junior mistake: logging the `Authorization` header in request middleware. Never do this. Redact the header before it reaches any log sink, and assert the redaction in a unit test so a future refactor cannot silently leak keys to Datadog or Splunk.

### Senior @ FAANG: Key Lifecycle, Scoping, Leak Detection, and Service Identity

At staff and principal level, API key authentication is not a hashing problem. It is a lifecycle, scoping, and identity problem. The SHA-256 + prefix pattern above is table stakes. What separates a staff design review from a junior one is the surrounding system.

**Prefix pattern as a public contract.** Stripe uses `sk_live_`, `sk_test_`, `pk_live_`, `rk_` (restricted). GitHub uses `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`. The prefix is not decoration. It is a machine-readable type tag that lets GitHub secret scanning, TruffleHog, and gitleaks identify the key class, route a leak notification to the right provider, and optionally auto-revoke. In 2026 the GitHub Secret Scanning Partner Program covers hundreds of providers, notifying them when a matching secret is pushed publicly, and some providers auto-revoke on notification. If you ship keys without a registered prefix pattern, you are opting out of the single most effective compromise-detection channel in the industry. Register your prefix with GitHub, publish a revocation webhook, and test the end-to-end path with a sentinel commit in a canary repo.

**Storage: SHA-256 vs argon2id, and when each applies.** SHA-256 is correct for 256-bit random keys because the input entropy eliminates the attack argon2id defends against. However, if your product exposes short or user-chosen tokens (webhook secrets with 16 characters, personal access tokens with user-supplied names embedded), argon2id with `memory=64MB, iterations=3, parallelism=4` is the right call. A common production compromise is a two-tier scheme: SHA-256 for high-entropy machine keys validated hot-path, argon2id for human-chosen secrets behind a small LRU cache keyed on the hash to amortize the KDF cost. Peppered HMAC (`HMAC-SHA256(server_pepper, key)`) is a third option used by several large providers so that a DB leak without the pepper yields unusable hashes. The pepper lives in an HSM or KMS, never in the DB.

**Scoping granularity and the deputy problem.** A key with a flat scope list like `["read", "write"]` is a design smell. Production systems need resource-action scoping (`payments:read`, `payments:refund`, `customers:write`) and optional resource-instance constraints (`account_id in {acc_123, acc_456}`). AWS IAM policies, GCP IAM conditions, and Stripe Restricted Keys all converge on this shape. The reason is the confused deputy: a broadly scoped key held by a legitimate service becomes a privilege escalation primitive when that service has an SSRF or prompt injection bug. Narrow scopes contain the blast radius. Enforce scopes at both the gateway (coarse) and the service (fine) so a compromised gateway cannot bypass domain logic.

**Rotation without downtime.** Two patterns dominate. First, dual-key acceptance: issue key version N+1, accept both N and N+1 for a grace window (typically 30 days), force N+1 usage after, revoke N. Second, grace-revoke-on-use: mark the old key as `deprecated`, log every use with caller identity, and hard-revoke after a tenant-defined window with escalating warnings. The first is safer for machine-to-machine. The second surfaces the actual consumers, which matters when a key has been copied into unknown systems. Build a self-service rotation endpoint and a forced-rotation admin endpoint. Staff-level design reviews will ask how you handle rotation during an incident when the old key must be revoked immediately. Answer: the grace window is a configurable per-key property, and incident response sets it to zero.

**Key leak detection beyond GitHub.** GitHub secret scanning catches public commits. You also need: (1) an egress-log scanner that alerts when a live key appears in outbound HTTP bodies to non-approved destinations, (2) a canary key planted in build artifacts and shipped to npm/PyPI that triggers a SEV2 if ever used, (3) CloudTrail/audit-log anomaly detection on unusual geographies or user-agents per key. At FAANG scale the canary approach is dominant because it detects leaks that never reach GitHub: accidental container image inclusion, CI log exposure, vendor breach.

**Service accounts vs API keys vs workload identity.** API keys are the wrong primitive for service-to-service authentication inside your own infrastructure. They require secret distribution, rotation, and storage, all of which are solved by short-lived workload identities. SPIFFE/SPIRE issues X.509 SVIDs or JWT-SVIDs bound to a workload's kernel attestation (process UID, k8s service account, AWS IAM role). mTLS between services uses the SVID as both identity and channel binding. In 2026, Istio and Cilium ship SPIFFE-compatible identity out of the box, Linkerd provides equivalent workload identity through its own mTLS scheme, and AWS IAM Roles Anywhere plus GCP Workload Identity Federation extend the same model across clouds. The rule: API keys for external callers you cannot attest, workload identity for everything inside your trust boundary. A design that uses long-lived API keys between internal microservices will be blocked at staff review.

**Timing-safe validation.** The lookup-by-hash pattern in the code is timing-safe by construction because the comparison is an indexed DB equality on the hash column. If you ever switch to iterating candidate keys (for example, supporting multiple active key versions per tenant), use `subtle.ConstantTimeCompare` from `crypto/subtle` for the hash comparison. A linear scan with `==` leaks the matching prefix length through response time and is a documented side channel.

**Observability and audit.** Every key validation should emit a structured event with key ID (never the raw key), tenant ID, scope used, route, source IP, and result. Feed this into your SIEM. The top three alerts that catch real compromises: first-use from a new ASN, 10x volume spike within a 5-minute window, and scope-denied events clustering on one key. These beat any static rule set. Cedar by AWS, OPA, and Zanzibar-style systems all integrate cleanly with this event stream because they already emit decision logs.

**What a staff design doc looks like.** One page covering: threat model (who has the key, where is it stored, how is it transmitted), key format and prefix registration, storage and KDF choice with justification, scope grammar, rotation protocol with grace windows, leak detection channels, revocation SLA, observability contract, and a rollback plan. If any section is missing, the design is not ready for review.

---
