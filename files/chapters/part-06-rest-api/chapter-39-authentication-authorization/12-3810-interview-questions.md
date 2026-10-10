## 39.10 Interview Questions

### Question 1: What's the difference between authentication and authorization? Give examples.

**Answer:**

**Authentication (AuthN)** answers "Who are you?" by verifying identity.
Examples:
- Username/password login
- JWT token validation
- OAuth access token verification
- API key validation
- Biometric verification

**Authorization (AuthZ)** answers "What can you do?" by verifying permissions.
Examples:
- Role-based access control (admin can delete, user cannot)
- Resource ownership (user can edit their own posts only)
- Attribute-based policies (user.department == "engineering")
- Scope validation (OAuth scope includes "read:users")

**Flow:** Authentication happens first. If authenticated, authorization checks what the identity can do:

```go
func ProtectedHandler(w http.ResponseWriter, r *http.Request) {
    // 1. Authentication: Who is making this request?
    user := GetUser(r.Context())
    if user == nil {
        http.Error(w, "Unauthorized", 401) // Not authenticated
        return
    }

    // 2. Authorization: Can they perform this action?
    if !rbac.HasPermission(user.Roles, "posts", "delete") {
        http.Error(w, "Forbidden", 403) // Authenticated but not authorized
        return
    }

    // Proceed with action
}
```

**What FAANG expects:** You must distinguish AuthN (identity proof) from AuthZ (policy decision) crisply, and place each at the correct layer. AuthN is an edge concern (gateway/middleware). AuthZ belongs in the service/domain layer where the resource is known. Senior candidates also mention that AuthZ must be enforced server-side *on every request*, never in the UI alone, and that 401 vs 403 have semantic meaning (re-authenticate vs. this identity is forbidden).

**Follow-ups:**
- *"Why return 403 and not 404 when a user lacks permission to see a resource?"* Some systems deliberately return 404 to avoid leaking resource existence (e.g., private GitHub repos), a valid design choice when existence itself is sensitive. 403 is correct when existence is not secret.
- *"Where do you authenticate vs. authorize in a microservices mesh?"* AuthN at the edge gateway (verify JWT/mTLS, attach identity to the request context). AuthZ at the service boundary and inside aggregate roots. Never trust the caller's claimed permissions.
- *"How does this change with service-to-service calls?"* Use mTLS with SPIFFE/SPIRE identities, or short-lived workload JWTs signed by a workload identity issuer. Human identity flows in as a propagated claim.

### Question 2: How would you implement secure session management?

**Answer:** There are two main approaches: stateful sessions and stateless tokens.

**Stateful Sessions (Server-side):**
```go
type SessionStore struct {
    redis *redis.Client
}

func (s *SessionStore) Create(userID string) (string, error) {
    sessionID := generateSecureRandom(32) // 256 bits

    session := Session{
        UserID:    userID,
        CreatedAt: time.Now(),
        ExpiresAt: time.Now().Add(24 * time.Hour),
        IP:        requestIP,
        UserAgent: userAgent,
    }

    // Store in Redis with TTL
    s.redis.Set(ctx, "session:"+sessionID, session, 24*time.Hour)

    return sessionID, nil
}

// Set secure cookie
http.SetCookie(w, &http.Cookie{
    Name:     "session_id",
    Value:    sessionID,
    HttpOnly: true,     // Not accessible via JavaScript
    Secure:   true,     // Only over HTTPS
    SameSite: http.SameSiteStrictMode, // CSRF protection
    Path:     "/",
    MaxAge:   86400,
})
```

**Stateless Tokens (JWT):**
```go
// Short-lived access token (15 min) + refresh token (7 days)
// Access token: Validates on every request
// Refresh token: Stored securely, used to get new access token

// Best of both: Use JWT for access, store refresh tokens server-side
type HybridSession struct {
    AccessToken  string // JWT, 15 minutes
    RefreshToken string // Random ID, stored in DB, 7 days
}
```

**Security considerations:**
- Regenerate session ID after login (prevent fixation)
- Bind to IP/User-Agent (detect hijacking)
- Absolute timeout (max session lifetime)
- Sliding expiration (extend on activity)
- Secure logout (invalidate all tokens)

**What FAANG expects:** The tell for senior-level answers is naming the *revocation problem* up front: stateless JWTs are hard to revoke, stateful sessions scale horizontally only as well as your session store. The accepted 2026 pattern is hybrid: short-lived (5-15 min) JWT access tokens signed with an asymmetric key (RS256/ES256) so any service can verify via JWKS without calling the auth server, paired with opaque refresh tokens stored server-side with rotation and reuse detection. You should also flag cookie attributes (`HttpOnly`, `Secure`, `SameSite=Lax` or `Strict`), and that `localStorage` for tokens is an XSS footgun.

**Follow-ups:**
- *"What happens when a user logs out of one device? Do their other sessions die too?"* It's a product decision. If yes, version the user record (`token_version`) and include it in JWT claims. A password change or "sign out everywhere" bumps the counter, invalidating all outstanding tokens within one access-token TTL.
- *"How do you revoke a JWT before expiry?"* You can't, without state. Options: (1) short TTL + don't bother revoking. (2) revocation allowlist/denylist in Redis keyed by `jti`. (3) bump user token version.
- *"Why not just make JWT TTL 24 hours and skip refresh tokens?"* Because a stolen access token is valid for 24 hours with no way to kill it. Short access + rotating refresh gives you fast revocation *and* stateless verification on the hot path.

### Question 3: How would you design an API key system for a public API?

**Answer:**

```go
// 1. Key Structure: Prefix + Random
// Format: prefix_randomBytes
// Example: sk_live_a1b2c3d4e5f6g7h8i9j0...
type APIKey struct {
    Prefix     string // Environment/type indicator
    Identifier string // First 8 chars (visible to user)
    Secret     string // Full key (shown once at creation)
    Hash       string // SHA-256 hash (stored in DB)
}

// 2. Generation
func GenerateAPIKey(environment string) (displayKey string, key *APIKey) {
    random := make([]byte, 32)
    crypto_rand.Read(random)

    secret := base64.RawURLEncoding.EncodeToString(random)
    fullKey := fmt.Sprintf("sk_%s_%s", environment, secret)

    hash := sha256.Sum256([]byte(fullKey))

    return fullKey, &APIKey{
        Prefix:     "sk_" + environment,
        Identifier: secret[:8],
        Hash:       hex.EncodeToString(hash[:]),
    }
}

// 3. Storage: Never store the actual key
// Store: ID, prefix, hash, user_id, scopes, created_at, last_used_at

// 4. Validation
func ValidateAPIKey(providedKey string) (*APIKey, error) {
    hash := sha256.Sum256([]byte(providedKey))
    hashHex := hex.EncodeToString(hash[:])

    // Look up by hash
    key, err := store.GetByHash(hashHex)
    if err != nil {
        return nil, ErrInvalidKey
    }

    // Check expiration, revocation, rate limits
    if key.IsExpired() || key.IsRevoked() {
        return nil, ErrInvalidKey
    }

    return key, nil
}

// 5. Features for production:
// - Key rotation with overlap period
// - Scoped permissions (read-only, specific resources)
// - IP whitelisting
// - Rate limiting per key
// - Usage analytics
// - Audit logging
```

**What FAANG expects:** The non-negotiable is that the raw key never hits the database. Stripe's well-known pattern hashes keys with a server-side pepper (HMAC-SHA256) so that even a full DB dump is useless without the pepper stored in a KMS/HSM. Prefix-based routing (`sk_live_`, `sk_test_`) accelerates lookup: you hash only within the matching prefix bucket. Senior candidates also mention rotation with overlap (old and new keys valid simultaneously), scope/permission limiting, per-key rate limits, and leaked-key scanning (GitHub's secret-scanning partnership).

**Follow-ups:**
- *"Why not bcrypt/argon2 for API keys like we do passwords?"* API keys are high-entropy random, not user-chosen. Slow hashing buys you nothing against brute force and adds tens of ms to every authenticated request. SHA-256 + pepper is standard.
- *"How would you detect a leaked key?"* Subscribe to GitHub's secret-scanning program (register your prefix), monitor paste sites, and emit anomaly alerts on usage from new IP ranges or geographies.
- *"A customer's key leaked. Walk me through the response."* Identify scope of access with audit logs, rotate the key (issue new, mark old for expiry in N hours with deprecation warnings), notify the customer, review what data was accessed during the exposure window.

### Question 4: Explain PKCE and why it's needed for OAuth.

**Answer:** PKCE (Proof Key for Code Exchange) prevents authorization code interception attacks in OAuth.

**The Problem:** In the original OAuth flow, if an attacker intercepts the authorization code (via malicious app, compromised redirect), they can exchange it for tokens.

**How PKCE Works:**
```go
// 1. Client generates code_verifier (random string)
verifier := generateSecureRandom(43) // 43-128 characters

// 2. Client creates code_challenge from verifier
hash := sha256.Sum256([]byte(verifier))
challenge := base64.RawURLEncoding.EncodeToString(hash[:])

// 3. Authorization request includes challenge
authURL := fmt.Sprintf("%s/authorize?client_id=%s&code_challenge=%s&code_challenge_method=S256",
    authServer, clientID, challenge)

// 4. User authenticates, server stores challenge with code

// 5. Token request includes verifier
tokenReq := TokenRequest{
    GrantType:    "authorization_code",
    Code:         authorizationCode,
    CodeVerifier: verifier, // Original random string
}

// 6. Server verifies: SHA256(verifier) == stored challenge
func (s *AuthServer) ValidatePKCE(verifier, storedChallenge string) bool {
    hash := sha256.Sum256([]byte(verifier))
    computed := base64.RawURLEncoding.EncodeToString(hash[:])
    return subtle.ConstantTimeCompare([]byte(computed), []byte(storedChallenge)) == 1
}
```

**Why attackers can't use intercepted codes:**
- They have the code but not the verifier
- Without verifier, they can't compute valid PKCE proof
- Server rejects token request

**PKCE is mandatory for:**
- Mobile apps (can't securely store client_secret)
- Single-page apps (JavaScript can't hide secrets)
- **Every client in OAuth 2.1**, confidential clients included (defense in depth against code leakage via logs, referrer headers, etc.)

**What FAANG expects:** You must draw the threat model: the authorization code travels through the user's browser (redirects, history, referrer headers, browser extensions, logs). Before PKCE the client_secret was the only defense. Public clients have no way to keep one. PKCE binds the code to a per-request ephemeral secret (the verifier) that never leaves the client. OAuth 2.1 makes PKCE universal because the attack surface (stolen codes via logs/history) exists for confidential clients too. Mention that the `code_challenge_method` must be `S256`. `plain` is still in the spec but should be refused.

**Follow-ups:**
- *"Why is `state` still needed if we have PKCE?"* `state` defends against CSRF on the redirect (binds the auth response to the original request), while PKCE defends against code theft. They solve different attacks.
- *"What's the difference between OAuth and OIDC?"* OAuth 2.1 is for *authorization* (delegated API access). OIDC (OpenID Connect) is an identity layer built on top that adds an `id_token` (JWT) with authenticated user claims. If you're "signing in with Google," you want OIDC, not raw OAuth.
- *"When would you use the client credentials grant?"* Machine-to-machine only: a backend service calling another backend with its own identity, not on behalf of a user. No PKCE needed because there's no browser.

### Question 5: How would you implement multi-tenant data isolation?

**Answer:**

```go
// Three approaches with trade-offs:

// 1. Separate Databases (highest isolation, highest cost)
type DatabasePerTenant struct {
    connections map[string]*sql.DB
}

func (d *DatabasePerTenant) GetDB(tenantID string) *sql.DB {
    return d.connections[tenantID]
}

// 2. Separate Schemas (good isolation, moderate cost)
type SchemaPerTenant struct {
    db *sql.DB
}

func (s *SchemaPerTenant) Query(tenantID, query string) (*sql.Rows, error) {
    // Set search_path for PostgreSQL. Identifiers cannot be bound as
    // parameters, so tenantID must be allowlist-validated and quoted
    // (pq.QuoteIdentifier) to prevent SQL injection.
    _, err := s.db.Exec("SET search_path TO " + pq.QuoteIdentifier(tenantID))
    if err != nil {
        return nil, err
    }
    return s.db.Query(query)
}

// 3. Shared Tables with tenant_id (lowest isolation, lowest cost)
type SharedTables struct {
    db *sql.DB
}

// RECOMMENDED: Automatic tenant filtering at repository level
type TenantAwareRepository struct {
    db *sql.DB
}

func (r *TenantAwareRepository) ListOrders(ctx context.Context) ([]Order, error) {
    tenant := GetTenant(ctx)
    if tenant == nil {
        return nil, ErrNoTenantContext
    }

    // Tenant ID is ALWAYS in the query - no way to forget
    query := `SELECT * FROM orders WHERE tenant_id = $1`
    return r.db.Query(query, tenant.ID)
}

// Use Row-Level Security (PostgreSQL) for defense in depth
// CREATE POLICY tenant_isolation ON orders
//   USING (tenant_id = current_setting('app.tenant_id')) - 
func (r *TenantAwareRepository) SetTenantContext(ctx context.Context) error {
    tenant := GetTenant(ctx)
    // set_config(..., true) is the parameterizable form of SET LOCAL
    // (SET itself cannot take bind parameters)
    _, err := r.db.ExecContext(ctx,
        "SELECT set_config('app.tenant_id', $1, true)",
        tenant.ID,
    )
    return err
}
```

**Security measures:**
- Tenant ID from JWT claims, not user input
- Middleware validates user belongs to tenant
- Row-level security as backup
- Audit logs for cross-tenant access attempts
- Regular security testing for isolation

**What FAANG expects:** The answer should walk the trade-off curve (shared table → schema-per-tenant → DB-per-tenant) in terms of isolation, operational cost, and blast radius, then pick shared-table-with-RLS as the 80% default. The critical detail is that tenant_id must come from the *authenticated context* (verified JWT claim), never from the request body or URL. The #1 multi-tenant bug is `?tenant_id=` being trusted. Defense in depth: (1) middleware attaches tenant to context, (2) repository layer refuses queries without tenant, (3) Postgres RLS as last line of defense. Senior candidates also mention "noisy neighbor" quotas (per-tenant rate limits, query timeouts) and per-tenant encryption keys for regulated data.

**Follow-ups:**
- *"A customer asks for data residency in the EU. How does your design handle that?"* Shared-table breaks down. You move to region-sharded deployments: tenant routing at the edge based on a tenant→region map, and each region runs an independent database. This is why identity and payments vendors offer regional deployments (Auth0's EU and AU regions, for example).
- *"How do you prevent a support admin from accidentally reading tenant data?"* Break-glass access with mandatory justification, time-bound elevation, and real-time audit notification to the customer. Mature platforms converge on this pattern.
- *"Your RLS policy is in place but a dev writes a raw query with a missing WHERE clause. Does it leak?"* No, RLS applies the policy predicate at the database level. That's the whole point of defense in depth. But you should still fail CI if a query misses tenant scoping (static analysis).

### Junior → FAANG: Interview Prep for Your First Auth-Focused Round

The questions above are the form. Below is the delivery. A junior candidate fails this round not because they do not know PKCE but because they recite definitions without threat modeling.

Structure every answer as Threat, Mechanism, Trade-off, Follow-up.

- Threat: what attack does this defend against.
- Mechanism: how the mitigation works, with the actual bytes on the wire.
- Trade-off: what this costs (latency, complexity, UX).
- Follow-up: the one gotcha an interviewer will probe.

Worked example: "What is CSRF." Threat: attacker site triggers a state-changing request to your site using the victim's session cookie. Mechanism: server issues a CSRF token bound to the session, client echoes it in a header, server validates. Trade-off: every form needs a token, AJAX clients need to fetch and send it. Follow-up: "Does `SameSite=Strict` replace CSRF tokens?" Answer: mostly yes for same-site browsers, but you still want defense in depth and `SameSite` does not protect against a compromised subdomain.

Prerequisite gaps to fix before the interview. (1) Know the HTTP cookie attributes cold: `HttpOnly`, `Secure`, `SameSite`, `Domain`, `Path`, `Max-Age`, `Expires`. (2) Draw the OAuth authorization code flow from memory, including PKCE, `state`, and the token endpoint. (3) Name three password hashing algorithms and which you would choose today (argon2id). (4) Explain `401` vs `403` without blinking. (5) Know what JWKS is and why it exists.

First-job context. In your first production incident, the question will not be "what is OAuth" but "our customer says their token was stolen, what do we do in the next 10 minutes." Rehearse the runbook: confirm the report, rotate the token, check audit logs for suspicious use, notify the customer with scope of access, open a postmortem.

Interview entry point for L3/L4. "Design login for a SaaS." The L3 answer: email/password, bcrypt, session cookie, MFA via TOTP. The L4 answer adds: password breach check via HIBP, rate limiting per IP and per account, suspicious login detection (new device/geo), account lockout with unlock email, WebAuthn as a primary factor not just backup.

### Senior @ FAANG: Signal Ladders L3-L7 and Bar-Raiser Calibration

Interview loops at FAANG assess signal, not answers. Below is the calibration ladder used by most bar-raisers in 2026.

L3 (SDE I / E3). Can answer "what is authentication vs authorization" and write a middleware that validates a JWT. Understands why passwords are hashed, not encrypted. Can recite PKCE. Will not design a new system.

L4 (SDE II / E4). Can implement a refresh-token rotation scheme with reuse detection. Can debug an algorithm confusion vulnerability. Knows `SameSite` cookie behavior and when each value is correct. Can integrate an IdP via OIDC without cargo-culting. Bar-raiser question: "why not store tokens in localStorage." A passing answer names XSS, `HttpOnly` cookies, and CSRF trade-offs.

L5 (Senior / E5). Can design auth for a multi-tenant SaaS with SSO, MFA, API keys, and service-to-service. Can run the incident response for a credential leak. Can choose between Auth0, WorkOS, Okta, and build, with clear trade-off reasoning. Bar-raiser questions: "migrate from session-based to token-based auth with zero downtime," "design account recovery that resists social engineering." A passing answer has concrete migration phases, monitoring SLOs, and rollback criteria.

L6 (Staff / E6). Owns authz strategy for a business unit. Can design ReBAC using Zanzibar patterns. Can own the IdP vendor relationship and the SSO contract with enterprise customers. Can define the auth platform's SLOs and error budget. Bar-raiser: "design service-to-service auth at FAANG scale, 10,000 services, 100 regions, sub-millisecond authorization decisions." A passing answer covers SPIFFE/SPIRE, workload-identity federation, policy distribution, caching, and failure modes including stale policy during IdP outage.

L7 (Principal / E7). Influences auth strategy across business units. Can represent the company in standards bodies (OAuth Working Group, FIDO Alliance). Drives multi-year migrations like passkey rollout for a billion users. Bar-raiser: "defend your company's identity strategy to the CISO and CFO." A passing answer includes regulatory posture (SOC 2, ISO 27001, FedRAMP, PCI, HIPAA as relevant), build-vs-buy TCO over five years, and attack-surface reduction KPIs.

Bar-raiser prompts by level.

- L5: "Design password reset that resists social engineering and supports MFA users."
- L5: "Implement rate limiting for login that handles both credential stuffing and distributed brute force."
- L6: "Design the authorization data plane for a product with 100 million users, 10 billion resources, and sharing semantics."
- L6: "Your IdP vendor has a four-hour outage. What breaks, and how do you design to survive."
- L7: "Migrate a legacy username-password product to passkey-first authentication across 500 million accounts with a 12-month deadline."
- L7: "Your company must comply with a new regulation (e.g., the EU eIDAS 2.0 wallet) in 18 months. Brief the board."

Maturity model for candidate preparation. L1 reads blog posts. L2 implements one flow end-to-end. L3 reads the RFC and the OWASP ASVS. L4 builds a toy IdP that implements OAuth 2.1 and OIDC. L5 has production experience with incident response. Move up by doing, not reading.

ADR exercise for the senior candidate. Before any design interview, have in your back pocket a real ADR you wrote, covering: context (company stage, constraints), decision (the chosen option), alternatives (at least three with trade-offs), consequences (what you gave up), revisit date. The interviewer will not ask for it by name, but the structure is the scaffolding of every staff-plus answer.

Governance hooks. At L6+ you are expected to describe governance, not just architecture. How do engineers request a new OAuth client. Who approves scope changes. How are secrets rotated. What is the SLO for credential revocation propagation across the fleet. What is the exception process for break-glass access. These answers distinguish the staff engineer from the senior engineer in the same way "how do you design a system" distinguishes the senior from the mid-level.

---
