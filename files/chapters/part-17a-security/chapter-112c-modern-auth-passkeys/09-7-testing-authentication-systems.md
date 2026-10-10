## 112C.8 Testing Authentication Systems

Authentication tests must cover security boundary conditions, not just the happy path. The suite below exercises replayed magic links, expired tokens, wrong TOTP codes, reused SMS OTPs, and elevated risk scores, because those are the paths an attacker drives. Every service is built against a mock store or a stub transport, so the tests stay hermetic and never touch the network. Injecting a stub `http.RoundTripper` into the breach checker also lets a test assert the k-anonymity property directly, proving that only the five-character hash prefix ever leaves the process. Table-driven subtests over a set of security scenarios make it easy to add new attack vectors as they are discovered without restructuring the test file.

```go
// The tests below are collected into one listing for readability. Each one
// really lives beside the code it exercises, as an in-package test, so this
// listing maps onto six files:
//
//	totp/totp_test.go          TestTOTPGeneration, mockTOTPStore
//	magiclink/link_test.go     TestMagicLinkFlow, TestMagicLinkExpiry, mockEmailService
//	riskauth/risk_test.go      TestRiskEngine
//	passwords/hash_test.go     TestPasswordHashing, TestPasswordBreachCheck
//	passkeys/webauthn_test.go  TestWebAuthnRegistrationFlow, mockCredentialStore
//	smsotp/otp_test.go         TestSMSOTPFlow, mockSMSSender
//
// Each file declares the package it tests, and each takes the subset of the
// imports below that it needs. Being in-package is what lets
// TestPasswordBreachCheck swap the unexported client on the HIBP checker.
package passwords

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestTOTPGeneration tests TOTP generation and validation
func TestTOTPGeneration(t *testing.T) {
	store := &mockTOTPStore{}
	config := DefaultTOTPConfig("TestApp")
	svc := NewTOTPService(config, store)

	// Generate secret
	secret, qrURL, backupCodes, err := svc.GenerateSecret("user-001", "test@example.com")
	require.NoError(t, err)
	assert.NotEmpty(t, secret)
	assert.Contains(t, qrURL, "otpauth://totp/")
	assert.Len(t, backupCodes, 10)

	// Get current TOTP
	code, remaining, err := svc.GetCurrentTOTP(secret)
	require.NoError(t, err)
	assert.Len(t, code, 6)
	assert.True(t, remaining > 0 && remaining <= 30*time.Second)

	// Validate current code
	valid, err := svc.ValidateTOTP("user-001", code)
	require.NoError(t, err)
	assert.True(t, valid)

	// Validate wrong code
	valid, err = svc.ValidateTOTP("user-001", "000000")
	require.NoError(t, err)
	assert.False(t, valid)
}

// TestMagicLinkFlow tests the complete magic link flow
func TestMagicLinkFlow(t *testing.T) {
	emailSvc := &mockEmailService{}
	config := MagicLinkConfig{
		BaseURL:     "https://app.example.com",
		TokenTTL:    15 * time.Minute,
		MaxAttempts: 3,
	}
	svc := NewMagicLinkService(emailSvc, config)

	// Send magic link
	err := svc.SendMagicLink("test@example.com", "user-001", "192.168.1.1")
	require.NoError(t, err)
	assert.True(t, emailSvc.sent)
	assert.Contains(t, emailSvc.lastBody, "/auth/magic-link?token=")

	// Extract token from email URL
	token := emailSvc.lastToken

	// Validate token
	userID, err := svc.ValidateMagicLink(token, "192.168.1.1")
	require.NoError(t, err)
	assert.Equal(t, "user-001", userID)

	// Replay attack: the same token must fail
	_, err = svc.ValidateMagicLink(token, "192.168.1.1")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "already used")
}

// TestMagicLinkExpiry tests token expiration
func TestMagicLinkExpiry(t *testing.T) {
	emailSvc := &mockEmailService{}
	config := MagicLinkConfig{
		BaseURL:     "https://app.example.com",
		TokenTTL:    1 * time.Millisecond, // Expire immediately for testing
		MaxAttempts: 3,
	}
	svc := NewMagicLinkService(emailSvc, config)

	err := svc.SendMagicLink("test@example.com", "user-001", "192.168.1.1")
	require.NoError(t, err)

	// Wait for expiry
	time.Sleep(10 * time.Millisecond)

	_, err = svc.ValidateMagicLink(emailSvc.lastToken, "192.168.1.1")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "expired")
}

// TestRiskEngine tests risk assessment
func TestRiskEngine(t *testing.T) {
	engine := &RiskEngine{}

	tests := []struct {
		name           string
		ctx            AuthContext
		expectedAction RiskAction
	}{
		{
			name: "normal login",
			ctx: AuthContext{
				UserID:         "user-001",
				IPAddress:      "192.168.1.100",
				Country:        "US",
				IsNewDevice:    false,
				FailedAttempts: 0,
			},
			expectedAction: ActionAllow,
		},
		{
			name: "tor exit node",
			ctx: AuthContext{
				UserID:    "user-001",
				IPAddress: "199.249.224.13",
				IsTor:     true,
				Country:   "US",
			},
			expectedAction: ActionRequireMFA,
		},
		{
			name: "multiple failed attempts",
			ctx: AuthContext{
				UserID:         "user-001",
				IPAddress:      "192.168.1.100",
				FailedAttempts: 10,
			},
			expectedAction: ActionRequireMFA,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			risk := engine.AssessRisk(tt.ctx)
			assert.Equal(t, tt.expectedAction, risk.Action,
				"unexpected action for risk score %.2f (factors: %v)",
				risk.Score, risk.Factors)
		})
	}
}

// TestPasswordHashing tests Argon2id hashing
func TestPasswordHashing(t *testing.T) {
	config := DefaultArgon2Config()

	// Hash password
	hash, err := HashPassword("correct-horse-battery-staple", config)
	require.NoError(t, err)
	assert.Contains(t, hash, "$argon2id$")

	// Verify correct password
	valid, err := VerifyPassword("correct-horse-battery-staple", hash)
	require.NoError(t, err)
	assert.True(t, valid)

	// Verify wrong password
	valid, err = VerifyPassword("wrong-password", hash)
	require.NoError(t, err)
	assert.False(t, valid)

	// Same password produces different hash (different salt)
	hash2, err := HashPassword("correct-horse-battery-staple", config)
	require.NoError(t, err)
	assert.NotEqual(t, hash, hash2)
}

// TestWebAuthnRegistrationFlow tests WebAuthn registration
func TestWebAuthnRegistrationFlow(t *testing.T) {
	store := &mockCredentialStore{}
	svc, err := NewWebAuthnService(
		"example.com",
		"Example App",
		[]string{"https://example.com"},
		store,
	)
	require.NoError(t, err)

	// Begin registration
	options, sessionKey, err := svc.BeginRegistration("user-001", "testuser", "Test User")
	require.NoError(t, err)
	assert.NotNil(t, options)
	assert.NotEmpty(t, sessionKey)

	// Verify options contain required fields
	optionsJSON, _ := json.Marshal(options)
	assert.Contains(t, string(optionsJSON), "challenge")
}

// stubHIBPTransport intercepts the outbound range request so the test can
// serve a canned response and inspect exactly what left the process.
type stubHIBPTransport struct {
	gotPath string
	body    string
}

func (s *stubHIBPTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	s.gotPath = r.URL.Path
	return &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(s.body)),
		Header:     make(http.Header),
	}, nil
}

// TestPasswordBreachCheck tests the HIBP k-anonymity client
func TestPasswordBreachCheck(t *testing.T) {
	// SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
	// Prefix 5BAA6 is sent, suffix 1E4C9B93F3F0682250B6CF8331B7EE68FD8
	// is matched locally against the returned range.
	tr := &stubHIBPTransport{
		body: "0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n" +
			"1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\n",
	}
	checker := NewHaveIBeenPwnedChecker()
	checker.client = &http.Client{Transport: tr}

	breached, count, err := checker.IsPasswordBreached("password")
	require.NoError(t, err)
	assert.True(t, breached)
	assert.Equal(t, 3861493, count)

	// k-anonymity: only the 5-character prefix is ever sent, and the
	// suffix that identifies the password never leaves the process.
	assert.Equal(t, "/range/5BAA6", tr.gotPath)
	assert.NotContains(t, tr.gotPath, "1E4C9B")

	// A range that does not contain the suffix means "not breached"
	tr2 := &stubHIBPTransport{body: "0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n"}
	checker.client = &http.Client{Transport: tr2}

	breached, count, err = checker.IsPasswordBreached("password")
	require.NoError(t, err)
	assert.False(t, breached)
	assert.Zero(t, count)
}

// TestSMSOTPFlow tests SMS OTP validation
func TestSMSOTPFlow(t *testing.T) {
	sender := &mockSMSSender{}
	config := SMSOTPConfig{
		CodeLength:  6,
		TTL:         5 * time.Minute,
		MaxAttempts: 3,
		RateLimit:   5,
	}
	svc := NewSMSOTPService(sender, config)

	// Send OTP
	err := svc.SendOTP("+1234567890", "user-001")
	require.NoError(t, err)
	assert.True(t, sender.sent)
	assert.Contains(t, sender.lastMessage, "verification code")

	// Correct OTP
	err = svc.ValidateOTP("+1234567890", sender.lastCode, "user-001")
	require.NoError(t, err)

	// Replay: already used
	err = svc.ValidateOTP("+1234567890", sender.lastCode, "user-001")
	assert.Error(t, err)
}

// Mock implementations for testing

type mockTOTPStore struct {
	secrets     map[string]string
	backupCodes map[string][]string
}

func (m *mockTOTPStore) SaveSecret(userID, secret string) error {
	if m.secrets == nil {
		m.secrets = make(map[string]string)
	}
	m.secrets[userID] = secret
	return nil
}

func (m *mockTOTPStore) GetSecret(userID string) (string, error) {
	return m.secrets[userID], nil
}

func (m *mockTOTPStore) SaveBackupCodes(userID string, codes []string) error {
	if m.backupCodes == nil {
		m.backupCodes = make(map[string][]string)
	}
	m.backupCodes[userID] = codes
	return nil
}

func (m *mockTOTPStore) GetBackupCodes(userID string) ([]string, error) {
	return m.backupCodes[userID], nil
}

func (m *mockTOTPStore) UseBackupCode(userID, code string) error {
	codes := m.backupCodes[userID]
	for i, c := range codes {
		if c == code {
			m.backupCodes[userID] = append(codes[:i], codes[i+1:]...)
			return nil
		}
	}
	return nil
}

type mockEmailService struct {
	sent      bool
	lastBody  string
	lastToken string
}

func (m *mockEmailService) Send(to, subject, htmlBody, textBody string) error {
	m.sent = true
	m.lastBody = htmlBody
	// Extract token from URL
	start := strings.Index(htmlBody, "token=")
	if start >= 0 {
		end := strings.Index(htmlBody[start:], `"`)
		if end >= 0 {
			m.lastToken = htmlBody[start+6 : start+end]
		}
	}
	return nil
}

type mockCredentialStore struct {
	creds map[string][]*StoredCredential
}

func (m *mockCredentialStore) SaveCredential(userID string, cred *StoredCredential) error {
	if m.creds == nil {
		m.creds = make(map[string][]*StoredCredential)
	}
	m.creds[userID] = append(m.creds[userID], cred)
	return nil
}

func (m *mockCredentialStore) GetCredentials(userID string) ([]*StoredCredential, error) {
	return m.creds[userID], nil
}

func (m *mockCredentialStore) GetCredentialByID(id []byte) (*StoredCredential, error) {
	for _, creds := range m.creds {
		for _, c := range creds {
			if string(c.ID) == string(id) {
				return c, nil
			}
		}
	}
	return nil, nil
}

func (m *mockCredentialStore) UpdateCredential(cred *StoredCredential) error { return nil }

func (m *mockCredentialStore) DeleteCredential(userID string, id []byte) error { return nil }

type mockSMSSender struct {
	sent        bool
	lastMessage string
	lastCode    string
}

func (m *mockSMSSender) Send(to, message string) error {
	m.sent = true
	m.lastMessage = message
	// Extract code from message
	start := strings.Index(message, ": ")
	end := strings.Index(message, ". Valid")
	if start >= 0 && end >= 0 {
		m.lastCode = message[start+2 : end]
	}
	return nil
}

```

---
