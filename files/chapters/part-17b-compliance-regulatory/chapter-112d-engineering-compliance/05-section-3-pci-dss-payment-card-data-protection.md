## 112D.4 PCI DSS - Payment Card Data Protection

PCI DSS Requirement 3 governs stored account data. Two rules drive the design here. Requirement 3.5.1 says PAN must be rendered unreadable anywhere it is stored. Requirement 3.3.1 says sensitive authentication data, meaning the full track, the CVV, and the PIN block, must never be retained after authorization completes, encrypted or not. The second rule has no exception for you: there is no such thing as a compliantly stored CVV.

Tokenization addresses the first rule by replacing the PAN with an opaque token before it reaches application code, shrinking the cardholder data environment to a single isolated vault service. The `TokenVault` below validates each PAN with the Luhn algorithm, encrypts it with AES-256-GCM before persistence, and returns a random UUID-shaped token. Systems outside the vault hold only tokens, which is what makes descoping possible: a token that cannot be reversed to a PAN without the vault carries no cardholder data. Whether those systems actually fall outside your assessed scope is a determination your QSA makes about your specific environment, and connectivity to the vault can pull them back in, so treat descoping as an argument you must build evidence for rather than a property you get for free. The `MaskPAN` helper renders a PAN down to the first six and last four digits, the maximum PCI DSS permits for display, masking everything between so a leaked log line carries nothing reconstructable.

```go
package pcidss

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// TokenVault tokenizes payment card data
// PCI DSS Requirement 3: Protect stored account data
type TokenVault struct {
	db         *sql.DB
	encryptKey []byte
}

// NewTokenVault requires a 32-byte key. The check is not ceremony: crypto/aes
// accepts 16, 24, and 32 byte keys and silently selects AES-128, AES-192, or
// AES-256 accordingly. A short key would leave this "AES-256-GCM" vault quietly
// running AES-128, and nothing at runtime would tell you.
func NewTokenVault(db *sql.DB, encryptKey []byte) (*TokenVault, error) {
	if len(encryptKey) != 32 {
		return nil, fmt.Errorf("encryption key must be 32 bytes for AES-256, got %d", len(encryptKey))
	}
	return &TokenVault{db: db, encryptKey: encryptKey}, nil
}

// Tokenize replaces a PAN with a token (non-sensitive substitute)
// Returns the token that can be stored anywhere.
//
// Note the signature: it takes a PAN and nothing else. There is deliberately no
// parameter for the CVV. If a caller has one, it goes to the acquirer with the
// authorization request and is then dropped. It never comes here.
func (tv *TokenVault) Tokenize(ctx context.Context, pan string) (string, error) {
	// Normalize once, then work only with the normalized value. Validating a
	// stripped copy while storing the raw input is how " 4111 1111 1111 1111"
	// ends up with a last4 of "1111" but a stored PAN that carries spaces.
	pan = normalizePAN(pan)

	// Validate PAN format (Luhn check)
	if !validateLuhn(pan) {
		return "", fmt.Errorf("invalid PAN")
	}

	// Generate random token (UUID format for easy identification)
	token, err := generateToken()
	if err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}

	// Encrypt the PAN before storing
	encrypted, err := tv.encrypt(pan)
	if err != nil {
		return "", fmt.Errorf("encrypt PAN: %w", err)
	}

	// Store mapping: token -> encrypted PAN
	_, err = tv.db.ExecContext(ctx, `
		INSERT INTO token_vault (token, encrypted_pan, pan_last4, card_network, created_at)
		VALUES ($1, $2, $3, $4, NOW())
	`,
		token,
		encrypted,
		pan[len(pan)-4:], // Last 4 is not cardholder data and may be stored in the clear
		detectCardNetwork(pan),
	)
	if err != nil {
		return "", fmt.Errorf("store token: %w", err)
	}

	return token, nil
}

// Authorizer decides whether the caller may detokenize. Keeping it an interface
// on the vault means detokenization cannot be reached without one: there is no
// constructor path that leaves the check out.
type Authorizer interface {
	// CanDetokenize returns nil if the caller in ctx may reverse a token.
	CanDetokenize(ctx context.Context) error
}

// Detokenize retrieves the PAN from a token.
//
// This is the single most sensitive method in the codebase, so the authorization
// check is a required argument rather than a comment saying "in production, check
// the role claim". A TODO is not an access control. Every reversal is also
// audited, successful or not, because Requirement 10 wants a record of who
// touched account data, and a denied attempt is the more interesting event.
func (tv *TokenVault) Detokenize(ctx context.Context, auth Authorizer, token string) (string, error) {
	if err := auth.CanDetokenize(ctx); err != nil {
		tv.auditReversal(ctx, token, false)
		return "", fmt.Errorf("detokenize denied: %w", err)
	}

	var encryptedPAN string
	err := tv.db.QueryRowContext(ctx,
		"SELECT encrypted_pan FROM token_vault WHERE token = $1 AND revoked = false",
		token,
	).Scan(&encryptedPAN)
	if errors.Is(err, sql.ErrNoRows) {
		tv.auditReversal(ctx, token, false)
		return "", fmt.Errorf("token not found or revoked")
	}
	if err != nil {
		tv.auditReversal(ctx, token, false)
		return "", err
	}

	pan, err := tv.decrypt(encryptedPAN)
	tv.auditReversal(ctx, token, err == nil)
	return pan, err
}

// auditReversal records the attempt. It logs the token, never the PAN.
func (tv *TokenVault) auditReversal(ctx context.Context, token string, success bool) {
	_, _ = tv.db.ExecContext(ctx, `
		INSERT INTO token_access_log (token, success, accessed_at) VALUES ($1, $2, NOW())
	`, token, success)
}

// GetTokenInfo returns non-sensitive token metadata
func (tv *TokenVault) GetTokenInfo(ctx context.Context, token string) (*TokenInfo, error) {
	var info TokenInfo
	err := tv.db.QueryRowContext(ctx, `
		SELECT token, pan_last4, card_network, created_at
		FROM token_vault WHERE token = $1
	`, token).Scan(&info.Token, &info.Last4, &info.Network, &info.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &info, nil
}

type TokenInfo struct {
	Token     string
	Last4     string
	Network   string
	CreatedAt time.Time
}

// Revoke invalidates a token
func (tv *TokenVault) Revoke(ctx context.Context, token string) error {
	_, err := tv.db.ExecContext(ctx,
		"UPDATE token_vault SET revoked = true, revoked_at = NOW() WHERE token = $1",
		token)
	return err
}

// encrypt uses AES-256-GCM
func (tv *TokenVault) encrypt(plaintext string) (string, error) {
	block, err := aes.NewCipher(tv.encryptKey)
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}

	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func (tv *TokenVault) decrypt(ciphertext string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(tv.encryptKey)
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("invalid ciphertext")
	}

	nonce, ciphertextBytes := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertextBytes, nil)
	if err != nil {
		return "", fmt.Errorf("decryption failed")
	}

	return string(plaintext), nil
}

// normalizePAN strips the separators humans type. Cards are keyed in with
// spaces and pasted with dashes.
func normalizePAN(pan string) string {
	return strings.NewReplacer(" ", "", "-", "").Replace(pan)
}

// Luhn algorithm for PAN validation. Expects a normalized PAN.
func validateLuhn(pan string) bool {
	if len(pan) < 13 || len(pan) > 19 {
		return false
	}

	sum := 0
	nDigits := len(pan)
	parity := nDigits % 2

	for i := range nDigits {
		// Reject non-digits explicitly. Without this, pan[i]-'0' on a letter
		// produces a large int that still contributes to sum, so a string like
		// "4111111111111abc" can reach sum%10 == 0 and validate.
		if pan[i] < '0' || pan[i] > '9' {
			return false
		}
		digit := int(pan[i] - '0')
		if i%2 == parity {
			digit *= 2
			if digit > 9 {
				digit -= 9
			}
		}
		sum += digit
	}
	return sum%10 == 0
}

// MaskPAN returns a masked version safe for logging: 4111111111111111 -> 411111******1111
//
// The threshold is 13, not 8. Below 13 there is no valid PAN, so anything
// shorter is masked outright: the input is either malformed or already masked,
// and in both cases revealing the first six digits of it helps nobody. The
// naive guard here is also a live panic: strings.Repeat panics on a negative
// count, so any input of length 8 or 9 would take the process down.
func MaskPAN(pan string) string {
	pan = normalizePAN(pan)
	if len(pan) < 13 {
		return strings.Repeat("*", len(pan))
	}
	return pan[:6] + strings.Repeat("*", len(pan)-10) + pan[len(pan)-4:]
}

// detectCardNetwork checks prefixes directly. The regexp version of this
// recompiled three patterns on every single call, which is pure waste on a
// path that runs per authorization.
func detectCardNetwork(pan string) string {
	switch {
	case strings.HasPrefix(pan, "4"):
		return "visa"
	case len(pan) >= 2 && pan[0] == '5' && pan[1] >= '1' && pan[1] <= '5':
		return "mastercard"
	case strings.HasPrefix(pan, "34"), strings.HasPrefix(pan, "37"):
		return "amex"
	default:
		return "unknown"
	}
}

func generateToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
```

### Junior → FAANG: The One Rule That Defines PCI DSS Engineering

PCI DSS has hundreds of requirements, but one rule eliminates most of them for most services: do not store, process, or transmit raw PANs in your system. Delegate all card-present and card-not-present flows to a PCI-compliant payment processor (Stripe, Braintree, Adyen). Your service receives a token that has no value outside the processor's vault. This is the descoping strategy that makes PCI DSS tractable for application teams.

First-job habit: treat any code path that receives card data as radioactive. Even logging a request body that might contain a PAN in a developer trace is a PCI violation. Configure your logging middleware to redact any field matching a card number pattern before the log record is written. Be precise about what that pattern can do: a regex can match a 13-to-19 digit run, but it cannot check Luhn, because Luhn is arithmetic and regular expressions do not do arithmetic. The working redactor is two stages, a cheap regex to find candidate digit runs and a Luhn check on each hit to decide whether to redact. Bias it toward over-redaction. A redacted order number is an annoyance, a logged PAN is an incident.

Interview framing: know that merchant levels are volume tiers set by the individual card brands, not by the PCI Security Standards Council, so the exact thresholds vary slightly between brands. The shape is consistent: Level 1 is the top tier, commonly over six million transactions per year for a given brand, and it calls for an annual Report on Compliance produced by a Qualified Security Assessor or by an internal auditor whose report an officer of the company signs. The lower tiers self-assess with the Self-Assessment Questionnaire variant matching how they handle card data. Most SaaS products start at Level 4. Knowing this shows you understand scope before jumping to implementation.

### Senior @ FAANG: PCI Scope Reduction as an Architecture Discipline

Know which version you are being assessed against. PCI DSS v4.0 superseded v3.2.1, and v4.0.1 is a clarifying revision of it, so requirement numbers you may remember from v3.2.1 have moved: the old 3.4 "render PAN unreadable" is 3.5.1 in v4.0. Many v4.0 requirements were introduced as future-dated best practices that became mandatory on 31 March 2025, so a control your team once deferred as optional is now assessable. If you inherit a payments codebase, check whether its compliance mapping predates that date.

The central staff-level question in PCI DSS is not "are we compliant?" but "how small is our cardholder data environment (CDE)?" Every system in the CDE requires quarterly vulnerability scans, annual penetration tests, rigorous change management, and network segmentation controls. Shrinking the CDE means fewer systems to harden, fewer teams to train, and lower audit cost.

The canonical scope-reduction architecture uses three boundaries. The first boundary is the browser-side tokenization layer: card data is entered directly into a hosted fields component served by the payment processor's CDN, so the raw PAN never touches your server. The second boundary is strict network segmentation: the small set of services that call payment processor APIs are isolated in a dedicated subnet with egress rules limited to payment processor IP ranges, and no lateral connectivity to internal databases. The third boundary is token vault isolation: your internal token-to-processor-reference mapping table lives in a dedicated service with its own auth model, not in your main application database.

Penetration testing scope matters. A pen test that covers your entire application is expensive and slow. A pen test scoped to the CDE plus the segmentation boundary is focused and actionable. A staff engineer owning a payments platform should be able to produce a network diagram that clearly shows the CDE boundary and defend it to a QSA without engineering support during the audit.

Key management is where PCI DSS and general cryptography practice diverge for most engineers. PCI DSS requires dual control and split knowledge for cryptographic key material: no single person should be able to access or reconstruct a key-encrypting key (KEK) alone. At FAANG scale this is implemented through HSMs with M-of-N access policies and operator card ceremonies. A staff engineer should understand the difference between a KEK hierarchy (symmetric, fast, used for envelope encryption) and a certificate hierarchy (asymmetric, used for identity), and know which PCI requirements apply to each.

---
