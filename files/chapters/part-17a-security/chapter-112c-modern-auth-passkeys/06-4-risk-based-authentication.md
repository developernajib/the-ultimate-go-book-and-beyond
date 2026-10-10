## 112C.5 Risk-Based Authentication

Risk-based authentication computes a numeric risk score for each login attempt based on contextual signals (new device fingerprint, unusual geolocation, impossible travel since the last login, recent failed attempts) and maps score ranges to authentication policy levels (allow, step-up MFA, block). The IP geolocation and device fingerprinting checks are performed against in-memory or cached data so the risk evaluation adds negligible latency to the authentication path. Higher-risk logins trigger a step-up challenge (TOTP, WebAuthn, or SMS OTP) rather than a blanket block, balancing security with usability for legitimate users who occasionally log in from new locations.

```go
package riskauth

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// RiskScore represents an authentication risk assessment
type RiskScore struct {
	Score       float64  // 0.0 (low risk) to 1.0 (high risk)
	Factors     []string // Contributing risk factors
	Action      RiskAction
	RequiredMFA []string // Additional factors required
}

// RiskAction defines what to do based on risk score
type RiskAction string

const (
	ActionAllow      RiskAction = "allow"
	ActionRequireMFA RiskAction = "require_mfa"
	ActionBlockStep  RiskAction = "block_step_up"
	ActionDeny       RiskAction = "deny"
	ActionReview     RiskAction = "review"
)

// AuthContext provides context for risk assessment
type AuthContext struct {
	UserID         string
	Email          string
	IPAddress      string
	UserAgent      string
	Country        string
	DeviceID       string
	Timestamp      time.Time
	FailedAttempts int
	LastLoginIP    string
	LastLoginTime  time.Time
	IsNewDevice    bool
	IsVPN          bool
	IsTor          bool
}

// RiskEngine assesses authentication risk
type RiskEngine struct {
	mu           sync.RWMutex
	ipReputation IPReputationService
	geoIP        GeoIPService
	deviceStore  DeviceStore
	loginHistory LoginHistoryStore
}

// IPReputationService checks IP reputation
type IPReputationService interface {
	IsKnownBad(ip string) (bool, string)
	IsVPN(ip string) bool
	IsTor(ip string) bool
	GetThreatScore(ip string) float64
}

// GeoIPService resolves IP to geographic location
type GeoIPService interface {
	GetCountry(ip string) string
	GetCity(ip string) string
	GetASN(ip string) string
}

// DeviceStore tracks known devices
type DeviceStore interface {
	IsKnownDevice(userID, deviceID string) bool
	RegisterDevice(userID, deviceID string, info DeviceInfo) error
	GetDeviceCount(userID string) int
}

// LoginHistoryStore tracks login history
type LoginHistoryStore interface {
	GetRecentAttempts(userID string, duration time.Duration) []LoginAttempt
	GetLastSuccessfulLogin(userID string) *LoginAttempt
	RecordAttempt(attempt LoginAttempt) error
}

// DeviceInfo represents device metadata
type DeviceInfo struct {
	UserAgent string
	DeviceID  string
	Platform  string
	FirstSeen time.Time
}

// LoginAttempt records a login event
type LoginAttempt struct {
	UserID    string
	IPAddress string
	Country   string
	DeviceID  string
	Success   bool
	Timestamp time.Time
	RiskScore float64
}

// AssessRisk evaluates the risk of an authentication attempt
func (e *RiskEngine) AssessRisk(ctx AuthContext) RiskScore {
	score := 0.0
	var factors []string

	// Factor 1: IP reputation
	if ctx.IsTor {
		score += 0.4
		factors = append(factors, "tor_exit_node")
	} else if ctx.IsVPN {
		score += 0.2
		factors = append(factors, "vpn_detected")
	}

	if e.ipReputation != nil {
		if isBad, reason := e.ipReputation.IsKnownBad(ctx.IPAddress); isBad {
			score += 0.5
			factors = append(factors, "bad_ip:"+reason)
		} else {
			threatScore := e.ipReputation.GetThreatScore(ctx.IPAddress)
			score += threatScore * 0.3
			if threatScore > 0.3 {
				factors = append(factors, fmt.Sprintf("suspicious_ip:%.2f", threatScore))
			}
		}
	}

	// Factor 2: Impossible travel detection
	if e.loginHistory != nil {
		lastLogin := e.loginHistory.GetLastSuccessfulLogin(ctx.UserID)
		if lastLogin != nil && lastLogin.Country != ctx.Country {
			timeDiff := ctx.Timestamp.Sub(lastLogin.Timestamp)
			if timeDiff < 2*time.Hour && lastLogin.Country != "" {
				score += 0.4
				factors = append(factors, fmt.Sprintf("impossible_travel:%s->%s",
					lastLogin.Country, ctx.Country))
			} else if timeDiff < 8*time.Hour {
				score += 0.2
				factors = append(factors, "new_country")
			}
		}
	}

	// Factor 3: New device
	if ctx.IsNewDevice {
		score += 0.15
		factors = append(factors, "new_device")
	}

	// Factor 4: Failed attempts
	if ctx.FailedAttempts > 0 {
		failurePenalty := float64(ctx.FailedAttempts) * 0.1
		if failurePenalty > 0.3 {
			failurePenalty = 0.3
		}
		score += failurePenalty
		factors = append(factors, fmt.Sprintf("failed_attempts:%d", ctx.FailedAttempts))
	}

	// Factor 5: Unusual time
	hour := ctx.Timestamp.Hour()
	if hour < 6 || hour >= 23 { // Late night / early morning
		score += 0.05
		factors = append(factors, "unusual_time")
	}

	// Factor 6: Brute force pattern
	if e.loginHistory != nil {
		recentAttempts := e.loginHistory.GetRecentAttempts(ctx.UserID, 15*time.Minute)
		failureCount := 0
		for _, attempt := range recentAttempts {
			if !attempt.Success {
				failureCount++
			}
		}
		if failureCount >= 5 {
			score += 0.3
			factors = append(factors, "brute_force_pattern")
		}
	}

	// Cap score at 1.0
	if score > 1.0 {
		score = 1.0
	}

	// Determine action and required MFA
	risk := RiskScore{
		Score:   score,
		Factors: factors,
	}

	switch {
	case score >= 0.8:
		risk.Action = ActionDeny
	case score >= 0.6:
		risk.Action = ActionBlockStep
		risk.RequiredMFA = []string{"webauthn", "totp"}
	case score >= 0.3:
		risk.Action = ActionRequireMFA
		risk.RequiredMFA = []string{"totp"}
	default:
		risk.Action = ActionAllow
	}

	// High-value operations always require MFA regardless of risk
	// (enforced by the calling code, not the risk engine)

	return risk
}

// AdaptiveMFAHandler handles adaptive MFA challenges
type AdaptiveMFAHandler struct {
	riskEngine *RiskEngine
	totpSvc    TOTPValidator
	webauthn   WebAuthnValidator
	sessions   SessionStore
}

// TOTPValidator validates TOTP codes
type TOTPValidator interface {
	ValidateTOTP(userID, code string) (bool, error)
}

// WebAuthnValidator validates WebAuthn assertions
type WebAuthnValidator interface {
	BeginAuthentication(userID string) (any, string, error)
	FinishAuthentication(userID, sessionKey string, r any) error
}

// SessionStore manages authentication sessions
type SessionStore interface {
	Create(userID string, risk RiskScore) (string, error)
	Get(sessionID string) (*AuthSession, error)
	Upgrade(sessionID string, factor string) error
}

// AuthSession represents an authentication session
type AuthSession struct {
	SessionID        string
	UserID           string
	CompletedFactors []string
	RiskScore        RiskScore
	CreatedAt        time.Time
	ExpiresAt        time.Time
}

// IsFullyAuthenticated checks if all required factors are completed
func (s *AuthSession) IsFullyAuthenticated() bool {
	required := s.RiskScore.RequiredMFA
	if len(required) == 0 {
		return true
	}

	for _, req := range required {
		found := false
		for _, completed := range s.CompletedFactors {
			if completed == req {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// ContinuousVerification implements zero-trust continuous authentication
type ContinuousVerification struct {
	mu           sync.RWMutex
	sessions     map[string]*VerifiedSession
	riskEngine   *RiskEngine
	verifyPeriod time.Duration
}

// VerifiedSession tracks a continuously verified session
type VerifiedSession struct {
	SessionID    string
	UserID       string
	LastVerified time.Time
	RiskHistory  []float64
	PostureScore float64
	Invalidated  bool
}

// NewContinuousVerification creates a continuous verification service
func NewContinuousVerification(riskEngine *RiskEngine, period time.Duration) *ContinuousVerification {
	return &ContinuousVerification{
		sessions:     make(map[string]*VerifiedSession),
		riskEngine:   riskEngine,
		verifyPeriod: period,
	}
}

// Register adds a session to continuous verification tracking
func (cv *ContinuousVerification) Register(sessionID, userID string) {
	cv.mu.Lock()
	defer cv.mu.Unlock()

	cv.sessions[sessionID] = &VerifiedSession{
		SessionID:    sessionID,
		UserID:       userID,
		LastVerified: time.Now(),
	}
}

// Verify continuously verifies a session's trustworthiness
func (cv *ContinuousVerification) Verify(sessionID string, ctx AuthContext) error {
	cv.mu.Lock()
	defer cv.mu.Unlock()

	session, exists := cv.sessions[sessionID]
	if !exists {
		return fmt.Errorf("session not found")
	}

	if session.Invalidated {
		return fmt.Errorf("session has been invalidated")
	}

	// Check if re-verification is needed
	if time.Since(session.LastVerified) > cv.verifyPeriod {
		risk := cv.riskEngine.AssessRisk(ctx)

		// Track risk history
		session.RiskHistory = append(session.RiskHistory, risk.Score)
		if len(session.RiskHistory) > 10 {
			session.RiskHistory = session.RiskHistory[1:]
		}

		// Calculate trending risk
		avgRisk := 0.0
		for _, r := range session.RiskHistory {
			avgRisk += r
		}
		avgRisk /= float64(len(session.RiskHistory))

		if avgRisk > 0.7 || risk.Score > 0.8 {
			session.Invalidated = true
			return fmt.Errorf("session invalidated due to elevated risk: %.2f", risk.Score)
		}

		session.PostureScore = risk.Score
		session.LastVerified = time.Now()
	}

	return nil
}

// GetPosture returns the current security posture for a session
func (cv *ContinuousVerification) GetPosture(sessionID string) (float64, error) {
	cv.mu.RLock()
	defer cv.mu.RUnlock()

	session, exists := cv.sessions[sessionID]
	if !exists {
		return 0, fmt.Errorf("session not found")
	}

	return session.PostureScore, nil
}

// DevicePostureChecker assesses device security posture
type DevicePostureChecker struct{}

// DevicePosture represents the security state of a device
type DevicePosture struct {
	IsManaged        bool
	OSVersion        string
	PatchLevel       string
	AntivirusActive  bool
	DiskEncrypted    bool
	ScreenLockActive bool
	ComplianceScore  float64
}

// CheckPosture evaluates device compliance
func (d *DevicePostureChecker) CheckPosture(deviceID string, claims map[string]any) DevicePosture {
	posture := DevicePosture{}

	// Extract device posture from client certificate or device attestation
	// In production: integrate with MDM (Jamf, Intune) or device attestation services
	isManaged, _ := claims["device_managed"].(bool)
	posture.IsManaged = isManaged

	encrypted, _ := claims["disk_encrypted"].(bool)
	posture.DiskEncrypted = encrypted

	antivirusActive, _ := claims["antivirus_active"].(bool)
	posture.AntivirusActive = antivirusActive

	screenLock, _ := claims["screen_lock_active"].(bool)
	posture.ScreenLockActive = screenLock

	// Calculate compliance score
	score := 0.0
	if posture.IsManaged {
		score += 0.4
	}
	if posture.DiskEncrypted {
		score += 0.3
	}
	if posture.AntivirusActive {
		score += 0.2
	}
	if posture.ScreenLockActive {
		score += 0.1
	}

	posture.ComplianceScore = score
	return posture
}

// ZeroTrustGateway implements zero-trust access control
type ZeroTrustGateway struct {
	policyEngine    PolicyEngine
	continuousVerif *ContinuousVerification
	deviceChecker   *DevicePostureChecker
	riskEngine      *RiskEngine
}

// PolicyEngine evaluates access policies
type PolicyEngine interface {
	EvaluatePolicy(userID, resource, action string, context map[string]any) (bool, string)
}

// AccessRequest represents a resource access request
type AccessRequest struct {
	SessionID string
	UserID    string
	Resource  string
	Action    string
	Context   AuthContext
}

// EvaluateAccess makes a zero-trust access decision
func (g *ZeroTrustGateway) EvaluateAccess(req AccessRequest) (bool, string) {
	// 1. Verify session is still valid
	if err := g.continuousVerif.Verify(req.SessionID, req.Context); err != nil {
		return false, "session_invalid: " + err.Error()
	}

	// 2. Assess current risk
	risk := g.riskEngine.AssessRisk(req.Context)
	if risk.Action == ActionDeny {
		return false, fmt.Sprintf("risk_too_high: %.2f (factors: %s)",
			risk.Score, strings.Join(risk.Factors, ","))
	}

	// 3. Check the session's risk posture (higher means riskier)
	posture, err := g.continuousVerif.GetPosture(req.SessionID)
	if err != nil || posture > 0.5 {
		return false, "session_risk_posture_too_high"
	}

	// 4. Evaluate policy
	context := map[string]any{
		"risk_score":     risk.Score,
		"device_posture": posture,
		"user_id":        req.UserID,
		"ip_address":     req.Context.IPAddress,
	}

	allowed, reason := g.policyEngine.EvaluatePolicy(
		req.UserID, req.Resource, req.Action, context)

	return allowed, reason
}
```

---
