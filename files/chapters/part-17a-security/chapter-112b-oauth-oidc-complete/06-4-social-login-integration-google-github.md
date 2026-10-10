## 112B.5 Social Login Integration (Google, GitHub)

Social login with Google and GitHub follows the same authorization code flow but diverges in how user identity is returned: Google issues an OIDC ID token with a signed `sub` claim, while GitHub returns a user profile via a REST API call after the token exchange. The implementation normalizes both providers into a common `SocialUser` struct, so the account linking and session creation logic downstream is provider-agnostic. This example reads identity from the providers' user info APIs after the token exchange. For Google you can go further and validate the returned ID token's signature against Google's JWKS endpoint (the `coreos/go-oidc` package handles this), which also blocks token substitution attacks where a token issued to another application is replayed against yours.

```go
package sociallogin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2"
	googleoauth "golang.org/x/oauth2/google"
)

// SocialProvider represents a social OAuth provider
type SocialProvider string

const (
	ProviderGoogle    SocialProvider = "google"
	ProviderGitHub    SocialProvider = "github"
	ProviderMicrosoft SocialProvider = "microsoft"
)

// SocialUser represents a user from a social provider
type SocialUser struct {
	Provider      SocialProvider
	ProviderID    string
	Email         string
	EmailVerified bool
	Name          string
	Picture       string
	RawClaims     map[string]any
}

// SocialLoginManager manages social login integrations
type SocialLoginManager struct {
	mu        sync.Mutex
	providers map[SocialProvider]*oauth2.Config
	states    map[string]SocialProvider
}

// NewSocialLoginManager creates a new social login manager
func NewSocialLoginManager() *SocialLoginManager {
	return &SocialLoginManager{
		providers: make(map[SocialProvider]*oauth2.Config),
		states:    make(map[string]SocialProvider),
	}
}

// RegisterGoogle registers Google as a social provider
func (m *SocialLoginManager) RegisterGoogle(clientID, clientSecret, redirectURL string) {
	m.providers[ProviderGoogle] = &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  redirectURL,
		Scopes:       []string{"openid", "profile", "email"},
		Endpoint:     googleoauth.Endpoint,
	}
}

// RegisterGitHub registers GitHub as a social provider
func (m *SocialLoginManager) RegisterGitHub(clientID, clientSecret, redirectURL string) {
	m.providers[ProviderGitHub] = &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  redirectURL,
		Scopes:       []string{"read:user", "user:email"},
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://github.com/login/oauth/authorize",
			TokenURL: "https://github.com/login/oauth/access_token",
		},
	}
}

// GetAuthURL returns the authorization URL for a provider
func (m *SocialLoginManager) GetAuthURL(provider SocialProvider, state string) (string, error) {
	config, exists := m.providers[provider]
	if !exists {
		return "", fmt.Errorf("provider %s not configured", provider)
	}

	m.mu.Lock()
	m.states[state] = provider
	m.mu.Unlock()

	opts := []oauth2.AuthCodeOption{
		oauth2.AccessTypeOnline,
	}

	// Provider-specific options
	if provider == ProviderGoogle {
		opts = append(opts, oauth2.SetAuthURLParam("prompt", "select_account"))
	}

	return config.AuthCodeURL(state, opts...), nil
}

// HandleCallback processes the OAuth callback
func (m *SocialLoginManager) HandleCallback(ctx context.Context, state, code string) (*SocialUser, error) {
	m.mu.Lock()
	provider, exists := m.states[state]
	if exists {
		delete(m.states, state)
	}
	m.mu.Unlock()

	if !exists {
		return nil, fmt.Errorf("invalid state")
	}

	config, exists := m.providers[provider]
	if !exists {
		return nil, fmt.Errorf("provider not configured")
	}

	// Exchange code for token
	token, err := config.Exchange(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("code exchange failed: %w", err)
	}

	// Fetch user info
	switch provider {
	case ProviderGoogle:
		return m.fetchGoogleUser(ctx, config, token)
	case ProviderGitHub:
		return m.fetchGitHubUser(ctx, token)
	default:
		return nil, fmt.Errorf("unknown provider: %s", provider)
	}
}

// GoogleUserInfo represents Google's user info response
type GoogleUserInfo struct {
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
	GivenName     string `json:"given_name"`
	FamilyName    string `json:"family_name"`
}

func (m *SocialLoginManager) fetchGoogleUser(
	ctx context.Context,
	config *oauth2.Config,
	token *oauth2.Token,
) (*SocialUser, error) {
	client := config.Client(ctx, token)
	resp, err := client.Get("https://www.googleapis.com/oauth2/v3/userinfo")
	if err != nil {
		return nil, fmt.Errorf("failed to fetch Google user info: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return nil, err
	}

	var info GoogleUserInfo
	if err := json.Unmarshal(body, &info); err != nil {
		return nil, fmt.Errorf("failed to parse Google user info: %w", err)
	}

	return &SocialUser{
		Provider:      ProviderGoogle,
		ProviderID:    info.Sub,
		Email:         info.Email,
		EmailVerified: info.EmailVerified,
		Name:          info.Name,
		Picture:       info.Picture,
	}, nil
}

// GitHubUser represents GitHub's user response
type GitHubUser struct {
	ID        int    `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
	Email     string `json:"email"`
}

// GitHubEmail represents a GitHub email
type GitHubEmail struct {
	Email    string `json:"email"`
	Verified bool   `json:"verified"`
	Primary  bool   `json:"primary"`
}

func (m *SocialLoginManager) fetchGitHubUser(ctx context.Context, token *oauth2.Token) (*SocialUser, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/user", nil)
	req.Header.Set("Authorization", "token "+token.AccessToken)
	req.Header.Set("Accept", "application/vnd.github.v3+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch GitHub user: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	var user GitHubUser
	json.Unmarshal(body, &user)

	// Fetch primary email separately if not public
	email := user.Email
	verified := false

	if email == "" {
		emailReq, _ := http.NewRequestWithContext(ctx, http.MethodGet,
			"https://api.github.com/user/emails", nil)
		emailReq.Header.Set("Authorization", "token "+token.AccessToken)
		emailReq.Header.Set("Accept", "application/vnd.github.v3+json")

		emailResp, err := http.DefaultClient.Do(emailReq)
		if err == nil {
			defer emailResp.Body.Close()
			emailBody, _ := io.ReadAll(io.LimitReader(emailResp.Body, 64*1024))
			var emails []GitHubEmail
			json.Unmarshal(emailBody, &emails)

			for _, e := range emails {
				if e.Primary {
					email = e.Email
					verified = e.Verified
					break
				}
			}
		}
	}

	return &SocialUser{
		Provider:      ProviderGitHub,
		ProviderID:    fmt.Sprintf("%d", user.ID),
		Email:         email,
		EmailVerified: verified,
		Name:          user.Name,
		Picture:       user.AvatarURL,
	}, nil
}

// SocialLoginHandler provides HTTP handlers for social login
type SocialLoginHandler struct {
	manager     *SocialLoginManager
	userService UserService
}

// UserService interface for user management
type UserService interface {
	FindByProviderID(provider SocialProvider, providerID string) (*LocalUser, error)
	CreateFromSocial(user *SocialUser) (*LocalUser, error)
	LinkSocialAccount(userID string, social *SocialUser) error
}

// LocalUser represents a local user account
type LocalUser struct {
	ID    string
	Email string
	Name  string
}

// HandleSocialCallback handles OAuth callback and creates/links user
func (h *SocialLoginHandler) HandleSocialCallback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")
	errParam := r.URL.Query().Get("error")

	if errParam != "" {
		http.Error(w, "OAuth error: "+errParam, http.StatusBadRequest)
		return
	}

	// Verify CSRF state. In production, check it against the session
	if state == "" {
		http.Error(w, "Missing state", http.StatusBadRequest)
		return
	}

	socialUser, err := h.manager.HandleCallback(r.Context(), state, code)
	if err != nil {
		http.Error(w, "Authentication failed", http.StatusInternalServerError)
		return
	}

	// Find or create local user
	localUser, err := h.userService.FindByProviderID(socialUser.Provider, socialUser.ProviderID)
	if err != nil {
		// Create new user
		localUser, err = h.userService.CreateFromSocial(socialUser)
		if err != nil {
			http.Error(w, "Failed to create user", http.StatusInternalServerError)
			return
		}
	}

	// Create session and redirect
	// In production: create JWT session token
	_ = localUser
	http.Redirect(w, r, "/dashboard", http.StatusFound)
}

// DeviceFlowClient implements OAuth 2.0 Device Authorization Grant (RFC 8628)
type DeviceFlowClient struct {
	clientID       string
	deviceEndpoint string
	tokenEndpoint  string
	httpClient     *http.Client
}

// DeviceAuthResponse represents the device authorization response
type DeviceAuthResponse struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
}

// StartDeviceFlow initiates the device authorization flow
func (c *DeviceFlowClient) StartDeviceFlow(ctx context.Context, scopes []string) (*DeviceAuthResponse, error) {
	params := url.Values{
		"client_id": {c.clientID},
		"scope":     {strings.Join(scopes, " ")},
	}

	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.deviceEndpoint, strings.NewReader(params.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("device auth request failed: %w", err)
	}
	defer resp.Body.Close()

	var authResp DeviceAuthResponse
	json.NewDecoder(resp.Body).Decode(&authResp)

	return &authResp, nil
}

// PollForToken polls the token endpoint until the user authorizes
func (c *DeviceFlowClient) PollForToken(ctx context.Context, deviceCode string, interval int) (*OAuthToken, error) {
	pollInterval := time.Duration(interval) * time.Second

	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(pollInterval):
		}

		params := url.Values{
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
			"device_code": {deviceCode},
			"client_id":   {c.clientID},
		}

		req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
			c.tokenEndpoint, strings.NewReader(params.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

		resp, err := c.httpClient.Do(req)
		if err != nil {
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var tokenResp struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			ExpiresIn    int    `json:"expires_in"`
			Error        string `json:"error"`
		}
		json.Unmarshal(body, &tokenResp)

		switch tokenResp.Error {
		case "authorization_pending":
			continue // User hasn't authorized yet
		case "slow_down":
			pollInterval += 5 * time.Second // Increase interval
			continue
		case "expired_token":
			return nil, fmt.Errorf("device code expired")
		case "access_denied":
			return nil, fmt.Errorf("user denied access")
		case "":
			return &OAuthToken{
				AccessToken:  tokenResp.AccessToken,
				RefreshToken: tokenResp.RefreshToken,
				ExpiresAt:    time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second),
			}, nil
		}
	}
}

// OAuthToken placeholder
type OAuthToken struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	Scopes       []string
}
```

---
