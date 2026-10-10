## 112C.3 TOTP: Time-Based One-Time Password

TOTP generates short-lived, algorithm-derived codes that expire within 30 seconds, making stolen credentials useless without simultaneous access to the authenticator device. The following implementation generates and validates TOTP codes per RFC 6238 and demonstrates QR code provisioning for authenticator app enrollment.

```go
package totp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"math"
	"net/url"
	"strings"
	"time"
)

// TOTPConfig holds TOTP configuration
type TOTPConfig struct {
	Issuer    string
	Period    time.Duration // 30 seconds standard
	Digits    int           // 6 standard
	Algorithm string        // SHA1 standard
	Skew      int           // Number of time windows to check (1 = ±1 window)
}

// DefaultTOTPConfig returns standard TOTP configuration
func DefaultTOTPConfig(issuer string) TOTPConfig {
	return TOTPConfig{
		Issuer:    issuer,
		Period:    30 * time.Second,
		Digits:    6,
		Algorithm: "SHA1",
		Skew:      1,
	}
}

// TOTPService manages TOTP secrets and validation
type TOTPService struct {
	config TOTPConfig
	store  TOTPStore
}

// TOTPStore interface for persisting TOTP secrets
type TOTPStore interface {
	SaveSecret(userID, secret string) error
	GetSecret(userID string) (string, error)
	SaveBackupCodes(userID string, codes []string) error
	GetBackupCodes(userID string) ([]string, error)
	UseBackupCode(userID, code string) error
}

// NewTOTPService creates a new TOTP service
func NewTOTPService(config TOTPConfig, store TOTPStore) *TOTPService {
	return &TOTPService{config: config, store: store}
}

// GenerateSecret generates a new TOTP secret for a user
func (s *TOTPService) GenerateSecret(userID, accountName string) (secret, qrCodeURL string, backupCodes []string, err error) {
	// Generate 20 bytes of random secret (160 bits)
	secretBytes := make([]byte, 20)
	if _, err = rand.Read(secretBytes); err != nil {
		return "", "", nil, fmt.Errorf("failed to generate secret: %w", err)
	}

	// Encode as base32 (required for TOTP)
	secret = base32.StdEncoding.WithPadding(base32.NoPadding).
		EncodeToString(secretBytes)

	// Generate OTP auth URL for QR code
	params := url.Values{
		"secret":    {secret},
		"issuer":    {s.config.Issuer},
		"algorithm": {s.config.Algorithm},
		"digits":    {fmt.Sprintf("%d", s.config.Digits)},
		"period":    {fmt.Sprintf("%d", int(s.config.Period.Seconds()))},
	}

	label := url.PathEscape(s.config.Issuer + ":" + accountName)
	qrCodeURL = "otpauth://totp/" + label + "?" + params.Encode()

	// Generate backup codes
	backupCodes = make([]string, 10)
	for i := range backupCodes {
		code := make([]byte, 4)
		rand.Read(code)
		backupCodes[i] = fmt.Sprintf("%04X-%04X",
			binary.BigEndian.Uint16(code[:2]),
			binary.BigEndian.Uint16(code[2:]))
	}

	// Store secret and backup codes
	if err = s.store.SaveSecret(userID, secret); err != nil {
		return "", "", nil, fmt.Errorf("failed to save secret: %w", err)
	}

	// Store hashed backup codes (in production: hash each code)
	if err = s.store.SaveBackupCodes(userID, backupCodes); err != nil {
		return "", "", nil, fmt.Errorf("failed to save backup codes: %w", err)
	}

	return secret, qrCodeURL, backupCodes, nil
}

// ValidateTOTP validates a TOTP code
func (s *TOTPService) ValidateTOTP(userID, code string) (bool, error) {
	secret, err := s.store.GetSecret(userID)
	if err != nil {
		return false, fmt.Errorf("failed to get secret: %w", err)
	}

	// Decode base32 secret
	secretBytes, err := base32.StdEncoding.WithPadding(base32.NoPadding).
		DecodeString(strings.ToUpper(secret))
	if err != nil {
		return false, fmt.Errorf("invalid secret format: %w", err)
	}

	// Get current time window
	now := time.Now().Unix()
	period := int64(s.config.Period.Seconds())

	// Check current window and skew windows (handle clock drift)
	currentWindow := now / period

	for i := -s.config.Skew; i <= s.config.Skew; i++ {
		window := currentWindow + int64(i)
		expected := s.generateTOTP(secretBytes, window)
		// Constant-time comparison prevents timing side channels
		if subtle.ConstantTimeCompare([]byte(code), []byte(expected)) == 1 {
			return true, nil
		}
	}

	return false, nil
}

// ValidateBackupCode validates and consumes a backup code
func (s *TOTPService) ValidateBackupCode(userID, code string) (bool, error) {
	codes, err := s.store.GetBackupCodes(userID)
	if err != nil {
		return false, err
	}

	for _, stored := range codes {
		// In production: compare hashed values
		if strings.EqualFold(stored, code) {
			// Mark code as used
			if err := s.store.UseBackupCode(userID, code); err != nil {
				return false, err
			}
			return true, nil
		}
	}

	return false, nil
}

// generateTOTP generates a TOTP for a given time window
func (s *TOTPService) generateTOTP(secret []byte, window int64) string {
	// Convert window to 8-byte big-endian
	msg := make([]byte, 8)
	binary.BigEndian.PutUint64(msg, uint64(window))

	// Compute HMAC-SHA1
	mac := hmac.New(sha1.New, secret)
	mac.Write(msg)
	h := mac.Sum(nil)

	// Dynamic truncation
	offset := h[len(h)-1] & 0x0F
	code := binary.BigEndian.Uint32(h[offset:offset+4]) & 0x7FFFFFFF

	// Reduce to required digits
	digits := int(math.Pow10(s.config.Digits))
	return fmt.Sprintf("%0*d", s.config.Digits, code%uint32(digits))
}

// GetCurrentTOTP returns the current TOTP for debugging/display
func (s *TOTPService) GetCurrentTOTP(secret string) (string, time.Duration, error) {
	secretBytes, err := base32.StdEncoding.WithPadding(base32.NoPadding).
		DecodeString(strings.ToUpper(secret))
	if err != nil {
		return "", 0, err
	}

	now := time.Now()
	period := int64(s.config.Period.Seconds())
	window := now.Unix() / period

	code := s.generateTOTP(secretBytes, window)

	// Time remaining in current window
	elapsed := time.Duration(now.Unix()%period) * time.Second
	remaining := s.config.Period - elapsed

	return code, remaining, nil
}
```

---
