## 112B.6 OIDC Session Management & Logout

OIDC session management must handle three logout scenarios: local logout (clear the Go session cookie), RP-initiated logout (redirect to the authorization server's end-session endpoint with an `id_token_hint`), and back-channel logout (handle a signed logout token from the authorization server when the user logs out of another client). The session is stored server-side with only a random opaque ID in the `HttpOnly, Secure, SameSite=Lax` cookie, so all session data is controlled server-side and the client cannot manipulate user identity or expiry. Cap the session TTL at the OIDC ID token's `exp` claim so the Go application's session lifetime stays bounded by the authorization server's policy rather than an independently configured value that could outlive the user's intent.

```go
package session

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// SessionManager manages OIDC sessions
type SessionManager struct {
	mu         sync.RWMutex
	sessions   map[string]*Session
	cookieName string
	cookieOpts CookieOptions
	sessionTTL time.Duration
}

// Session represents an authenticated session
type Session struct {
	ID           string
	UserID       string
	IDToken      string
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	CreatedAt    time.Time
	LastAccessed time.Time
	AuthTime     time.Time
	AMR          []string // Authentication Methods References
	ACR          string   // Authentication Context Class Reference
}

// CookieOptions configures session cookie security
type CookieOptions struct {
	Domain   string
	Path     string
	Secure   bool
	HTTPOnly bool
	SameSite http.SameSite
}

// NewSessionManager creates a new session manager
func NewSessionManager(cookieName string, sessionTTL time.Duration, opts CookieOptions) *SessionManager {
	return &SessionManager{
		sessions:   make(map[string]*Session),
		cookieName: cookieName,
		cookieOpts: opts,
		sessionTTL: sessionTTL,
	}
}

// Create creates a new session and sets the session cookie
func (m *SessionManager) Create(w http.ResponseWriter, r *http.Request, session *Session) error {
	// Generate session ID
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return fmt.Errorf("failed to generate session ID: %w", err)
	}
	sessionID := base64.RawURLEncoding.EncodeToString(b)

	now := time.Now()
	session.ID = sessionID
	session.CreatedAt = now
	session.LastAccessed = now
	session.ExpiresAt = now.Add(m.sessionTTL)

	m.mu.Lock()
	m.sessions[sessionID] = session
	m.mu.Unlock()

	// Set secure session cookie
	http.SetCookie(w, &http.Cookie{
		Name:     m.cookieName,
		Value:    sessionID,
		Path:     m.cookieOpts.Path,
		Domain:   m.cookieOpts.Domain,
		Expires:  session.ExpiresAt,
		Secure:   m.cookieOpts.Secure,
		HttpOnly: m.cookieOpts.HTTPOnly,
		SameSite: m.cookieOpts.SameSite,
	})

	return nil
}

// Get retrieves and validates a session
func (m *SessionManager) Get(r *http.Request) (*Session, error) {
	cookie, err := r.Cookie(m.cookieName)
	if err != nil {
		return nil, fmt.Errorf("no session cookie")
	}

	m.mu.RLock()
	session, exists := m.sessions[cookie.Value]
	m.mu.RUnlock()

	if !exists {
		return nil, fmt.Errorf("session not found")
	}

	if time.Now().After(session.ExpiresAt) {
		m.Delete(r)
		return nil, fmt.Errorf("session expired")
	}

	// Update last accessed
	m.mu.Lock()
	session.LastAccessed = time.Now()
	m.mu.Unlock()

	return session, nil
}

// Delete invalidates a session
func (m *SessionManager) Delete(r *http.Request) {
	cookie, err := r.Cookie(m.cookieName)
	if err != nil {
		return
	}

	m.mu.Lock()
	delete(m.sessions, cookie.Value)
	m.mu.Unlock()
}

// Logout clears the local session and cookie (local logout)
func (m *SessionManager) Logout(w http.ResponseWriter, r *http.Request) {
	session, err := m.Get(r)
	if err == nil && session != nil {
		m.Delete(r)
	}

	// Clear cookie
	http.SetCookie(w, &http.Cookie{
		Name:     m.cookieName,
		Value:    "",
		Path:     m.cookieOpts.Path,
		MaxAge:   -1,
		Secure:   m.cookieOpts.Secure,
		HttpOnly: m.cookieOpts.HTTPOnly,
		SameSite: m.cookieOpts.SameSite,
	})

	// For RP-initiated logout, redirect to the provider's
	// end_session_endpoint with an id_token_hint instead
	http.Redirect(w, r, "/", http.StatusFound)
}

// GCExpiredSessions removes expired sessions (run periodically)
func (m *SessionManager) GCExpiredSessions() {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	for id, session := range m.sessions {
		if now.After(session.ExpiresAt) {
			delete(m.sessions, id)
		}
	}
}

// BackChannelLogoutHandler handles OIDC back-channel logout requests
func (m *SessionManager) BackChannelLogoutHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse logout token (JWT)
	logoutToken := r.FormValue("logout_token")
	if logoutToken == "" {
		http.Error(w, "missing logout_token", http.StatusBadRequest)
		return
	}

	// In production: validate logout token JWT signature
	// Extract "sub" and "sid" claims
	// Find and invalidate matching sessions

	type logoutTokenClaims struct {
		Sub string `json:"sub"`
		SID string `json:"sid"`
		JTI string `json:"jti"`
	}

	// Simplified: parse claims without validation (MUST validate in production)
	parts := strings.Split(logoutToken, ".")
	if len(parts) != 3 {
		http.Error(w, "invalid logout token", http.StatusBadRequest)
		return
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		http.Error(w, "invalid logout token", http.StatusBadRequest)
		return
	}

	var claims logoutTokenClaims
	json.Unmarshal(payload, &claims)

	// Invalidate sessions for this user
	m.mu.Lock()
	for id, session := range m.sessions {
		if session.UserID == claims.Sub {
			delete(m.sessions, id)
		}
	}
	m.mu.Unlock()

	w.WriteHeader(http.StatusOK)
}
```

---
