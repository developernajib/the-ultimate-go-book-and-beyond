## 112.4 JWT Best Practices

### Secure JWT Creation and Validation

The JWT utility generates RS256 tokens (RSA + SHA-256) signed with a 2048-bit private key rather than HS256, because RS256 allows resource servers to verify tokens using only the public key without holding the signing secret, enabling a zero-trust verification model where no service except the issuer can mint new tokens. The verifier uses `jwt.WithValidMethods([]string{"RS256"})` to reject tokens claiming `alg: none` or any symmetric algorithm, closing the algorithm-confusion vulnerability present in many JWT libraries that accept whatever algorithm the token header declares. The `jti` (JWT ID) claim combined with a short expiry and a token revocation list enables the issuer to invalidate specific tokens before expiry for logout or suspicious-activity responses.

```go
package jwtutil

import (
    "crypto/rand"
    "crypto/rsa"
    "errors"
    "fmt"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

var (
    ErrInvalidToken = errors.New("invalid token")
    ErrExpiredToken = errors.New("token expired")
    ErrInvalidIssuer = errors.New("invalid issuer")
)

type CustomClaims struct {
    jwt.RegisteredClaims
    UserID      string   `json:"user_id"`
    Email       string   `json:"email"`
    Roles       []string `json:"roles"`
    Permissions []string `json:"permissions"`
    TenantID    string   `json:"tenant_id,omitempty"`
}

type JWTManager struct {
    privateKey *rsa.PrivateKey
    publicKey  *rsa.PublicKey
    issuer     string
}

func NewJWTManager(privateKey *rsa.PrivateKey, publicKey *rsa.PublicKey, issuer string) *JWTManager {
    return &JWTManager{
        privateKey: privateKey,
        publicKey:  publicKey,
        issuer:     issuer,
    }
}

// CreateToken creates a JWT with best practices
func (m *JWTManager) CreateToken(userID, email string, roles, permissions []string, duration time.Duration) (string, error) {
    claims := CustomClaims{
        RegisteredClaims: jwt.RegisteredClaims{
            Subject:   userID,
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(duration)),
            IssuedAt:  jwt.NewNumericDate(time.Now()),
            NotBefore: jwt.NewNumericDate(time.Now()),
            Issuer:    m.issuer,
            ID:        generateJTI(), // Unique token ID for revocation
        },
        UserID:      userID,
        Email:       email,
        Roles:       roles,
        Permissions: permissions,
    }

    token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
    return token.SignedString(m.privateKey)
}

// ValidateToken validates JWT with all security checks
func (m *JWTManager) ValidateToken(tokenString string) (*CustomClaims, error) {
    token, err := jwt.ParseWithClaims(tokenString, &CustomClaims{}, func(token *jwt.Token) (any, error) {
        // Defense in depth: the parser already enforces WithValidMethods
        if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
            return nil, ErrInvalidToken
        }
        return m.publicKey, nil
    }, jwt.WithValidMethods([]string{"RS256"}), jwt.WithExpirationRequired())

    if err != nil {
        return nil, err
    }

    claims, ok := token.Claims.(*CustomClaims)
    if !ok || !token.Valid {
        return nil, ErrInvalidToken
    }

    // Verify issuer
    if claims.Issuer != m.issuer {
        return nil, ErrInvalidIssuer
    }

    // Check expiration (jwt library does this, but explicit check is good)
    if claims.ExpiresAt == nil || time.Now().After(claims.ExpiresAt.Time) {
        return nil, ErrExpiredToken
    }

    // Check not-before
    if claims.NotBefore != nil && time.Now().Before(claims.NotBefore.Time) {
        return nil, ErrInvalidToken
    }

    return claims, nil
}

func generateJTI() string {
    // Generate unique ID for token tracking/revocation
    // IMPORTANT: Use crypto/rand, not time-based values which are predictable
    b := make([]byte, 16)
    _, _ = rand.Read(b) // crypto/rand
    return fmt.Sprintf("%x", b)
}
```

**JWT Security Checklist**:
1. ✅ Use RS256 (RSA) or ES256 (ECDSA), never HS256 with shared secrets in distributed systems
2. ✅ Always validate `alg` header to prevent algorithm confusion attacks
3. ✅ Set short expiration times (15 minutes for access tokens)
4. ✅ Include `jti` (JWT ID) for token revocation tracking
5. ✅ Validate `iss` (issuer), `aud` (audience), `exp`, `nbf` claims
6. ✅ Don't store sensitive data in JWT payload (it's base64, not encrypted)
7. ✅ Implement token rotation for refresh tokens

### Deep Dive: The Stateless Fallacy of JWTs for User Sessions

In modern application engineering, teams frequently default to JWTs for user sessions under the assumption of "stateless scalability." However, as detailed in production retrospectives (such as [I Switched From JWTs to Session Cookies and Everyone Yelled at Me](https://medium.com/@author/i-switched-from-jwts-to-session-cookies-and-everyone-yelled-at-me) and [If You Store JWT Tokens Like This Stop Now](https://medium.com/@author/if-you-store-jwt-tokens-like-this-stop-now)), using JWTs for interactive browser sessions frequently introduces architectural contradictions:

```
Interactive Session Requirements:
1. Immediate Revocation (user clicks logout or changes password)
2. "Log out of all devices" (revoke active tokens across 5 sessions)
3. Role/Permission Demotion (admin downgrades user rights immediately)
```

To satisfy these requirements with JWTs, backend architectures maintain a Redis blocklist of revoked `jti` tokens, which must be queried on *every single incoming request*. 

**The Paradox**: If an API gateway or backend must query Redis on every request to verify whether a `jti` has been revoked, the architecture is **no longer stateless**. The system incurs the latency of a distributed database lookup on every request, while still bearing all the complexity of JWTs: RSA cryptographic signature validation overhead, oversized HTTP headers (1-2 KB per request), complex refresh token rotation loops, and exposure to token exfiltration if stored in `localStorage`.

#### Cryptographic Opaque Session Cookies in Go

For browser-facing web applications, an opaque, cryptographically random session token stored in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie provides superior security guarantees with simpler operations:

```go
package session

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var (
	ErrInvalidSession = errors.New("invalid or tampered session token")
	ErrExpiredSession = errors.New("session expired")
)

type SessionData struct {
	UserID    string    `json:"user_id"`
	Email     string    `json:"email"`
	Role      string    `json:"role"`
	IPAddress string    `json:"ip"`
	CreatedAt time.Time `json:"created_at"`
}

type SessionManager struct {
	rdb       *redis.Client
	hmacKey   []byte
	cookieTTL time.Duration
}

func NewSessionManager(rdb *redis.Client, secretKey []byte, ttl time.Duration) *SessionManager {
	return &SessionManager{
		rdb:       rdb,
		hmacKey:   secretKey,
		cookieTTL: ttl,
	}
}

// CreateSession generates a signed 256-bit opaque token and stores session state in Redis
func (sm *SessionManager) CreateSession(ctx context.Context, w http.ResponseWriter, user SessionData) (string, error) {
	// Generate 32 bytes of cryptographically secure randomness
	rawBytes := make([]byte, 32)
	if _, err := rand.Read(rawBytes); err != nil {
		return "", fmt.Errorf("crypto rand failed: %w", err)
	}
	sessionID := base64.RawURLEncoding.EncodeToString(rawBytes)

	// Sign the token using HMAC-SHA256 to prevent client forgery
	mac := hmac.New(sha256.New, sm.hmacKey)
	mac.Write([]byte(sessionID))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	signedToken := fmt.Sprintf("%s.%s", sessionID, signature)

	// Persist session payload into Redis
	payload, err := json.Marshal(user)
	if err != nil {
		return "", err
	}

	pipe := sm.rdb.TxPipeline()
	// session:<id> stores session data with TTL
	pipe.Set(ctx, fmt.Sprintf("session:%s", sessionID), payload, sm.cookieTTL)
	// user_sessions:<uid> tracks all active sessions for multi-device logout
	pipe.SAdd(ctx, fmt.Sprintf("user_sessions:%s", user.UserID), sessionID)
	if _, err := pipe.Exec(ctx); err != nil {
		return "", fmt.Errorf("redis set session error: %w", err)
	}

	// Set hardened cookie: HttpOnly prevents JavaScript XSS exfiltration
	http.SetCookie(w, &http.Cookie{
		Name:     "session_id",
		Value:    signedToken,
		Path:     "/",
		MaxAge:   int(sm.cookieTTL.Seconds()),
		HttpOnly: true,
		Secure:   true, // Require HTTPS
		SameSite: http.SameSiteLaxMode,
	})

	return sessionID, nil
}

// ValidateSession verifies token signature and fetches active session data
func (sm *SessionManager) ValidateSession(ctx context.Context, r *http.Request) (*SessionData, error) {
	cookie, err := r.Cookie("session_id")
	if err != nil {
		return nil, ErrInvalidSession
	}

	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 {
		return nil, ErrInvalidSession
	}
	sessionID, clientSig := parts[0], parts[1]

	// Constant-time HMAC validation
	mac := hmac.New(sha256.New, sm.hmacKey)
	mac.Write([]byte(sessionID))
	expectedSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(clientSig), []byte(expectedSig)) {
		return nil, ErrInvalidSession
	}

	// Fetch live session from Redis
	val, err := sm.rdb.Get(ctx, fmt.Sprintf("session:%s", sessionID)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, ErrExpiredSession
	} else if err != nil {
		return nil, err
	}

	var data SessionData
	if err := json.Unmarshal([]byte(val), &data); err != nil {
		return nil, err
	}

	return &data, nil
}

// RevokeAllUserSessions enables instantaneous "log out of all devices"
func (sm *SessionManager) RevokeAllUserSessions(ctx context.Context, userID string) error {
	key := fmt.Sprintf("user_sessions:%s", userID)
	sessionIDs, err := sm.rdb.SMembers(ctx, key).Result()
	if err != nil {
		return err
	}

	pipe := sm.rdb.TxPipeline()
	for _, sid := range sessionIDs {
		pipe.Del(ctx, fmt.Sprintf("session:%s", sid))
	}
	pipe.Del(ctx, key)
	_, err = pipe.Exec(ctx)
	return err
}
```

#### Decision Matrix: JWT vs. Cryptographic Session Cookies

| Dimension | JSON Web Tokens (JWT) | Opaque Session Cookies |
|---|---|---|
| **Primary Use Case** | Machine-to-machine APIs, Microservice mesh, Mobile clients, OIDC federation | Browser-facing web applications, Monoliths, Microservices behind API Gateway |
| **Revocation Model** | Difficult; requires distributed `jti` blocklist or waiting for `exp` | Instantaneous $O(1)$ (`DEL session:<id>`) |
| **XSS Vulnerability** | High if stored in `localStorage` / `sessionStorage` | Immune when stored in `HttpOnly` cookie |
| **CSRF Vulnerability** | None if sent via `Authorization: Bearer` header | Requires `SameSite=Lax` or anti-CSRF token |
| **Header Bandwidth** | 800 bytes - 2 KB per HTTP request | ~44 bytes per HTTP request |
| **State Location** | Client-side (self-contained cryptographic claims) | Centralized session store (Redis / DB) |
| **Verification Overhead** | High (RSA/ECDSA asymmetric signature calculation) | Negligible (In-memory HMAC comparison + fast Redis read) |

### Junior → FAANG: JWT Best Practices as Non-Negotiable Defaults

JWT security mistakes are among the most commonly exploited auth vulnerabilities. The best practices in this section are not optional: each one addresses a specific, exploitable vulnerability.

**Gap to close:** The most critical best practice is verifying the `alg` header. The JWT specification allows the `none` algorithm (no signature). An attacker can forge a JWT by setting `alg: none` and removing the signature. Always specify the expected algorithm explicitly in your JWT library configuration. Never allow `none`. Never allow `alg` switching (the key for RS256 is different from HS256, an attacker who can switch algorithms can forge tokens using the public key as the HMAC secret).

**First-job habit:** When using any JWT library, read its documentation for the specific configuration that prevents `alg: none` and `alg` switching attacks. Most modern Go JWT libraries (`golang-jwt/jwt`, `lestrrat-go/jwx`) have explicit options to specify allowed algorithms. Use them.

**Interview framing:** When asked about JWT security, mention: algorithm specification (never `none`, specify explicitly), expiry validation (`exp` claim is required and checked), audience validation (`aud` claim matches your service), and signature verification (using the correct public key from JWKS, not trusting client-provided keys).

### Senior @ FAANG: JWT Infrastructure and Operational Concerns

At senior level, JWT is infrastructure. The decisions about signing key management, token lifetime, claims schema, and revocation affect the security and operability of your entire authentication system.

**Signing key rotation without downtime:** JWT signing key rotation requires: generating a new key pair, publishing the new public key in the JWKS endpoint alongside the old one, issuing new tokens with the new key (using the new `kid`), waiting for all tokens signed with the old key to expire (approximately the access token lifetime), removing the old key from the JWKS endpoint. This rotation process takes at minimum one access token lifetime (e.g., 15 minutes). Services that cache the JWKS for longer than the access token lifetime need to be configured to refresh the JWKS when they encounter an unknown `kid`.

**Token revocation:** JWTs are stateless by design: once issued, they are valid until expiry. This means a revoked session token or a token from a compromised account continues to work until it expires. For high-security applications, implement token revocation: maintain a deny list of revoked `jti` (JWT ID) values, checked on every request. The deny list is bounded in size by the access token lifetime (entries older than the max token lifetime can be purged). This adds per-request latency (deny list lookup) but provides immediate revocation.

**Claims as a policy decision:** Which claims you put in a JWT is a policy decision with security implications. Claims are client-readable (the JWT payload is base64-encoded, not encrypted). Do not put sensitive information in JWT claims that should not be visible to the bearer. Roles and permissions can safely be claims if they are not sensitive in themselves. User PII (email, phone, address) should be fetched from a service on demand, not embedded in a long-lived token where they can become stale.

---
