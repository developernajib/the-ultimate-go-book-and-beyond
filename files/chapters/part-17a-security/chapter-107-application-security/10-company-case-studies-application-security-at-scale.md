## 107.9 Company Case Studies: Application Security at Scale

### Google: Defense in Depth

Google implements multiple layers of application security across their services:

```go
// Google-style layered security middleware
package security

import (
    "context"
    "log/slog"
    "net/http"
    "strings"
)

type RateLimiter struct{}
func (r *RateLimiter) Allow(req *http.Request) bool { return true }

type InputValidator struct{}
func (v *InputValidator) ValidateRequest(req *http.Request) error { return nil }

type CSRFProtection struct{}
func (c *CSRFProtection) Validate(req *http.Request) error { return nil }

type Authorizer struct{}
func (a *Authorizer) IsAuthorized(ctx context.Context, req *http.Request) bool { return true }

type AuditLogger struct{}
func (l *AuditLogger) Log(ctx context.Context, req *http.Request) {}

func GetClientIP(r *http.Request) string {
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        parts := strings.Split(xff, ",")
        return strings.TrimSpace(parts[0])
    }
    return r.RemoteAddr
}

type contextKey string
const userKey contextKey = "user_id"

func getUserID(ctx context.Context) string {
    if id, ok := ctx.Value(userKey).(string); ok {
        return id
    }
    return "anonymous"
}

// GoogleStyleSecurityStack implements defense-in-depth
type GoogleStyleSecurityStack struct {
    logger           *slog.Logger
    rateLimiter      *RateLimiter
    validator        *InputValidator
    csrfProtection   *CSRFProtection
    authz            *Authorizer
    auditLogger      *AuditLogger
}

// Middleware applies Google's layered security approach
func (s *GoogleStyleSecurityStack) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ctx := r.Context()

        // Layer 1: Rate limiting (DDoS protection)
        if !s.rateLimiter.Allow(r) {
            s.logger.Warn("rate limit exceeded",
                "ip", GetClientIP(r),
                "path", r.URL.Path)
            http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
            return
        }

        // Layer 2: Input validation (injection prevention)
        if err := s.validator.ValidateRequest(r); err != nil {
            s.logger.Warn("invalid input",
                "error", err,
                "path", r.URL.Path)
            http.Error(w, "Bad Request", http.StatusBadRequest)
            return
        }

        // Layer 3: CSRF protection (state-changing requests)
        if isStateChanging(r.Method) {
            if err := s.csrfProtection.Validate(r); err != nil {
                s.logger.Warn("CSRF validation failed",
                    "error", err,
                    "path", r.URL.Path)
                http.Error(w, "Forbidden", http.StatusForbidden)
                return
            }
        }

        // Layer 4: Authorization check
        if !s.authz.IsAuthorized(ctx, r) {
            s.logger.Warn("unauthorized access attempt",
                "user", getUserID(ctx),
                "path", r.URL.Path)
            http.Error(w, "Forbidden", http.StatusForbidden)
            return
        }

        // Layer 5: Audit logging
        s.auditLogger.Log(ctx, r)

        // Apply security headers
        w.Header().Set("Content-Security-Policy", getCSPPolicy())
        w.Header().Set("X-Content-Type-Options", "nosniff")
        w.Header().Set("X-Frame-Options", "DENY")
        w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

        next.ServeHTTP(w, r)
    })
}

func isStateChanging(method string) bool {
    return method == "POST" || method == "PUT" || method == "DELETE" || method == "PATCH"
}

func getCSPPolicy() string {
    return "default-src 'self'; script-src 'self' 'strict-dynamic'; object-src 'none'; base-uri 'self'"
}
```

### Stripe: PCI-DSS Compliant Input Handling

Stripe processes billions in payments with strict input validation:

```go
// Stripe-style sensitive data handling
package stripe

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "regexp"
    "strings"
)

type Tokenizer struct{}

func NewTokenizer() *Tokenizer {
    return &Tokenizer{}
}

func (t *Tokenizer) Tokenize(pan string) string {
    return "tok_" + hex.EncodeToString([]byte(pan))[:16]
}

// SensitiveFieldValidator implements PCI-DSS compliant validation
type SensitiveFieldValidator struct {
    cardPattern  *regexp.Regexp
    ssnPattern   *regexp.Regexp
    tokenizer    *Tokenizer
}

func NewSensitiveFieldValidator() *SensitiveFieldValidator {
    return &SensitiveFieldValidator{
        cardPattern: regexp.MustCompile(`\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b`),
        ssnPattern:  regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`),
        tokenizer:   NewTokenizer(),
    }
}

// SanitizeInput removes sensitive data before logging/storage
func (v *SensitiveFieldValidator) SanitizeInput(input string) string {
    // Mask credit card numbers
    sanitized := v.cardPattern.ReplaceAllStringFunc(input, func(match string) string {
        cleaned := strings.ReplaceAll(strings.ReplaceAll(match, "-", ""), " ", "")
        if len(cleaned) >= 4 {
            return "****-****-****-" + cleaned[len(cleaned)-4:]
        }
        return "****"
    })

    // Mask SSNs
    sanitized = v.ssnPattern.ReplaceAllString(sanitized, "***-**-****")

    return sanitized
}

// ValidateCardNumber checks Luhn algorithm without storing full number
func (v *SensitiveFieldValidator) ValidateCardNumber(cardNumber string) (bool, string, error) {
    // Clean input
    cleaned := regexp.MustCompile(`[^0-9]`).ReplaceAllString(cardNumber, "")

    if len(cleaned) < 13 || len(cleaned) > 19 {
        return false, "", fmt.Errorf("invalid card number length")
    }

    // Luhn algorithm validation
    if !luhnCheck(cleaned) {
        return false, "", fmt.Errorf("invalid card number")
    }

    // Generate token for storage (never store actual card number)
    token := v.tokenizer.Tokenize(cleaned)

    return true, token, nil
}

// HashForLookup creates a keyed one-way hash for duplicate detection.
// PCI DSS v4 requires keyed hashing (HMAC) for PANs: the card number
// space is small enough that a plain salted SHA-256 can be brute-forced
// once the salt leaks.
func (v *SensitiveFieldValidator) HashForLookup(value string, key []byte) string {
    mac := hmac.New(sha256.New, key)
    mac.Write([]byte(value))
    return hex.EncodeToString(mac.Sum(nil))
}

func luhnCheck(number string) bool {
    sum := 0
    isSecond := false

    for i := len(number) - 1; i >= 0; i-- {
        digit := int(number[i] - '0')

        if isSecond {
            digit *= 2
            if digit > 9 {
                digit -= 9
            }
        }

        sum += digit
        isSecond = !isSecond
    }

    return sum%10 == 0
}
```

### Netflix: Context-Aware Rate Limiting

Netflix implements adaptive rate limiting based on user behavior:

```go
// Netflix-style adaptive rate limiting
package ratelimit

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// AdaptiveRateLimiter adjusts limits based on user behavior
type AdaptiveRateLimiter struct {
    mu              sync.RWMutex
    userProfiles    map[string]*UserProfile
    baseLimit       int
    premiumLimit    int
    suspiciousLimit int
}

type UserProfile struct {
    UserID          string
    TrustScore      float64  // 0.0 to 1.0
    RequestHistory  []time.Time
    FailedRequests  int
    LastSeen        time.Time
    IsPremium       bool
}

func NewAdaptiveRateLimiter() *AdaptiveRateLimiter {
    return &AdaptiveRateLimiter{
        userProfiles:    make(map[string]*UserProfile),
        baseLimit:       100,  // requests per minute
        premiumLimit:    500,
        suspiciousLimit: 10,
    }
}

// Allow checks if request should be allowed with adaptive limits
func (r *AdaptiveRateLimiter) Allow(ctx context.Context, userID string) (bool, string) {
    r.mu.Lock()
    defer r.mu.Unlock()

    profile := r.getOrCreateProfile(userID)
    r.updateProfile(profile)

    // Calculate effective limit based on trust score
    limit := r.calculateLimit(profile)

    // Count recent requests
    recentRequests := r.countRecentRequests(profile, time.Minute)

    if recentRequests >= limit {
        return false, fmt.Sprintf("rate limit exceeded: %d/%d", recentRequests, limit)
    }

    profile.RequestHistory = append(profile.RequestHistory, time.Now())
    return true, ""
}

func (r *AdaptiveRateLimiter) calculateLimit(profile *UserProfile) int {
    if profile.TrustScore < 0.3 {
        return r.suspiciousLimit
    }

    if profile.IsPremium {
        return int(float64(r.premiumLimit) * profile.TrustScore)
    }

    return int(float64(r.baseLimit) * profile.TrustScore)
}

// ReportSuspiciousActivity lowers trust score
func (r *AdaptiveRateLimiter) ReportSuspiciousActivity(userID string, severity float64) {
    r.mu.Lock()
    defer r.mu.Unlock()

    profile := r.getOrCreateProfile(userID)
    profile.TrustScore = max(0.0, profile.TrustScore-severity)
    profile.FailedRequests++
}

// RecoverTrust gradually increases trust for good behavior
func (r *AdaptiveRateLimiter) RecoverTrust(userID string) {
    r.mu.Lock()
    defer r.mu.Unlock()

    profile := r.getOrCreateProfile(userID)

    // Slowly recover trust over time
    hoursSinceLastFail := time.Since(profile.LastSeen).Hours()
    if hoursSinceLastFail > 24 && profile.FailedRequests == 0 {
        profile.TrustScore = min(1.0, profile.TrustScore+0.1)
    }
}

func (r *AdaptiveRateLimiter) getOrCreateProfile(userID string) *UserProfile {
    if profile, exists := r.userProfiles[userID]; exists {
        return profile
    }

    profile := &UserProfile{
        UserID:         userID,
        TrustScore:     0.8, // New users start with reasonable trust
        RequestHistory: make([]time.Time, 0),
        LastSeen:       time.Now(),
    }
    r.userProfiles[userID] = profile
    return profile
}

func (r *AdaptiveRateLimiter) updateProfile(profile *UserProfile) {
    profile.LastSeen = time.Now()
}

func (r *AdaptiveRateLimiter) countRecentRequests(profile *UserProfile, d time.Duration) int {
    cutoff := time.Now().Add(-d)
    count := 0
    for _, t := range profile.RequestHistory {
        if t.After(cutoff) {
            count++
        }
    }
    return count
}
```

### Amazon: Request Signing and Validation

Amazon uses request signing for API authentication:

```go
// Amazon-style request signing (similar to AWS Signature V4)
package signing

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "net/http"
    "strings"
    "time"
)

// RequestSigner implements AWS-style request signing
type RequestSigner struct {
    accessKeyID     string
    secretAccessKey string
    region          string
    service         string
}

func NewRequestSigner(accessKeyID, secretAccessKey, region, service string) *RequestSigner {
    return &RequestSigner{
        accessKeyID:     accessKeyID,
        secretAccessKey: secretAccessKey,
        region:          region,
        service:         service,
    }
}

func (s *RequestSigner) createCanonicalRequest(req *http.Request) string {
    return fmt.Sprintf("%s\n%s\n%s", req.Method, req.URL.Path, req.Header.Get("X-Amz-Date"))
}

func (s *RequestSigner) getSignedHeaders(req *http.Request) string {
    return "host;x-amz-date"
}

func parseAuthHeader(header string) (sig, credScope, signedHeaders string, err error) {
    parts := strings.Split(header, ", ")
    for _, p := range parts {
        if strings.HasPrefix(p, "Signature=") {
            sig = strings.TrimPrefix(p, "Signature=")
        } else if strings.HasPrefix(p, "SignedHeaders=") {
            signedHeaders = strings.TrimPrefix(p, "SignedHeaders=")
        }
    }
    credScope = "20260101/us-east-1/s3/aws4_request"
    return sig, credScope, signedHeaders, nil
}

// SignRequest adds authentication headers to request
func (s *RequestSigner) SignRequest(req *http.Request) error {
    now := time.Now().UTC()
    dateStamp := now.Format("20060102")
    amzDate := now.Format("20060102T150405Z")

    // Add required headers
    req.Header.Set("X-Amz-Date", amzDate)
    req.Header.Set("Host", req.Host)

    // Create canonical request
    canonicalRequest := s.createCanonicalRequest(req)

    // Create string to sign
    credentialScope := fmt.Sprintf("%s/%s/%s/aws4_request", dateStamp, s.region, s.service)
    stringToSign := fmt.Sprintf("AWS4-HMAC-SHA256\n%s\n%s\n%s",
        amzDate,
        credentialScope,
        hash(canonicalRequest))

    // Calculate signature
    signature := s.calculateSignature(dateStamp, stringToSign)

    // Add authorization header
    signedHeaders := s.getSignedHeaders(req)
    authHeader := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
        s.accessKeyID, credentialScope, signedHeaders, signature)

    req.Header.Set("Authorization", authHeader)
    return nil
}

// ValidateRequest verifies request signature
func (s *RequestSigner) ValidateRequest(req *http.Request) error {
    authHeader := req.Header.Get("Authorization")
    if authHeader == "" {
        return fmt.Errorf("missing authorization header")
    }

    // Parse authorization header
    signature, credentialScope, _, err := parseAuthHeader(authHeader)
    if err != nil {
        return fmt.Errorf("invalid authorization header: %w", err)
    }

    // Recreate canonical request
    canonicalRequest := s.createCanonicalRequest(req)

    // Recreate string to sign
    amzDate := req.Header.Get("X-Amz-Date")
    stringToSign := fmt.Sprintf("AWS4-HMAC-SHA256\n%s\n%s\n%s",
        amzDate,
        credentialScope,
        hash(canonicalRequest))

    // Calculate expected signature
    dateStamp := amzDate[:8]
    expectedSignature := s.calculateSignature(dateStamp, stringToSign)

    // Timing-safe comparison
    if !hmac.Equal([]byte(signature), []byte(expectedSignature)) {
        return fmt.Errorf("invalid signature")
    }

    return nil
}

func (s *RequestSigner) calculateSignature(dateStamp, stringToSign string) string {
    kDate := hmacSHA256([]byte("AWS4"+s.secretAccessKey), []byte(dateStamp))
    kRegion := hmacSHA256(kDate, []byte(s.region))
    kService := hmacSHA256(kRegion, []byte(s.service))
    kSigning := hmacSHA256(kService, []byte("aws4_request"))
    return hex.EncodeToString(hmacSHA256(kSigning, []byte(stringToSign)))
}

func hmacSHA256(key, data []byte) []byte {
    h := hmac.New(sha256.New, key)
    h.Write(data)
    return h.Sum(nil)
}

func hash(data string) string {
    h := sha256.Sum256([]byte(data))
    return hex.EncodeToString(h[:])
}
```

### Uber: Security Event Monitoring

Uber implements real-time security event detection:

```go
// Uber-style security event monitoring
package security

import (
    "log/slog"
    "sync"
    "time"
)

// SecurityEventType represents different security events
type SecurityEventType string

const (
    EventAuthFailure     SecurityEventType = "auth_failure"
    EventSuspiciousIP    SecurityEventType = "suspicious_ip"
    EventRateLimitHit    SecurityEventType = "rate_limit_hit"
    EventInjectionAttempt SecurityEventType = "injection_attempt"
    EventUnauthorizedAccess SecurityEventType = "unauthorized_access"
)

// SecurityEvent represents a security-relevant event
type SecurityEvent struct {
    Type      SecurityEventType
    UserID    string
    IP        string
    Path      string
    Details   map[string]any
    Timestamp time.Time
    Severity  string // low, medium, high, critical
}

// SecurityMonitor tracks and analyzes security events
type SecurityMonitor struct {
    mu            sync.RWMutex
    events        []SecurityEvent
    alertChan     chan SecurityEvent
    userFailures  map[string][]time.Time
    ipFailures    map[string][]time.Time
    logger        *slog.Logger
}

func NewSecurityMonitor(logger *slog.Logger) *SecurityMonitor {
    m := &SecurityMonitor{
        events:       make([]SecurityEvent, 0),
        alertChan:    make(chan SecurityEvent, 100),
        userFailures: make(map[string][]time.Time),
        ipFailures:   make(map[string][]time.Time),
        logger:       logger,
    }

    go m.processAlerts()
    return m
}

// RecordEvent logs security event and checks for patterns
func (m *SecurityMonitor) RecordEvent(event SecurityEvent) {
    m.mu.Lock()
    defer m.mu.Unlock()

    event.Timestamp = time.Now()
    m.events = append(m.events, event)

    // Check for suspicious patterns
    if threat := m.detectThreat(event); threat != "" {
        event.Severity = "high"
        event.Details["threat"] = threat
        m.alertChan <- event
    }

    m.logger.Info("security event",
        "type", event.Type,
        "user", event.UserID,
        "ip", event.IP,
        "severity", event.Severity)
}

// detectThreat analyzes event for attack patterns
func (m *SecurityMonitor) detectThreat(event SecurityEvent) string {
    // Track failures by user
    if event.Type == EventAuthFailure {
        m.userFailures[event.UserID] = append(m.userFailures[event.UserID], event.Timestamp)
        if m.countRecentFailures(m.userFailures[event.UserID]) > 5 {
            return "brute_force_attack"
        }
    }

    // Track failures by IP
    m.ipFailures[event.IP] = append(m.ipFailures[event.IP], event.Timestamp)
    if m.countRecentFailures(m.ipFailures[event.IP]) > 10 {
        return "distributed_attack"
    }

    // Check for injection attempts
    if event.Type == EventInjectionAttempt {
        return "injection_attack"
    }

    return ""
}

func (m *SecurityMonitor) countRecentFailures(failures []time.Time) int {
    count := 0
    threshold := time.Now().Add(-5 * time.Minute)

    for _, t := range failures {
        if t.After(threshold) {
            count++
        }
    }
    return count
}

func (m *SecurityMonitor) processAlerts() {
    for event := range m.alertChan {
        // Send to SIEM, page on-call, block IP, etc.
        m.logger.Error("SECURITY ALERT",
            "threat", event.Details["threat"],
            "user", event.UserID,
            "ip", event.IP,
            "severity", event.Severity)
    }
}
```

### Junior → FAANG: Reading Case Studies as a Learning Framework

Case studies from large companies are not just interesting stories. They are compressed lessons about what works at scale. Juniors who read them passively miss the value. The right approach is active extraction: what specific technical control did this company implement? What organizational process did they change? Could I apply this pattern at my current scale?

**Gap to close:** After reading any security case study, answer three questions: (1) What vulnerability class was exploited or prevented? (2) What specific technical control was applied? (3) What would this look like implemented in Go? If you cannot answer the third question, the case study was not actionable.

**First-job habit:** Keep a personal security incident log. When you read a public post-mortem or case study, write one paragraph summarizing the root cause, the control that would have prevented it, and how you would implement that control in your current codebase. After 20 entries, you will have a personal reference library worth more than most security textbooks.

**Interview framing:** Interviewers at FAANG companies often open with "tell me about a security incident you worked on or learned from." If you have not worked on one directly, reference a well-known public case study, explain what went wrong technically, and describe what you would do differently. Demonstrating analytical thinking about others' incidents is acceptable for L3/L4.

### Senior @ FAANG: Using Case Studies to Drive Org-Level Security Investment

At senior level, case studies are inputs to security roadmap decisions. When you want to justify an investment in a security control, a relevant case study with a quantified impact is more persuasive than a theoretical argument.

**ADR use of case studies:** When writing an ADR for a security control, reference public incidents that demonstrate the risk being mitigated. "Google's BeyondCorp model, described in their 2014 paper, motivated our move away from perimeter-based access control" is a stronger justification than "zero trust is considered best practice." Linking decisions to concrete evidence builds organizational trust in the security roadmap.

**Post-mortem culture:** At Google, Meta, and Amazon, blameless post-mortems are required after security incidents. The post-mortem identifies the contributing factors (not a single root cause), the detection gap (why did it take this long to notice?), and the corrective actions (specific, assigned, with due dates). Staff engineers drive the post-mortem process for high-severity incidents. The output is not a document that gets filed: it is a set of tracked items in the engineering backlog with owners and deadlines.

**Pattern recognition across incidents:** After reviewing multiple case studies, staff engineers identify recurring patterns. Broken access control appears in a disproportionate share of serious incidents. Credential compromise is the initial vector in most supply chain attacks. Insufficient logging is a contributing factor in almost every delayed detection story. Recognizing these patterns lets you prioritize controls that address the most common failure modes rather than chasing exotic vulnerabilities.

**Communicating risk to leadership:** Senior engineers translate case studies into business risk language for non-technical stakeholders. "The 2022 Uber breach began with a stolen contractor credential and an MFA fatigue attack, resulting in broad internal network access" becomes "our current authentication configuration has the same profile. The business risk is X." Quantify where possible (regulatory fines, breach notification costs, customer churn) to drive security investment decisions. This translation skill is a distinguishing characteristic of L6+ engineers.

---
