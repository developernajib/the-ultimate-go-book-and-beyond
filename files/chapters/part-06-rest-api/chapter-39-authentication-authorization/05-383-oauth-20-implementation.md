## 39.3 OAuth 2.1 Implementation

> **OAuth 2.1 vs 2.0 (what changed, and why this chapter targets 2.1).** OAuth 2.1 is the consolidation draft that rolls a decade of RFC errata and BCPs into a single spec. The practical differences you must internalize:
> - **PKCE is mandatory for every client** using the authorization code flow, confidential and public alike. Not "recommended for mobile" as in 2.0.
> - **The implicit flow (`response_type=token`) is removed.** It exposed access tokens in browser URL fragments and history. Authorization code + PKCE replaces every legitimate use.
> - **The Resource Owner Password Credentials (ROPC) grant is removed.** It required apps to handle user passwords directly, defeating the point of OAuth.
> - **Redirect URIs must be matched by exact string comparison.** No prefix matching, no wildcards: those caused real-world account takeovers.
> - **Refresh tokens for public clients must be sender-constrained or one-time-use (rotation).** Reuse detection is how you catch stolen tokens.
> - **Bearer tokens must not appear in query strings.** Use the `Authorization: Bearer` header only.
>
> The server below implements authorization code + PKCE as the only flow, which is all you should ever expose in new systems.

### OAuth 2.1 Server

The OAuth server issues short-lived authorization codes and exchanges them for access tokens. For confidential clients the client secret prevents code interception. For public clients (SPAs, mobile, CLIs) PKCE is the only defense and is required. Redirect URIs are validated by **exact string match** against the pre-registered list so attackers cannot redirect tokens to a malicious endpoint after phishing an authorization code.

```go
// ... imports omitted for brevity (crypto/rand, encoding/base64, encoding/json, net/http, strings, time)

// Client represents an OAuth client
type Client struct {
    ID           string   `json:"client_id"`
    Secret       string   `json:"-"`
    Name         string   `json:"name"`
    RedirectURIs []string `json:"redirect_uris"`
    Scopes       []string `json:"scopes"`
    GrantTypes   []string `json:"grant_types"`
}

// AuthorizationCode represents an authorization code
type AuthorizationCode struct {
    Code        string
    ClientID    string
    UserID      string
    RedirectURI string
    Scopes      []string
    ExpiresAt   time.Time
    CodeChallenge string // PKCE
    CodeChallengeMethod string
}

// TokenStore manages tokens and codes
type TokenStore interface {
    SaveAuthorizationCode(code *AuthorizationCode) error
    GetAuthorizationCode(code string) (*AuthorizationCode, error)
    DeleteAuthorizationCode(code string) error
    SaveRefreshToken(token string, userID, clientID string, scopes []string, expiresAt time.Time) error
    GetRefreshToken(token string) (userID, clientID string, scopes []string, err error)
    DeleteRefreshToken(token string) error
}

// OAuthServer implements OAuth 2.0 flows
type OAuthServer struct {
    clients      map[string]*Client
    tokenStore   TokenStore
    tokenService *TokenService
}

// AuthorizeHandler handles authorization requests
func (s *OAuthServer) AuthorizeHandler(w http.ResponseWriter, r *http.Request) {
    // Parse request
    clientID := r.URL.Query().Get("client_id")
    redirectURI := r.URL.Query().Get("redirect_uri")
    responseType := r.URL.Query().Get("response_type")
    scope := r.URL.Query().Get("scope")
    state := r.URL.Query().Get("state")

    // PKCE parameters
    codeChallenge := r.URL.Query().Get("code_challenge")
    codeChallengeMethod := r.URL.Query().Get("code_challenge_method")

    // Validate client
    client, ok := s.clients[clientID]
    if !ok {
        http.Error(w, "Invalid client", http.StatusBadRequest)
        return
    }

    // Validate redirect URI
    if !s.validateRedirectURI(client, redirectURI) {
        http.Error(w, "Invalid redirect URI", http.StatusBadRequest)
        return
    }

    // For authorization code flow
    if responseType != "code" {
        redirectWithError(w, r, redirectURI, "unsupported_response_type", state)
        return
    }

    // Get authenticated user (from session)
    user := getUserFromSession(r)
    if user == nil {
        // Redirect to login
        http.Redirect(w, r, "/login?continue="+r.URL.String(), http.StatusFound)
        return
    }

    // Generate authorization code
    code := generateCode()
    authCode := &AuthorizationCode{
        Code:        code,
        ClientID:    clientID,
        UserID:      user.ID,
        RedirectURI: redirectURI,
        Scopes:      parseScopes(scope),
        ExpiresAt:   time.Now().Add(10 * time.Minute),
        CodeChallenge: codeChallenge,
        CodeChallengeMethod: codeChallengeMethod,
    }

    if err := s.tokenStore.SaveAuthorizationCode(authCode); err != nil {
        redirectWithError(w, r, redirectURI, "server_error", state)
        return
    }

    // Redirect with code
    redirectURL := redirectURI + "?code=" + code
    if state != "" {
        redirectURL += "&state=" + state
    }
    http.Redirect(w, r, redirectURL, http.StatusFound)
}

// TokenHandler handles token requests
func (s *OAuthServer) TokenHandler(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
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
        writeOAuthError(w, "unsupported_grant_type", "")
    }
}

func (s *OAuthServer) handleAuthorizationCodeGrant(w http.ResponseWriter, r *http.Request) {
    code := r.FormValue("code")
    redirectURI := r.FormValue("redirect_uri")
    clientID := r.FormValue("client_id")
    clientSecret := r.FormValue("client_secret")
    codeVerifier := r.FormValue("code_verifier") // PKCE

    // Validate client
    client, ok := s.clients[clientID]
    if !ok || !SecureCompare(client.Secret, clientSecret) {
        writeOAuthError(w, "invalid_client", "")
        return
    }

    // Get and validate authorization code
    authCode, err := s.tokenStore.GetAuthorizationCode(code)
    if err != nil || authCode == nil {
        writeOAuthError(w, "invalid_grant", "Invalid authorization code")
        return
    }

    if time.Now().After(authCode.ExpiresAt) {
        writeOAuthError(w, "invalid_grant", "Authorization code expired")
        return
    }

    if authCode.ClientID != clientID || authCode.RedirectURI != redirectURI {
        writeOAuthError(w, "invalid_grant", "")
        return
    }

    // Validate PKCE
    if authCode.CodeChallenge != "" {
        if !validatePKCE(codeVerifier, authCode.CodeChallenge, authCode.CodeChallengeMethod) {
            writeOAuthError(w, "invalid_grant", "Invalid code verifier")
            return
        }
    }

    // Delete used code
    s.tokenStore.DeleteAuthorizationCode(code)

    // Generate tokens
    user := &User{ID: authCode.UserID}
    tokens, err := s.tokenService.GenerateTokenPair(user)
    if err != nil {
        writeOAuthError(w, "server_error", "")
        return
    }

    // Save refresh token
    s.tokenStore.SaveRefreshToken(
        tokens.RefreshToken,
        user.ID,
        clientID,
        authCode.Scopes,
        time.Now().Add(30*24*time.Hour),
    )

    writeTokenResponse(w, tokens, authCode.Scopes)
}

func writeTokenResponse(w http.ResponseWriter, tokens *TokenPair, scopes []string) {
    w.Header().Set("Content-Type", "application/json")
    w.Header().Set("Cache-Control", "no-store")
    w.Header().Set("Pragma", "no-cache")

    response := map[string]any{
        "access_token":  tokens.AccessToken,
        "token_type":    tokens.TokenType,
        "expires_in":    tokens.ExpiresIn,
        "refresh_token": tokens.RefreshToken,
    }
    if len(scopes) > 0 {
        response["scope"] = strings.Join(scopes, " ")
    }

    json.NewEncoder(w).Encode(response)
}

func writeOAuthError(w http.ResponseWriter, code, description string) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusBadRequest)

    response := map[string]string{"error": code}
    if description != "" {
        response["error_description"] = description
    }
    json.NewEncoder(w).Encode(response)
}
```

### PKCE Support

PKCE replaces the client secret for public clients (mobile apps, SPAs) by generating a random `code_verifier` that is hashed to a `code_challenge` sent with the authorization request. The server stores the challenge and re-derives it from the verifier at token exchange, proving the requester originated the authorization flow without ever transmitting a static secret.

```go
// ... imports omitted for brevity (crypto/rand, crypto/sha256, crypto/subtle, encoding/base64)

// GeneratePKCE generates code verifier and challenge
func GeneratePKCE() (verifier, challenge string, err error) {
    // Generate random verifier (43-128 characters)
    b := make([]byte, 32)
    if _, err := rand.Read(b); err != nil {
        return "", "", err
    }
    verifier = base64.RawURLEncoding.EncodeToString(b)

    // Generate challenge using S256
    h := sha256.Sum256([]byte(verifier))
    challenge = base64.RawURLEncoding.EncodeToString(h[:])

    return verifier, challenge, nil
}

// validatePKCE validates the code verifier against the challenge
func validatePKCE(verifier, challenge, method string) bool {
    switch method {
    case "S256":
        h := sha256.Sum256([]byte(verifier))
        expected := base64.RawURLEncoding.EncodeToString(h[:])
        return subtle.ConstantTimeCompare([]byte(challenge), []byte(expected)) == 1
    case "plain":
        return subtle.ConstantTimeCompare([]byte(verifier), []byte(challenge)) == 1
    default:
        return false
    }
}
```

### Junior → FAANG: OAuth 2.1 as a sequence a junior can draw

OAuth confuses juniors because the vocabulary overlaps. There are four roles. The resource owner is the human end user. The client is the application asking for access (your web app, your mobile app, a third-party integration). The authorization server issues tokens (Auth0, Okta, your own `OAuthServer`). The resource server holds the data and accepts access tokens (your REST API). A token for one resource server is not automatically valid at another, which is what the `aud` claim enforces.

The authorization code flow with PKCE is the only flow you need to learn for 95 percent of work. Draw it as six arrows. One, the user clicks "sign in with Example" in your client app. Two, the client generates a random `code_verifier`, hashes it with SHA-256 to get `code_challenge`, and redirects the browser to `GET /authorize?client_id=...&redirect_uri=...&response_type=code&code_challenge=...&code_challenge_method=S256&state=...&scope=...`. Three, the authorization server authenticates the user (password, passkey, whatever), shows a consent screen, and redirects back to `redirect_uri?code=...&state=...`. Four, the client verifies `state` matches the value it sent (CSRF defense) and makes a back-channel `POST /token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, and `code_verifier`. Five, the server hashes the verifier, compares to the stored challenge, invalidates the code, and returns `access_token` plus `refresh_token`. Six, the client calls the resource server with `Authorization: Bearer <access_token>`.

PKCE solves the code interception attack. Without it, a malicious app on the same device that intercepts the redirect can exchange the code for a token because the code alone is sufficient. With PKCE, the attacker would also need the `code_verifier` that was generated in-memory by the legitimate client and never left the device. The verifier is the proof of possession.

The `state` parameter is not optional. It prevents CSRF on the redirect URI. If you forget to validate that the returned `state` matches what you sent, an attacker can trick a user's browser into completing the attacker's authorization flow, linking the attacker's account to the victim's session. Every OAuth client must generate `state` with `crypto/rand`, store it server-side or in a signed cookie, and compare it on the redirect. `nonce` plays a similar role for OIDC ID tokens.

As a worked exercise, register an OAuth app in your GitHub developer settings, implement the flow in a small Go program, and successfully fetch the user's email from `https://api.github.com/user`. You will understand OAuth better after one round trip than after ten tutorials.

### Senior @ FAANG: OAuth 2.1 review items and the modern landscape

The code above passes a surface review and fails a principal-track one. Below is the checklist a senior reviewer runs on every OAuth implementation in 2026, followed by the landscape knowledge you are expected to bring to design reviews.

PKCE is accepted but not required. `if authCode.CodeChallenge != "" { validatePKCE(...) }` means a client that omits `code_challenge` gets a free pass. OAuth 2.1 mandates PKCE for every client. The server must reject `/authorize` with `invalid_request` if `code_challenge` is missing, and reject `/token` with `invalid_grant` if `code_verifier` is missing. The `plain` method in `validatePKCE` must also be rejected. S256 is the only acceptable method in 2026.

Client secret comparison is correct (uses `SecureCompare`) but the secret itself should not be stored in plaintext. The `Client` struct holds `Secret string` and the memory model suggests direct comparison. Production stores only a bcrypt or Argon2id hash of the secret and compares by hashing the presented value. This protects you when the database leaks and lets you rotate secrets without invalidating every client.

Redirect URI validation is gestured at with `validateRedirectURI` but the spec requires exact string match including scheme, host, port, and path. A client registered with `https://app.example.com/callback` must not match `https://app.example.com/callback/`, `https://app.example.com/callback?foo=bar`, or any other variant. Prefix or wildcard matching has caused real account takeovers across major providers, documented repeatedly in bug bounty disclosures. The implementation must be `registered == presented`, full stop.

Authorization codes are not bound to the client's TLS session or DPoP key. A sophisticated attacker who steals a code mid-flight (man-in-the-middle on a compromised network, or a malicious proxy) can redeem it if they also control or guess the PKCE verifier. DPoP on the token endpoint binds the eventual access token to a client key pair so that even a stolen token is useless without the matching private key. For high-value APIs this is now expected.

Refresh token rotation with reuse detection is missing. `handleRefreshTokenGrant` (referenced but not shown here) presumably returns a new access token against the same long-lived refresh token. The Auth0 pattern is: every refresh issues a new refresh token, invalidates the old one, and records the lineage. If the old token is ever presented again, the entire family is revoked. This catches the case where an attacker stole a refresh token and the legitimate client rotated before the attacker used it, which is the most common detectable sign of compromise.

Scope validation is implicit. The server accepts whatever `scope` the client requests and issues a token with those scopes. Production validates that requested scopes are a subset of the scopes registered for the client, that the user has consented to them (and remembers consent across flows), and that sensitive scopes (write, admin, PII) require fresh authentication. Google and Microsoft enforce incremental consent where a client first granted `read` and later requesting `write` must re-prompt the user.

No token introspection endpoint, no revocation endpoint, no discovery document. Production OAuth servers expose `/oauth/introspect` (RFC 7662) so resource servers can validate opaque tokens, `/oauth/revoke` (RFC 7009) so clients can proactively invalidate tokens on logout, and `/.well-known/openid-configuration` (OIDC discovery) or `/.well-known/oauth-authorization-server` (RFC 8414) so clients can auto-configure. Missing any of these limits interop with standard SDKs.

No OIDC layer. OAuth 2.1 authorizes access. OIDC (OpenID Connect) layers identity on top by adding an `id_token` (a JWT with standard claims about the user: `sub`, `email`, `name`, `picture`, `amr`, `acr`) returned alongside the access token. If your use case is "let users log in with Google", you need OIDC, not raw OAuth 2.1. The `id_token` is consumed by the client to know who the user is. The `access_token` is sent to the resource server. A senior engineer reviewing "let users sign in with X" unambiguously pushes for OIDC plus the authorization code flow plus PKCE plus `nonce` plus `state`.

OAuth 2.1 plus its extensions. In 2026 your mental model should include the mandatory base plus: PKCE (RFC 7636), DPoP (RFC 9449) or mTLS-bound tokens (RFC 8705), Pushed Authorization Requests (RFC 9126) to keep authorization parameters off the front channel, JWT Secured Authorization Response Mode (JARM) for signed responses, Rich Authorization Requests (RAR, RFC 9396) for fine-grained consent, and Step-Up Authentication Challenge Protocol (RFC 9470) for elevating session assurance mid-flow. You will not implement all of these on day one, but you will be asked "why or why not" in a staff-level design review.

Workforce identity versus consumer identity. For consumer apps "sign in with Apple", "sign in with Google", and passkey-first flows dominate. For enterprise B2B, SAML 2.0 (via `crewjam/saml` in Go) and SCIM 2.0 for provisioning are non-negotiable because enterprise IT teams already run ADFS, Okta, or Azure AD and will not integrate with anything else. A B2B product without SAML loses six-figure deals at the procurement stage. WorkOS and Auth0 Enterprise exist precisely because implementing SAML correctly is a multi-quarter project that few teams should undertake from scratch.

Build versus buy, revisited. The code in this file is roughly 200 lines. A production OAuth 2.1 plus OIDC plus SAML plus SCIM server is 50,000 to 200,000 lines plus a compliance programme. Keycloak, Ory Hydra plus Kratos, Authentik, and Zitadel are open-source options you can self-host. Auth0, Okta, WorkOS, Clerk, Stytch, SuperTokens, and Kinde are hosted. The honest answer for most teams in 2026 is to use one of these and spend your engineering time on your product. You own the integration, the SDK, the session handling, and the authorization logic. You do not own the protocol stack.

---
