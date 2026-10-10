## 112.3 OpenID Connect (OIDC)

OIDC is an identity layer on top of OAuth 2.0. It adds standardized user information.

```go
package main

import (
    "encoding/json"
    "net/http"
    "strings"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

type OAuth2Server struct {
    jwtSecret []byte
}

// OIDC adds ID Token to OAuth 2.0
type IDTokenClaims struct {
    jwt.RegisteredClaims
    Email         string `json:"email"`
    EmailVerified bool   `json:"email_verified"`
    Name          string `json:"name"`
    Picture       string `json:"picture"`
    // Standard OIDC claims
    Nonce         string `json:"nonce,omitempty"`
}

func (s *OAuth2Server) generateIDToken(userID, clientID, nonce string) string {
    claims := IDTokenClaims{
        RegisteredClaims: jwt.RegisteredClaims{
            Subject:   userID,
            Audience:  jwt.ClaimStrings{clientID},
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
            IssuedAt:  jwt.NewNumericDate(time.Now()),
            Issuer:    "https://auth.example.com",
        },
        Email:         "user@example.com",
        EmailVerified: true,
        Name:          "John Doe",
        Picture:       "https://example.com/avatar.jpg",
        Nonce:         nonce,
    }

    // IMPORTANT: production OIDC ID tokens are signed with an asymmetric
    // algorithm (RS256 or ES256) so clients can verify them via JWKS:
    //   token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
    //   tokenString, err := token.SignedString(rsaPrivateKey)
    // Using HS256 with a shared secret here only to keep the demo self-contained:
    token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    tokenString, _ := token.SignedString(s.jwtSecret)
    return tokenString
}

// UserInfo endpoint (OIDC standard)
func (s *OAuth2Server) HandleUserInfo(w http.ResponseWriter, r *http.Request) {
    // Extract access token from Authorization header
    authHeader := r.Header.Get("Authorization")
    if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
        http.Error(w, "unauthorized", http.StatusUnauthorized)
        return
    }

    tokenString := strings.TrimPrefix(authHeader, "Bearer ")

    // Validate token and get user ID.
    // WithValidMethods pins the algorithm and blocks alg-confusion attacks.
    token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
        return s.jwtSecret, nil
    }, jwt.WithValidMethods([]string{"HS256"}))

    if err != nil || !token.Valid {
        http.Error(w, "invalid_token", http.StatusUnauthorized)
        return
    }

    claims := token.Claims.(jwt.MapClaims)
    userID := claims["sub"].(string)

    // Return user info
    userInfo := map[string]any{
        "sub":            userID,
        "email":          "user@example.com",
        "email_verified": true,
        "name":           "John Doe",
        "picture":        "https://example.com/avatar.jpg",
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(userInfo)
}

func main() {
    server := &OAuth2Server{jwtSecret: []byte("super-secret-oidc-key-32bytes!!")}
    idToken := server.generateIDToken("user-123", "client-456", "nonce-789")
    _ = idToken
}
```

### Junior → FAANG: OIDC as the User Identity Standard

OIDC (OpenID Connect) is the most widely deployed user identity protocol. Every major identity provider (Google, Microsoft, Okta, Auth0) implements it. Understanding OIDC is required for any backend engineer who builds authentication.

**Gap to close:** Understand the difference between the ID token and the access token in OIDC. The ID token is a JWT that contains claims about the authenticated user (subject, name, email, issued at, expiry). It is intended for the client application to establish who the user is. The access token is for calling APIs on behalf of the user. Do not send the ID token to your API: send the access token. The API validates the access token and uses it for authorization.

**JWKS endpoint:** Know how OIDC token validation works without hardcoded secrets. The identity provider publishes its public signing keys at a JWKS (JSON Web Key Set) endpoint (e.g., `https://idp.example.com/.well-known/jwks.json`). Your service fetches this endpoint, caches the keys, and uses them to verify JWT signatures. When keys rotate, the JWKS endpoint is updated and your service fetches the new keys (triggered by a `kid` in the JWT header that does not match any cached key).

**Interview framing:** When asked "how does your Go service validate a JWT from an OIDC provider?", describe the JWKS-based validation flow: fetch the JWKS endpoint, find the key matching the JWT's `kid` header, verify the JWT signature using the key, check the `exp` and `nbf` claims, verify the `aud` claim matches your service, extract the subject and claims for authorization. This complete answer demonstrates production-level JWT validation knowledge.

### Senior @ FAANG: OIDC Discovery and Federation

At senior level, OIDC is the foundation for federated identity across multiple identity providers and multiple applications. The OIDC discovery document (`/.well-known/openid-configuration`) is the key to building provider-agnostic authentication.

**Multi-IdP federation:** Large organizations may use multiple identity providers (enterprise SSO via SAML or OIDC, social login via Google/Microsoft, partner identity via federated OIDC). The architecture that supports multiple IdPs without per-provider code is: a central auth service that federates all IdPs and issues normalized tokens to your applications. Applications only trust tokens from the central auth service, regardless of which upstream IdP authenticated the user.

**OIDC in service-to-service authentication:** Kubernetes workload identity, AWS IRSA, and GCP Workload Identity all use OIDC as their underlying protocol: the identity provider is the Kubernetes API server or the cloud provider, the token is a projected service account JWT, and the relying party verifies the JWT against the IdP's JWKS endpoint. This unification of user authentication (OIDC for humans) and workload authentication (OIDC for services) is a powerful simplification that modern cloud-native architectures exploit.

**Claims schema governance:** Define the claims schema for your organization's OIDC tokens as a policy document. Which claims are required in every token? Which are optional? What are the allowed values for enumerated claims (roles, groups)? This schema is the contract between your identity provider and your services. Changes to the schema (adding a new claim, changing a claim name) require coordination across services and a migration plan. Documenting the schema prevents ad-hoc claim additions that break downstream consumers.

---
