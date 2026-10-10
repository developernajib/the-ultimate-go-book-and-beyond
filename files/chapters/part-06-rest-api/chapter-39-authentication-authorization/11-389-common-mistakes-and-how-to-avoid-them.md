## 39.9 Common Mistakes and How to Avoid Them

### Mistake 1: Storing Secrets in JWT Claims

JWT payloads are base64-encoded, not encrypted, so any party in possession of the token can decode and read every claim without the signing key. Only opaque identifiers like user ID, roles, and tenant belong in claims. Sensitive fields like SSN or password hashes must be retrieved from the database per request.

```go
// ❌ Wrong: Sensitive data in JWT (anyone can decode the payload)
type BadClaims struct {
    jwt.RegisteredClaims
    UserID       string `json:"user_id"`
    SSN          string `json:"ssn"`           // Never!
    CreditCard   string `json:"cc"`            // Never!
    PasswordHash string `json:"password_hash"` // Never!
}

// ✅ Correct: Only non-sensitive identifiers
type GoodClaims struct {
    jwt.RegisteredClaims
    UserID   string   `json:"user_id"`
    Roles    []string `json:"roles"`
    TenantID string   `json:"tenant_id"`
}

// Fetch sensitive data from database when needed
func (h *Handler) GetProfile(w http.ResponseWriter, r *http.Request) {
    claims := GetClaims(r.Context())

    // Load full user from database
    user, err := h.userRepo.Get(r.Context(), claims.UserID)
    if err != nil {
        // ...
    }

    // Return profile (sensitive data never in token)
    response.JSON(w, http.StatusOK, user.Profile())
}
```

**Why it matters:** JWTs are base64-encoded, not encrypted. Anyone with the token can read the payload. Only store identifiers and non-sensitive claims.

### Mistake 2: Not Validating All JWT Claims

Validating only the signature leaves the door open to algorithm confusion attacks, cross-service token reuse (`aud` claim), and stale tokens past their expiry. The corrected flow enforces algorithm, issuer, audience, and expiration through `ParseWithClaims` options, then performs a final blacklist lookup to catch explicitly revoked tokens.

```go
// ❌ Wrong: Only checking signature
func (s *TokenService) BadValidate(tokenString string) (*Claims, error) {
    token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
        return s.secret, nil
    })
    if err != nil {
        return nil, err
    }
    return token.Claims.(*Claims), nil // Not checking anything else!
}

// ✅ Correct: Full validation
func (s *TokenService) GoodValidate(tokenString string) (*Claims, error) {
    token, err := jwt.ParseWithClaims(tokenString, &Claims{},
        func(token *jwt.Token) (any, error) {
            // 1. Validate algorithm (prevent algorithm confusion attacks)
            if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
                return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
            }
            return s.secret, nil
        },
        // 2. Validate issuer
        jwt.WithIssuer(s.expectedIssuer),
        // 3. Validate audience
        jwt.WithAudience(s.expectedAudience),
        // 4. Validate expiration (automatic with library)
        jwt.WithExpirationRequired(),
    )

    if err != nil {
        return nil, err
    }

    claims, ok := token.Claims.(*Claims)
    if !ok || !token.Valid {
        return nil, ErrTokenInvalid
    }

    // 5. Check token blacklist
    if blacklisted, _ := s.blacklist.IsBlacklisted(claims.ID); blacklisted {
        return nil, ErrTokenRevoked
    }

    return claims, nil
}
```

**Why it matters:** Missing validations can lead to token substitution attacks, expired token usage, or acceptance of tokens meant for other services.

### Mistake 3: Using Weak JWT Secrets

Short or dictionary-derived HMAC secrets can be brute-forced offline against any intercepted token, since verification requires no server round-trip. The fix generates a cryptographically random 256-bit secret at startup, or uses an asymmetric RSA key pair so the private key never needs to leave the signing service.

```go
// ❌ Wrong: Weak/predictable secrets
var badSecrets = []string{
    "secret",
    "jwt-secret",
    "my-secret-key",
    "password123",
    os.Getenv("JWT_SECRET"), // If not properly set
}

// ✅ Correct: Strong, randomly generated secrets
func GenerateSecureSecret() ([]byte, error) {
    // For HS256: at least 256 bits (32 bytes)
    secret := make([]byte, 32)
    if _, err := crypto_rand.Read(secret); err != nil {
        return nil, err
    }
    return secret, nil
}

// Even better: Use RSA keys for asymmetric signing
func GenerateKeyPair() (*rsa.PrivateKey, *rsa.PublicKey, error) {
    privateKey, err := rsa.GenerateKey(crypto_rand.Reader, 2048)
    if err != nil {
        return nil, nil, err
    }
    return privateKey, &privateKey.PublicKey, nil
}
```

**Why it matters:** Weak secrets can be brute-forced, allowing attackers to forge valid tokens. Use at least 256 random bits for HMAC secrets.

### Mistake 4: Not Implementing Token Revocation

Without revocation, a stolen token remains valid until expiry, potentially hours or days. The three-layer strategy covers individual token blacklisting, per-user version counters that invalidate all sessions on password change, and a global version that acts as a circuit breaker during a security incident.

```go
// ❌ Wrong: No way to invalidate tokens
func (s *TokenService) NoRevocation() {
    // User logs out... token still valid until expiration
    // User changes password... old tokens still work
    // Account compromised... can't invalidate sessions
}

// ✅ Correct: Multiple revocation strategies
type TokenRevocationService struct {
    blacklist    TokenBlacklist    // Per-token revocation
    userVersions map[string]int64  // Per-user revocation (password change)
    globalVersion int64             // Global revocation (security incident)
}

func (s *TokenRevocationService) ValidateToken(claims *Claims) error {
    // Check token-specific blacklist
    if s.blacklist.IsBlacklisted(claims.ID) {
        return ErrTokenRevoked
    }

    // Check user version (password change invalidates all tokens)
    userVersion := s.userVersions[claims.UserID]
    if claims.TokenVersion < userVersion {
        return ErrTokenRevoked
    }

    // Check global version (emergency revocation)
    if claims.GlobalVersion < s.globalVersion {
        return ErrTokenRevoked
    }

    return nil
}

// Include versions in token claims
type ClaimsWithVersions struct {
    jwt.RegisteredClaims
    UserID        string `json:"user_id"`
    TokenVersion  int64  `json:"tv"`  // User's token version when issued
    GlobalVersion int64  `json:"gv"`  // Global version when issued
}
```

**Why it matters:** Without revocation, compromised tokens remain valid until expiration. Critical for logout, password changes, and security incidents.

### Mistake 5: Exposing Timing Information

Naive string comparison short-circuits on the first differing byte, letting an attacker measure response times to guess secrets character by character. `crypto/subtle.ConstantTimeCompare` always scans the full byte slice regardless of where characters differ, eliminating the timing signal.

```go
// ❌ Wrong: Variable-time comparison leaks information
func BadPasswordCheck(stored, provided string) bool {
    return stored == provided // Vulnerable to timing attacks
}

func BadAPIKeyCheck(stored, provided string) bool {
    if len(stored) != len(provided) {
        return false // Length check reveals information
    }
    for i := range stored {
        if stored[i] != provided[i] {
            return false // Early return reveals match position
        }
    }
    return true
}

// ✅ Correct: Constant-time comparison
import "crypto/subtle"

func GoodPasswordCheck(stored, provided string) bool {
    return subtle.ConstantTimeCompare([]byte(stored), []byte(provided)) == 1
}

func GoodAPIKeyCheck(storedHash, providedHash []byte) bool {
    return subtle.ConstantTimeCompare(storedHash, providedHash) == 1
}

// For passwords: Compare hashes, not plaintext
func SecurePasswordCheck(storedHash, password string) bool {
    // VerifyPassword recomputes the Argon2id hash and compares in constant time
    match, _ := VerifyPassword(password, storedHash)
    return match
}
```

**Why it matters:** Timing attacks can reveal password characters or API key bytes one at a time by measuring response times.

### Junior → FAANG: The Top Ten Auth Mistakes You Will Make in Year One

Every junior engineer ships at least three of these before their first promotion. The goal is not to avoid every mistake, but to recognize them in code review before they ship to production.

1. JWT in `localStorage`. `localStorage` is readable by any JavaScript on the page, so any XSS (even a stale npm dependency) exfiltrates the token. Put the session in an `HttpOnly`, `Secure`, `SameSite=Lax` (or `Strict`) cookie. The token is then invisible to JavaScript. If you must read identity from JS, put a separate non-sensitive `user_id` cookie with `HttpOnly=false`.
2. No CSRF protection on state-changing requests. If you use cookie-based sessions and accept JSON POSTs without a CSRF token or `SameSite=Strict`, a cross-origin form submit can act as the logged-in user. Use the double-submit-cookie pattern or rely on `SameSite=Strict` plus an `Origin` header check.
3. Trusting `X-Forwarded-For` for rate limiting or audit logging. `X-Forwarded-For` is client-controlled unless a trusted proxy overwrites it. Always pin which proxy hop you trust (your CDN or load balancer) and parse from the right end of the header chain.
4. Session not invalidated on logout. `DELETE /session` must delete the server-side session record and clear the cookie. If you only clear the cookie, the token is still valid for anyone who captured it.
5. Permission check in the handler but not the service layer. Handlers get bypassed by internal callers, cron jobs, and GraphQL resolvers. The authorization check belongs in the service layer where every code path converges.
6. Hardcoded secrets in code or Docker images. Use environment variables backed by a secret manager (Vault, AWS Secrets Manager, GCP Secret Manager). Rotate on compromise and on every employee offboarding.
7. MD5 or SHA1 for password hashing. These are not password hashing functions, they are message digests, and GPU rigs crack them at billions of attempts per second. Use `argon2id` (or `bcrypt` cost 12+ as a legacy option).
8. Timing attacks on token comparison. Use `crypto/subtle.ConstantTimeCompare`. The example in mistake 5 above is the canonical pattern.
9. No MFA on admin accounts. Admin accounts are the highest-value target. Require WebAuthn or TOTP for any account with write access to production, billing, or user data.
10. BOLA/IDOR through sequential IDs. If `GET /api/invoices/42` returns your invoice and `GET /api/invoices/43` returns mine, you have a Broken Object Level Authorization bug. Either use unguessable IDs (UUIDv4, ULID) or check ownership on every read. OWASP ranks this as the number one API vulnerability in its 2023 list, the current edition.

Worked example. A junior ships `GET /api/users/:id/orders` and checks authentication but not ownership. A customer discovers that changing the ID returns other customers' orders. Postmortem question: "where should the authorization check have lived?" Answer: in the service layer, as `orderService.ListForUser(ctx, requester, targetUserID)`, with an explicit comparison `if requester.ID != targetUserID && !requester.IsAdmin() { return ErrForbidden }`. Add an integration test that creates two users and asserts user A cannot read user B's orders.

Interview entry point. "Tell me about a security bug you found or caused." Do not lie about catching one. Describe a real case, ideally an IDOR or a missing MFA on an admin tool, and explain the fix at both the immediate (patch the check) and systemic (add an auth-boundary lint rule or a service-layer authorizer) level. The systemic answer is what separates L4 from L5.

### Senior @ FAANG: Governance, Bar-Raiser Mistakes, and the Staff-Level Checklist

Staff and principal engineers own the class-of-bug eradication, not the individual bug. The mistakes below are the ones that show up in incident reviews with seven-figure blast radius.

Class-of-bug eradication for IDOR. Individual code review will not catch every missing ownership check across a thousand endpoints. The staff move is to enforce authorization as a type. Pattern: every resource handle returned from the data layer is an unauthorized opaque reference, and to turn it into a usable object you must pass a `Principal` through an `Authorizer`. The type system refuses to compile a handler that skips the authorizer. Several large companies have built variants of this pattern, and Airbnb's public writeup of its Himeji authorization service shows the centralized-check version of the same idea.

Algorithm confusion (CVE-2015-9235 class). A token signed with RS256 can be forged as HS256 if the verifier passes the RSA public key as the HMAC secret. Libraries have fixed this, but custom verifiers still repeat the bug. The staff-level defense: accept exactly one algorithm per audience, never negotiate from the token header, and fail closed if `alg` is unexpected or `none`.

`kid` header injection. The `kid` header chooses which key to verify against. If the verifier uses it as a filesystem path or SQL key, the attacker injects `../` or `' OR 1=1`. Treat `kid` as untrusted input, look it up through a whitelist-only JWKS cache.

Refresh token theft without reuse detection. A refresh token stolen via XSS or malware remains valid until absolute expiration, often 30 days. The fix is rotation with reuse detection (see the Auth0 case study): every refresh rotates the token, and if an old token is presented after rotation, the entire family is revoked and security is alerted. This is the OAuth 2.1 recommendation and the current industry baseline.

Session fixation after login. If the session ID is not rotated on login, an attacker can pre-plant a session ID in the victim's browser and then use it after the victim logs in. Always issue a new session cookie on authentication state changes (login, privilege elevation, MFA).

Mass assignment on profile updates. `UPDATE users SET ... = ...` with unfiltered request body lets the client set `is_admin=true`. Always allowlist the mutable fields at the binding layer.

OAuth state parameter not validated. Without `state` validation, the OAuth callback can be replayed from an attacker's authorization, tricking the victim's browser into linking the attacker's identity. PKCE and `state` are both required in 2026.

Cookie scope too wide. `Domain=.example.com` shares the cookie with every subdomain, including `marketing-intern-2019.example.com`. Scope cookies to the exact hostname unless you need sharing, and then use a dedicated auth subdomain (`auth.example.com`).

Logging sensitive tokens. Every CDN, APM, and SIEM that touches request data must have tokens redacted. Define a redaction middleware at the logging boundary, and periodically grep production logs for anything matching `eyJ` (JWT magic bytes) or `sk_live_`. Discovery of tokens in logs is a severity-one incident.

Service-to-service auth via shared secrets. A single long-lived API key shared across all services means one leak compromises everything. The staff-level answer is SPIFFE/SPIRE, mTLS with short-lived certificates, or workload-identity federation (Google's GCP workload identity, AWS IAM Roles for Service Accounts, Azure workload identity).

Password reset that does not invalidate sessions. On password reset, all existing sessions must be invalidated except optionally the current one. Otherwise, if the reset is triggered because of compromise, the attacker's session survives.

SSRF in OAuth redirect_uri. Open redirect via `redirect_uri` lets an attacker capture the authorization code. Exact-match the registered redirect URIs, never prefix or suffix match.

Bar-raiser questions.

- "You discover your JWT signing key was exposed in a public GitHub repo three hours ago. Walk me through the next 30 minutes." Answer: rotate the signing key immediately (publish new key to JWKS, keep old key in the verification set for a grace period matching max token lifetime), force logout every active session (bump a global token version), alert the security team, begin log forensics for anomalous token use, notify legal and PR depending on blast radius, write the postmortem.
- "Migrate 10,000 services from JWT validation to opaque token introspection with zero downtime." Answer: dual-validation middleware that accepts both, traffic-shaped migration by service tier, introspection cache with negative cache for revocations, latency SLO enforcement, final flag flip after six weeks.
- "Implement ReBAC with Zanzibar semantics for a 10-million-user product." Answer: OpenFGA or SpiceDB, tuple storage partitioned by tenant, consistency via zookies, per-request check cache with TTL tied to tuple-write timestamps, global read replicas with bounded staleness, write path through a single region with async replication.
- "Design passkey rollout for a 1-billion-user consumer product." Answer: phased rollout starting with high-risk accounts, device binding via WebAuthn level 2, account recovery through existing MFA factors plus social-proof, fallback to passwords during migration window, abuse-resistance against mass enrollment.
- "You receive an alert that credential stuffing traffic is hitting login at 100K RPS. Walk through the response." Answer: rate limit per IP with sliding window, deploy a bot-management challenge (Cloudflare Turnstile, hCaptcha), enable password-leak check (HIBP Pwned Passwords API or on-prem bloom filter), require MFA on suspicious logins, capture attacker patterns for longer-term rule authoring, publish a blog post with IOCs to the community.

Staff-level auth mistake checklist for code review. Run this list on every PR touching identity or authorization. (1) Is the check at the service layer. (2) Is the principal explicit in the function signature. (3) Are ownership checks tested with a two-user fixture. (4) Are secrets injected, not hardcoded. (5) Are tokens compared with constant-time functions. (6) Are sessions invalidated on logout, password reset, and MFA change. (7) Are CSRF or SameSite protections in place. (8) Are redirect URIs exact-match. (9) Are logs redacted. (10) Is there an audit log entry for every authorization decision on sensitive resources.

Maturity model. L1 ships bugs. L2 catches bugs in review. L3 writes lint rules and tests. L4 designs the service-layer authorizer pattern. L5 kills the entire class of bug through typed authorization across the codebase.

---
