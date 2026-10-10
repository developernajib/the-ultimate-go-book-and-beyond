## 42B.5 API Security Design

### Authentication: Choosing the Right Mechanism

**API Keys**: Simple tokens, issued per application.
```
Authorization: Bearer sk_live_abc123def456
X-API-Key: sk_live_abc123def456
```

Best for: Service-to-service, developer tools, simple integrations.
Pros: Simple to implement and use, easy to rotate, easy to scope.
Cons: No expiry by default, leaked keys are valid until rotated, no user identity.

**JWT (JSON Web Tokens)**: Self-contained tokens with claims.
```
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.signature
```

Best for: User authentication in SPAs/mobile apps.
Pros: Stateless (no database lookup for validation), contains claims (user ID, roles).
Cons: Cannot be revoked without a blocklist (defeating statelessness), large size, leaking private key is catastrophic.

**OAuth2**: Delegated authorization framework.
```
Authorization: Bearer access_token_from_oauth_flow
```

Best for: Third-party integrations where users grant apps access to their data.
Pros: Industry standard, user consent model, scopes, refresh tokens.
Cons: Complex to implement correctly.

```go
package auth

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "strings"
)

// APIKeyAuthenticator validates and looks up API keys
type APIKeyAuthenticator struct {
    store  APIKeyStore
    hasher APIKeyHasher
}

// API keys are stored hashed (like passwords) to prevent database leaks
// Format: prefix_version_randompart (e.g., sk_live_v1_abc123...)
func (a *APIKeyAuthenticator) Authenticate(ctx context.Context, rawKey string) (*APIKeyContext, error) {
    parts := strings.SplitN(rawKey, "_", 3)
    if len(parts) < 2 {
        return nil, ErrInvalidAPIKey
    }

    prefix := parts[0] + "_" + parts[1] // "sk_live"

    // Hash the raw key for lookup
    hash := a.hasher.Hash(rawKey)

    apiKey, err := a.store.FindByHash(ctx, prefix, hash)
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            return nil, ErrInvalidAPIKey // Don't distinguish between invalid and not-found
        }
        return nil, fmt.Errorf("looking up api key: %w", err)
    }

    if apiKey.RevokedAt != nil {
        return nil, ErrRevokedAPIKey
    }

    if apiKey.ExpiresAt != nil && apiKey.ExpiresAt.Before(time.Now()) {
        return nil, ErrExpiredAPIKey
    }

    // Update last_used_at asynchronously (don't block the request).
    //
    // Caveat worth internalising: this is an unbounded goroutine plus a
    // database write on every authenticated request. Under load it will
    // exhaust the connection pool and the write amplification buys you a
    // timestamp nobody reads in real time. In production, push the key ID
    // to a buffered channel and have a single writer flush coalesced
    // updates every few seconds. Note also the deliberate
    // context.Background(): using r.Context() here would cancel the update
    // as soon as the response is written, so the write would usually lose
    // the race and last_used_at would silently stop updating.
    go a.store.UpdateLastUsed(context.Background(), apiKey.ID)

    return &APIKeyContext{
        KeyID:   apiKey.ID,
        UserID:  apiKey.UserID,
        OrgID:   apiKey.OrgID,
        Scopes:  apiKey.Scopes,
        IsTest:  apiKey.IsTest,
    }, nil
}

// Hash API key using HMAC-SHA256 with a server-side secret
type APIKeyHasher struct {
    secret []byte
}

func (h *APIKeyHasher) Hash(key string) string {
    mac := hmac.New(sha256.New, h.secret)
    mac.Write([]byte(key))
    return hex.EncodeToString(mac.Sum(nil))
}
```

### OAuth2 Flows

A note on which OAuth you are implementing. The base standard is **OAuth 2.0 (RFC 6749)**, published 2012. **OAuth 2.1** consolidates a decade of security guidance and removes the footguns, but it is **still an IETF draft, not a ratified RFC**, so do not write "compliant with OAuth 2.1" in a design doc as though citing a standard. Its substance is nonetheless current best practice and mostly published separately as security BCP: PKCE for every client, exact-match redirect URIs, no implicit grant, no resource owner password credentials grant, no bearer tokens in query strings. Build to those rules regardless of what you call them.

**Authorization Code Flow with PKCE** (for apps acting on behalf of users):
```
0. App generates: code_verifier = <43-128 random chars>
                  code_challenge = BASE64URL(SHA256(code_verifier))
1. App redirects user to: /oauth/authorize?response_type=code&client_id=...
     &scope=read:orders&redirect_uri=...&state=random
     &code_challenge=...&code_challenge_method=S256
2. User authenticates and consents
3. Server redirects to: redirect_uri?code=AUTHCODE&state=random
4. App POSTs: /oauth/token with code + code_verifier (+ client_secret if confidential)
5. Server recomputes SHA256(code_verifier), compares to the stored
   code_challenge, and rejects the exchange on mismatch
6. Server returns: access_token + refresh_token
7. App uses: Authorization: Bearer access_token
```

PKCE (RFC 7636, pronounced "pixy") is not optional any more, and it is worth understanding what it defends against rather than adding it as ritual. Without it, an attacker who intercepts the authorization code at step 3 (via a malicious app registering the same custom URI scheme on a mobile OS, a referrer leak, or a proxy log) can redeem that code themselves. PKCE binds the code to the client that started the flow: the code is only redeemable by whoever knows the `code_verifier`, which never left the client. Originally aimed at mobile and SPA clients that cannot hold a secret, it is now recommended for **confidential clients too**, because it also blunts authorization code injection where the client secret does not help.

Two things the flow above quietly depends on. `state` and PKCE solve **different** problems and you need both: `state` is CSRF protection for the redirect, PKCE binds the code to the requester. And `code_challenge_method` must be `S256` - the spec permits `plain`, which transmits the verifier in the clear and defeats the entire mechanism.

**Client Credentials Flow** (for service-to-service, no user):
```
1. Service POSTs: /oauth/token with grant_type=client_credentials + client_id + client_secret
2. Server returns: access_token. No refresh token: RFC 6749 says one SHOULD NOT
   be issued here, because the client can simply re-authenticate with the
   credentials it already holds.
3. Service uses: Authorization: Bearer access_token
```
There is no PKCE here, and that is correct rather than an oversight: PKCE protects a redirect that this flow does not have. There is also no user, so any scope granted is the service's own authority. Resist the temptation to use this flow with a `user_id` parameter to act on someone's behalf, which is an authorization bypass wearing an OAuth costume.

```go
// Client Credentials token endpoint
func (h *OAuthHandler) TokenEndpoint(w http.ResponseWriter, r *http.Request) {
    if err := r.ParseForm(); err != nil {
        writeOAuthError(w, "invalid_request", "Failed to parse request body")
        return
    }

    grantType := r.FormValue("grant_type")

    switch grantType {
    case "client_credentials":
        h.handleClientCredentials(w, r)
    case "authorization_code":
        h.handleAuthorizationCode(w, r)
    case "refresh_token":
        h.handleRefreshToken(w, r)
    default:
        writeOAuthError(w, "unsupported_grant_type",
            fmt.Sprintf("Grant type %q is not supported", grantType))
    }
}

func (h *OAuthHandler) handleClientCredentials(w http.ResponseWriter, r *http.Request) {
    clientID, clientSecret, ok := r.BasicAuth()
    if !ok {
        clientID = r.FormValue("client_id")
        clientSecret = r.FormValue("client_secret")
    }

    client, err := h.clients.Authenticate(r.Context(), clientID, clientSecret)
    if err != nil {
        writeOAuthError(w, "invalid_client", "Client authentication failed")
        return
    }

    requestedScopes := parseScopes(r.FormValue("scope"))
    allowedScopes := intersect(requestedScopes, client.AllowedScopes)

    token, err := h.tokens.Create(r.Context(), TokenParams{
        ClientID:  client.ID,
        Scopes:    allowedScopes,
        ExpiresIn: 3600,
    })
    if err != nil {
        writeInternalError(w)
        return
    }

    writeJSON(w, http.StatusOK, map[string]any{
        "access_token": token.Value,
        "token_type":   "Bearer",
        "expires_in":   3600,
        "scope":        strings.Join(allowedScopes, " "),
    })
}
```

### Scope Design: Principle of Least Privilege

Design scopes at the right granularity:

```
# Too coarse: clients get everything they don't need
read
write

# Too fine: impossible to manage
orders:read:created:last_30_days
orders:read:specific:id

# Right: resource-level with read/write distinction
orders:read
orders:write
products:read
products:write
customers:read
customers:write
payments:read      # note: no payments:write for security-sensitive operations
webhooks:manage
```

Implement scope validation in middleware:

```go
func RequireScope(scopes ...string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            authCtx := GetAuthContext(r.Context())
            if authCtx == nil {
                apierror.Write(w, r, apierror.Unauthorized())
                return
            }

            for _, required := range scopes {
                if !authCtx.HasScope(required) {
                    apierror.Write(w, r, &apierror.ProblemDetail{
                        Type:   "https://api.example.com/errors/insufficient-scope",
                        Title:  "Insufficient Scope",
                        Status: http.StatusForbidden,
                        Detail: fmt.Sprintf("This endpoint requires the %q scope.", required),
                    })
                    return
                }
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Usage in router
r.With(RequireScope("orders:read")).Get("/orders", h.ListOrders)
r.With(RequireScope("orders:write")).Post("/orders", h.CreateOrder)
r.With(RequireScope("payments:read")).Get("/payments", h.ListPayments)
```

### Rate Limiting in API Design

Rate limits should be:
1. **Documented**: Clients must know their limits before hitting them
2. **Communicated in headers**: On every response, not just failures
3. **Predictable**: The algorithm (fixed window vs sliding window vs token bucket) should be consistent

```go
// Rate limit headers on every response
func rateLimitHeaders(w http.ResponseWriter, info RateLimitInfo) {
    w.Header().Set("X-RateLimit-Limit", strconv.Itoa(info.Limit))
    w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(info.Remaining))
    w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(info.ResetAt.Unix(), 10))
    w.Header().Set("X-RateLimit-Policy", info.Policy) // e.g., "100;w=60" (100 per 60 seconds)
}

// On rate limit exceeded:
func rateLimitExceeded(w http.ResponseWriter, r *http.Request, retryAfter int) {
    w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
    apierror.Write(w, r, apierror.RateLimited(retryAfter))
}
```

### CORS Design

Configure CORS thoughtfully - it is not just a "make the error go away" checkbox:

```go
func CORSMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            origin := r.Header.Get("Origin")

            if origin != "" && isAllowedOrigin(origin, allowedOrigins) {
                w.Header().Set("Access-Control-Allow-Origin", origin)
                w.Header().Set("Access-Control-Allow-Credentials", "true")
                w.Header().Set("Vary", "Origin")
            }

            if r.Method == http.MethodOptions {
                // Preflight request
                w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
                w.Header().Set("Access-Control-Allow-Headers",
                    "Authorization, Content-Type, X-Request-ID, API-Version, Idempotency-Key")
                w.Header().Set("Access-Control-Max-Age", "86400") // Cache preflight for 24h
                w.WriteHeader(http.StatusNoContent)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

func isAllowedOrigin(origin string, allowed []string) bool {
    for _, a := range allowed {
        if a == "*" {
            return true
        }
        // Support wildcard subdomains: *.example.com
        if strings.HasPrefix(a, "*.") {
            domain := a[2:]
            if strings.HasSuffix(origin, "."+domain) || origin == "https://"+domain {
                return true
            }
        }
        if a == origin {
            return true
        }
    }
    return false
}
```

### Junior → FAANG: Building the Security Intuition API Work Demands

Most junior engineers learn authentication as "add a JWT check." That is the starting point, not the finish line. API security at a professional level requires understanding threat models, not just implementation patterns.

**The prerequisite gap.** The most common junior blind spot is treating authentication and authorization as the same thing. Authentication answers "who are you?" Authorization answers "what are you allowed to do?" An API that authenticates correctly but authorizes coarsely is still vulnerable. A client with `orders:read` scope should not be able to read another customer's orders just because they have the right scope. Tenant isolation is enforced in the query layer, not just the middleware layer.

**Worked example: The scope that was too coarse.** An e-commerce API issues API keys with a single `read` scope. A partner integrates to read their own order history. Six months later, a bug in the order list endpoint is found: it paginates through all orders in the database if the caller omits a `customer_id` filter, and the API trusts the caller to self-filter. The partner could enumerate every order in the system. The fix requires adding tenant-scoped query enforcement, not just tightening scopes. The lesson: scope validation at the middleware layer and tenant enforcement at the data layer are both required. Neither replaces the other.

**Interview entry-point framing.** When asked "How would you secure this API?", a passing answer covers auth mechanism selection. A strong answer covers: the threat model (who are the callers, what is the blast radius of a leaked credential), scope granularity rationale, how you would detect and respond to credential abuse (rate limiting, anomaly detection on the auth logs), and what happens when a key is leaked (rotation, revocation, audit trail).

**First-job habits:**
- Never store raw API keys. Hash them with HMAC-SHA256 against a server-side secret before writing to the database. The code in this chapter shows exactly this pattern. Read it carefully.
- Always return the same error for "invalid key" and "key not found." Distinguishing them leaks information about which keys exist.
- Emit an audit log event on every authentication: who authenticated, from what IP, with what key, at what time. You will need this when a customer reports unauthorized activity.
- Document your scopes before you implement them. If you cannot explain what `orders:write` allows and excludes in two sentences, the scope is not well-designed yet.

**On JWT revocation.** JWTs are stateless by design. That is their advantage and their liability. A leaked JWT is valid until it expires. The common mitigation is a short expiry (15 minutes) combined with a refresh token flow. The more rigorous mitigation is a blocklist checked on every request, which partially defeats the statelessness but is required for security-sensitive operations like banking or health data. Know this tradeoff and be able to state when each is appropriate.

---

### Senior @ FAANG: API Security as a Platform Discipline

At senior and staff level, API security is not something you implement once and ship. It is a set of controls that must be continuously enforced, audited, and evolved as the threat landscape and the API surface both change.

**Credential lifecycle management at scale.** A single API key with no expiry, no rotation policy, and no revocation audit trail is a liability that compounds over time. The platform discipline is: every credential has a defined lifecycle. Keys are issued with a maximum validity period. Rotation is automated or at minimum surfaced in a dashboard with aging alerts. Revocation triggers an audit event and a notification to the key owner. At FAANG scale, you instrument key usage per endpoint per day, and alert on anomalies: a key that suddenly calls endpoints it has never called before is a signal worth investigating before it becomes an incident.

**Scope design as an ADR, not a naming exercise.** Scope granularity is an architectural decision with long-term consequences. Too coarse and you violate least-privilege. Too fine and you create an impossible consent UX and an unmaintainable authorization matrix. The right frame is: model scopes around the data domain and the sensitivity tier. `payments:read` is a different sensitivity tier than `orders:read`. The scope taxonomy should be reviewed by a security architect, not just the team that built the endpoint. Once scopes are in production, removing or merging them is a breaking change that requires migration.

**The CORS misconfiguration that everyone ships once.** Wildcard `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true` is an invalid combination that browsers reject, but engineers still reach for it under deadline pressure. More dangerous is the pattern of reflecting the `Origin` header without validating it, which allows any origin to make credentialed requests. The code in this chapter validates against an allowlist including wildcard subdomain matching. At platform level, this logic belongs in a shared middleware library that all services consume, not reimplemented per service. Every reimplementation is a chance for a subtle bypass.

**Rate limiting architecture at platform scale.** Per-service rate limiting is a starting point. At platform level, you need: rate limits that are consistent across all instances of a service (requires a shared counter store, typically Redis with a sliding window or token bucket algorithm), rate limits that aggregate across multiple API keys belonging to the same organization (org-level quota, not just key-level), and rate limits that are configurable per API key tier without a code deploy (stored in the credential store, read by the rate limiter middleware at request time). The `X-RateLimit-Policy` header in this chapter is an IETF draft standard (draft-ietf-httpapi-ratelimit-headers). Know it. Using non-standard headers for rate limit communication is a DX debt that accumulates.

**mTLS for service-to-service authentication.** For internal APIs where the caller is another service rather than a human-controlled client, API keys are an antipattern. The key must be stored somewhere in the calling service's config, which means it appears in environment variables, Kubernetes secrets, or config maps, all of which have weaker audit trails than a certificate authority. mTLS (mutual TLS) issues each service a certificate from a platform CA. The certificate identifies the service by name. Authorization is based on the service identity, not a shared secret. Rotation is handled by the certificate lifecycle, not by manual key rotation. SPIFFE/SPIRE is the reference implementation. Know the architecture even if your current employer has not adopted it.

**Audit logging as a first-class API concern.** Every authentication event, every authorization failure, and every sensitive data access must produce a structured audit log entry. At minimum: timestamp, caller identity (key ID or service identity), requested resource, action, outcome (allowed or denied), source IP, and request ID for correlation. Audit logs feed SIEM systems. They are the forensic record when an incident is investigated. An API that does not produce them is not production-grade regardless of how clean its handler code is. At FAANG scale, audit log volume is significant. Route them through a separate write path from application logs to prevent application log pressure from affecting audit durability.

**Bar-raiser signals at L6+.** The interviewer is looking for evidence that you think about security as a system property, not a feature. Strong signals: you propose a credential lifecycle policy before you discuss implementation, you distinguish authentication from authorization and describe where each is enforced, you explain the tradeoff between JWT statelessness and revocation ability with a concrete recommendation for the use case being discussed, you name SPIFFE or mTLS when asked about service-to-service security, and you describe what observability you would build around the auth layer to detect abuse. Weak signals: describing JWT as "stateless and therefore better," treating CORS as a browser problem rather than a security control, or not mentioning revocation when asked about API key management.

---
