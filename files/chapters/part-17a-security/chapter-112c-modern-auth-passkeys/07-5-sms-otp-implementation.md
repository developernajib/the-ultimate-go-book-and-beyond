## 112C.6 SMS OTP Implementation

SMS OTP delivers a one-time code to the user's phone number as a second authentication factor, adding a possession check to password-based login. Know its limits: SMS is the weakest MFA factor, vulnerable to SIM-swap attacks and SS7 interception, so offer it as a fallback rather than the primary factor. The following implementation delegates delivery to an SMS provider behind a small interface, applies per-number rate limiting to prevent toll fraud and SMS pumping, and enforces code expiry and single-use semantics.

```go
package smsotp

import (
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"math/big"
	"sync"
	"time"
)

// SMSOTPService handles SMS-based OTP authentication
type SMSOTPService struct {
	mu          sync.RWMutex
	pendingOTPs map[string]*OTPEntry
	sendLog     map[string][]time.Time
	smsSender   SMSSender
	config      SMSOTPConfig
}

// SMSOTPConfig holds configuration
type SMSOTPConfig struct {
	CodeLength    int
	TTL           time.Duration
	MaxAttempts   int
	RateLimit     int  // Max OTPs per phone per hour
	RequireUserID bool // Link OTP to specific user
}

// OTPEntry represents a pending OTP
type OTPEntry struct {
	Code        string
	PhoneNumber string
	UserID      string
	ExpiresAt   time.Time
	Attempts    int
	Used        bool
}

// SMSSender interface for SMS delivery
type SMSSender interface {
	Send(to, message string) error
}

// NewSMSOTPService creates an SMS OTP service
func NewSMSOTPService(smsSender SMSSender, config SMSOTPConfig) *SMSOTPService {
	return &SMSOTPService{
		pendingOTPs: make(map[string]*OTPEntry),
		sendLog:     make(map[string][]time.Time),
		smsSender:   smsSender,
		config:      config,
	}
}

// SendOTP generates and sends an OTP to a phone number
func (s *SMSOTPService) SendOTP(phoneNumber, userID string) error {
	// Validate phone number format
	if !isValidPhoneNumber(phoneNumber) {
		return fmt.Errorf("invalid phone number format")
	}

	// Generate numeric OTP
	code, err := generateNumericCode(s.config.CodeLength)
	if err != nil {
		return fmt.Errorf("failed to generate OTP: %w", err)
	}

	s.mu.Lock()

	// Enforce per-phone rate limit (toll fraud and SMS pumping defense)
	cutoff := time.Now().Add(-1 * time.Hour)
	recent := make([]time.Time, 0, len(s.sendLog[phoneNumber]))
	for _, t := range s.sendLog[phoneNumber] {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	if len(recent) >= s.config.RateLimit {
		s.mu.Unlock()
		return fmt.Errorf("rate limit exceeded for this phone number")
	}
	s.sendLog[phoneNumber] = append(recent, time.Now())

	// Store OTP
	s.pendingOTPs[phoneNumber] = &OTPEntry{
		Code:        code,
		PhoneNumber: phoneNumber,
		UserID:      userID,
		ExpiresAt:   time.Now().Add(s.config.TTL),
		Attempts:    0,
		Used:        false,
	}
	s.mu.Unlock()

	// Send SMS
	message := fmt.Sprintf("Your verification code is: %s. Valid for %d minutes. Do not share this code.",
		code, int(s.config.TTL.Minutes()))

	return s.smsSender.Send(phoneNumber, message)
}

// ValidateOTP validates an OTP for a phone number
func (s *SMSOTPService) ValidateOTP(phoneNumber, code, userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, exists := s.pendingOTPs[phoneNumber]
	if !exists {
		return fmt.Errorf("no OTP found for this phone number")
	}

	if entry.Used {
		delete(s.pendingOTPs, phoneNumber)
		return fmt.Errorf("OTP already used")
	}

	if time.Now().After(entry.ExpiresAt) {
		delete(s.pendingOTPs, phoneNumber)
		return fmt.Errorf("OTP expired")
	}

	entry.Attempts++
	if entry.Attempts > s.config.MaxAttempts {
		delete(s.pendingOTPs, phoneNumber)
		return fmt.Errorf("too many failed attempts")
	}

	// Verify user ID if required
	if s.config.RequireUserID && entry.UserID != userID {
		return fmt.Errorf("OTP not issued for this user")
	}

	// Constant-time comparison to prevent timing attacks
	if !secureCompare(entry.Code, code) {
		return fmt.Errorf("invalid OTP")
	}

	// Mark as used and delete
	entry.Used = true
	delete(s.pendingOTPs, phoneNumber)

	return nil
}

func generateNumericCode(length int) (string, error) {
	max := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(length)), nil)
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%0*d", length, n), nil
}

func isValidPhoneNumber(phone string) bool {
	// Simplified validation, use libphonenumber in production
	return len(phone) >= 10 && len(phone) <= 15
}

func secureCompare(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
```

---
