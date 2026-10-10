## 90I.22 Change Healthcare: $2.5 Billion Ransomware Attack (2024)

### The Attack: February 21, 2024

On February 21, 2024, the ALPHV/BlackCat ransomware group launched an attack against Change Healthcare, a
subsidiary of UnitedHealth Group that processes approximately 15 billion healthcare transactions annually  - 
roughly one-third of all US healthcare claims. The attack disrupted healthcare payment processing across the
entire United States for weeks, preventing pharmacies from processing prescriptions, hospitals from submitting
claims, and healthcare providers from receiving payments.

### The Entry Point: A Citrix Portal Without MFA

The attackers gained initial access through a Citrix remote access portal that did not have multi-factor
authentication enabled. Using stolen credentials - obtained through the same infostealer-to-credential-market
pipeline that enabled the Snowflake breach - the attackers logged into the Citrix portal as a legitimate user.

From this initial foothold, the attackers spent nine days conducting reconnaissance, moving laterally through
the network, escalating privileges, and exfiltrating data before deploying the ransomware payload. During this
nine-day dwell time, the attackers:

1. Mapped the internal network topology
2. Identified and compromised Active Directory domain controllers
3. Exfiltrated approximately 6 TB of data containing protected health information (PHI)
4. Deployed ransomware across the environment

### The Damage: 193 Million People

The breach affected approximately 193 million people - more than half the US population - making it the largest
healthcare data breach in American history. The stolen data included:

- Names, addresses, dates of birth, Social Security numbers
- Health insurance information and policy details
- Medical records, diagnoses, medications, test results
- Financial and banking information used for claims processing

UnitedHealth Group paid a $22 million ransom to ALPHV/BlackCat. In a twist that illustrated the unreliability of
ransomware operators, the affiliate who conducted the attack claimed ALPHV kept the entire ransom without sharing
the agreed-upon split. The affiliate then threatened to release the stolen data independently, resulting in a
second extortion attempt against Change Healthcare.

The total cost to UnitedHealth Group was estimated at $2.5 billion, including ransom payment, incident response,
system rebuilding, and business interruption. The broader impact on the US healthcare system - delayed treatments,
pharmacy disruptions, provider cash flow crises - was incalculable.

### Go Code: Zero-Trust Access Gateway

The Change Healthcare attackers spent nine days inside the network because lateral movement went undetected,
a direct consequence of trusting any session that originated from a valid login. The gateway below operationalizes
the zero-trust principle by re-evaluating every request against four independent signals: MFA recency, device
compliance posture, a behavioral risk score, and session anomaly detection. Each rule produces its own
`AccessDecision` and the engine applies the most restrictive result across all rules, so a single signal
indicating elevated risk triggers a step-up challenge even if the other three signals pass. Every decision
(granted, denied, or step-up) is appended to an append-only audit log that can be streamed to a SIEM, giving
incident responders the per-request visibility needed to reconstruct lateral movement paths in minutes rather
than days.

```go
package zerotrust

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// AccessDecision represents the result of a zero-trust policy evaluation.
type AccessDecision int

const (
	AccessDenied AccessDecision = iota
	AccessGranted
	AccessRequireStepUp // Require additional verification
)

// DevicePosture represents the security state of a connecting device.
type DevicePosture struct {
	DeviceID        string    `json:"device_id"`
	OSVersion       string    `json:"os_version"`
	PatchLevel      string    `json:"patch_level"`
	EncryptionOn    bool      `json:"encryption_on"`
	FirewallOn      bool      `json:"firewall_on"`
	AntivirusActive bool      `json:"antivirus_active"`
	LastChecked     time.Time `json:"last_checked"`
	Compliant       bool      `json:"compliant"`
}

// AccessContext contains all signals used to make an access decision.
type AccessContext struct {
	UserID        string
	SessionID     string
	SourceIP      net.IP
	UserAgent     string
	Resource      string
	Action        string
	MFAVerified   bool
	MFAVerifiedAt time.Time
	DevicePosture *DevicePosture
	GeoLocation   string
	RiskScore     float64
	Timestamp     time.Time
}

// PolicyRule defines a single zero-trust policy evaluation rule.
type PolicyRule struct {
	Name        string
	Description string
	Evaluate    func(ctx AccessContext) (AccessDecision, string)
}

// ZeroTrustGateway implements a zero-trust access proxy that evaluates
// every request against multiple policy signals.
type ZeroTrustGateway struct {
	mu       sync.RWMutex
	logger   *slog.Logger
	rules    []PolicyRule
	sessions map[string]*SessionState
	auditLog []AuditEntry
}

// SessionState tracks the security state of an active session.
type SessionState struct {
	SessionID     string
	UserID        string
	CreatedAt     time.Time
	LastActivity  time.Time
	MFAVerified   bool
	MFAVerifiedAt time.Time
	DeviceID      string
	SourceIP      string
	RiskScore     float64
}

// AuditEntry records an access decision for forensic analysis.
type AuditEntry struct {
	Timestamp time.Time      `json:"timestamp"`
	UserID    string         `json:"user_id"`
	SessionID string         `json:"session_id"`
	Resource  string         `json:"resource"`
	Action    string         `json:"action"`
	Decision  AccessDecision `json:"decision"`
	Reason    string         `json:"reason"`
	SourceIP  string         `json:"source_ip"`
	RiskScore float64        `json:"risk_score"`
}

// NewZeroTrustGateway creates a gateway with default security policies.
func NewZeroTrustGateway(logger *slog.Logger) *ZeroTrustGateway {
	gw := &ZeroTrustGateway{
		logger:   logger,
		sessions: make(map[string]*SessionState),
	}

	// Register default policy rules
	gw.rules = []PolicyRule{
		{
			Name:        "require_mfa",
			Description: "All access requires verified MFA (prevents Snowflake/Change Healthcare-style breaches)",
			Evaluate: func(ctx AccessContext) (AccessDecision, string) {
				if !ctx.MFAVerified {
					return AccessDenied, "MFA verification required"
				}
				// Re-verify MFA if last verification was more than 4 hours ago
				if time.Since(ctx.MFAVerifiedAt) > 4*time.Hour {
					return AccessRequireStepUp, "MFA re-verification required (session age)"
				}
				return AccessGranted, "MFA verified"
			},
		},
		{
			Name:        "device_compliance",
			Description: "Device must meet security baseline",
			Evaluate: func(ctx AccessContext) (AccessDecision, string) {
				if ctx.DevicePosture == nil {
					return AccessDenied, "device posture data required"
				}
				if !ctx.DevicePosture.Compliant {
					return AccessDenied, "device does not meet compliance requirements"
				}
				if !ctx.DevicePosture.EncryptionOn {
					return AccessDenied, "disk encryption required"
				}
				// Reject stale device posture (must be checked within last hour)
				if time.Since(ctx.DevicePosture.LastChecked) > time.Hour {
					return AccessRequireStepUp, "device posture check expired"
				}
				return AccessGranted, "device compliant"
			},
		},
		{
			Name:        "risk_score_check",
			Description: "Block high-risk access patterns (prevents lateral movement)",
			Evaluate: func(ctx AccessContext) (AccessDecision, string) {
				if ctx.RiskScore > 0.8 {
					return AccessDenied, fmt.Sprintf("risk score too high: %.2f", ctx.RiskScore)
				}
				if ctx.RiskScore > 0.5 {
					return AccessRequireStepUp, fmt.Sprintf("elevated risk score: %.2f", ctx.RiskScore)
				}
				return AccessGranted, "risk score acceptable"
			},
		},
		{
			Name:        "session_anomaly",
			Description: "Detect session anomalies (IP changes, impossible travel)",
			Evaluate: func(ctx AccessContext) (AccessDecision, string) {
				// In production, this would check for IP changes, geographic
				// impossibilities, and behavioral anomalies
				return AccessGranted, "no anomalies detected"
			},
		},
	}

	return gw
}

// Evaluate runs all policy rules and returns the most restrictive decision.
func (gw *ZeroTrustGateway) Evaluate(ctx AccessContext) (AccessDecision, string) {
	gw.mu.RLock()
	rules := gw.rules
	gw.mu.RUnlock()

	finalDecision := AccessGranted
	var reasons []string

	for _, rule := range rules {
		decision, reason := rule.Evaluate(ctx)
		reasons = append(reasons, fmt.Sprintf("%s: %s", rule.Name, reason))

		// Most restrictive decision wins
		if decision == AccessDenied {
			finalDecision = AccessDenied
			break
		}
		if decision == AccessRequireStepUp && finalDecision == AccessGranted {
			finalDecision = AccessRequireStepUp
		}
	}

	combinedReason := strings.Join(reasons, "; ")

	// Audit log every decision
	entry := AuditEntry{
		Timestamp: time.Now().UTC(),
		UserID:    ctx.UserID,
		SessionID: ctx.SessionID,
		Resource:  ctx.Resource,
		Action:    ctx.Action,
		Decision:  finalDecision,
		Reason:    combinedReason,
		SourceIP:  ctx.SourceIP.String(),
		RiskScore: ctx.RiskScore,
	}

	gw.mu.Lock()
	gw.auditLog = append(gw.auditLog, entry)
	gw.mu.Unlock()

	logLevel := slog.LevelInfo
	if finalDecision == AccessDenied {
		logLevel = slog.LevelWarn
	}
	gw.logger.Log(context.Background(), logLevel, "access decision",
		"user_id", ctx.UserID,
		"resource", ctx.Resource,
		"decision", finalDecision,
		"reason", combinedReason,
	)

	return finalDecision, combinedReason
}

// Middleware returns an HTTP middleware that enforces zero-trust policies.
func (gw *ZeroTrustGateway) Middleware(
	extractContext func(*http.Request) (AccessContext, error),
) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			accessCtx, err := extractContext(r)
			if err != nil {
				gw.logger.Warn("Failed to extract access context", "error", err)
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}

			decision, reason := gw.Evaluate(accessCtx)

			switch decision {
			case AccessDenied:
				http.Error(w, "Access denied: "+reason, http.StatusForbidden)
			case AccessRequireStepUp:
				w.Header().Set("X-Step-Up-Required", "true")
				http.Error(w, "Additional verification required", http.StatusForbidden)
			case AccessGranted:
				next.ServeHTTP(w, r)
			}
		})
	}
}

// GenerateSessionID creates a cryptographically secure session identifier.
func GenerateSessionID() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate session ID: %w", err)
	}
	hash := sha256.Sum256(b)
	return hex.EncodeToString(hash[:]), nil
}

// ExportAuditLog returns audit entries as JSON for SIEM integration.
func (gw *ZeroTrustGateway) ExportAuditLog() ([]byte, error) {
	gw.mu.RLock()
	defer gw.mu.RUnlock()
	return json.MarshalIndent(gw.auditLog, "", "  ")
}
```

### Lessons for Go Engineers

1. **Nine days of undetected lateral movement is a detection failure** - The Change Healthcare attackers spent
   nine days inside the network before deploying ransomware. Behavioral analytics and anomaly detection must
   identify unauthorized movement within hours, not days.
2. **A single unprotected portal can compromise an entire organization** - One Citrix portal without MFA led to
   a $2.5 billion incident. Every entry point must enforce the same security baseline.
3. **Zero-trust means verify everything, every time** - The gateway code above evaluates multiple signals (MFA
   status, device posture, risk score, session anomalies) for every request. No single signal is sufficient.
4. **Healthcare data requires the highest protection tier** - 193 million people's medical records were exposed.
   Systems handling PHI must implement defense in depth with the assumption that perimeter defenses will fail.

---

### Junior → FAANG: Single Entry Point Risk and Zero-Trust Request Validation as Interview Topics

The Change Healthcare attack is the interview answer to "what is the risk of having a single entry point without MFA?" One Citrix portal without MFA led to a $2.5 billion incident and 193 million records exposed. For FAANG interviews, the single entry point lesson is: every entry point must enforce the same security baseline. There is no concept of a "less important" portal that can have weaker authentication. Attackers seek the weakest entry, not the most prominent one. The zero-trust request validation answer from this section evaluates MFA recency, device posture, and behavioral risk score on every request, not just at login. For any service handling sensitive data, the authentication check is not "did this session start with valid credentials?" but "does this specific request meet all current security requirements at this moment?"

### Senior @ FAANG: Healthcare System Resilience and Dwell Time Detection as Platform Standards

At L6, Change Healthcare demonstrates that critical infrastructure with a single point of failure (one Citrix portal, one data processing hub for half of US healthcare claims) creates systemic risk that extends far beyond the attacked organization. The nine-day dwell time (the attacker was inside the network for nine days before deploying ransomware) is the platform-level lesson: your detection must identify unauthorized lateral movement within hours, not days. The behavioral analytics platform for this requires: establishing baselines for each service account (which resources it accesses, at what times, from which source IPs), alerting on any access that deviates from the baseline by more than a defined threshold, and automatically escalating high-deviation accesses for human review. This is the "assume breach" posture implemented at the detection layer: you do not rely on the attacker making a mistake that triggers a signature-based alert. You rely on the attacker's behavior differing from established baselines, which it always does. For healthcare and other regulated industries, you also define explicit business continuity requirements: if the primary system is offline, what is the manual fallback process, and how long can the organization sustain that fallback? Change Healthcare had no tested fallback for US claims processing, which is why pharmacies could not verify insurance for weeks.

