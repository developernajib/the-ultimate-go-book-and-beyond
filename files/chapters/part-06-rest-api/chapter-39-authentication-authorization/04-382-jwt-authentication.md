## 39.2 JWT Authentication

### JWT Structure and Creation

This type definition captures the data and dependencies required by the component. Grouping related fields into a struct and constructing it through a constructor function enforces invariants and makes the zero value safe or explicitly invalid.

```go
// ... imports omitted for brevity (crypto/rsa, errors, time, github.com/golang-jwt/jwt/v5)

// Claims extends standard JWT claims
type Claims struct {
    jwt.RegisteredClaims
    UserID   string   `json:"user_id"`
    Email    string   `json:"email"`
    Roles    []string `json:"roles"`
    TenantID string   `json:"tenant_id,omitempty"`
}

// TokenConfig holds JWT configuration
type TokenConfig struct {
    Secret          []byte
    PrivateKey      *rsa.PrivateKey
    PublicKey       *rsa.PublicKey
    Issuer          string
    Audience        []string
    AccessTokenTTL  time.Duration
    RefreshTokenTTL time.Duration
}

// TokenService handles JWT operations
type TokenService struct {
    config TokenConfig
}

func NewTokenService(config TokenConfig) *TokenService {
    return &TokenService{config: config}
}

// GenerateAccessToken creates a new access token
func (s *TokenService) GenerateAccessToken(user *User) (string, error) {
    now := time.Now()

    claims := Claims{
        RegisteredClaims: jwt.RegisteredClaims{
            Issuer:    s.config.Issuer,
            Subject:   user.ID,
            Audience:  s.config.Audience,
            ExpiresAt: jwt.NewNumericDate(now.Add(s.config.AccessTokenTTL)),
            IssuedAt:  jwt.NewNumericDate(now),
            NotBefore: jwt.NewNumericDate(now),
            ID:        generateTokenID(),
        },
        UserID:   user.ID,
        Email:    user.Email,
        Roles:    user.Roles,
        TenantID: user.TenantID,
    }

    var token *jwt.Token
    if s.config.PrivateKey != nil {
        token = jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
        return token.SignedString(s.config.PrivateKey)
    }

    token = jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    return token.SignedString(s.config.Secret)
}

// GenerateRefreshToken creates a new refresh token
func (s *TokenService) GenerateRefreshToken(user *User) (string, error) {
    now := time.Now()

    claims := jwt.RegisteredClaims{
        Issuer:    s.config.Issuer,
        Subject:   user.ID,
        Audience:  s.config.Audience,
        ExpiresAt: jwt.NewNumericDate(now.Add(s.config.RefreshTokenTTL)),
        IssuedAt:  jwt.NewNumericDate(now),
        ID:        generateTokenID(),
    }

    var token *jwt.Token
    if s.config.PrivateKey != nil {
        token = jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
        return token.SignedString(s.config.PrivateKey)
    }

    token = jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    return token.SignedString(s.config.Secret)
}

// TokenPair contains access and refresh tokens
type TokenPair struct {
    AccessToken  string `json:"access_token"`
    RefreshToken string `json:"refresh_token"`
    TokenType    string `json:"token_type"`
    ExpiresIn    int64  `json:"expires_in"`
}

// GenerateTokenPair creates both access and refresh tokens
func (s *TokenService) GenerateTokenPair(user *User) (*TokenPair, error) {
    accessToken, err := s.GenerateAccessToken(user)
    if err != nil {
        return nil, err
    }

    refreshToken, err := s.GenerateRefreshToken(user)
    if err != nil {
        return nil, err
    }

    return &TokenPair{
        AccessToken:  accessToken,
        RefreshToken: refreshToken,
        TokenType:    "Bearer",
        ExpiresIn:    int64(s.config.AccessTokenTTL.Seconds()),
    }, nil
}
```

### JWT Validation

The validator explicitly restricts accepted signing algorithms with `WithValidMethods` to prevent algorithm-confusion attacks where a token signed with `none` or a weak algorithm bypasses verification. Sentinel errors like `ErrTokenExpired` and `ErrTokenInvalid` let callers return precise `401` or `403` responses without parsing error strings.

```go
// ... imports omitted for brevity (errors, fmt, github.com/golang-jwt/jwt/v5)

var (
    ErrTokenExpired   = errors.New("token has expired")
    ErrTokenInvalid   = errors.New("token is invalid")
    ErrTokenMalformed = errors.New("token is malformed")
)

// ValidateToken validates and parses a JWT token
func (s *TokenService) ValidateToken(tokenString string) (*Claims, error) {
    keyFunc := func(token *jwt.Token) (any, error) {
        // Validate signing method
        if s.config.PublicKey != nil {
            if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
                return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
            }
            return s.config.PublicKey, nil
        }

        if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
        }
        return s.config.Secret, nil
    }

    token, err := jwt.ParseWithClaims(tokenString, &Claims{}, keyFunc,
        jwt.WithValidMethods([]string{"RS256", "HS256"}),
        jwt.WithIssuer(s.config.Issuer),
        jwt.WithAudience(s.config.Audience[0]),
    )

    if err != nil {
        if errors.Is(err, jwt.ErrTokenExpired) {
            return nil, ErrTokenExpired
        }
        if errors.Is(err, jwt.ErrTokenMalformed) {
            return nil, ErrTokenMalformed
        }
        return nil, fmt.Errorf("%w: %v", ErrTokenInvalid, err)
    }

    claims, ok := token.Claims.(*Claims)
    if !ok || !token.Valid {
        return nil, ErrTokenInvalid
    }

    return claims, nil
}

// ValidateRefreshToken validates a refresh token
func (s *TokenService) ValidateRefreshToken(tokenString string) (string, error) {
    keyFunc := func(token *jwt.Token) (any, error) {
        if s.config.PublicKey != nil {
            return s.config.PublicKey, nil
        }
        return s.config.Secret, nil
    }

    token, err := jwt.ParseWithClaims(tokenString, &jwt.RegisteredClaims{}, keyFunc)
    if err != nil {
        return "", fmt.Errorf("invalid refresh token: %w", err)
    }

    claims, ok := token.Claims.(*jwt.RegisteredClaims)
    if !ok || !token.Valid {
        return "", ErrTokenInvalid
    }

    return claims.Subject, nil
}
```

### JWT Middleware

Interceptors and middleware provide a clean mechanism for applying cross-cutting concerns (logging, authentication, metrics) across all operations without modifying individual handlers. They receive the full request context and can short-circuit the chain by returning an error.

```go
// ... imports omitted for brevity (context, errors, net/http, strings)

type contextKey string
const UserContextKey contextKey = "user"

// JWTAuth middleware validates JWT tokens
func JWTAuth(tokenService *TokenService) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract token
            auth := r.Header.Get("Authorization")
            if auth == "" {
                http.Error(w, "Authorization required", http.StatusUnauthorized)
                return
            }

            if !strings.HasPrefix(auth, "Bearer ") {
                http.Error(w, "Invalid authorization format", http.StatusUnauthorized)
                return
            }

            tokenString := auth[7:]

            // Validate token
            claims, err := tokenService.ValidateToken(tokenString)
            if err != nil {
                switch {
                case errors.Is(err, ErrTokenExpired):
                    http.Error(w, "Token expired", http.StatusUnauthorized)
                default:
                    http.Error(w, "Invalid token", http.StatusUnauthorized)
                }
                return
            }

            // Create user from claims
            user := &User{
                ID:       claims.UserID,
                Email:    claims.Email,
                Roles:    claims.Roles,
                TenantID: claims.TenantID,
            }

            // Add user to context
            ctx := context.WithValue(r.Context(), UserContextKey, user)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// GetUser extracts user from context
func GetUser(ctx context.Context) *User {
    user, _ := ctx.Value(UserContextKey).(*User)
    return user
}

// OptionalJWTAuth allows unauthenticated requests
func OptionalJWTAuth(tokenService *TokenService) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            auth := r.Header.Get("Authorization")
            if auth != "" && strings.HasPrefix(auth, "Bearer ") {
                tokenString := auth[7:]
                if claims, err := tokenService.ValidateToken(tokenString); err == nil {
                    user := &User{
                        ID:       claims.UserID,
                        Email:    claims.Email,
                        Roles:    claims.Roles,
                        TenantID: claims.TenantID,
                    }
                    ctx := context.WithValue(r.Context(), UserContextKey, user)
                    r = r.WithContext(ctx)
                }
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

### Junior → FAANG: how a JWT actually works, byte by byte

A JWT is three base64url-encoded JSON blobs joined by dots. Header, payload, signature. Paste any token from your staging environment into jwt.io and look at it. The header tells the verifier which algorithm to use (`alg`) and which key to look up (`kid`). The payload contains the claims. The signature is computed over `base64url(header) + "." + base64url(payload)` using either an HMAC with a shared secret (HS256) or a digital signature with a private key (RS256, ES256, EdDSA). The verifier recomputes the signature with the matching key and checks for equality in constant time.

Three standard claims are load-bearing and you will be asked about them in interviews. `exp` is the expiration timestamp as seconds since the Unix epoch. A verifier that does not check `exp` accepts tokens forever, which is why every JWT library checks it by default and why disabling that check is almost always a bug. `iss` identifies the issuer and prevents a token from one system being replayed against another. `aud` identifies the intended audience and prevents an access token for service A being replayed against service B. If you only remember three claims, remember these three.

Symmetric versus asymmetric signing is a foundational choice. HS256 uses a shared secret, which means every service that verifies tokens must hold the secret, which means a compromise of any verifier lets an attacker mint valid tokens. RS256 and ES256 use a private key held only by the issuer and a public key distributed to verifiers via a JWKS endpoint. Verifiers cannot mint tokens. Asymmetric signing is the correct choice for any system with more than one verifier or any system that distributes tokens across a trust boundary. HS256 is acceptable only inside a single service with a single secret.

As a worked exercise, generate an RSA key pair, sign a token with `GenerateAccessToken`, print the three segments separately, and decode the header and payload with `base64.RawURLEncoding`. Then corrupt one byte of the payload and watch `ValidateToken` reject it. This is the mental model you need before debugging a real JWT issue.

### Senior @ FAANG: the anti-patterns in the code above and how to harden it

The code in this file is competent but a staff engineer signing off on it has a list of changes. Every item below is a real production lesson and most of them are CVEs waiting to happen.

Algorithm allow-list is correct but fragile. `WithValidMethods([]string{"RS256", "HS256"})` admits both asymmetric and symmetric. The key confusion attack works like this: a token with `alg: HS256` is presented to a verifier configured for RS256. If the verifier's `keyFunc` returns an RSA public key and the HMAC code path uses it as a shared secret, the attacker (who has the public key because it is public) signs arbitrary tokens. `golang-jwt/jwt/v5` mitigates this by type-asserting the method inside `keyFunc`, which the code above does correctly, but the list should contain one algorithm per deployment. If you issue RS256, accept only RS256. If you plan to migrate to ES256, issue both, accept both during the window, then drop RS256. Do not leave HS256 in the list because "it might be useful later".

No `kid` handling means no key rotation. The header has a `kid` field for a reason. When a signing key is compromised or reaches its rotation window, you need to issue new tokens with a new key while still verifying tokens signed with the old key until they expire. The production `keyFunc` looks up the key by `token.Header["kid"]` from a JWKS cache that is refreshed periodically from the issuer's `/.well-known/jwks.json` endpoint. Without `kid`, you either cannot rotate or you rotate by rejecting every outstanding token, which is a user-visible outage. Stripe, Google, and Auth0 all publish JWKS and rotate keys every 30 to 90 days. Do the same.

No clock skew tolerance. `jwt.ParseWithClaims` treats `exp` strictly against `time.Now()`. In a multi-region deployment with even well-synced NTP, a client and server can differ by a few seconds, and a token issued by region A that lands at region B at the moment of expiration will be rejected. Configure a small leeway (30 to 60 seconds) via `jwt.WithLeeway` and document the trade-off. Larger leeway widens the window for replay of a stolen just-expired token, so this is a security versus reliability dial, not a free knob.

No denylist. The `ValidateToken` function is purely local, which is the selling point of JWT, but it also means that a compromised or logged-out token remains valid until `exp`. For any application that supports logout or admin-triggered revocation, wrap the validator with a Redis check on `jti`. On logout, write `jti` to Redis with a TTL equal to the remaining token lifetime. On validation, reject if `jti` is present. This preserves the stateless scaling profile for the common case (cache hit rate is high, lookups are sub-millisecond) while providing revocation for the uncommon case.

Refresh tokens do not rotate. `GenerateRefreshToken` issues a long-lived token that the client presents repeatedly. If it is stolen, the attacker retains access for the full refresh TTL. The modern pattern (Auth0, Okta) is refresh token rotation with reuse detection. Every refresh call issues a new refresh token and invalidates the old one. If the old one is ever presented again, the entire token family is revoked and the user is forced to re-authenticate. This requires server-side state (a refresh token store keyed by `jti` with a lineage pointer), which is the same state you already need for revocation, so the cost is modest and the security gain is significant.

Refresh tokens are JWTs. They should not be. Refresh tokens live on the server side, need fast revocation, and do not benefit from stateless verification because the server already has to look them up to check reuse. Make them opaque random bytes (32 to 64 bytes from `crypto/rand`, base64url encoded), stored hashed in the database, and validated by lookup. This is what every mature OAuth server does.

Claims bloat. The `Claims` struct embeds `Roles []string` and `Email`. Email is PII and putting it in a bearer token that gets logged by every intermediate proxy is a regulatory liability under GDPR and CCPA. Roles in the token mean you cannot revoke a role without waiting for the token to expire. The production pattern is a minimal token (`sub`, `iss`, `aud`, `exp`, `jti`, `tenant_id`) plus a fast resolver that fetches the current role and email from a cache at request time. This keeps tokens small, keeps PII out of headers, and makes permission changes take effect immediately.

No DPoP or mTLS binding. A bearer token stolen from a client can be replayed from any origin. DPoP (RFC 9449) binds the token to a client-held EC key pair by requiring a `DPoP` header on every request whose body is a signed proof over the HTTP method, URL, and a nonce, tied to the public key whose thumbprint is in the token's `cnf.jkt` claim. A stolen token without the matching private key is useless. For service-to-service traffic, mTLS with certificate-bound access tokens (RFC 8705) achieves the same result. Any high-value API in 2026 should ship with one of these, and the code above has neither.

`OptionalJWTAuth` silently discards validation errors, which is appropriate for public endpoints that give authenticated users extra data, but it hides a class of bugs where a token is subtly malformed and the client thinks it is authenticated. Log validation failures at INFO with the reason code so that operators can see when a client is misbehaving, and consider returning a `WWW-Authenticate` header with an error code per RFC 6750 so clients can self-diagnose.

Error handling returns plain text. Production auth responses are JSON with a stable error code, plus the RFC 6750 `WWW-Authenticate: Bearer error="invalid_token", error_description="..."` header. This is what SDKs parse to decide whether to refresh and retry versus prompt the user to log in again. Text responses break every client auto-retry path.

HTTP status discipline. Expired tokens correctly return 401. Malformed tokens also return 401 here, which is debatable. Some teams use 400 for malformed to distinguish client bugs from expired tokens. The consensus is 401 for anything where re-authenticating would help, 400 for a request the server cannot parse at all. Pick one and document it, because client retry logic depends on it.

---
