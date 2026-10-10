## 90I.7 CircleCI - Session Cookie Theft Bypasses MFA (2023)

### The Attack Timeline

On January 4, 2023, CircleCI - one of the most popular continuous integration/continuous deployment (CI/CD)
platforms - disclosed a security incident that forced them to rotate every customer secret stored on the
platform. The breach demonstrated a critical weakness in modern authentication: session cookies, once stolen,
provide full authenticated access regardless of MFA.

**Phase 1: Engineer Laptop Compromise (December 16, 2022)**

An attacker compromised a CircleCI engineer's laptop through malware that was not detected by the company's
endpoint detection and response (EDR) solution. The malware was a sophisticated information stealer specifically
designed to extract session cookies from browsers. The engineer had active authenticated sessions to CircleCI's
internal production systems.

**Phase 2: Session Hijacking (December 19, 2022)**

Using the stolen session cookies, the attacker authenticated to CircleCI's internal systems as the compromised
engineer. The session cookies were valid because:
- The cookies were not bound to the original device
- The cookies did not expire when the browser was closed
- The cookies were valid even when used from a different IP address and User-Agent
- MFA had been satisfied when the original session was created, so the cookie represented a fully authenticated
  state

The attacker then used the engineer's access to reach CircleCI's production database, which contained:
- Customer environment variables (API keys, tokens, secrets)
- Encryption keys used to protect customer secrets
- OAuth tokens for customer integrations with GitHub, Bitbucket, and AWS

**Phase 3: Data Exfiltration (December 19-22, 2022)**

The attacker accessed the production database and exfiltrated customer secrets, encryption keys, and OAuth tokens.
They specifically targeted high-value secrets - AWS access keys, API tokens, and signing keys - that would
provide access to customer infrastructure.

**Phase 4: Discovery and Response (December 29, 2022 - January 4, 2023)**

CircleCI detected the compromise on December 29, 2022, through an alert triggered by unusual database access
patterns. They immediately began their incident response process and, critically, made the decision to rotate
every customer secret on the platform - an unprecedented action that affected hundreds of thousands of projects.

CircleCI's public disclosure on January 4, 2023, was accompanied by clear guidance:
- Rotate all secrets stored in CircleCI (environment variables, contexts, project API tokens)
- Review internal logs for unauthorized access from December 16, 2022 to January 4, 2023
- Rotate any secrets that were referenced in CircleCI configurations

### Technical Root Cause Analysis

1. **Session cookies not bound to devices**: The stolen session cookie worked from any device, any IP, any
   browser. There was no verification that the session was being used from the same device that created it.

2. **MFA is session-creation-time only**: MFA verified the user's identity when the session was created, but the
   resulting session cookie carried full authenticated access with no ongoing verification.

3. **Persistent sessions with excessive lifetime**: The session cookies did not expire when the browser closed
   and had long lifetimes, maximizing the window of opportunity for theft.

4. **Engineer access to production secrets**: A single engineer's session provided access to customer secrets in
   the production database, violating the principle of least privilege.

### Go Code: Device-Bound Sessions

Device-bound sessions prevent stolen session cookies from being used on a different device. The session is
cryptographically tied to a device fingerprint that is verified on every request:

```go
package devicesession

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Session represents an authenticated session bound to a specific device.
type Session struct {
	ID             string    `json:"id"`
	UserID         string    `json:"userId"`
	DeviceHash     string    `json:"deviceHash"`
	IPNetwork      string    `json:"ipNetwork"` // /24 network, not exact IP.
	CreatedAt      time.Time `json:"createdAt"`
	ExpiresAt      time.Time `json:"expiresAt"`
	LastVerifiedAt time.Time `json:"lastVerifiedAt"`
	MFAVerified    bool      `json:"mfaVerified"`
	MFAMethod      string    `json:"mfaMethod"`
	RiskScore      int       `json:"riskScore"`
}

// DeviceFingerprint captures device-specific attributes that are used to
// bind a session to the device that created it.
type DeviceFingerprint struct {
	UserAgent      string `json:"userAgent"`
	AcceptLanguage string `json:"acceptLanguage"`
	Platform       string `json:"platform"`
	ScreenRes      string `json:"screenRes,omitempty"`
	Timezone       string `json:"timezone,omitempty"`
	ClientCertHash string `json:"clientCertHash,omitempty"`
}

// SessionStore is the interface for session persistence.
type SessionStore interface {
	Save(ctx context.Context, session *Session) error
	Get(ctx context.Context, sessionID string) (*Session, error)
	Delete(ctx context.Context, sessionID string) error
	DeleteAllForUser(ctx context.Context, userID string) error
}

// SessionManager handles creation, validation, and lifecycle of device-bound
// sessions. It re-verifies device binding on every request, not just at
// session creation time.
type SessionManager struct {
	store           SessionStore
	signingKey      []byte
	sessionLifetime time.Duration
	reAuthInterval  time.Duration
	mu              sync.RWMutex
}

// SessionManagerConfig configures session behavior.
type SessionManagerConfig struct {
	// SigningKey is used to HMAC session cookies, preventing forgery.
	SigningKey []byte

	// SessionLifetime is the maximum duration of a session.
	SessionLifetime time.Duration

	// ReAuthInterval forces re-authentication after this duration,
	// even if the session is otherwise valid.
	ReAuthInterval time.Duration
}

// NewSessionManager creates a session manager with device-binding enforcement.
func NewSessionManager(store SessionStore, config SessionManagerConfig) *SessionManager {
	if config.SessionLifetime == 0 {
		config.SessionLifetime = 8 * time.Hour
	}
	if config.ReAuthInterval == 0 {
		config.ReAuthInterval = 1 * time.Hour
	}

	return &SessionManager{
		store:           store,
		signingKey:      config.SigningKey,
		sessionLifetime: config.SessionLifetime,
		reAuthInterval:  config.ReAuthInterval,
	}
}

// CreateSession creates a new session bound to the requesting device.
func (sm *SessionManager) CreateSession(
	ctx context.Context,
	userID string,
	r *http.Request,
	mfaMethod string,
) (*Session, string, error) {
	fingerprint := sm.extractFingerprint(r)
	deviceHash := sm.hashFingerprint(fingerprint)

	sessionID, err := generateSecureID(32)
	if err != nil {
		return nil, "", fmt.Errorf("generating session ID: %w", err)
	}

	now := time.Now().UTC()
	session := &Session{
		ID:             sessionID,
		UserID:         userID,
		DeviceHash:     deviceHash,
		IPNetwork:      extractNetwork(r.RemoteAddr),
		CreatedAt:      now,
		ExpiresAt:      now.Add(sm.sessionLifetime),
		LastVerifiedAt: now,
		MFAVerified:    true,
		MFAMethod:      mfaMethod,
	}

	if err := sm.store.Save(ctx, session); err != nil {
		return nil, "", fmt.Errorf("saving session: %w", err)
	}

	cookie := sm.signSessionCookie(sessionID, deviceHash)
	return session, cookie, nil
}

// ValidateRequest checks the session cookie, verifies device binding, and
// returns the session if valid. This runs on EVERY request.
func (sm *SessionManager) ValidateRequest(
	ctx context.Context,
	r *http.Request,
) (*Session, error) {
	cookie, err := r.Cookie("session")
	if err != nil {
		return nil, errors.New("no session cookie")
	}

	sessionID, cookieDeviceHash, err := sm.verifySessionCookie(cookie.Value)
	if err != nil {
		return nil, fmt.Errorf("invalid session cookie: %w", err)
	}

	session, err := sm.store.Get(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("session not found: %w", err)
	}

	// Check expiry.
	now := time.Now().UTC()
	if now.After(session.ExpiresAt) {
		_ = sm.store.Delete(ctx, sessionID)
		return nil, errors.New("session expired")
	}

	// CRITICAL: Verify device binding on every request.
	currentFingerprint := sm.extractFingerprint(r)
	currentDeviceHash := sm.hashFingerprint(currentFingerprint)

	if currentDeviceHash != session.DeviceHash {
		// Device mismatch - potential session theft.
		_ = sm.store.Delete(ctx, sessionID)
		return nil, fmt.Errorf(
			"device binding mismatch: session created on device %s, "+
				"request from device %s (possible session theft)",
			session.DeviceHash[:8], currentDeviceHash[:8],
		)
	}

	if cookieDeviceHash != session.DeviceHash {
		_ = sm.store.Delete(ctx, sessionID)
		return nil, errors.New("cookie device hash mismatch")
	}

	// Check IP network (allow within /24, flag network changes).
	currentNetwork := extractNetwork(r.RemoteAddr)
	if currentNetwork != session.IPNetwork {
		session.RiskScore += 25
	}

	// Check if re-authentication is required.
	if now.Sub(session.LastVerifiedAt) > sm.reAuthInterval {
		return nil, fmt.Errorf("re-authentication required (last verified %s ago)",
			now.Sub(session.LastVerifiedAt).Round(time.Minute))
	}

	return session, nil
}

// extractFingerprint collects device-identifying attributes from the request.
func (sm *SessionManager) extractFingerprint(r *http.Request) DeviceFingerprint {
	return DeviceFingerprint{
		UserAgent:      r.Header.Get("User-Agent"),
		AcceptLanguage: r.Header.Get("Accept-Language"),
		Platform:       r.Header.Get("Sec-Ch-Ua-Platform"),
		Timezone:       r.Header.Get("X-Timezone"),
	}
}

// hashFingerprint creates a stable hash of device attributes.
func (sm *SessionManager) hashFingerprint(fp DeviceFingerprint) string {
	data, _ := json.Marshal(fp)
	h := hmac.New(sha256.New, sm.signingKey)
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// signSessionCookie creates an HMAC-signed cookie value that includes
// both the session ID and the device hash, preventing forgery.
func (sm *SessionManager) signSessionCookie(sessionID, deviceHash string) string {
	payload := sessionID + "|" + deviceHash
	h := hmac.New(sha256.New, sm.signingKey)
	h.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(h.Sum(nil))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + sig
}

// verifySessionCookie validates the HMAC signature and extracts the session ID
// and device hash.
func (sm *SessionManager) verifySessionCookie(cookieValue string) (string, string, error) {
	parts := strings.SplitN(cookieValue, ".", 2)
	if len(parts) != 2 {
		return "", "", errors.New("malformed cookie")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", "", errors.New("invalid cookie encoding")
	}

	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", "", errors.New("invalid signature encoding")
	}

	h := hmac.New(sha256.New, sm.signingKey)
	h.Write(payloadBytes)
	expectedSig := h.Sum(nil)

	if !hmac.Equal(sigBytes, expectedSig) {
		return "", "", errors.New("invalid cookie signature")
	}

	payload := strings.SplitN(string(payloadBytes), "|", 2)
	if len(payload) != 2 {
		return "", "", errors.New("malformed cookie payload")
	}

	return payload[0], payload[1], nil
}

// RevokeAllSessions terminates all sessions for a user - use this when
// a compromise is suspected.
func (sm *SessionManager) RevokeAllSessions(ctx context.Context, userID string) error {
	return sm.store.DeleteAllForUser(ctx, userID)
}

// SetCookie creates an HTTP cookie with security best practices.
func SetCookie(w http.ResponseWriter, name, value, domain string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Domain:   domain,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

func generateSecureID(length int) (string, error) {
	b := make([]byte, length)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func extractNetwork(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return "unknown"
	}
	// Use /24 network for IPv4, /48 for IPv6.
	if ip.To4() != nil {
		_, network, _ := net.ParseCIDR(ip.String() + "/24")
		if network != nil {
			return network.String()
		}
	}
	return ip.String()
}
```

### Engineering Lessons

1. **Session cookies are bearer tokens.** Once stolen, they bypass all authentication including MFA. Bind
   sessions to devices using fingerprinting and re-verify on every request.

2. **MFA protects session creation, not the session itself.** The industry treats MFA as a complete solution,
   but it only authenticates the user at login time. Continuous verification requires device binding, IP
   validation, and periodic re-authentication.

3. **CI/CD platforms are high-value targets.** They contain the secrets needed to deploy to production. Treat
   CI/CD access as production access - with the same security controls, monitoring, and least-privilege policies.

4. **Aggressive incident response builds trust.** CircleCI's decision to rotate every customer secret was
   operationally painful but demonstrated integrity. Contrast this with Okta's minimization approach.

---

### Junior → FAANG: Session Security and CI/CD Access Controls as Interview Topics

The CircleCI breach is the interview answer to "why is MFA not sufficient to protect sessions?" MFA authenticates the user at login time, but the resulting session token is a bearer token: whoever possesses it has full session access, regardless of how it was obtained. CircleCI's attacker stole session cookies from a laptop and used them to bypass MFA entirely. The defense is session binding: cryptographically linking the session to the device that created it, using device fingerprint, IP address, or hardware-bound keys. For FAANG interviews, CI/CD security is increasingly important because CI/CD systems hold production deployment credentials. Treat CI/CD access as production access: the same MFA requirements, the same privileged access monitoring, and the same least-privilege policies. If an attacker can push to your CI/CD pipeline, they can deploy malicious code to production.

### Senior @ FAANG: CI/CD Security as a Platform Standard and Secrets Rotation as a Platform Capability

At L6, the CircleCI breach demonstrates that CI/CD platforms are tier-0 security infrastructure. They hold credentials for every environment they deploy to, which means a compromised CI/CD platform is effectively a compromised production environment. At staff level, you define explicit security requirements for the CI/CD platform: all secrets are stored in a vault integration (not in environment variables that are readable from the CI/CD UI), all secrets are scoped to the minimum required permissions for the specific pipeline step that uses them, and all secrets have automated rotation with rotation events logged in the tamper-evident audit trail. The CircleCI response (requiring all customers to rotate all secrets) demonstrates the operational cost of not having automated rotation: when rotation is manual, a mass rotation event takes days. When rotation is automated, it takes minutes. Building the automated rotation capability as a platform tool rather than a team-level practice is the investment that makes the difference between a four-day incident and a four-hour one.

