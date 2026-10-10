## 90I.21 Snowflake Customer Breach (2024)

### 165 Accounts, Zero MFA

In April-June 2024, threat actors compromised approximately 165 Snowflake customer accounts in one of the largest
data breaches of the year. The attack was remarkable not for its technical sophistication but for its simplicity:
the attackers used credentials stolen by infostealer malware (Vidar, RisePro, Redline, Raccoon, Lumma, and
MetaStealer) to log directly into Snowflake customer accounts that had no multi-factor authentication (MFA)
enabled.

The threat actor group, tracked as UNC5537, obtained credentials from infostealer logs - databases of stolen
usernames and passwords that are actively traded on criminal forums. These credentials were stolen from the
personal computers of Snowflake customers' employees, often months or years before being used.

### The Victims

The scale of data exposure was staggering:

- **AT&T** - Call and text records of nearly all 110 million wireless customers, including phone numbers,
  call/text metadata, and cell site location data for a six-month period
- **Ticketmaster (Live Nation)** - 560 million customer records including names, addresses, phone numbers,
  email addresses, and partial payment card data
- **Santander Bank** - 30 million customer records including account details and credit card numbers
- **Advance Auto Parts** - 380 million customer profiles and 140 million customer orders
- **LendingTree/QuoteWizard** - 190 million records

The attackers did not need to exploit any vulnerability in Snowflake's platform. They simply logged in with
valid credentials because the affected accounts did not have MFA enabled, and Snowflake did not enforce MFA
as a requirement.

### The Root Cause: Optional MFA

The breach highlighted a fundamental design flaw in how cloud platforms handle authentication. Snowflake offered
MFA as an option but did not require it, even for accounts with access to billions of records. The affected
accounts were using single-factor authentication (username and password) to protect some of the most sensitive
datasets on the planet.

After the breach, Snowflake announced it would require all users to implement MFA - a change that came too late
for the hundreds of millions of people whose data had already been stolen.

### Go Code: Mandatory MFA Enforcement

The critical design decision in the enforcer below is that MFA is a hard gate, not an optional feature flag.
`RequireMFA` middleware returns HTTP 403 and a redirect to enrollment for any user whose `LastVerified`
timestamp is absent or older than 12 hours. There is no code path that allows a fully authenticated session
without a completed TOTP challenge. The `TOTPGenerator` implements RFC 6238 dynamic truncation directly,
making the time-based code derivation auditable and free of third-party dependencies, important in a
healthcare or financial context where supply chain trust is itself an attack surface.

```go
package mfaenforce

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sync"
	"time"
)

// MFAStatus tracks the MFA enrollment state for a user.
type MFAStatus int

const (
	MFANotEnrolled MFAStatus = iota
	MFAEnrolled
	MFAVerified // MFA challenge completed for current session
)

// MFAMethod represents the type of second factor.
type MFAMethod int

const (
	MFATOTP   MFAMethod = iota // Time-based One-Time Password (RFC 6238)
	MFAWebAuthn                 // FIDO2/WebAuthn hardware keys
)

// UserMFARecord stores a user's MFA configuration.
type UserMFARecord struct {
	UserID       string
	Method       MFAMethod
	Secret       []byte    // TOTP shared secret
	EnrolledAt   time.Time
	LastVerified time.Time
	BackupCodes  []string  // Hashed backup codes
}

// TOTPGenerator generates and validates TOTP codes per RFC 6238.
type TOTPGenerator struct {
	digits   int
	period   int64 // seconds
	skew     int   // allowed time step skew
}

// NewTOTPGenerator creates a TOTP generator with standard parameters.
func NewTOTPGenerator() *TOTPGenerator {
	return &TOTPGenerator{
		digits: 6,
		period: 30,
		skew:   1, // Allow 1 step before/after for clock drift
	}
}

// GenerateSecret creates a cryptographically random TOTP secret.
func (t *TOTPGenerator) GenerateSecret() ([]byte, string, error) {
	secret := make([]byte, 20) // 160-bit secret per RFC 4226
	if _, err := rand.Read(secret); err != nil {
		return nil, "", fmt.Errorf("failed to generate TOTP secret: %w", err)
	}
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret)
	return secret, encoded, nil
}

// GenerateCode produces the current TOTP code for a given secret.
func (t *TOTPGenerator) GenerateCode(secret []byte, timestamp time.Time) string {
	counter := uint64(timestamp.Unix()) / uint64(t.period)
	return t.generateHOTP(secret, counter)
}

func (t *TOTPGenerator) generateHOTP(secret []byte, counter uint64) string {
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, counter)

	mac := hmac.New(sha256.New, secret)
	mac.Write(buf)
	hash := mac.Sum(nil)

	// Dynamic truncation per RFC 4226
	offset := hash[len(hash)-1] & 0x0F
	truncated := binary.BigEndian.Uint32(hash[offset:offset+4]) & 0x7FFFFFFF

	code := truncated % uint32(math.Pow10(t.digits))
	return fmt.Sprintf("%0*d", t.digits, code)
}

// ValidateCode checks if a TOTP code is valid, allowing for clock skew.
func (t *TOTPGenerator) ValidateCode(secret []byte, code string, timestamp time.Time) bool {
	for i := -t.skew; i <= t.skew; i++ {
		adjusted := timestamp.Add(time.Duration(int64(i)*t.period) * time.Second)
		expected := t.GenerateCode(secret, adjusted)
		if subtle.ConstantTimeCompare([]byte(code), []byte(expected)) == 1 {
			return true
		}
	}
	return false
}

// MFAEnforcer is middleware that blocks access for users without MFA.
// This is the pattern that would have prevented the Snowflake breach:
// MFA is mandatory, not optional.
type MFAEnforcer struct {
	mu          sync.RWMutex
	logger      *slog.Logger
	totp        *TOTPGenerator
	userRecords map[string]*UserMFARecord // userID -> record
	gracePeriod time.Duration             // Time allowed after login to complete MFA enrollment
}

// NewMFAEnforcer creates an enforcer that requires MFA for all users.
func NewMFAEnforcer(logger *slog.Logger) *MFAEnforcer {
	return &MFAEnforcer{
		logger:      logger,
		totp:        NewTOTPGenerator(),
		userRecords: make(map[string]*UserMFARecord),
		gracePeriod: 24 * time.Hour,
	}
}

// EnrollUser sets up TOTP for a user. Returns the secret for QR code generation.
func (e *MFAEnforcer) EnrollUser(userID string) (string, error) {
	secret, encoded, err := e.totp.GenerateSecret()
	if err != nil {
		return "", err
	}

	e.mu.Lock()
	e.userRecords[userID] = &UserMFARecord{
		UserID:     userID,
		Method:     MFATOTP,
		Secret:     secret,
		EnrolledAt: time.Now().UTC(),
	}
	e.mu.Unlock()

	e.logger.Info("MFA enrolled for user", "user_id", userID)
	return encoded, nil
}

// VerifyMFA checks a TOTP code for a user.
func (e *MFAEnforcer) VerifyMFA(userID, code string) error {
	e.mu.RLock()
	record, ok := e.userRecords[userID]
	e.mu.RUnlock()

	if !ok {
		return errors.New("user not enrolled in MFA")
	}

	if !e.totp.ValidateCode(record.Secret, code, time.Now()) {
		e.logger.Warn("MFA verification failed", "user_id", userID)
		return errors.New("invalid MFA code")
	}

	e.mu.Lock()
	record.LastVerified = time.Now().UTC()
	e.mu.Unlock()

	e.logger.Info("MFA verified", "user_id", userID)
	return nil
}

// RequireMFA returns middleware that blocks requests from users without verified MFA.
func (e *MFAEnforcer) RequireMFA(getUserID func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			userID := getUserID(r)
			if userID == "" {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			e.mu.RLock()
			record, enrolled := e.userRecords[userID]
			e.mu.RUnlock()

			if !enrolled {
				e.logger.Warn("Access denied: MFA not enrolled",
					"user_id", userID,
					"path", r.URL.Path,
				)
				http.Error(w, "MFA enrollment required. Enroll at /auth/mfa/enroll", http.StatusForbidden)
				return
			}

			// Require MFA verification within the last 12 hours
			if time.Since(record.LastVerified) > 12*time.Hour {
				http.Error(w, "MFA verification expired. Re-verify at /auth/mfa/verify", http.StatusForbidden)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
```

### Lessons for Go Engineers

1. **MFA must be mandatory, not optional** - The Snowflake breach compromised hundreds of millions of records
   because MFA was a suggestion, not a requirement. Design your authentication systems to require MFA from day one.
2. **Infostealer malware is the new phishing** - Credentials are stolen from employee personal devices and sold
   in bulk. Password-only authentication is fundamentally broken regardless of password complexity.
3. **Cloud shared responsibility requires enforcement** - Snowflake provided the MFA capability. customers failed
   to use it. Platform providers must enforce security baselines, not just offer them.
4. **Credential rotation is insufficient alone** - Infostealers continuously harvest new credentials. MFA provides
   a second factor that cannot be stolen from a credential dump.

---

### Junior → FAANG: Mandatory MFA and Infostealer Defense as Interview Topics

The Snowflake breach is the interview answer to "why is password-only authentication fundamentally broken in 2024?" Infostealers (malware that runs on personal devices and harvests saved credentials from browsers, credential managers, and session cookies) have made credential theft so efficient that attackers do not need to crack passwords: they buy working credentials in bulk from dark web markets. For FAANG interviews, the defense has two layers. First, MFA must be mandatory, not optional, for any service that handles sensitive data. The Snowflake breach compromised 165 customer accounts because MFA was available but not required. Make it required. Second, the authentication flow must verify MFA recency at the request level, not just at session creation: a session that was created with MFA four hours ago and has been dormant should re-verify MFA before accessing sensitive operations. This is the session binding and re-authentication pattern.

### Senior @ FAANG: Shared Responsibility Enforcement and Authentication Baseline as Platform Standards

At L6, the Snowflake breach reveals a shared responsibility gap: Snowflake offered MFA, customers failed to enable it, and hundreds of millions of records were exposed. At staff level, you do not rely on customers to make the secure choice. You design the platform so that the secure choice is the default and the insecure choice requires explicit override. For any SaaS or platform product your organization offers, MFA is enabled by default and requires a deliberate action to disable, with audit logging of the disable action and automatic re-enable after a defined period. For any platform your organization consumes, your security policy defines the minimum authentication requirements and includes verification (using the platform's audit API) that those requirements are enforced. Shared responsibility documentation describes obligations, but platform enforcement is what actually reduces risk. The Snowflake breach is the argument for moving security requirements from the "recommended" column to the "enforced" column in every platform your organization operates or consumes.

