## 29.7 Sessions and Cookies

### Session Management

HTTP is stateless, so sessions are implemented by issuing a signed or encrypted cookie that carries a session identifier. The `gorilla/sessions` package manages session stores backed by cookies, files, or Redis, and handles serialization transparently.

```go
package session

import (
    "crypto/rand"
    "encoding/base64"
    "sync"
    "time"
)

type Session struct {
    ID        string
    UserID    string
    Data      map[string]any
    CreatedAt time.Time
    ExpiresAt time.Time
}

type SessionStore struct {
    mu       sync.RWMutex
    sessions map[string]*Session
    ttl      time.Duration
}

func NewSessionStore(ttl time.Duration) *SessionStore {
    store := &SessionStore{
        sessions: make(map[string]*Session),
        ttl:      ttl,
    }
    go store.cleanup()
    return store
}

func (s *SessionStore) Create(userID string) *Session {
    id := generateSessionID()

    session := &Session{
        ID:        id,
        UserID:    userID,
        Data:      make(map[string]any),
        CreatedAt: time.Now(),
        ExpiresAt: time.Now().Add(s.ttl),
    }

    s.mu.Lock()
    s.sessions[id] = session
    s.mu.Unlock()

    return session
}

func (s *SessionStore) Get(id string) (*Session, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    session, exists := s.sessions[id]
    if !exists || time.Now().After(session.ExpiresAt) {
        return nil, false
    }

    return session, true
}

func (s *SessionStore) Delete(id string) {
    s.mu.Lock()
    delete(s.sessions, id)
    s.mu.Unlock()
}

func (s *SessionStore) cleanup() {
    ticker := time.NewTicker(time.Minute)
    for range ticker.C {
        s.mu.Lock()
        now := time.Now()
        for id, session := range s.sessions {
            if now.After(session.ExpiresAt) {
                delete(s.sessions, id)
            }
        }
        s.mu.Unlock()
    }
}

func generateSessionID() string {
    b := make([]byte, 32)
    rand.Read(b)
    return base64.URLEncoding.EncodeToString(b)
}
```

### Cookie Handling

Cookies must be set with `Secure`, `HttpOnly`, and `SameSite` attributes to mitigate theft via network sniffing, XSS, and CSRF respectively. Go's `http.SetCookie` accepts an `http.Cookie` struct where these attributes are explicitly controlled.

```go
package session

import (
    "net/http"
    "time"
)

const SessionCookieName = "session_id"

func SetSessionCookie(w http.ResponseWriter, sessionID string, maxAge time.Duration) {
    http.SetCookie(w, &http.Cookie{
        Name:     SessionCookieName,
        Value:    sessionID,
        Path:     "/",
        MaxAge:   int(maxAge.Seconds()),
        HttpOnly: true,
        Secure:   true,
        SameSite: http.SameSiteLaxMode,
    })
}

func GetSessionCookie(r *http.Request) (string, error) {
    cookie, err := r.Cookie(SessionCookieName)
    if err != nil {
        return "", err
    }
    return cookie.Value, nil
}

func ClearSessionCookie(w http.ResponseWriter) {
    http.SetCookie(w, &http.Cookie{
        Name:     SessionCookieName,
        Value:    "",
        Path:     "/",
        MaxAge:   -1,
        HttpOnly: true,
        Secure:   true,
    })
}
```

### Session Middleware

Session middleware runs on every request and looks up the session from the cookie. If a valid session exists, it stores the session object in the request context so downstream handlers can access the current user's session data without repeating the lookup.

```go
package middleware

func Session(store *session.SessionStore) Middleware {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            sessionID, err := session.GetSessionCookie(r)
            if err == nil {
                if sess, ok := store.Get(sessionID); ok {
                    ctx := context.WithValue(r.Context(), SessionContextKey, sess)
                    r = r.WithContext(ctx)
                }
            }

            next.ServeHTTP(w, r)
        })
    }
}

func GetSession(ctx context.Context) (*session.Session, bool) {
    sess, ok := ctx.Value(SessionContextKey).(*session.Session)
    return sess, ok
}
```

### Junior to FAANG: Session Safety Basics

The in-memory `map[string]*Session` works only for a single-process server. The moment you run two pods behind a load balancer, a user who logs in on pod A will appear logged out on pod B. Default to one of three patterns. Sticky sessions at the LB (fragile, but simple). Shared session store in Redis (standard). Stateless sessions via signed cookies or JWT (popular but has revocation problems). Know the tradeoffs.

Cookie attributes checklist. `Secure` (HTTPS only). `HttpOnly` (no JS access, defeats XSS session theft). `SameSite=Lax` (defeats most CSRF for state-changing requests). Short `MaxAge` (30 days max, shorter for sensitive ops). Consider `__Host-` prefix so the cookie is locked to your exact hostname with path `/` and no domain.

Worked example, rotating the session ID after login. Rotation prevents session fixation where an attacker sets a known session ID, tricks the user into logging in, then uses the session. Always rotate on privilege change.

```go
func Login(w http.ResponseWriter, r *http.Request) {
    user := authenticate(r)
    oldID, _ := GetSessionCookie(r)
    if oldID != "" { store.Delete(oldID) }
    sess := store.Create(user.ID)
    SetSessionCookie(w, sess.ID, 24*time.Hour)
}
```

Interview framing. "How does SameSite prevent CSRF." Answer. `SameSite=Lax` omits the cookie from cross-site POST requests, so a malicious site cannot trigger a state-changing action using the user's credentials. Top-level GET navigations still carry the cookie (which is why GETs must never mutate state). For extra safety, use `SameSite=Strict` for sensitive dashboards and require CSRF tokens for non-idempotent requests regardless.

### Senior at FAANG: Session Substrate Decisions

Pick one substrate per product surface and document the ADR.

Substrate A, encrypted cookies (Iron, Fernet, `securecookie`). Stateless, scales horizontally trivially, no backing store. Limit, 4 KB cookie size forces you to carry only user ID plus minimal claims. Revocation is hard (you must track revoked session IDs server-side defeating the statelessness benefit). Good for read-mostly public APIs with short-lived sessions.

Substrate B, server-side with Redis. The FAANG default for user-facing products. Sub-millisecond lookup. Trivial revocation (`DEL session:id`). Supports session-expiration extension on activity. Operationally, you own a Redis cluster with mTLS, eviction policies, and failover. Session data is PII and must be encrypted at rest (Redis AOF on encrypted EBS) and in transit (mTLS).

Substrate C, DynamoDB or Spanner for global products. Higher latency (5 to 20 ms) but cross-region replicated. Use when sessions must survive a regional outage without user re-login.

Substrate D, JWT. Popular, often misused. Problems, revocation requires a server-side blocklist (so you lost the "stateless" win), token size bloats headers, algorithm confusion CVEs recur every few years, clock skew causes flaky auth. FAANG usage, JWT for service-to-service (short-lived, minted per call), not for user sessions. Use opaque session IDs for users, JWT for internal machine identities.

Session fixation and rotation policy. Rotate session ID on login, on privilege escalation, on MFA step-up, and on password change. Absolute lifetime cap (24 hours for dashboards, 30 days for "remember me"). Idle timeout (30 minutes for sensitive, 24 hours for casual). These are policies, not code. Write the matrix, enforce per surface.

CSRF policy. Three approaches. Double-submit cookie (send token as cookie and header, server compares). Synchronizer token (server-side token per session). SameSite cookies (browser-enforced, not a full replacement). Defense in depth, SameSite=Lax plus double-submit for state-changing endpoints. Publish the CSRF middleware in `platform/csrf`, wire it before auth in the chain so unauth'd CSRF failures still return clear errors.

Cross-domain sessions (SSO). For multi-product orgs with `app.corp.com`, `admin.corp.com`, `api.corp.com`, set cookie domain to `.corp.com` with `__Host-` prefix where possible. Use SAML or OIDC for cross-org SSO. Do not roll your own cross-domain session protocol, you will get it wrong.

Session security incidents to prepare for. Cookie theft via reflected XSS (mitigated by CSP, HttpOnly, subresource integrity). Session prediction (mitigated by CSPRNG, min 128 bits of entropy). Session hijacking via network (mitigated by TLS, HSTS). Session reuse after logout (mitigated by server-side revocation, never just clearing the cookie). Include all four in your threat model doc.

Observability. Metrics per session event (created, renewed, revoked, expired). Alert on anomalous creation rate (credential stuffing). Log every session creation with IP and user agent hash for retrospective forensics. Never log the session ID itself, only its hash.

Session store failure modes. Redis down, does the service fail closed (all users logged out, safe) or fail open (users pass through unauth, insecure). Fail closed. Cache session data locally for a short TTL (30 seconds) to absorb brief Redis blips without user impact. Document the policy.

Staff archetype. The Identity Platform Lead owns the session ADR, the cookie spec, and the SSO protocol. Partners with security on threat models, with SRE on the Redis substrate, and with product on UX trade-offs (how often to re-auth). Not a glamorous role, and the single highest-risk one in the org when it breaks.

Multi-year roadmap. Year 1, unify on one substrate per surface, migrate off legacy. Year 2, roll passkey support (WebAuthn), deprecate password-only where possible. Year 3, cross-device session management UI for users. Year 4, continuous authentication signals (device posture, behavior) feeding adaptive session duration.

---
