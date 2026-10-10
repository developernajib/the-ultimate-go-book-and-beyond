## Authentication Pitfalls: When Security Goes Wrong

### The JWT Secret in Git History

**The Incident**: A startup stored their JWT signing key in an environment variable file. One developer committed `.env` to Git "temporarily for testing" and immediately removed it in the next commit. Two years later, an attacker found it in the Git history, used the key to forge admin tokens, and exfiltrated all customer data. The breach cost seven figures in fines and destroyed customer trust.

```go
// WRONG: Hardcoded or poorly managed secrets
var jwtSecret = []byte("super-secret-key-123") // Hardcoded!

func generateToken(user *User) (string, error) {
    token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
        "user_id": user.ID,
        "admin":   user.IsAdmin,
        "exp":     time.Now().Add(24 * time.Hour).Unix(),
    })
    return token.SignedString(jwtSecret)
}

// CORRECT: Secure key management with rotation support
type JWTManager struct {
    currentKey    *KeyVersion
    previousKey   *KeyVersion // For key rotation
    keyStore      KeyStore
    mu            sync.RWMutex
}

type KeyVersion struct {
    ID        string
    Secret    []byte
    CreatedAt time.Time
    ExpiresAt time.Time
}

func NewJWTManager(keyStore KeyStore) (*JWTManager, error) {
    m := &JWTManager{keyStore: keyStore}

    // Load keys from secure store (Vault, KMS, etc.)
    if err := m.loadKeys(); err != nil {
        return nil, err
    }

    // Start background key rotation checker
    go m.watchForRotation()

    return m, nil
}

func (m *JWTManager) GenerateToken(user *User) (string, error) {
    m.mu.RLock()
    key := m.currentKey
    m.mu.RUnlock()

    token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
        "user_id": user.ID,
        "roles":   user.Roles, // Not "admin": true/false!
        "exp":     time.Now().Add(15 * time.Minute).Unix(), // Short expiry
        "iat":     time.Now().Unix(),
    })
    token.Header["kid"] = key.ID // Key ID belongs in the header (RFC 7515)

    return token.SignedString(key.Secret)
}

func (m *JWTManager) ValidateToken(tokenString string) (*Claims, error) {
    // Parse without verifying to read the key ID from the header
    unverified, _, err := jwt.NewParser().ParseUnverified(tokenString, jwt.MapClaims{})
    if err != nil {
        return nil, ErrInvalidToken
    }

    kid, _ := unverified.Header["kid"].(string)

    // Get the appropriate key
    key := m.getKey(kid)
    if key == nil {
        return nil, ErrInvalidToken
    }

    // Now validate with the correct key
    token, err := jwt.Parse(tokenString, func(t *jwt.Token) (any, error) {
        if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
        }
        return key.Secret, nil
    })

    if err != nil {
        return nil, err
    }

    // Additional validation
    return validateClaims(token.Claims.(jwt.MapClaims))
}
```

### The Algorithm Confusion Attack

**The Incident**: An API used RS256 (asymmetric) for JWT signing. The validation code accepted "alg" from the token header without checking. An attacker changed "alg" to "HS256" and signed the token using the public key (which was exposed). The server validated using the public key as an HMAC secret, and the forged token was accepted. Every user was compromised.

```go
// WRONG: Trusting the algorithm from the token
func validateTokenBad(tokenString string) (*jwt.Token, error) {
    return jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
        // Checks algorithm type but not specific algorithm!
        if _, ok := token.Method.(*jwt.SigningMethodHMAC); ok {
            return hmacSecret, nil
        }
        if _, ok := token.Method.(*jwt.SigningMethodRSA); ok {
            return rsaPublicKey, nil
        }
        return nil, fmt.Errorf("unexpected signing method")
    })
}
// Attacker can switch from RS256 to HS256 and sign with public key!

// CORRECT: Explicit algorithm verification
func validateToken(tokenString string) (*jwt.Token, error) {
    return jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
        // Explicitly check for the expected algorithm
        switch token.Method.Alg() {
        case "RS256":
            // Only accept RS256 with our specific key
            if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
                return nil, fmt.Errorf("invalid signing method")
            }
            return rsaPublicKey, nil

        default:
            return nil, fmt.Errorf("unexpected signing method: %s", token.Method.Alg())
        }
    })
}

// Even better: Use a library that prevents this by design
func validateTokenSafe(tokenString string) (*Claims, error) {
    parser := jwt.NewParser(
        jwt.WithValidMethods([]string{"RS256"}), // Whitelist algorithms
        jwt.WithExpirationRequired(),
        jwt.WithIssuedAt(),
    )

    token, err := parser.ParseWithClaims(tokenString, &Claims{}, func(t *jwt.Token) (any, error) {
        return rsaPublicKey, nil
    })

    if err != nil {
        return nil, err
    }

    claims, ok := token.Claims.(*Claims)
    if !ok || !token.Valid {
        return nil, ErrInvalidToken
    }

    return claims, nil
}
```

### The Refresh Token Replay Attack

**The Incident**: A banking app used refresh tokens stored in a database. When a refresh token was used, the old one was deleted and a new one created. An attacker stole a refresh token via XSS. The legitimate user also used their refresh token. Now both had valid sessions. The attacker drained the account while the user thought everything was normal. Token rotation without replay detection failed completely.

```go
// WRONG: Simple token rotation without family tracking
func RefreshTokenBad(ctx context.Context, refreshToken string) (*TokenPair, error) {
    token, err := db.GetRefreshToken(ctx, refreshToken)
    if err != nil {
        return nil, ErrInvalidToken
    }

    // Delete old token
    db.DeleteRefreshToken(ctx, refreshToken)

    // Generate new tokens
    return generateTokenPair(token.UserID)
}
// Both attacker and user can refresh - no way to detect theft!

// CORRECT: Token families with reuse detection
type RefreshToken struct {
    ID        string
    UserID    string
    FamilyID  string    // All tokens from same login share this
    Used      bool
    CreatedAt time.Time
    ExpiresAt time.Time
}

func RefreshToken(ctx context.Context, refreshToken string) (*TokenPair, error) {
    token, err := db.GetRefreshToken(ctx, refreshToken)
    if err != nil {
        return nil, ErrInvalidToken
    }

    // Check if token was already used
    if token.Used {
        // TOKEN REUSE DETECTED! Possible theft.
        // Invalidate entire token family
        log.Warn("refresh token reuse detected",
            "user_id", token.UserID,
            "family_id", token.FamilyID)

        db.InvalidateTokenFamily(ctx, token.FamilyID)

        // Alert user
        notifyUserOfSuspiciousActivity(token.UserID)

        // Force re-authentication
        return nil, ErrTokenReuseDetected
    }

    // Check if token is expired
    if time.Now().After(token.ExpiresAt) {
        db.InvalidateTokenFamily(ctx, token.FamilyID)
        return nil, ErrTokenExpired
    }

    // Mark current token as used (don't delete!)
    if err := db.MarkTokenUsed(ctx, token.ID); err != nil {
        return nil, err
    }

    // Generate new refresh token in same family
    newRefreshToken := &RefreshToken{
        ID:        generateID(),
        UserID:    token.UserID,
        FamilyID:  token.FamilyID, // Same family!
        Used:      false,
        CreatedAt: time.Now(),
        ExpiresAt: time.Now().Add(7 * 24 * time.Hour),
    }

    if err := db.SaveRefreshToken(ctx, newRefreshToken); err != nil {
        return nil, err
    }

    // Generate new access token
    accessToken, err := generateAccessToken(token.UserID)
    if err != nil {
        return nil, err
    }

    return &TokenPair{
        AccessToken:  accessToken,
        RefreshToken: newRefreshToken.ID,
    }, nil
}

// On logout: invalidate entire family
func Logout(ctx context.Context, refreshToken string) error {
    token, err := db.GetRefreshToken(ctx, refreshToken)
    if err != nil {
        return nil // Already logged out or invalid
    }

    return db.InvalidateTokenFamily(ctx, token.FamilyID)
}
```

### The RBAC Bypass Through Direct Object Reference

**The Incident**: An API checked user roles before showing the "Edit" button in the UI, but the actual PUT endpoint didn't verify permissions - it only checked if the user was authenticated. Any authenticated user could edit any resource by guessing IDs. An attacker modified thousands of records before anyone noticed. The RBAC system was UI-only.

```go
// WRONG: Authorization only at UI level
func UpdateProject(w http.ResponseWriter, r *http.Request) {
    user := getAuthenticatedUser(r) // Only checks authentication!
    projectID := r.PathValue("id")

    var update ProjectUpdate
    json.NewDecoder(r.Body).Decode(&update)

    // No authorization check - any user can update any project!
    err := db.UpdateProject(projectID, update)
    // ...
}

// CORRECT: Authorization check on every protected action
type Authorizer interface {
    CanRead(ctx context.Context, user *User, resource Resource) bool
    CanWrite(ctx context.Context, user *User, resource Resource) bool
    CanDelete(ctx context.Context, user *User, resource Resource) bool
}

func UpdateProject(w http.ResponseWriter, r *http.Request) {
    ctx := r.Context()
    user := getAuthenticatedUser(r)
    projectID := r.PathValue("id")

    // Load the resource first
    project, err := db.GetProject(ctx, projectID)
    if err != nil {
        http.Error(w, "Project not found", http.StatusNotFound)
        return
    }

    // Authorization check
    if !authorizer.CanWrite(ctx, user, project) {
        // Log the attempt
        log.Warn("unauthorized access attempt",
            "user_id", user.ID,
            "action", "update_project",
            "project_id", projectID)

        // Return 404 instead of 403 to prevent enumeration
        http.Error(w, "Project not found", http.StatusNotFound)
        return
    }

    var update ProjectUpdate
    json.NewDecoder(r.Body).Decode(&update)

    // Now safe to update
    err = db.UpdateProject(projectID, update)
    // ...
}

// Middleware for common authorization patterns
func RequirePermission(permission string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            user := getAuthenticatedUser(r)
            resource := getResourceFromRequest(r)

            if !authorizer.HasPermission(r.Context(), user, permission, resource) {
                http.Error(w, "Not found", http.StatusNotFound)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

### Quick Reference: Authentication Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Hardcoded secrets | Secrets in Git history | Key management service, rotation |
| Algorithm confusion | Forged tokens accepted | Whitelist specific algorithms |
| Token replay | Stolen tokens work forever | Token families, reuse detection |
| UI-only authorization | Backend ignores roles | Check permissions on every action |
| Long-lived tokens | Extended attack window | Short access tokens + refresh |
| Missing token binding | Session hijacking | Bind to device/IP fingerprint |
| Password in logs | Credential exposure | Never log authentication data |
| Timing attacks | User enumeration | Constant-time comparisons |

### Junior → FAANG: Postmortem Literacy

Every pitfall in the table above started as a postmortem. Junior engineers who want to move fast learn to read postmortems the way junior pilots read NTSB reports. You are not trying to memorize the specific bug, you are trying to pattern-match the class of mistake so that when you are about to ship the same class of code you stop.

Reading framework. For each postmortem, extract five things: (1) What was the attacker model (insider, external, compromised credential, supply chain). (2) What did the system let them do that it should not have. (3) What one invariant, if enforced, would have caught this. (4) How long was the exposure window. (5) What systemic change prevents the class of bug.

Worked example: the JWT-in-git-history story above. Attacker model: external, used public data. System allowed: offline forgery of admin tokens because the key was static and never rotated. Invariant: signing keys must be stored in a managed secret store with audit logging, and a git pre-receive hook must block files matching `^JWT_` or `.env`. Exposure window: two years. Systemic change: pre-commit hooks with `gitleaks` or `trufflehog`, secrets manager enforcement, and automatic key rotation.

"Why did this fail" reflex. When you see a failure, your instinct should be to ask at least three "why"s before stopping. "Why was the key in git." Because there was no secrets manager. "Why was there no secrets manager." Because the team had no platform team yet. "Why did the team have no platform team." Because security was not budgeted until after the company hit Series B. That last answer is the organizational root cause, and it is what staff engineers address.

First-job context. You will be asked to ship auth code within your first six months. Before you merge, run through the table. If your PR introduces any row in the "Symptom" column, stop and fix it. The fastest way to get your first promotion is to catch a bug from the table in someone else's code review and explain why it matters.

Interview entry point. "Tell me about a security vulnerability you found in your own or other code." Pick one from this table, describe how you found it (ideally through code review, not through a production incident), and explain the fix. Bonus points if you turned the fix into a lint rule or a code-review checklist.

### Senior @ FAANG: Incident Command, Governance, and Class-of-Bug Eradication

At staff and principal level, individual pitfalls are symptoms. The job is to eradicate classes.

Incident command for auth incidents. When a credential or key is suspected compromised, the response runs on a clock. Minute 0-5: confirm the report, assemble the incident channel, declare severity (SEV-1 for key compromise, SEV-2 for single-account takeover, SEV-3 for individual bug). Minute 5-30: containment (rotate keys, revoke tokens, force logout if needed). Minute 30-120: forensic scope (who did what with the compromised credential, from what IPs, against what resources). Hour 2-24: customer notification (legal, PR, support coordination). Hour 24-72: postmortem draft. Week 1-2: postmortem review, action items, and systemic changes filed as tickets with owners and deadlines.

Key rotation as a first-class system. A FAANG-tier auth platform rotates signing keys on a schedule (quarterly for HS256, annually for RS256) and on demand during incidents. The system publishes multiple keys in JWKS with unique `kid` values, validators accept any current key, new tokens are issued with the newest key, old keys stay in JWKS for at least max-token-lifetime after retirement. Test this by running a "key rotation fire drill" every quarter: rotate a non-production key, watch for any validator that fails, fix those validators. If you cannot rotate without downtime, you cannot rotate in an incident.

Secrets pipeline governance. Every secret has an owner, a rotation policy, a last-rotated timestamp, and a storage location. Build a dashboard that shows every secret and flags anything not rotated in the policy window. Tie this to the on-call rotation: the on-call reviews the dashboard weekly. Teams that do this rarely suffer key-in-git incidents. Teams that do not have them regularly.

Class-of-bug eradication for algorithm confusion. Individual code review will not catch every `jwt.Parse` that forgets to pin the algorithm. Ship a lint rule: `ast.Inspect` that walks every call to the JWT library and requires `jwt.WithValidMethods` in the options. Block merges without it. This is the pattern mature security teams converge on.

Class-of-bug eradication for UI-only authorization. Build a service-layer `Authorizer` that every resource method must accept. Make the resource type unusable without going through the authorizer. Test by writing a "null handler" that takes raw path parameters and queries the database directly, and confirm that the code does not compile because the types do not line up.

Class-of-bug eradication for refresh token replay. Make the refresh endpoint emit a metric on every reuse detection, pager-alert on any reuse, and dashboard the reuse-rate by user. If the rate is above zero for sustained periods, you have either a bug (race condition in the client retrying correctly) or an attack.

ADR: "Rotation vs revocation for session termination." Decision: prefer short-lived access tokens (5-15 min) with revocable refresh tokens over long-lived access tokens with revocation lists. Context: revocation lists do not scale past a few thousand entries per verifier, and the hot path latency matters. Alternatives: centralized revocation with distributed cache, token binding. Consequences: users notice faster logout (5-15 min max), clients must implement refresh, operational complexity shifts from revocation list to refresh token storage.

ADR: "Opaque tokens vs JWT for session." Decision: opaque bearer token for session, JWT for service-to-service. Context: sessions need fast revocation, service-to-service needs stateless verification. Consequences: session validation is a DB or Redis lookup, service-to-service validation is a signature check. Review date: 12 months.

Bar-raiser questions at staff level.

- "A signing key may have been compromised 30 minutes ago. What do you do in the next hour." Answer: rotate key immediately, bump global token version, monitor reuse metrics, forensic scope, legal notification.
- "A customer reports that an employee who left the company six months ago still has an active session. What went wrong." Answer: employee offboarding did not include token revocation, SCIM deprovisioning not wired to IdP, session store TTL too long, no audit log alert on stale sessions. Fix: wire offboarding to identity lifecycle, bump user token version on termination, alert on sessions older than 90 days.
- "You are tasked with reducing the blast radius of a leaked signing key from months to minutes. How." Answer: move to short-lived tokens plus opaque sessions, implement key rotation as a service, publish JWKS with `kid` and TTLs, require consumers to refresh JWKS hourly, add a revocation broadcast channel.

Maturity model for auth reliability. L1 has hardcoded secrets. L2 has secrets in env vars. L3 has secrets in a secrets manager with manual rotation. L4 has automated rotation with audit logs and fire drills. L5 has rotation as a platform service with self-service APIs for every team.

Governance layer. Every auth-related change goes through a security review with an assigned reviewer from the security team. Every new OAuth client must be registered with scoped permissions, an owner, and a review date. Every external identity provider integration has an ADR. Every incident triggers a postmortem with action items and systemic fixes. This governance is what distinguishes a FAANG-tier auth platform from a startup's first auth system.

---
