## 112C.4 Magic Link Authentication

Magic link authentication generates a 32-byte cryptographically random token, stores its SHA-256 hash (not the raw token) in the server-side store, and emails the raw token as part of the login URL, so even if the store is compromised, the attacker cannot derive valid links from the stored hashes. The token is single-use: the first validation marks it used, so a replay from a forwarded email or an insecure mail client is rejected and can be flagged for alerting. A configurable short TTL (15 minutes) limits the window for an attacker who intercepts the email to use the link before it expires.

```go
package magiclink

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// MagicLinkService handles passwordless magic link authentication
type MagicLinkService struct {
	mu       sync.RWMutex
	tokens   map[string]*MagicLinkToken
	emailSvc EmailService
	config   MagicLinkConfig
}

// MagicLinkConfig holds configuration
type MagicLinkConfig struct {
	BaseURL     string
	TokenTTL    time.Duration
	MaxAttempts int
}

// MagicLinkToken represents a pending magic link.
// Only the SHA-256 hash of the token is stored server-side
type MagicLinkToken struct {
	TokenHash string
	Email     string
	UserID    string
	ExpiresAt time.Time
	Used      bool
	IPAddress string
	Attempts  int
}

// EmailService interface for sending emails
type EmailService interface {
	Send(to, subject, htmlBody, textBody string) error
}

// NewMagicLinkService creates a magic link service
func NewMagicLinkService(emailSvc EmailService, config MagicLinkConfig) *MagicLinkService {
	return &MagicLinkService{
		tokens:   make(map[string]*MagicLinkToken),
		emailSvc: emailSvc,
		config:   config,
	}
}

// SendMagicLink generates and sends a magic link to the user
func (s *MagicLinkService) SendMagicLink(email, userID, ipAddress string) error {
	// Generate cryptographically secure token
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return fmt.Errorf("failed to generate token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	tokenHash := hashToken(token)

	// Store only the hash: a leaked store cannot yield valid links
	s.mu.Lock()
	s.tokens[tokenHash] = &MagicLinkToken{
		TokenHash: tokenHash,
		Email:     email,
		UserID:    userID,
		ExpiresAt: time.Now().Add(s.config.TokenTTL),
		Used:      false,
		IPAddress: ipAddress,
	}
	s.mu.Unlock()

	// Generate magic link URL
	magicURL := fmt.Sprintf("%s/auth/magic-link?token=%s", s.config.BaseURL, token)

	// Send email
	subject := "Your sign-in link"
	htmlBody := fmt.Sprintf(`
<!DOCTYPE html>
<html>
<body>
  <h2>Sign in to your account</h2>
  <p>Click the link below to sign in. This link expires in %d minutes.</p>
  <a href="%s" style="...">Sign In</a>
  <p>If you didn't request this, you can safely ignore this email.</p>
  <p>For security: this link can only be used once and expires at %s</p>
</body>
</html>`,
		int(s.config.TokenTTL.Minutes()),
		magicURL,
		time.Now().Add(s.config.TokenTTL).Format(time.RFC1123))

	textBody := fmt.Sprintf("Sign in link: %s\nExpires: %s",
		magicURL, time.Now().Add(s.config.TokenTTL).Format(time.RFC1123))

	return s.emailSvc.Send(email, subject, htmlBody, textBody)
}

// ValidateMagicLink validates a magic link token and returns the user ID
func (s *MagicLinkService) ValidateMagicLink(token, ipAddress string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tokenHash := hashToken(token)
	entry, exists := s.tokens[tokenHash]
	if !exists {
		return "", fmt.Errorf("invalid or expired token")
	}

	if entry.Used {
		// Potential replay attack
		// In production: alert security team
		return "", fmt.Errorf("token already used")
	}

	if time.Now().After(entry.ExpiresAt) {
		delete(s.tokens, tokenHash)
		return "", fmt.Errorf("token expired")
	}

	entry.Attempts++
	if entry.Attempts > s.config.MaxAttempts {
		delete(s.tokens, tokenHash)
		return "", fmt.Errorf("too many attempts")
	}

	// Mark as used (single-use). The entry stays until TTL cleanup
	// so a replayed link is detected as reuse, not an unknown token
	entry.Used = true

	return entry.UserID, nil
}

// hashToken returns the SHA-256 hash of a token, base64url-encoded
func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// HandleMagicLinkClick processes magic link clicks
func (s *MagicLinkService) HandleMagicLinkClick(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "Missing token", http.StatusBadRequest)
		return
	}

	userID, err := s.ValidateMagicLink(token, r.RemoteAddr)
	if err != nil {
		// Show user-friendly error page
		http.Error(w, "This link has expired or already been used. Please request a new one.", http.StatusUnauthorized)
		return
	}

	// Create authenticated session
	// In production: call session manager to create session
	_ = userID

	http.Redirect(w, r, "/dashboard", http.StatusFound)
}

// CleanupExpiredTokens removes expired tokens (run periodically)
func (s *MagicLinkService) CleanupExpiredTokens() {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	for token, entry := range s.tokens {
		if now.After(entry.ExpiresAt) {
			delete(s.tokens, token)
		}
	}
}
```

---
