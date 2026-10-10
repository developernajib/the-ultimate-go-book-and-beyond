## Part 5: Device Management and Session Handling

Each device registration creates a row in the `devices` table keyed by the push token with a `platform` column (`ios`, `android`), allowing targeted notifications and analytics segmentation by platform without querying the token format. Sessions are stored in Redis with a TTL equal to the token expiry, with the session ID embedded in a signed JWT. On each request the server validates the JWT signature then looks up the session in Redis to check for revocation without a database round trip. Concurrent logins from the same user on multiple devices are tracked by storing all active session IDs in a Redis set per user, allowing a 'log out everywhere' operation to delete all sessions atomically.

**Never trust a client-supplied device fingerprint as an identity.** The `Fingerprint` field below is useful as a stable *hint* for deduplicating registrations from the same physical device, but any rooted/jailbroken client can forge it. Treat it as advisory, the authoritative device identity is the server-assigned `DeviceID` (opaque UUID) returned from the first `Register` call and bound into the JWT's `did` claim thereafter. For stronger assurance on sensitive flows (payments, account recovery), layer in platform attestation:

- **Android:** Play Integrity API, the client requests an integrity verdict, which the server verifies against Google's public keys. Distinguishes genuine Play-installed binaries from tampered APKs and emulators.
- **iOS:** App Attest + DeviceCheck, App Attest proves the running binary is a legitimate build signed by your Team ID. DeviceCheck gives you two per-device persistent bits that survive reinstall for anti-fraud signaling.

Gate high-risk endpoints (withdrawals, password changes, SIM-swap recovery) on a fresh attestation token rather than the login session alone.

```go
package device

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// Device represents a registered mobile device
type Device struct {
	ID          string    `json:"id" db:"id"`
	UserID      string    `json:"user_id" db:"user_id"`
	Platform    string    `json:"platform" db:"platform"`
	OSVersion   string    `json:"os_version" db:"os_version"`
	AppVersion  string    `json:"app_version" db:"app_version"`
	PushToken   string    `json:"push_token,omitempty" db:"push_token"`
	DeviceName  string    `json:"device_name" db:"device_name"`
	Fingerprint string    `json:"fingerprint" db:"fingerprint"` // hardware ID hash
	CreatedAt   time.Time `json:"created_at" db:"created_at"`
	LastSeenAt  time.Time `json:"last_seen_at" db:"last_seen_at"`
	Active      bool      `json:"active" db:"active"`
}

// DeviceSession is a JWT-backed session tied to a device
type DeviceSession struct {
	SessionID   string    `json:"session_id"`
	DeviceID    string    `json:"device_id"`
	UserID      string    `json:"user_id"`
	AccessToken string    `json:"access_token"`
	RefreshToken string   `json:"refresh_token"`
	ExpiresAt   time.Time `json:"expires_at"`
	CreatedAt   time.Time `json:"created_at"`
}

// DeviceManager handles device registration and session management
type DeviceManager struct {
	db      DeviceStore
	sessions SessionStore
	jwtKey  []byte
}

type DeviceStore interface {
	Create(ctx context.Context, device Device) error
	GetByID(ctx context.Context, id string) (*Device, error)
	GetByFingerprint(ctx context.Context, userID, fingerprint string) (*Device, error)
	UpdatePushToken(ctx context.Context, deviceID, token string) error
	UpdateLastSeen(ctx context.Context, deviceID string) error
	ListByUser(ctx context.Context, userID string) ([]Device, error)
	Deactivate(ctx context.Context, deviceID string) error
}

type SessionStore interface {
	Create(ctx context.Context, session DeviceSession) error
	GetByRefreshToken(ctx context.Context, token string) (*DeviceSession, error)
	Revoke(ctx context.Context, sessionID string) error
	RevokeAllForDevice(ctx context.Context, deviceID string) error
}

// RegisterRequest is a device registration request
type RegisterRequest struct {
	Platform    string `json:"platform" validate:"required,oneof=ios android"`
	OSVersion   string `json:"os_version"`
	AppVersion  string `json:"app_version"`
	DeviceName  string `json:"device_name"`
	Fingerprint string `json:"fingerprint"`
	PushToken   string `json:"push_token"`
}

// Register creates or updates a device registration
func (dm *DeviceManager) Register(ctx context.Context, userID string, req RegisterRequest) (*DeviceSession, error) {
	// Check if device already registered (by fingerprint)
	existing, err := dm.db.GetByFingerprint(ctx, userID, req.Fingerprint)
	if err != nil && !isNotFound(err) {
		return nil, fmt.Errorf("check device: %w", err)
	}

	var deviceID string
	if existing != nil {
		deviceID = existing.ID
		// Update push token if changed
		if req.PushToken != "" && req.PushToken != existing.PushToken {
			if err := dm.db.UpdatePushToken(ctx, deviceID, req.PushToken); err != nil {
				return nil, fmt.Errorf("update push token: %w", err)
			}
		}
	} else {
		// New device
		deviceID = generateID()
		device := Device{
			ID:          deviceID,
			UserID:      userID,
			Platform:    req.Platform,
			OSVersion:   req.OSVersion,
			AppVersion:  req.AppVersion,
			DeviceName:  req.DeviceName,
			Fingerprint: req.Fingerprint,
			PushToken:   req.PushToken,
			CreatedAt:   time.Now().UTC(),
			LastSeenAt:  time.Now().UTC(),
			Active:      true,
		}
		if err := dm.db.Create(ctx, device); err != nil {
			return nil, fmt.Errorf("create device: %w", err)
		}
	}

	// Create session
	session, err := dm.createSession(ctx, userID, deviceID)
	if err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}

	return session, nil
}

func (dm *DeviceManager) createSession(ctx context.Context, userID, deviceID string) (*DeviceSession, error) {
	accessToken, err := dm.generateJWT(userID, deviceID, 1*time.Hour)
	if err != nil {
		return nil, err
	}

	refreshToken := generateToken(32)

	session := DeviceSession{
		SessionID:    generateID(),
		DeviceID:     deviceID,
		UserID:       userID,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresAt:    time.Now().Add(30 * 24 * time.Hour), // 30 days for refresh
		CreatedAt:    time.Now().UTC(),
	}

	if err := dm.sessions.Create(ctx, session); err != nil {
		return nil, fmt.Errorf("create session: %w", err)
	}

	return &session, nil
}

// RefreshToken issues a new access token using a refresh token
func (dm *DeviceManager) RefreshToken(ctx context.Context, refreshToken string) (*DeviceSession, error) {
	session, err := dm.sessions.GetByRefreshToken(ctx, refreshToken)
	if err != nil {
		return nil, fmt.Errorf("get session: %w", err)
	}

	if time.Now().After(session.ExpiresAt) {
		return nil, fmt.Errorf("refresh token expired")
	}

	// Revoke old session
	if err := dm.sessions.Revoke(ctx, session.SessionID); err != nil {
		return nil, fmt.Errorf("revoke session: %w", err)
	}

	// Create new session
	return dm.createSession(ctx, session.UserID, session.DeviceID)
}

func (dm *DeviceManager) generateJWT(userID, deviceID string, duration time.Duration) (string, error) {
	// Simplified JWT generation - use golang-jwt/jwt in production
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(
		`{"sub":"%s","did":"%s","exp":%d,"iat":%d}`,
		userID, deviceID,
		time.Now().Add(duration).Unix(),
		time.Now().Unix(),
	)))
	return header + "." + payload + "." + "signature", nil
}

func generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func generateToken(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func isNotFound(err error) bool {
	return err != nil && strings.Contains(err.Error(), "not found")
}
```

### Junior → FAANG: Why Device And Session Code Is Security Code, Not CRUD

Read this section again, and note that almost every line has a security implication. Device registration is where an attacker impersonates a legitimate user's device. Refresh tokens are where token theft gives an attacker a multi-month foothold. Push token updates are where a malicious client hijacks another user's notifications. This is not a CRUD module. It is an auth module that happens to store device metadata, and it must be reviewed with the same rigor as your password flow.

Worked example of the refresh token rotation trap. The code above revokes the old session on refresh and issues a new one. That is correct. The trap is what happens when a refresh request is replayed. A legitimate client refreshes, gets a new token, the network drops the response, the client retries with the same refresh token, and the second request now fails because the token was already revoked. The user is logged out. The production pattern is refresh-token rotation with a grace window: when a refresh token is used, mark it as rotated but keep it valid for a short window (commonly 30-60 seconds) for the benign retry case, and if the rotated token is used after a second successful refresh has occurred, treat it as token theft and invalidate the entire refresh chain. This is the RFC 6749 plus RFC 6819 plus the OAuth 2.1 best-current-practice discipline. Missing it is a common junior bug that shows up as intermittent forced logouts.

Interview framing. If asked "how do you handle a stolen refresh token," the junior answer is "short expiration." The correct answer is rotation with theft detection: rotate on every use, detect reuse of a rotated token as evidence of theft, and on detection invalidate all descendants of the compromised refresh token. Mentioning DPoP (RFC 9449) as the emerging answer for device-bound tokens signals you have read the current IETF work and are not stuck in 2018 best practices.

First-job context. Your first real task on device management is almost always "add a 'log out everywhere' endpoint," which sounds trivial and is not. The semantics must distinguish current-device from other-devices, must revoke refresh tokens atomically across all sessions (Redis `MULTI/EXEC` or a Lua script to avoid partial revocation), must invalidate any long-lived cached JWTs via a revocation list checked on each request, and must propagate to downstream services that may have their own session cache. Doing this correctly is a one-week task. Doing it incorrectly creates a trust-ratcheting-bug where "log out everywhere" does not actually log out everywhere, which is a security incident.

### Senior @ FAANG: Device Attestation, DPoP, And The Mobile Session Security Stack

The session code above is correct for the baseline case. At staff level the baseline is not enough. Three trends in 2026 define the senior-track mobile session story: platform-attested device binding, DPoP or similar proof-of-possession tokens, and the end of simple bearer tokens for high-value flows.

Platform attestation is the authoritative answer to "is this really a legitimate device running my real app." On iOS, App Attest (introduced in iOS 14, mature in 2026) generates a hardware-backed attestation that can be verified server-side to confirm the request is coming from a genuine copy of your app running on real Apple hardware. DeviceCheck adds two bits of per-device persistent state that survive reinstall, which is a crude but useful anti-fraud signal. On Android, SafetyNet was deprecated in early 2024 and Play Integrity API is the replacement. Play Integrity provides three verdicts: device integrity (the device has not been rooted or tampered), app integrity (the APK signature matches the one distributed through Play), and account integrity (the signed-in Google account has a legitimate Play license). The verdicts are signed JWTs from Google that your Go backend verifies against Google's public keys. The staff-level discipline is to gate high-risk endpoints (withdrawals, password changes, account recovery, SIM-swap flows) on a fresh attestation token, not just a valid session. Attestation tokens are single-use with short TTLs, so an attacker who steals a refresh token still cannot complete a sensitive action without also having the device.

DPoP (RFC 9449, Demonstrating Proof-of-Possession) binds an OAuth access token to a client-held key pair. Each request includes a signed proof header that demonstrates the client holds the private key. A stolen bearer token is useless without the key. For mobile, the key can be generated in the Secure Enclave (iOS) or Android Keystore (hardware-backed on most modern devices), so the private key never leaves the secure hardware. DPoP is the emerging answer to the "bearer tokens are unsafe on mobile" problem and is the pattern to advocate for on new mobile backend designs in 2026. Adoption is still uneven. Major IdPs like Okta, Auth0, and Google have DPoP support in 2026, but many first-party auth systems at FAANG companies have their own internal equivalents that predate DPoP and solve the same problem. The staff-level ADR names which proof-of-possession scheme applies to which surface and what the fallback is for clients that cannot support it.

Root and jailbreak detection is a trade-off, not a slam dunk. Detection libraries (RootBeer on Android, various jailbreak-detection libraries on iOS) are easily bypassed by a determined attacker. Treating the signal as gospel means false positives lock out legitimate users on rooted phones (developers, power users, users in markets where rooting is common and benign). Treating the signal as advisory and combining it with other risk signals (new device, new IP range, unusual access pattern) is the mature approach. The staff-level ADR documents which flows require "no detected root" as a hard gate (typically none), which flows use it as a risk signal that elevates to step-up authentication (typically payments, account recovery), and which flows ignore it (typically read-only flows). The ADR also names that SafetyNet is deprecated and Play Integrity is the replacement, because the deprecation cutover was a real migration for many teams through 2024 and 2025.

Token-bound session identifiers and device graveyards interact in production incidents. When a device is lost or stolen, the user-initiated "revoke this device" flow must tear down: the device row (marked inactive, not deleted, for audit), all sessions associated with the device, any cached push tokens on the device, and any long-lived credentials (OAuth refresh tokens, third-party integration tokens) that were granted through the device. Missing any one of these leaves a residual foothold. The staff-level test for this flow is an integration test that registers a device, authenticates, mutates state, revokes the device, and then asserts that every token associated with the device returns `401` within the session cache TTL.

Session concurrency limits are a product decision with security implications. Some products allow unlimited concurrent sessions per user (mail clients, productivity apps). Others enforce a limit with an oldest-session-wins eviction policy (streaming services, often for business reasons around account sharing, but the mechanism is equivalent to a security control). The staff-level design names the limit, the eviction policy, and the user-visible behavior when the limit is hit. The code pattern is usually a Redis-backed bounded set per user with `ZADD` on new session and a trim on size, and the eviction emits an event that the push service uses to notify the evicted device. Getting the notification right matters: silently logging someone out of their streaming app on a long-haul flight is a support ticket generator.

---
