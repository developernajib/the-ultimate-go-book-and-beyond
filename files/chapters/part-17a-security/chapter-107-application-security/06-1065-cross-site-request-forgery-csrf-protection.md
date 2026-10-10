## 107.5 Cross-Site Request Forgery (CSRF) Protection

CSRF attacks trick users into performing unintended actions. Production Go applications must implement CSRF tokens.

A critical detail that homebrew implementations often miss: each token must be bound to the session that requested it. A store that accepts any token it ever issued is broken, because an attacker can obtain a valid token from their own session and embed it in the forged request. The store below keys every token by session ID so a token is only valid for the session it was issued to.

```go
package csrf

import (
    "crypto/rand"
    "encoding/base64"
    "fmt"
    "net/http"
    "sync"
    "time"
)

// TokenStore manages CSRF tokens with expiration
type TokenStore struct {
    tokens map[string]time.Time
    mu     sync.RWMutex
}

func NewTokenStore() *TokenStore {
    store := &TokenStore{
        tokens: make(map[string]time.Time),
    }

    // Clean expired tokens every 5 minutes
    go store.cleanExpired()

    return store
}

// GenerateToken creates a new CSRF token bound to the given session.
// Binding to the session is essential: a token valid for any session
// would let an attacker use their own token in a forged request.
func (s *TokenStore) GenerateToken(sessionID string) (string, error) {
    b := make([]byte, 32)
    if _, err := rand.Read(b); err != nil {
        return "", err
    }

    token := base64.URLEncoding.EncodeToString(b)

    s.mu.Lock()
    s.tokens[sessionID+":"+token] = time.Now().Add(1 * time.Hour)
    s.mu.Unlock()

    return token, nil
}

// ValidateToken checks if token is valid for this session, not expired,
// and consumes it (single-use)
func (s *TokenStore) ValidateToken(sessionID, token string) bool {
    s.mu.Lock()
    defer s.mu.Unlock()

    key := sessionID + ":" + token
    expiry, exists := s.tokens[key]
    if !exists {
        return false
    }

    // Always delete the token - CSRF tokens must be single-use
    // to prevent replay attacks
    delete(s.tokens, key)

    if time.Now().After(expiry) {
        return false
    }

    return true
}

// cleanExpired removes expired tokens
func (s *TokenStore) cleanExpired() {
    ticker := time.NewTicker(5 * time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        s.mu.Lock()
        now := time.Now()
        for token, expiry := range s.tokens {
            if now.After(expiry) {
                delete(s.tokens, token)
            }
        }
        s.mu.Unlock()
    }
}

// Middleware provides CSRF protection
func Middleware(store *TokenStore) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Only check CSRF for state-changing methods
            if r.Method == "POST" || r.Method == "PUT" || r.Method == "DELETE" || r.Method == "PATCH" {
                sessionID := GetSessionIDFromRequest(r) // from your session layer

                token := r.Header.Get("X-CSRF-Token")

                if token == "" {
                    // Fallback to form value
                    token = r.FormValue("csrf_token")
                }

                if !store.ValidateToken(sessionID, token) {
                    http.Error(w, "Invalid CSRF token", http.StatusForbidden)
                    return
                }
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Example usage in handler
func FormHandler(store *TokenStore) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        if r.Method == "GET" {
            token, err := store.GenerateToken(GetSessionIDFromRequest(r))
            if err != nil {
                http.Error(w, "Server error", http.StatusInternalServerError)
                return
            }

            // Render form with token
            fmt.Fprintf(w, `
                <form method="POST">
                    <input type="hidden" name="csrf_token" value="%s">
                    <button type="submit">Submit</button>
                </form>
            `, token)
            return
        }

        // POST request - token already validated by middleware
        fmt.Fprintf(w, "Form submitted successfully!")
    }
}

// GetSessionIDFromRequest extracts session ID from cookie
func GetSessionIDFromRequest(r *http.Request) string {
    if cookie, err := r.Cookie("session_id"); err == nil {
        return cookie.Value
    }
    return ""
}
```

### Junior → FAANG: When CSRF Matters and When It Does Not

CSRF is one of the most misunderstood attack categories for juniors. The common mistake is either ignoring it entirely or applying CSRF tokens to APIs that do not need them.

**Gap to close:** CSRF attacks exploit browser behavior: the browser automatically sends cookies with every request to a domain. If your API uses cookies for authentication, it is CSRF-vulnerable. If your API uses Bearer tokens in the `Authorization` header, it is not CSRF-vulnerable because browsers do not automatically send `Authorization` headers cross-origin. Know which authentication mechanism your API uses before deciding whether CSRF protection is needed.

**First-job habit:** For any server-rendered form, always use a CSRF token library rather than implementing your own. Libraries handle token generation with sufficient entropy, secure comparison, and expiry. Homebrew implementations frequently have timing side-channels or insufficient token lengths.

**Interview framing:** When asked about CSRF, explain the attack (cross-origin request using the victim's cookie), the condition for vulnerability (cookie-based auth), and the defense (synchronizer token pattern or `SameSite=Strict` cookies). Adding that `SameSite=Strict` is now widely supported and provides defense-in-depth alongside token validation shows current knowledge.

### Senior @ FAANG: CSRF Policy in Modern API Design

At senior level, CSRF protection is an API design decision, not just a middleware configuration. The authentication mechanism choice has security implications that affect the entire API surface.

**Authentication mechanism as CSRF control:** Choosing `Authorization: Bearer` header-based authentication over cookie-based authentication eliminates CSRF as a threat category for the API. This is a significant security simplification. Document this in your API design ADR: "We use Bearer token authentication to eliminate CSRF attack surface. Endpoints that require cookie-based authentication for browser compatibility (the OAuth callback, the logout endpoint) use SameSite=Strict and additionally validate the CSRF token." This explicitness prevents engineers from accidentally mixing authentication mechanisms.

**SameSite cookie policy governance:** `SameSite=Strict` prevents cookies from being sent on any cross-origin request. `SameSite=Lax` (the browser default for new cookies) allows cookies on top-level navigation but not on subresource requests. Neither replaces CSRF token validation for sensitive state-changing operations, but both reduce the attack surface. Define your cookie policy organization-wide, document it, and enforce it with a shared cookie-setting utility that applies the correct attributes by default. Individual handlers that set cookies directly are a governance gap.

**Double-submit cookie as a stateless CSRF defense:** For stateless services that cannot share session state (microservices, CDN edge functions), the double-submit cookie pattern provides CSRF protection without server-side state. The server sets a random CSRF token as a cookie and requires the same value in a request header or form field. An attacker cannot read the cookie cross-origin, so they cannot forge the header. Document the conditions under which double-submit is safe (the domain does not have subdomains that could be compromised to write cookies) and when the synchronizer token pattern is required instead.

**Measurement and alerting:** CSRF attack attempts appear as requests with invalid or missing tokens to state-changing endpoints. Track the `csrf_validation_failure_total` counter by endpoint and alert on sustained spikes. A spike often indicates an automated scanning tool probing for CSRF vulnerabilities. Surface these events to your security team with the source IP for further investigation.

---
