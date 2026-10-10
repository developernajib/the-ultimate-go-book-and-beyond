## 112.2 OAuth 2.0 Implementation

OAuth 2.0 is the industry standard for delegated authorization. It allows third-party applications to access user resources without exposing credentials.

### OAuth 2.0 Authorization Code Flow

The authorization code flow diagram shows the six-step protocol: the client sends the user to the authorization server with a PKCE code challenge, the user authenticates and consents, the server redirects back with an authorization code, and the client exchanges the code plus verifier for tokens. PKCE (Proof Key for Code Exchange) protects against authorization code interception attacks by binding the code to a secret the client generates locally, the server can verify the binding without storing a shared secret. The `state` parameter is a CSRF token that the client must validate on the redirect callback to prevent cross-site request forgery attacks against the OAuth flow.

```
┌────────┐                                           ┌───────────┐
│        │─(1) Authorization Request───────────────>│            │
│        │                                           │ Resource  │
│        │<─(2) Authorization Grant─────────────────│  Owner     │
│        │                                           │  (User)   │
│ Client │                                           └───────────┘
│        │                                           ┌───────────┐
│        │─(3) Authorization Grant──────────────────>│           │
│        │                                           │   Auth    │
│        │<─(4) Access Token────────────────────────│  Server    │
│        │                                           └───────────┘
│        │                                           ┌───────────┐
│        │─(5) Access Token─────────────────────────>│           │
│        │                                           │ Resource  │
│        │<─(6) Protected Resource──────────────────│  Server    │
└────────┘                                           └───────────┘
```

### Complete OAuth 2.0 Server Implementation

The Go OAuth 2.0 server implementation handles the `/authorize` and `/token` endpoints, validating the PKCE code challenge on the authorization request and verifying the code verifier against the stored challenge during token exchange. Authorization codes are single-use and short-lived (the example uses the 10-minute maximum that RFC 6749 recommends), and access tokens are issued as signed JWTs so resource servers can validate them without calling back to the authorization server. The example keeps codes and tokens in in-memory maps to keep the flow visible. In production, store refresh tokens in a persistent store keyed by the token's hash so the original value is never retained in the database.

```go
// cmd/oauth-server/main.go
package main

import (
    "crypto/rand"
    "crypto/sha256"
    "crypto/subtle"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "net/http"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

// OAuth2Server implements OAuth 2.0 with Authorization Code + PKCE
type OAuth2Server struct {
    clients       map[string]*Client
    authCodes     map[string]*AuthorizationCode
    accessTokens  map[string]*AccessToken
    refreshTokens map[string]*RefreshToken
    jwtSecret     []byte
}

type Client struct {
    ID           string
    Secret       string
    RedirectURIs []string
    Name         string
    Trusted      bool // For first-party apps
}

type AuthorizationCode struct {
    Code              string
    ClientID          string
    UserID            string
    RedirectURI       string
    Scope             string
    ExpiresAt         time.Time
    CodeChallenge     string // PKCE
    CodeChallengeMethod string // "S256" or "plain"
}

type AccessToken struct {
    Token     string
    UserID    string
    ClientID  string
    Scope     string
    ExpiresAt time.Time
}

type RefreshToken struct {
    Token     string
    UserID    string
    ClientID  string
    Scope     string
    ExpiresAt time.Time
}

func NewOAuth2Server(jwtSecret []byte) *OAuth2Server {
    return &OAuth2Server{
        clients:       make(map[string]*Client),
        authCodes:     make(map[string]*AuthorizationCode),
        accessTokens:  make(map[string]*AccessToken),
        refreshTokens: make(map[string]*RefreshToken),
        jwtSecret:     jwtSecret,
    }
}

// Authorization endpoint - Step 1 & 2
func (s *OAuth2Server) HandleAuthorize(w http.ResponseWriter, r *http.Request) {
    clientID := r.URL.Query().Get("client_id")
    redirectURI := r.URL.Query().Get("redirect_uri")
    scope := r.URL.Query().Get("scope")
    state := r.URL.Query().Get("state")
    codeChallenge := r.URL.Query().Get("code_challenge")
    codeChallengeMethod := r.URL.Query().Get("code_challenge_method")

    // Validate client
    client, exists := s.clients[clientID]
    if !exists {
        http.Error(w, "invalid client", http.StatusBadRequest)
        return
    }

    // Validate redirect URI
    validRedirect := false
    for _, uri := range client.RedirectURIs {
        if uri == redirectURI {
            validRedirect = true
            break
        }
    }
    if !validRedirect {
        http.Error(w, "invalid redirect_uri", http.StatusBadRequest)
        return
    }

    // In production: Show login/consent page
    // For this example, auto-approve for demonstration
    userID := "user123" // Would come from session after login

    // Generate authorization code
    code := s.generateSecureToken()
    s.authCodes[code] = &AuthorizationCode{
        Code:                code,
        ClientID:            clientID,
        UserID:              userID,
        RedirectURI:         redirectURI,
        Scope:               scope,
        ExpiresAt:           time.Now().Add(10 * time.Minute),
        CodeChallenge:       codeChallenge,
        CodeChallengeMethod: codeChallengeMethod,
    }

    // Redirect back to client with code
    redirectURL := fmt.Sprintf("%s?code=%s&state=%s", redirectURI, code, state)
    http.Redirect(w, r, redirectURL, http.StatusFound)
}

// Token endpoint - Step 3 & 4
func (s *OAuth2Server) HandleToken(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    grantType := r.FormValue("grant_type")

    switch grantType {
    case "authorization_code":
        s.handleAuthorizationCodeGrant(w, r)
    case "refresh_token":
        s.handleRefreshTokenGrant(w, r)
    case "client_credentials":
        s.handleClientCredentialsGrant(w, r)
    default:
        http.Error(w, "unsupported_grant_type", http.StatusBadRequest)
    }
}

func (s *OAuth2Server) handleAuthorizationCodeGrant(w http.ResponseWriter, r *http.Request) {
    code := r.FormValue("code")
    clientID := r.FormValue("client_id")
    clientSecret := r.FormValue("client_secret")
    redirectURI := r.FormValue("redirect_uri")
    codeVerifier := r.FormValue("code_verifier") // PKCE

    // Validate client credentials
    client, exists := s.clients[clientID]
    if !exists || !secureCompare(client.Secret, clientSecret) {
        s.writeError(w, "invalid_client", http.StatusUnauthorized)
        return
    }

    // Validate authorization code
    authCode, exists := s.authCodes[code]
    if !exists {
        s.writeError(w, "invalid_grant", http.StatusBadRequest)
        return
    }

    // Check expiration
    if time.Now().After(authCode.ExpiresAt) {
        delete(s.authCodes, code)
        s.writeError(w, "invalid_grant", http.StatusBadRequest)
        return
    }

    // Validate PKCE if present
    if authCode.CodeChallenge != "" {
        if !s.verifyPKCE(codeVerifier, authCode.CodeChallenge, authCode.CodeChallengeMethod) {
            s.writeError(w, "invalid_grant", http.StatusBadRequest)
            return
        }
    }

    // Validate redirect URI
    if authCode.RedirectURI != redirectURI {
        s.writeError(w, "invalid_grant", http.StatusBadRequest)
        return
    }

    // Authorization code is one-time use
    delete(s.authCodes, code)

    // Generate tokens
    accessToken := s.generateJWT(authCode.UserID, authCode.ClientID, authCode.Scope, 1*time.Hour)
    refreshToken := s.generateSecureToken()

    s.accessTokens[accessToken] = &AccessToken{
        Token:     accessToken,
        UserID:    authCode.UserID,
        ClientID:  authCode.ClientID,
        Scope:     authCode.Scope,
        ExpiresAt: time.Now().Add(1 * time.Hour),
    }

    s.refreshTokens[refreshToken] = &RefreshToken{
        Token:     refreshToken,
        UserID:    authCode.UserID,
        ClientID:  authCode.ClientID,
        Scope:     authCode.Scope,
        ExpiresAt: time.Now().Add(30 * 24 * time.Hour), // 30 days
    }

    response := map[string]any{
        "access_token":  accessToken,
        "token_type":    "Bearer",
        "expires_in":    3600,
        "refresh_token": refreshToken,
        "scope":         authCode.Scope,
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}

func (s *OAuth2Server) handleRefreshTokenGrant(w http.ResponseWriter, r *http.Request) {
    refreshTokenString := r.FormValue("refresh_token")
    clientID := r.FormValue("client_id")
    clientSecret := r.FormValue("client_secret")

    // Validate client
    client, exists := s.clients[clientID]
    if !exists || !secureCompare(client.Secret, clientSecret) {
        s.writeError(w, "invalid_client", http.StatusUnauthorized)
        return
    }

    // Validate refresh token
    refreshToken, exists := s.refreshTokens[refreshTokenString]
    if !exists || refreshToken.ClientID != clientID {
        s.writeError(w, "invalid_grant", http.StatusBadRequest)
        return
    }

    if time.Now().After(refreshToken.ExpiresAt) {
        delete(s.refreshTokens, refreshTokenString)
        s.writeError(w, "invalid_grant", http.StatusBadRequest)
        return
    }

    // Generate new access token
    accessToken := s.generateJWT(refreshToken.UserID, clientID, refreshToken.Scope, 1*time.Hour)

    // Token rotation: Generate new refresh token
    newRefreshToken := s.generateSecureToken()
    delete(s.refreshTokens, refreshTokenString) // Invalidate old token
    s.refreshTokens[newRefreshToken] = &RefreshToken{
        Token:     newRefreshToken,
        UserID:    refreshToken.UserID,
        ClientID:  clientID,
        Scope:     refreshToken.Scope,
        ExpiresAt: time.Now().Add(30 * 24 * time.Hour),
    }

    response := map[string]any{
        "access_token":  accessToken,
        "token_type":    "Bearer",
        "expires_in":    3600,
        "refresh_token": newRefreshToken,
        "scope":         refreshToken.Scope,
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}

func (s *OAuth2Server) handleClientCredentialsGrant(w http.ResponseWriter, r *http.Request) {
    clientID := r.FormValue("client_id")
    clientSecret := r.FormValue("client_secret")
    scope := r.FormValue("scope")

    // Validate client credentials
    client, exists := s.clients[clientID]
    if !exists || !secureCompare(client.Secret, clientSecret) {
        s.writeError(w, "invalid_client", http.StatusUnauthorized)
        return
    }

    // Generate access token (no refresh token for client credentials)
    accessToken := s.generateJWT(clientID, clientID, scope, 1*time.Hour)

    response := map[string]any{
        "access_token": accessToken,
        "token_type":   "Bearer",
        "expires_in":   3600,
        "scope":        scope,
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}

// PKCE verification (RFC 7636)
func (s *OAuth2Server) verifyPKCE(verifier, challenge, method string) bool {
    switch method {
    case "S256":
        hash := sha256.Sum256([]byte(verifier))
        computed := base64.RawURLEncoding.EncodeToString(hash[:])
        return secureCompare(computed, challenge)
    default:
        // Reject "plain" and anything else: OAuth 2.1 requires S256
        return false
    }
}

// secureCompare prevents timing attacks on secret comparison
func secureCompare(a, b string) bool {
    return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (s *OAuth2Server) generateJWT(userID, clientID, scope string, duration time.Duration) string {
    claims := jwt.MapClaims{
        "sub":       userID,
        "client_id": clientID,
        "scope":     scope,
        "exp":       time.Now().Add(duration).Unix(),
        "iat":       time.Now().Unix(),
    }

    token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
    tokenString, _ := token.SignedString(s.jwtSecret)
    return tokenString
}

func (s *OAuth2Server) generateSecureToken() string {
    b := make([]byte, 32)
    rand.Read(b)
    return base64.RawURLEncoding.EncodeToString(b)
}

func (s *OAuth2Server) writeError(w http.ResponseWriter, errorCode string, statusCode int) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(statusCode)
    json.NewEncoder(w).Encode(map[string]string{"error": errorCode})
}

func main() {
    server := NewOAuth2Server([]byte("super-secret-oauth-key-32bytes!"))
    mux := http.NewServeMux()
    mux.HandleFunc("/authorize", server.HandleAuthorize)
    mux.HandleFunc("/token", server.HandleToken)
    fmt.Println("OAuth 2.0 server initialized on :8080")
    _ = mux
}
```

### Junior → FAANG: OAuth 2.0 Flows and When to Use Each

OAuth 2.0 has multiple flows (grant types) for different use cases. Knowing which flow applies to which scenario is tested in FAANG backend interviews.

**Gap to close:** Know four flows: (1) Authorization Code Flow with PKCE: for web applications and mobile apps where a user authenticates in a browser. PKCE (Proof Key for Code Exchange) prevents authorization code interception. (2) Client Credentials Flow: for service-to-service authentication where no user is involved. (3) Device Authorization Flow: for devices without a browser (TV apps, CLI tools). (4) Implicit Flow: deprecated. Do not use. Know that Implicit Flow is deprecated because the access token is exposed in the browser URL.

**Common mistake:** Using Client Credentials Flow for user-facing applications. Client Credentials is for machines, not users. If a user is involved, use Authorization Code + PKCE. If the application is acting on its own behalf (batch processing, background jobs), use Client Credentials.

**Interview framing:** When asked "how would you implement user authentication for a web application?", describe Authorization Code + PKCE: the application redirects the user to the identity provider, the user authenticates, the identity provider redirects back with an authorization code, the application exchanges the code (plus the PKCE verifier) for an access token and a refresh token. The access token is short-lived (15 minutes), the refresh token is long-lived and stored securely.

### Senior @ FAANG: OAuth 2.0 Infrastructure at Scale

At senior level, OAuth 2.0 is infrastructure. The decisions you make about client registration, token lifetimes, PKCE policy, and refresh token rotation affect every user in your system.

**Token lifetime policy:** Define token lifetimes as policy: access tokens 15 minutes (limits the window if a token is stolen), refresh tokens 30 days (rotated on each use, old refresh token is revoked). Document the rationale for each lifetime in your auth architecture ADR. Longer access token lifetimes are easier to implement but increase the exposure window. Shorter lifetimes require more frequent token refreshes, adding latency.

**Refresh token rotation:** Implement refresh token rotation: each refresh token can only be used once. When it is used to get a new access token, a new refresh token is issued and the old one is revoked. If an old refresh token is presented after it has been rotated, that is a signal of theft: the original holder and the attacker both have the token. The correct response is to revoke all refresh tokens for that user's session and force re-authentication.

**Client registration governance:** In a large organization, there may be hundreds of OAuth clients (different applications, services, integrations). Define a client registration process: each client has a documented owner, a documented scope of access, and a rotation schedule for client secrets. Decommission clients that are no longer in use. An unmanaged client catalog is a security liability.

---
