## 111.4 Service-to-Service Authentication

Beyond mTLS, services need to pass claims and authorization context.

### JWT-Based Service Auth

Service-to-service JWT authentication issues short-lived tokens whose `iss` and `sub` claims identify the caller. The example below uses HMAC (HS256) with a shared signing key to keep the code focused. In production prefer an asymmetric algorithm (ES256 or EdDSA) so verifiers hold only a public key, and set an `aud` claim naming the recipient service so a token minted for one service cannot be replayed against another. The verifier explicitly checks the signing method to prevent algorithm-confusion attacks where an attacker submits a token signed with `none` or substitutes a different algorithm. Keeping token lifetimes short (5-15 minutes) limits the exposure window if a token leaks, and pairing with mTLS ensures both the transport and application layers require valid identity.

```go
package main

import (
    "context"
    "fmt"
    "net/http"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

// ServiceClaims represents service-to-service JWT claims
type ServiceClaims struct {
    ServiceName string   `json:"service_name"`
    Scopes      []string `json:"scopes"`
    jwt.RegisteredClaims
}

// ServiceAuthenticator handles service authentication
type ServiceAuthenticator struct {
    signingKey []byte
}

// NewServiceAuthenticator creates an authenticator
func NewServiceAuthenticator(signingKey []byte) *ServiceAuthenticator {
    return &ServiceAuthenticator{signingKey: signingKey}
}

// GenerateToken creates a JWT for service-to-service communication
func (a *ServiceAuthenticator) GenerateToken(serviceName string, scopes []string, duration time.Duration) (string, error) {
    claims := ServiceClaims{
        ServiceName: serviceName,
        Scopes:      scopes,
        RegisteredClaims: jwt.RegisteredClaims{
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(duration)),
            IssuedAt:  jwt.NewNumericDate(time.Now()),
            NotBefore: jwt.NewNumericDate(time.Now()),
            Issuer:    "auth-service",
            Subject:   serviceName,
        },
    }

    token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    return token.SignedString(a.signingKey)
}

// ValidateToken verifies and extracts claims from a JWT
func (a *ServiceAuthenticator) ValidateToken(tokenString string) (*ServiceClaims, error) {
    token, err := jwt.ParseWithClaims(tokenString, &ServiceClaims{}, func(token *jwt.Token) (any, error) {
        // Verify signing method
        if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
            return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
        }
        return a.signingKey, nil
    })

    if err != nil {
        return nil, err
    }

    if claims, ok := token.Claims.(*ServiceClaims); ok && token.Valid {
        return claims, nil
    }

    return nil, fmt.Errorf("invalid token")
}

// AuthorizeScope checks if token has required scope
func (a *ServiceAuthenticator) AuthorizeScope(claims *ServiceClaims, requiredScope string) error {
    for _, scope := range claims.Scopes {
        if scope == requiredScope {
            return nil
        }
    }
    return fmt.Errorf("missing required scope: %s", requiredScope)
}

// ctxKey avoids collisions with other packages' context values
type ctxKey string

const claimsKey ctxKey = "claims"

// Example: HTTP middleware for service auth
func ServiceAuthMiddleware(auth *ServiceAuthenticator, requiredScopes []string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            authHeader := r.Header.Get("Authorization")
            if authHeader == "" {
                http.Error(w, "Missing Authorization header", http.StatusUnauthorized)
                return
            }

            // Extract Bearer token
            const prefix = "Bearer "
            if len(authHeader) < len(prefix) || authHeader[:len(prefix)] != prefix {
                http.Error(w, "Invalid Authorization header format", http.StatusUnauthorized)
                return
            }
            tokenString := authHeader[len(prefix):]

            // Validate token
            claims, err := auth.ValidateToken(tokenString)
            if err != nil {
                http.Error(w, "Invalid token", http.StatusUnauthorized)
                return
            }

            // Check scopes
            for _, required := range requiredScopes {
                if err := auth.AuthorizeScope(claims, required); err != nil {
                    http.Error(w, "Insufficient permissions", http.StatusForbidden)
                    return
                }
            }

            // Store claims in context
            ctx := context.WithValue(r.Context(), claimsKey, claims)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

func main() {
    auth := NewServiceAuthenticator([]byte("secret-key-32-bytes-long-jwt!!"))
    token, err := auth.GenerateToken("billing-service", []string{"read", "write"}, 15*time.Minute)
    if err != nil {
        panic(err)
    }
    claims, err := auth.ValidateToken(token)
    if err != nil {
        panic(err)
    }
    fmt.Printf("Validated service: %s, scopes: %v\n", claims.ServiceName, claims.Scopes)
}
```

### Junior → FAANG: Service-to-Service Authentication Patterns

Service-to-service authentication is one of the most commonly asked about topics in FAANG backend system design interviews. The question "how do your microservices authenticate to each other?" has a specific expected answer structure.

**Gap to close:** Know the difference between transport-layer authentication (mTLS, which authenticates the connection) and application-layer authentication (JWT service tokens or OIDC tokens, which authenticate the specific call and can carry claims about the caller's identity and the user on whose behalf the call is made). A complete service-to-service authentication solution uses both: mTLS for transport, JWT for application-layer claims propagation.

**Worked example:** Service A handles a user request and needs to call Service B. Service A: (1) establishes an mTLS connection to Service B (transport authentication), (2) includes a service account JWT as a Bearer token in the call (application authentication), (3) includes the user's context token as a separate header (user context propagation). Service B: (1) verifies the mTLS certificate (is this really Service A?), (2) verifies the service account JWT (is Service A authorized to make this call?), (3) verifies the user context token (is this user authorized for the requested action?). Three verification layers for a complete zero-trust call.

### Senior @ FAANG: Service-to-Service Auth as a Platform Service

At senior level, service-to-service authentication is a platform service that every team uses without building themselves. The platform provides the JWT minting, the token verification middleware, and the propagation mechanism.

**Token minting service:** Build a central token minting service that issues short-lived service account JWTs. Services authenticate to the minting service using their workload identity (SVID or cloud workload identity) and receive a JWT with their service identity encoded as claims. The JWT is signed by the minting service's private key, and all services have the corresponding public key (or a JWKS endpoint) for verification. This centralizes the authentication token issuance and provides a single audit point for all service-to-service authentication.

**Context propagation protocol:** Define a protocol for propagating request context (user identity, trace ID, authorization context) across service boundaries. This protocol should be standardized across all services: a specific set of headers, a specific JWT format, a specific propagation library. Services that do not follow the protocol cannot make calls into the zero-trust service mesh. This standardization is both a security control (only services that follow the protocol can call other services) and an observability benefit (trace IDs are consistently propagated across the entire call graph).

---
