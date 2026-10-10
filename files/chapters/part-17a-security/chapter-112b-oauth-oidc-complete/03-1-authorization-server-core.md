## 112B.2 Authorization Server Core

The authorization server core handles PKCE validation by computing `SHA-256(code_verifier)` and comparing it to the stored `code_challenge` from the authorization request, binding the token exchange to the same client that initiated the flow. Authorization codes are single-use and short-lived (stored with a 60-second TTL), and are deleted from the store immediately upon exchange to prevent replay attacks. The RSA key pair is generated at startup and the public key is exposed via a JWKS endpoint (`/jwks.json`) so resource servers can fetch and cache the signing key for offline JWT verification.

```go
package authserver

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"math/big"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// AuthorizationServer implements OAuth 2.0 + OIDC
type AuthorizationServer struct {
	mu            sync.RWMutex
	config        ServerConfig
	clients       map[string]*Client
	authCodes     map[string]*AuthorizationCode
	accessTokens  map[string]*TokenRecord
	refreshTokens map[string]*RefreshTokenRecord
	privateKey    *rsa.PrivateKey
	keyID         string
	userStore     UserStore
}

// ServerConfig holds authorization server configuration
type ServerConfig struct {
	Issuer                    string
	AuthorizationEndpoint     string
	TokenEndpoint             string
	UserInfoEndpoint          string
	JWKSEndpoint              string
	RevocationEndpoint        string
	IntrospectionEndpoint     string
	AccessTokenLifetime       time.Duration
	RefreshTokenLifetime      time.Duration
	AuthorizationCodeLifetime time.Duration
	IDTokenLifetime           time.Duration
}

// Client represents a registered OAuth client
type Client struct {
	ClientID                string
	ClientSecret            string // bcrypt hash for confidential clients
	ClientType              string // confidential, public
	RedirectURIs            []string
	AllowedGrantTypes       []string
	AllowedScopes           []string
	RequirePKCE             bool
	TokenEndpointAuthMethod string // client_secret_basic, client_secret_post, private_key_jwt, none
}

// AuthorizationCode represents an authorization code
type AuthorizationCode struct {
	Code                string
	ClientID            string
	UserID              string
	RedirectURI         string
	Scopes              []string
	CodeChallenge       string
	CodeChallengeMethod string
	Nonce               string
	ExpiresAt           time.Time
	Used                bool
}

// TokenRecord represents an active access token
type TokenRecord struct {
	Token     string
	ClientID  string
	UserID    string
	Scopes    []string
	ExpiresAt time.Time
}

// RefreshTokenRecord represents a refresh token
type RefreshTokenRecord struct {
	Token       string
	ClientID    string
	UserID      string
	Scopes      []string
	ExpiresAt   time.Time
	FamilyID    string // For refresh token rotation detection
	ParentToken string
}

// UserStore interface for user lookup
type UserStore interface {
	FindByID(userID string) (*User, error)
	Authenticate(username, password string) (*User, error)
}

// User represents an authenticated user
type User struct {
	ID            string
	Username      string
	Email         string
	EmailVerified bool
	Name          string
	GivenName     string
	FamilyName    string
	Picture       string
	Locale        string
	ZoneInfo      string
	Roles         []string
}

// Claims represents JWT claims for access token
type Claims struct {
	jwt.RegisteredClaims
	ClientID string   `json:"client_id,omitempty"`
	Scope    string   `json:"scope,omitempty"`
	Roles    []string `json:"roles,omitempty"`
}

// IDTokenClaims represents OIDC ID token claims
type IDTokenClaims struct {
	jwt.RegisteredClaims
	Nonce         string `json:"nonce,omitempty"`
	AuthTime      int64  `json:"auth_time,omitempty"`
	Email         string `json:"email,omitempty"`
	EmailVerified bool   `json:"email_verified,omitempty"`
	Name          string `json:"name,omitempty"`
	GivenName     string `json:"given_name,omitempty"`
	FamilyName    string `json:"family_name,omitempty"`
	Picture       string `json:"picture,omitempty"`
	Locale        string `json:"locale,omitempty"`
	ZoneInfo      string `json:"zoneinfo,omitempty"`
}

// NewAuthorizationServer creates a new authorization server
func NewAuthorizationServer(config ServerConfig, userStore UserStore) (*AuthorizationServer, error) {
	// Generate RSA key pair for signing
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("failed to generate RSA key: %w", err)
	}

	// Generate key ID
	keyID := generateSecureToken(16)

	return &AuthorizationServer{
		config:        config,
		clients:       make(map[string]*Client),
		authCodes:     make(map[string]*AuthorizationCode),
		accessTokens:  make(map[string]*TokenRecord),
		refreshTokens: make(map[string]*RefreshTokenRecord),
		privateKey:    privateKey,
		keyID:         keyID,
		userStore:     userStore,
	}, nil
}

// RegisterClient registers a new OAuth client
func (s *AuthorizationServer) RegisterClient(client *Client) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.clients[client.ClientID]; exists {
		return fmt.Errorf("client %s already registered", client.ClientID)
	}

	s.clients[client.ClientID] = client
	return nil
}

// HandleAuthorization handles the authorization endpoint
func (s *AuthorizationServer) HandleAuthorization(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		s.showAuthorizationForm(w, r)
		return
	}

	if r.Method == http.MethodPost {
		s.processAuthorization(w, r)
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

func (s *AuthorizationServer) showAuthorizationForm(w http.ResponseWriter, r *http.Request) {
	params := r.URL.Query()

	clientID := params.Get("client_id")
	responseType := params.Get("response_type")
	redirectURI := params.Get("redirect_uri")
	scope := params.Get("scope")
	state := params.Get("state")
	codeChallenge := params.Get("code_challenge")
	codeChallengeMethod := params.Get("code_challenge_method")
	nonce := params.Get("nonce")

	// Validate client
	client, err := s.validateClient(clientID)
	if err != nil {
		http.Error(w, "invalid_client", http.StatusBadRequest)
		return
	}

	// Validate response type
	if responseType != "code" {
		s.redirectError(w, r, redirectURI, "unsupported_response_type", "only code flow supported", state)
		return
	}

	// Validate redirect URI
	if !s.isValidRedirectURI(client, redirectURI) {
		http.Error(w, "invalid_redirect_uri", http.StatusBadRequest)
		return
	}

	// Public clients MUST use PKCE
	if client.ClientType == "public" && codeChallenge == "" {
		s.redirectError(w, r, redirectURI, "invalid_request",
			"PKCE required for public clients", state)
		return
	}

	// Validate PKCE method
	if codeChallenge != "" && codeChallengeMethod != "S256" {
		s.redirectError(w, r, redirectURI, "invalid_request",
			"only S256 code challenge method supported", state)
		return
	}

	// Store auth request in session and show login form
	// In production: store in encrypted session cookie
	_ = scope
	_ = nonce
	_ = codeChallengeMethod

	// Render consent form. Every interpolated value is HTML-escaped:
	// these parameters are attacker-controlled query strings.
	w.Header().Set("Content-Type", "text/html")
	fmt.Fprintf(w, `
<!DOCTYPE html>
<html>
<head><title>Authorization</title></head>
<body>
<h2>Login to %s</h2>
<form method="POST" action="/oauth/authorize">
  <input type="hidden" name="client_id" value="%s">
  <input type="hidden" name="redirect_uri" value="%s">
  <input type="hidden" name="state" value="%s">
  <input type="hidden" name="scope" value="%s">
  <input type="hidden" name="code_challenge" value="%s">
  <input type="hidden" name="code_challenge_method" value="S256">
  <input type="hidden" name="nonce" value="%s">
  <label>Username: <input type="text" name="username" required></label><br>
  <label>Password: <input type="password" name="password" required></label><br>
  <button type="submit">Login</button>
</form>
</body>
</html>`,
		html.EscapeString(client.ClientID), html.EscapeString(clientID),
		html.EscapeString(redirectURI), html.EscapeString(state),
		html.EscapeString(scope), html.EscapeString(codeChallenge),
		html.EscapeString(nonce))
}

func (s *AuthorizationServer) processAuthorization(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()

	clientID := r.FormValue("client_id")
	redirectURI := r.FormValue("redirect_uri")
	state := r.FormValue("state")
	scope := r.FormValue("scope")
	codeChallenge := r.FormValue("code_challenge")
	codeChallengeMethod := r.FormValue("code_challenge_method")
	nonce := r.FormValue("nonce")
	username := r.FormValue("username")
	password := r.FormValue("password")

	// Re-validate client and redirect URI: hidden form fields are
	// attacker-controlled, trusting them would allow an open redirect
	client, err := s.validateClient(clientID)
	if err != nil {
		http.Error(w, "invalid_client", http.StatusBadRequest)
		return
	}
	if !s.isValidRedirectURI(client, redirectURI) {
		http.Error(w, "invalid_redirect_uri", http.StatusBadRequest)
		return
	}

	// Authenticate user
	user, err := s.userStore.Authenticate(username, password)
	if err != nil {
		http.Error(w, "invalid_credentials", http.StatusUnauthorized)
		return
	}

	// Generate authorization code
	code := generateSecureToken(32)
	authCode := &AuthorizationCode{
		Code:                code,
		ClientID:            clientID,
		UserID:              user.ID,
		RedirectURI:         redirectURI,
		Scopes:              strings.Split(scope, " "),
		CodeChallenge:       codeChallenge,
		CodeChallengeMethod: codeChallengeMethod,
		Nonce:               nonce,
		ExpiresAt:           time.Now().Add(s.config.AuthorizationCodeLifetime),
	}

	s.mu.Lock()
	s.authCodes[code] = authCode
	s.mu.Unlock()

	// Redirect with authorization code, URL-encoding every parameter
	q := url.Values{}
	q.Set("code", code)
	if state != "" {
		q.Set("state", state)
	}

	http.Redirect(w, r, redirectURI+"?"+q.Encode(), http.StatusFound)
}

// HandleToken handles the token endpoint
func (s *AuthorizationServer) HandleToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.ParseForm()
	grantType := r.FormValue("grant_type")

	var response any
	var err error

	switch grantType {
	case "authorization_code":
		response, err = s.handleAuthorizationCodeGrant(r)
	case "refresh_token":
		response, err = s.handleRefreshTokenGrant(r)
	case "client_credentials":
		response, err = s.handleClientCredentialsGrant(r)
	default:
		s.writeTokenError(w, "unsupported_grant_type", "grant type not supported")
		return
	}

	if err != nil {
		s.writeTokenError(w, "invalid_grant", err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	json.NewEncoder(w).Encode(response)
}

// TokenResponse represents the OAuth token response
type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token,omitempty"`
	Scope        string `json:"scope"`
	IDToken      string `json:"id_token,omitempty"`
}

func (s *AuthorizationServer) handleAuthorizationCodeGrant(r *http.Request) (*TokenResponse, error) {
	code := r.FormValue("code")
	redirectURI := r.FormValue("redirect_uri")
	clientID := r.FormValue("client_id")
	codeVerifier := r.FormValue("code_verifier")

	// Retrieve authorization code
	s.mu.Lock()
	authCode, exists := s.authCodes[code]
	if exists {
		delete(s.authCodes, code) // Single-use code
	}
	s.mu.Unlock()

	if !exists {
		return nil, errors.New("authorization code not found")
	}

	// Validate code is not expired
	if time.Now().After(authCode.ExpiresAt) {
		return nil, errors.New("authorization code expired")
	}

	// Validate client matches
	if authCode.ClientID != clientID {
		return nil, errors.New("client mismatch")
	}

	// Validate redirect URI matches
	if authCode.RedirectURI != redirectURI {
		return nil, errors.New("redirect_uri mismatch")
	}

	// Validate PKCE
	if authCode.CodeChallenge != "" {
		if codeVerifier == "" {
			return nil, errors.New("code_verifier required")
		}
		if !verifyPKCE(codeVerifier, authCode.CodeChallenge, authCode.CodeChallengeMethod) {
			return nil, errors.New("PKCE verification failed")
		}
	}

	// Generate tokens
	return s.generateTokenResponse(authCode.ClientID, authCode.UserID, authCode.Scopes, authCode.Nonce)
}

func (s *AuthorizationServer) handleRefreshTokenGrant(r *http.Request) (*TokenResponse, error) {
	refreshTokenStr := r.FormValue("refresh_token")
	clientID := r.FormValue("client_id")

	s.mu.Lock()
	refreshToken, exists := s.refreshTokens[refreshTokenStr]
	if exists {
		delete(s.refreshTokens, refreshTokenStr) // Rotate: consume old token
	}
	s.mu.Unlock()

	if !exists {
		return nil, errors.New("refresh token not found")
	}

	// Validate not expired
	if time.Now().After(refreshToken.ExpiresAt) {
		return nil, errors.New("refresh token expired")
	}

	// Validate client
	if refreshToken.ClientID != clientID {
		// Potential token theft: invalidate the entire family
		s.invalidateTokenFamily(refreshToken.FamilyID)
		return nil, errors.New("client mismatch: token family invalidated")
	}

	// Issue new token pair (refresh token rotation)
	return s.generateTokenResponse(refreshToken.ClientID, refreshToken.UserID, refreshToken.Scopes, "")
}

func (s *AuthorizationServer) handleClientCredentialsGrant(r *http.Request) (*TokenResponse, error) {
	// Extract client credentials from Basic auth or form params
	clientID, clientSecret, ok := r.BasicAuth()
	if !ok {
		clientID = r.FormValue("client_id")
		clientSecret = r.FormValue("client_secret")
	}

	client, err := s.validateClient(clientID)
	if err != nil {
		return nil, err
	}

	if client.ClientType != "confidential" {
		return nil, errors.New("client credentials grant requires confidential client")
	}

	if !verifyClientSecret(clientSecret, client.ClientSecret) {
		return nil, errors.New("invalid client credentials")
	}

	scope := r.FormValue("scope")
	scopes := strings.Split(scope, " ")

	// Generate access token (no user, no refresh token for M2M)
	accessToken, err := s.generateAccessToken(clientID, "", scopes)
	if err != nil {
		return nil, err
	}

	return &TokenResponse{
		AccessToken: accessToken,
		TokenType:   "Bearer",
		ExpiresIn:   int(s.config.AccessTokenLifetime.Seconds()),
		Scope:       scope,
	}, nil
}

func (s *AuthorizationServer) generateTokenResponse(
	clientID, userID string, scopes []string, nonce string,
) (*TokenResponse, error) {
	// Generate access token
	accessToken, err := s.generateAccessToken(clientID, userID, scopes)
	if err != nil {
		return nil, err
	}

	// Generate refresh token
	familyID := generateSecureToken(16)
	refreshTokenStr := generateSecureToken(32)

	s.mu.Lock()
	s.refreshTokens[refreshTokenStr] = &RefreshTokenRecord{
		Token:     refreshTokenStr,
		ClientID:  clientID,
		UserID:    userID,
		Scopes:    scopes,
		ExpiresAt: time.Now().Add(s.config.RefreshTokenLifetime),
		FamilyID:  familyID,
	}
	s.mu.Unlock()

	response := &TokenResponse{
		AccessToken:  accessToken,
		TokenType:    "Bearer",
		ExpiresIn:    int(s.config.AccessTokenLifetime.Seconds()),
		RefreshToken: refreshTokenStr,
		Scope:        strings.Join(scopes, " "),
	}

	// Generate ID token if openid scope requested
	if containsScope(scopes, "openid") && userID != "" {
		idToken, err := s.generateIDToken(clientID, userID, nonce, scopes)
		if err != nil {
			return nil, err
		}
		response.IDToken = idToken
	}

	return response, nil
}

func (s *AuthorizationServer) generateAccessToken(clientID, userID string, scopes []string) (string, error) {
	user, _ := s.userStore.FindByID(userID)

	var roles []string
	if user != nil {
		roles = user.Roles
	}

	now := time.Now()
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    s.config.Issuer,
			Subject:   userID,
			Audience:  jwt.ClaimStrings{clientID},
			ExpiresAt: jwt.NewNumericDate(now.Add(s.config.AccessTokenLifetime)),
			IssuedAt:  jwt.NewNumericDate(now),
			ID:        generateSecureToken(16),
		},
		ClientID: clientID,
		Scope:    strings.Join(scopes, " "),
		Roles:    roles,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = s.keyID

	return token.SignedString(s.privateKey)
}

func (s *AuthorizationServer) generateIDToken(clientID, userID, nonce string, scopes []string) (string, error) {
	user, err := s.userStore.FindByID(userID)
	if err != nil {
		return "", fmt.Errorf("user not found: %w", err)
	}

	now := time.Now()
	claims := IDTokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    s.config.Issuer,
			Subject:   userID,
			Audience:  jwt.ClaimStrings{clientID},
			ExpiresAt: jwt.NewNumericDate(now.Add(s.config.IDTokenLifetime)),
			IssuedAt:  jwt.NewNumericDate(now),
		},
		Nonce:    nonce,
		AuthTime: now.Unix(),
	}

	// Add claims based on requested scopes
	if containsScope(scopes, "email") {
		claims.Email = user.Email
		claims.EmailVerified = user.EmailVerified
	}
	if containsScope(scopes, "profile") {
		claims.Name = user.Name
		claims.GivenName = user.GivenName
		claims.FamilyName = user.FamilyName
		claims.Picture = user.Picture
		claims.Locale = user.Locale
		claims.ZoneInfo = user.ZoneInfo
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = s.keyID

	return token.SignedString(s.privateKey)
}

// HandleJWKS serves the JSON Web Key Set
func (s *AuthorizationServer) HandleJWKS(w http.ResponseWriter, r *http.Request) {
	publicKey := s.privateKey.Public().(*rsa.PublicKey)

	jwks := map[string]any{
		"keys": []map[string]any{
			{
				"kty": "RSA",
				"use": "sig",
				"kid": s.keyID,
				"alg": "RS256",
				"n":   base64.RawURLEncoding.EncodeToString(publicKey.N.Bytes()),
				"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(publicKey.E)).Bytes()),
			},
		},
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(jwks)
}

// HandleDiscovery serves the OIDC discovery document
func (s *AuthorizationServer) HandleDiscovery(w http.ResponseWriter, r *http.Request) {
	discovery := map[string]any{
		"issuer":                                s.config.Issuer,
		"authorization_endpoint":                s.config.AuthorizationEndpoint,
		"token_endpoint":                        s.config.TokenEndpoint,
		"userinfo_endpoint":                     s.config.UserInfoEndpoint,
		"jwks_uri":                              s.config.JWKSEndpoint,
		"revocation_endpoint":                   s.config.RevocationEndpoint,
		"introspection_endpoint":                s.config.IntrospectionEndpoint,
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token", "client_credentials"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"scopes_supported":                      []string{"openid", "profile", "email", "offline_access"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_basic", "client_secret_post", "none"},
		"claims_supported":                      []string{"sub", "iss", "aud", "exp", "iat", "email", "name"},
		"code_challenge_methods_supported":      []string{"S256"},
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(discovery)
}

// HandleIntrospection implements RFC 7662 token introspection
func (s *AuthorizationServer) HandleIntrospection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Authenticate the requesting client (only resource servers may introspect)
	introClientID, introClientSecret, ok := r.BasicAuth()
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	introClient, err := s.validateClient(introClientID)
	if err != nil || !verifyClientSecret(introClientSecret, introClient.ClientSecret) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	token := r.FormValue("token")

	// Parse and validate JWT
	claims := &Claims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.privateKey.Public(), nil
	})

	w.Header().Set("Content-Type", "application/json")

	if err != nil || !parsed.Valid {
		json.NewEncoder(w).Encode(map[string]bool{"active": false})
		return
	}

	json.NewEncoder(w).Encode(map[string]any{
		"active":    true,
		"sub":       claims.Subject,
		"client_id": claims.ClientID,
		"scope":     claims.Scope,
		"exp":       claims.ExpiresAt.Unix(),
		"iat":       claims.IssuedAt.Unix(),
		"iss":       claims.Issuer,
	})
}

// HandleRevocation implements RFC 7009 token revocation
func (s *AuthorizationServer) HandleRevocation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	token := r.FormValue("token")
	tokenTypeHint := r.FormValue("token_type_hint")

	if tokenTypeHint == "refresh_token" || tokenTypeHint == "" {
		s.mu.Lock()
		if rt, exists := s.refreshTokens[token]; exists {
			s.invalidateTokenFamily(rt.FamilyID)
		}
		delete(s.refreshTokens, token)
		s.mu.Unlock()
	}

	// Always return 200 even if token not found (RFC 7009)
	w.WriteHeader(http.StatusOK)
}

func (s *AuthorizationServer) invalidateTokenFamily(familyID string) {
	// In production: store family IDs in database with revocation timestamp
	// For now, find all refresh tokens in this family
	for token, rt := range s.refreshTokens {
		if rt.FamilyID == familyID {
			delete(s.refreshTokens, token)
		}
	}
}

func (s *AuthorizationServer) validateClient(clientID string) (*Client, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	client, exists := s.clients[clientID]
	if !exists {
		return nil, fmt.Errorf("client %s not found", clientID)
	}
	return client, nil
}

func (s *AuthorizationServer) isValidRedirectURI(client *Client, redirectURI string) bool {
	return slices.Contains(client.RedirectURIs, redirectURI)
}

func (s *AuthorizationServer) redirectError(
	w http.ResponseWriter, r *http.Request,
	redirectURI, errorCode, errorDescription, state string,
) {
	q := url.Values{}
	q.Set("error", errorCode)
	q.Set("error_description", errorDescription)
	if state != "" {
		q.Set("state", state)
	}
	http.Redirect(w, r, redirectURI+"?"+q.Encode(), http.StatusFound)
}

func (s *AuthorizationServer) writeTokenError(w http.ResponseWriter, code, description string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	json.NewEncoder(w).Encode(map[string]string{
		"error":             code,
		"error_description": description,
	})
}

// verifyPKCE verifies the PKCE code challenge
func verifyPKCE(verifier, challenge, method string) bool {
	if method != "S256" {
		return false
	}
	hash := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(hash[:])
	return subtle.ConstantTimeCompare([]byte(computed), []byte(challenge)) == 1
}

func verifyClientSecret(provided, storedHash string) bool {
	// Client secrets are stored as bcrypt hashes, never in plaintext
	return bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(provided)) == nil
}

func generateSecureToken(length int) string {
	b := make([]byte, length)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func containsScope(scopes []string, scope string) bool {
	return slices.Contains(scopes, scope)
}
```

---
