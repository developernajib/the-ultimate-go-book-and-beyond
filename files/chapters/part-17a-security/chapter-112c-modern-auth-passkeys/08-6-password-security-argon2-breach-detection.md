## 112C.7 Password Security: Argon2 & Breach Detection

Even in a passkey world, most systems keep passwords as a fallback factor, and storing them correctly means Argon2id with OWASP-recommended parameters, a per-password random salt, and constant-time verification. Breach detection layers on top: the Have I Been Pwned range API uses a k-anonymity model, so you can check a password against billions of leaked credentials without sending the password, or even its full hash, off your servers. A strength checker rounds out the defense by rejecting short or commonly used choices at registration time.

```go
package passwords

import (
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2Config holds Argon2id parameters
type Argon2Config struct {
	Memory      uint32 // KB of memory
	Iterations  uint32 // Number of passes
	Parallelism uint8  // Degree of parallelism
	SaltLength  uint32
	KeyLength   uint32
}

// DefaultArgon2Config returns OWASP-recommended parameters
func DefaultArgon2Config() Argon2Config {
	return Argon2Config{
		Memory:      64 * 1024, // 64 MB
		Iterations:  3,
		Parallelism: 4,
		SaltLength:  16,
		KeyLength:   32,
	}
}

// HashPassword hashes a password using Argon2id
func HashPassword(password string, config Argon2Config) (string, error) {
	// Generate random salt
	salt := make([]byte, config.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("failed to generate salt: %w", err)
	}

	// Hash with Argon2id
	hash := argon2.IDKey(
		[]byte(password),
		salt,
		config.Iterations,
		config.Memory,
		config.Parallelism,
		config.KeyLength,
	)

	// Encode as: $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
	encoded := fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version,
		config.Memory,
		config.Iterations,
		config.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash),
	)

	return encoded, nil
}

// VerifyPassword verifies a password against an Argon2id hash
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 {
		return false, fmt.Errorf("invalid hash format")
	}

	if parts[1] != "argon2id" {
		return false, fmt.Errorf("unsupported algorithm: %s", parts[1])
	}

	// Parse parameters
	var version int
	var memory, iterations uint32
	var parallelism uint8

	fmt.Sscanf(parts[2], "v=%d", &version)
	fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism)

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, fmt.Errorf("invalid salt encoding: %w", err)
	}

	expectedHash, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, fmt.Errorf("invalid hash encoding: %w", err)
	}

	// Recompute hash
	computedHash := argon2.IDKey(
		[]byte(password),
		salt,
		iterations,
		memory,
		parallelism,
		uint32(len(expectedHash)),
	)

	// Constant-time comparison
	return secureEqual(computedHash, expectedHash), nil
}

// HaveIBeenPwnedChecker checks if password appears in breach databases
type HaveIBeenPwnedChecker struct {
	client *http.Client
}

// NewHaveIBeenPwnedChecker creates a HIBP checker
func NewHaveIBeenPwnedChecker() *HaveIBeenPwnedChecker {
	return &HaveIBeenPwnedChecker{
		client: &http.Client{},
	}
}

// IsPasswordBreached checks if a password has been found in data breaches
// Uses the k-anonymity model, only the first 5 chars of the SHA-1 hash are sent
func (c *HaveIBeenPwnedChecker) IsPasswordBreached(password string) (bool, int, error) {
	// Hash password with SHA-1
	hash := sha1.Sum([]byte(password))
	hashStr := strings.ToUpper(hex.EncodeToString(hash[:]))

	// k-anonymity: send only first 5 characters
	prefix := hashStr[:5]
	suffix := hashStr[5:]

	// Query HIBP API
	url := "https://api.pwnedpasswords.com/range/" + prefix
	resp, err := c.client.Get(url)
	if err != nil {
		return false, 0, fmt.Errorf("HIBP API request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return false, 0, err
	}

	// Parse response, format: SUFFIX:COUNT\r\n
	lines := strings.Split(string(body), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}

		if strings.EqualFold(parts[0], suffix) {
			var count int
			fmt.Sscanf(parts[1], "%d", &count)
			return true, count, nil
		}
	}

	return false, 0, nil
}

// PasswordStrengthChecker evaluates password strength
type PasswordStrengthChecker struct {
	minLength       int
	requireUpper    bool
	requireLower    bool
	requireDigit    bool
	requireSpecial  bool
	commonPasswords map[string]bool
}

// PasswordStrengthResult represents strength evaluation
type PasswordStrengthResult struct {
	Score    int      // 0-4 (zxcvbn-style)
	Strength string   // "very-weak", "weak", "fair", "strong", "very-strong"
	Issues   []string // Specific problems
	Entropy  float64
}

// CheckStrength evaluates password strength
func (c *PasswordStrengthChecker) CheckStrength(password string) PasswordStrengthResult {
	result := PasswordStrengthResult{}
	var issues []string

	if len(password) < c.minLength {
		issues = append(issues, fmt.Sprintf("too short (minimum %d characters)", c.minLength))
	}

	hasUpper := false
	hasLower := false
	hasDigit := false
	hasSpecial := false

	for _, ch := range password {
		switch {
		case ch >= 'A' && ch <= 'Z':
			hasUpper = true
		case ch >= 'a' && ch <= 'z':
			hasLower = true
		case ch >= '0' && ch <= '9':
			hasDigit = true
		default:
			hasSpecial = true
		}
	}

	if c.requireUpper && !hasUpper {
		issues = append(issues, "must contain uppercase letter")
	}
	if c.requireLower && !hasLower {
		issues = append(issues, "must contain lowercase letter")
	}
	if c.requireDigit && !hasDigit {
		issues = append(issues, "must contain number")
	}
	if c.requireSpecial && !hasSpecial {
		issues = append(issues, "must contain special character")
	}

	if c.commonPasswords[strings.ToLower(password)] {
		issues = append(issues, "this is a commonly used password")
	}

	// Calculate score
	score := 4 - len(issues)
	if score < 0 {
		score = 0
	}

	strengths := []string{"very-weak", "weak", "fair", "strong", "very-strong"}
	result.Score = score
	result.Strength = strengths[score]
	result.Issues = issues

	return result
}

func secureEqual(a, b []byte) bool {
	return subtle.ConstantTimeCompare(a, b) == 1
}
```

---
