## 112B.4 OAuth Client: Authorization Code + PKCE Flow

The OAuth client generates a cryptographically random 32-byte code verifier, derives the S256 code challenge by base64url-encoding its SHA-256 hash, and stores the verifier in a server-side session keyed by the `state` parameter. When the authorization server redirects back with the code, the client retrieves the verifier from the session, sends it in the token exchange request, and discards the session entry, making the verifier single-use and preventing CSRF by validating the state. This implementation is deliberately hand-rolled so every protocol step is visible. In production you can lean on `golang.org/x/oauth2`, whose `TokenSource` refreshes the access token automatically when it detects expiry.

```go
package oauthclient

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// OAuthClient implements the OAuth 2.0 authorization code flow with PKCE
type OAuthClient struct {
	mu         sync.RWMutex
	config     ClientConfig
	stateStore map[string]*pendingAuth
	tokenStore TokenStore
	httpClient *http.Client
}

// ClientConfig holds client configuration
type ClientConfig struct {
	ClientID      string
	ClientSecret  string // Empty for public clients
	RedirectURI   string
	Scopes        []string
	AuthEndpoint  string
	TokenEndpoint string
	Issuer        string
}

// pendingAuth stores state for in-progress authorization
type pendingAuth struct {
	State        string
	CodeVerifier string
	ExpiresAt    time.Time
}

// TokenStore interface for storing tokens
type TokenStore interface {
	Save(userID string, token *OAuthToken) error
	Load(userID string) (*OAuthToken, error)
	Delete(userID string) error
}

// OAuthToken represents stored OAuth tokens
type OAuthToken struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	IDToken      string    `json:"id_token,omitempty"`
	ExpiresAt    time.Time `json:"expires_at"`
	Scopes       []string  `json:"scopes"`
}

// IsExpired checks if the access token is expired
func (t *OAuthToken) IsExpired() bool {
	return time.Now().After(t.ExpiresAt.Add(-30 * time.Second)) // 30s buffer
}

// NewOAuthClient creates a new OAuth client
func NewOAuthClient(config ClientConfig, tokenStore TokenStore) *OAuthClient {
	return &OAuthClient{
		config:     config,
		stateStore: make(map[string]*pendingAuth),
		tokenStore: tokenStore,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// AuthorizationURL generates the authorization URL to redirect the user to
func (c *OAuthClient) AuthorizationURL(nonce string) (string, error) {
	// Generate PKCE code verifier (RFC 7636)
	verifierBytes := make([]byte, 32)
	if _, err := rand.Read(verifierBytes); err != nil {
		return "", fmt.Errorf("failed to generate code verifier: %w", err)
	}
	codeVerifier := base64.RawURLEncoding.EncodeToString(verifierBytes)

	// Generate code challenge (S256)
	hash := sha256.Sum256([]byte(codeVerifier))
	codeChallenge := base64.RawURLEncoding.EncodeToString(hash[:])

	// Generate state parameter (CSRF protection)
	stateBytes := make([]byte, 16)
	if _, err := rand.Read(stateBytes); err != nil {
		return "", fmt.Errorf("failed to generate state: %w", err)
	}
	state := base64.RawURLEncoding.EncodeToString(stateBytes)

	// Store pending auth
	c.mu.Lock()
	c.stateStore[state] = &pendingAuth{
		State:        state,
		CodeVerifier: codeVerifier,
		ExpiresAt:    time.Now().Add(10 * time.Minute),
	}
	c.mu.Unlock()

	// Build authorization URL
	params := url.Values{
		"response_type":         {"code"},
		"client_id":             {c.config.ClientID},
		"redirect_uri":          {c.config.RedirectURI},
		"scope":                 {strings.Join(c.config.Scopes, " ")},
		"state":                 {state},
		"code_challenge":        {codeChallenge},
		"code_challenge_method": {"S256"},
	}
	if nonce != "" {
		params.Set("nonce", nonce)
	}

	return c.config.AuthEndpoint + "?" + params.Encode(), nil
}

// ExchangeCode exchanges an authorization code for tokens
func (c *OAuthClient) ExchangeCode(ctx context.Context, code, state string) (*OAuthToken, error) {
	// Validate and retrieve state
	c.mu.Lock()
	pending, exists := c.stateStore[state]
	if exists {
		delete(c.stateStore, state)
	}
	c.mu.Unlock()

	if !exists {
		return nil, fmt.Errorf("invalid state parameter")
	}

	if time.Now().After(pending.ExpiresAt) {
		return nil, fmt.Errorf("authorization request expired")
	}

	// Exchange code for tokens
	params := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {c.config.RedirectURI},
		"client_id":     {c.config.ClientID},
		"code_verifier": {pending.CodeVerifier},
	}

	// Confidential clients include client secret
	if c.config.ClientSecret != "" {
		params.Set("client_secret", c.config.ClientSecret)
	}

	return c.requestToken(ctx, params)
}

// RefreshToken exchanges a refresh token for new tokens
func (c *OAuthClient) RefreshToken(ctx context.Context, userID string) (*OAuthToken, error) {
	stored, err := c.tokenStore.Load(userID)
	if err != nil || stored == nil {
		return nil, fmt.Errorf("no stored token for user %s", userID)
	}

	if stored.RefreshToken == "" {
		return nil, fmt.Errorf("no refresh token available")
	}

	params := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {stored.RefreshToken},
		"client_id":     {c.config.ClientID},
	}

	if c.config.ClientSecret != "" {
		params.Set("client_secret", c.config.ClientSecret)
	}

	newToken, err := c.requestToken(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("token refresh failed: %w", err)
	}

	if err := c.tokenStore.Save(userID, newToken); err != nil {
		return nil, fmt.Errorf("failed to save refreshed token: %w", err)
	}

	return newToken, nil
}

// GetValidToken returns a valid access token, refreshing if needed
func (c *OAuthClient) GetValidToken(ctx context.Context, userID string) (*OAuthToken, error) {
	token, err := c.tokenStore.Load(userID)
	if err != nil {
		return nil, fmt.Errorf("failed to load token: %w", err)
	}

	if token == nil {
		return nil, fmt.Errorf("no token for user %s", userID)
	}

	if token.IsExpired() {
		return c.RefreshToken(ctx, userID)
	}

	return token, nil
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

func (c *OAuthClient) requestToken(ctx context.Context, params url.Values) (*OAuthToken, error) {
	req, err := http.NewRequestWithContext(ctx,
		http.MethodPost,
		c.config.TokenEndpoint,
		strings.NewReader(params.Encode()))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, fmt.Errorf("failed to read token response: %w", err)
	}

	var tokenResp tokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("failed to parse token response: %w", err)
	}

	if tokenResp.Error != "" {
		return nil, fmt.Errorf("token error: %s: %s", tokenResp.Error, tokenResp.ErrorDesc)
	}

	scopes := strings.Split(tokenResp.Scope, " ")
	return &OAuthToken{
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		IDToken:      tokenResp.IDToken,
		ExpiresAt:    time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second),
		Scopes:       scopes,
	}, nil
}
```

---
