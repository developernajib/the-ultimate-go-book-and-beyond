## 107.14 Detailed Interview Questions with Frameworks

### Question 1: Designing a Secure Authentication System

**What FAANG expects:** Argon2id for password storage (bcrypt in legacy systems), PKCE-mandatory OAuth 2.1 / OIDC for auth flows, MFA with WebAuthn/passkeys (not SMS, which is SS7-bypassable), rate-limited login with account-level lockout, password-pwnage check (HaveIBeenPwned API). Session tokens: short-lived access JWT (< 15m) + rotating refresh tokens. No custom crypto. Bonus for naming passkey-only flows as the 2026 direction (Apple, Google, and Microsoft all pushing passwordless-by-default).

**Problem**: Design a complete authentication system with proper security controls.

```
┌─────────────────────────────────────────────────────────────────┐
│           AUTHENTICATION SECURITY FRAMEWORK                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. PASSWORD STORAGE                                            │
│     ├─ Use bcrypt/argon2 (NEVER store plaintext or MD5/SHA)     │
│     ├─ Cost factor 12+ for bcrypt                               │
│     └─ Per-password random salt (built into bcrypt)             │
│                                                                 │
│  2. LOGIN PROCESS                                               │
│     ├─ Rate limit by IP AND username                            │
│     ├─ Constant-time password comparison                        │
│     ├─ Same error for invalid user vs wrong password            │
│     └─ Account lockout after N failures (with notification)     │
│                                                                 │
│  3. SESSION MANAGEMENT                                          │
│     ├─ Use crypto/rand for session IDs (min 128 bits)           │
│     ├─ Secure cookie flags: HttpOnly, Secure, SameSite=Strict   │
│     ├─ Session timeout (absolute + idle)                        │
│     ├─ Session invalidation on logout                           │
│     └─ Rotate session ID after authentication                   │
│                                                                 │
│  4. MULTI-FACTOR AUTHENTICATION                                 │
│     ├─ TOTP (RFC 6238) with backup codes                        │
│     ├─ WebAuthn for passwordless option                         │
│     └─ Remember device with encrypted token                     │
│                                                                 │
│  5. SECURITY EVENTS                                             │
│     ├─ Log all auth attempts (success/failure)                  │
│     ├─ Alert on suspicious patterns                             │
│     └─ Notify user of new device/location login                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// Complete secure authentication implementation
package auth

import (
    "context"
    "crypto/rand"
    "encoding/base64"
    "errors"
    "net/http"
    "time"

    "golang.org/x/crypto/bcrypt"
)

var (
    ErrInvalidCredentials = errors.New("invalid credentials")
    ErrAccountLocked      = errors.New("account locked")
    ErrMFARequired        = errors.New("MFA required")
)

type User struct {
    ID           string
    Username     string
    PasswordHash string
    LockedUntil  time.Time
    MFAEnabled   bool
    MFASecret    string
}

type LoginRequest struct {
    Username  string
    Password  string
    MFACode   string
    IP        string
    UserAgent string
}

type Session struct {
    ID        string
    UserID    string
    CreatedAt time.Time
    ExpiresAt time.Time
    LastSeen  time.Time
    IP        string
    UserAgent string
}

type UserRepository interface {
    GetByUsername(ctx context.Context, username string) (*User, error)
    ClearLoginFailures(ctx context.Context, userID string) error
}

type SessionStore interface {
    Create(ctx context.Context, session *Session) error
}

type RateLimiter struct{}

func (r *RateLimiter) AllowLogin(ip, username string) bool { return true }

type EventType string

const (
    EventRateLimitHit EventType = "rate_limit_hit"
    EventAuthSuccess  EventType = "auth_success"
)

type SecurityEvent struct {
    Type   EventType
    IP     string
    UserID string
}

type SecurityMonitor struct{}

func (m *SecurityMonitor) RecordEvent(e SecurityEvent) {}

type AuthService struct {
    userRepo        UserRepository
    sessionStore    SessionStore
    rateLimiter     *RateLimiter
    securityMonitor *SecurityMonitor
    bcryptCost      int
}

func NewAuthService(
    userRepo UserRepository,
    sessionStore SessionStore,
    rateLimiter *RateLimiter,
    securityMonitor *SecurityMonitor,
) *AuthService {
    return &AuthService{
        userRepo:        userRepo,
        sessionStore:    sessionStore,
        rateLimiter:     rateLimiter,
        securityMonitor: securityMonitor,
        bcryptCost:      12, // Production-appropriate cost
    }
}

// Login authenticates user with security controls
func (s *AuthService) Login(ctx context.Context, req LoginRequest) (*Session, error) {
    // Step 1: Rate limiting
    if !s.rateLimiter.AllowLogin(req.IP, req.Username) {
        s.securityMonitor.RecordEvent(SecurityEvent{
            Type:   EventRateLimitHit,
            IP:     req.IP,
            UserID: req.Username,
        })
        return nil, ErrInvalidCredentials // Same error to prevent enumeration
    }

    // Step 2: Get user (always do password check to prevent timing attack)
    user, err := s.userRepo.GetByUsername(ctx, req.Username)

    var hashToCompare []byte
    if err != nil || user == nil {
        // Use dummy hash to maintain constant timing
        hashToCompare = s.getDummyHash()
    } else {
        hashToCompare = []byte(user.PasswordHash)
    }

    // Step 3: Password verification (always runs)
    err = bcrypt.CompareHashAndPassword(hashToCompare, []byte(req.Password))

    // Step 4: Check result (after constant-time comparison)
    if user == nil || err != nil {
        s.recordFailedLogin(ctx, req)
        return nil, ErrInvalidCredentials
    }

    // Step 5: Check account lock status
    if user.LockedUntil.After(time.Now()) {
        return nil, ErrAccountLocked
    }

    // Step 6: Check MFA requirement
    if user.MFAEnabled && req.MFACode == "" {
        return nil, ErrMFARequired
    }
    if user.MFAEnabled {
        if !s.verifyTOTP(user.MFASecret, req.MFACode) {
            s.recordFailedLogin(ctx, req)
            return nil, ErrInvalidCredentials
        }
    }

    // Step 7: Create secure session
    session, err := s.createSession(ctx, user, req.IP, req.UserAgent)
    if err != nil {
        return nil, err
    }

    // Step 8: Clear failed login count
    _ = s.userRepo.ClearLoginFailures(ctx, user.ID)

    // Step 9: Log successful authentication
    s.securityMonitor.RecordEvent(SecurityEvent{
        Type:   EventAuthSuccess,
        UserID: user.ID,
        IP:     req.IP,
    })

    return session, nil
}

// createSession generates secure session with proper configuration
func (s *AuthService) createSession(
    ctx context.Context,
    user *User,
    ip, userAgent string,
) (*Session, error) {
    // Generate cryptographically secure session ID
    sessionID, err := generateSecureToken(32) // 256 bits
    if err != nil {
        return nil, err
    }

    session := &Session{
        ID:        sessionID,
        UserID:    user.ID,
        CreatedAt: time.Now(),
        ExpiresAt: time.Now().Add(24 * time.Hour), // Absolute timeout
        LastSeen:  time.Now(),
        IP:        ip,
        UserAgent: userAgent,
    }

    if err := s.sessionStore.Create(ctx, session); err != nil {
        return nil, err
    }

    return session, nil
}

// SetSecureCookie configures session cookie with security flags
func SetSecureCookie(w http.ResponseWriter, sessionID string) {
    http.SetCookie(w, &http.Cookie{
        Name:     "session_id",
        Value:    sessionID,
        Path:     "/",
        HttpOnly: true,                    // Prevent JavaScript access
        Secure:   true,                    // HTTPS only
        SameSite: http.SameSiteStrictMode, // CSRF protection
        MaxAge:   86400,                   // 24 hours
    })
}

func generateSecureToken(bytes int) (string, error) {
    b := make([]byte, bytes)
    if _, err := rand.Read(b); err != nil {
        return "", err
    }
    return base64.URLEncoding.EncodeToString(b), nil
}

func (s *AuthService) getDummyHash() []byte {
    return []byte("$2a$12$e86g55o9Y0X8lJb7aY7OmeD7x0y1y0W2f/4kYp0d6qE8kI1u/7j6u")
}

func (s *AuthService) recordFailedLogin(ctx context.Context, req LoginRequest) {}

func (s *AuthService) verifyTOTP(secret, code string) bool { return code != "" }
```

---

### Question 2: Explain Your Approach to Input Validation

**What FAANG expects:** Defense in depth: schema validation at the edge (OpenAPI + `validator/v10`), type-driven validation in the handler, parameterized queries at the DB, output encoding for XSS. Deny-list < allow-list. Canonicalize before validating (Unicode normalization, URL decoding). Bonus for naming ozzo-validation as the idiomatic Go alternative to struct-tag validators for complex rules, and for citing OWASP Top 10 A03:2021 (Injection) as the umbrella category.

**Problem**: How do you validate user input to prevent injection attacks?

```
┌─────────────────────────────────────────────────────────────────┐
│           INPUT VALIDATION LAYERS FRAMEWORK                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  LAYER 1: SYNTACTIC VALIDATION                                  │
│  ├─ Check data type (is it a valid integer/date/email?)         │
│  ├─ Check length (min/max bounds)                               │
│  ├─ Check format (regex for patterns like phone numbers)        │
│  └─ Check character set (alphanumeric only? Unicode?)           │
│                                                                 │
│  LAYER 2: SEMANTIC VALIDATION                                   │
│  ├─ Check business rules (age must be positive)                 │
│  ├─ Check relationships (end_date > start_date)                 │
│  ├─ Check against allowed values (status in [draft,published])  │
│  └─ Check permissions (user can set this role?)                 │
│                                                                 │
│  LAYER 3: SANITIZATION (Output Encoding)                        │
│  ├─ HTML context → HTML entity encoding                         │
│  ├─ SQL context → Parameterized queries (not escaping!)         │
│  ├─ URL context → URL encoding                                  │
│  └─ JSON context → Proper JSON serialization                    │
│                                                                 │
│  KEY PRINCIPLE: Validate input, encode output                   │
│  Different outputs need different encoding!                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// Production input validation implementation
package validation

import (
    "errors"
    "fmt"
    "regexp"
    "strings"
    "unicode/utf8"
)

type CreateUserRequest struct {
    Email    string
    Password string
    Name     string
    Role     string
}

// ValidationError contains detailed validation failure information
type ValidationError struct {
    Field   string `json:"field"`
    Message string `json:"message"`
    Code    string `json:"code"`
}

type ValidationResult struct {
    Valid  bool
    Errors []ValidationError
}

// Request validator with comprehensive rules
type RequestValidator struct {
    rules map[string][]Rule
}

type Rule interface {
    Validate(value any) error
    Name() string
}

// Common validation rules
type RequiredRule struct{}
func (r RequiredRule) Name() string { return "required" }
func (r RequiredRule) Validate(value any) error {
    if value == nil {
        return errors.New("is required")
    }
    if str, ok := value.(string); ok && strings.TrimSpace(str) == "" {
        return errors.New("is required")
    }
    return nil
}

type MaxLengthRule struct{ Max int }
func (r MaxLengthRule) Name() string { return "max_length" }
func (r MaxLengthRule) Validate(value any) error {
    if str, ok := value.(string); ok {
        if utf8.RuneCountInString(str) > r.Max {
            return fmt.Errorf("must not exceed %d characters", r.Max)
        }
    }
    return nil
}

type PatternRule struct {
    Pattern *regexp.Regexp
    Message string
}
func (r PatternRule) Name() string { return "pattern" }
func (r PatternRule) Validate(value any) error {
    if str, ok := value.(string); ok {
        if !r.Pattern.MatchString(str) {
            return errors.New(r.Message)
        }
    }
    return nil
}

type AllowedValuesRule struct{ Values []string }
func (r AllowedValuesRule) Name() string { return "allowed_values" }
func (r AllowedValuesRule) Validate(value any) error {
    if str, ok := value.(string); ok {
        for _, v := range r.Values {
            if str == v {
                return nil
            }
        }
        return fmt.Errorf("must be one of: %v", r.Values)
    }
    return nil
}

// NoSQLInjectionRule checks for common SQL injection patterns
type NoSQLInjectionRule struct{}
func (r NoSQLInjectionRule) Name() string { return "no_sql_injection" }
func (r NoSQLInjectionRule) Validate(value any) error {
    if str, ok := value.(string); ok {
        suspicious := []string{
            "'--", "';", "' OR ", "' AND ",
            "UNION SELECT", "DROP TABLE", "DELETE FROM",
            "/*", "*/", "xp_", "0x",
        }
        upper := strings.ToUpper(str)
        for _, pattern := range suspicious {
            if strings.Contains(upper, strings.ToUpper(pattern)) {
                return errors.New("contains potentially malicious content")
            }
        }
    }
    return nil
}

// ValidateCreateUserRequest validates user creation input
func ValidateCreateUserRequest(req CreateUserRequest) ValidationResult {
    result := ValidationResult{Valid: true}

    // Email validation
    if req.Email == "" {
        result.addError("email", "is required", "required")
    } else {
        emailRegex := regexp.MustCompile(`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`)
        if !emailRegex.MatchString(req.Email) {
            result.addError("email", "must be a valid email address", "format")
        }
        if len(req.Email) > 254 {
            result.addError("email", "must not exceed 254 characters", "max_length")
        }
    }

    // Password validation
    if req.Password == "" {
        result.addError("password", "is required", "required")
    } else if len(req.Password) < 12 {
        result.addError("password", "must be at least 12 characters", "min_length")
    } else {
        if !regexp.MustCompile(`[A-Z]`).MatchString(req.Password) {
            result.addError("password", "must contain uppercase letter", "pattern")
        }
        if !regexp.MustCompile(`[a-z]`).MatchString(req.Password) {
            result.addError("password", "must contain lowercase letter", "pattern")
        }
        if !regexp.MustCompile(`[0-9]`).MatchString(req.Password) {
            result.addError("password", "must contain number", "pattern")
        }
        if !regexp.MustCompile(`[!@#$%^&*(),.?":{}|<>]`).MatchString(req.Password) {
            result.addError("password", "must contain special character", "pattern")
        }
    }

    // Name validation (prevent XSS/injection in stored data)
    if req.Name != "" {
        if len(req.Name) > 100 {
            result.addError("name", "must not exceed 100 characters", "max_length")
        }
        // Allow Unicode letters and common punctuation
        nameRegex := regexp.MustCompile(`^[\p{L}\p{M}\s\-'.]+$`)
        if !nameRegex.MatchString(req.Name) {
            result.addError("name", "contains invalid characters", "pattern")
        }
    }

    // Role validation (allowlist)
    allowedRoles := []string{"user", "admin", "moderator"}
    validRole := false
    for _, role := range allowedRoles {
        if req.Role == role {
            validRole = true
            break
        }
    }
    if !validRole {
        result.addError("role", "must be one of: user, admin, moderator", "allowed_values")
    }

    return result
}

func (r *ValidationResult) addError(field, message, code string) {
    r.Valid = false
    r.Errors = append(r.Errors, ValidationError{
        Field:   field,
        Message: message,
        Code:    code,
    })
}
```

---

### Question 3: Design a Rate Limiting System

**What FAANG expects:** Security-focused rate limiter: per-IP + per-account + per-endpoint, with tighter limits on auth endpoints (login, password reset, MFA). Account lockout after N failures with exponential backoff. Captcha on suspicious patterns. Log and alert on rate-limit breaches. Bonus for distinguishing abuse-prevention rate limiting (security) from capacity rate limiting (SLO) and for calling out that a rate-limiter bypass via X-Forwarded-For spoofing is the most common real-world failure.

**Problem**: Design a rate limiting system that protects against abuse while minimizing impact on legitimate users.

```
┌─────────────────────────────────────────────────────────────────┐
│           MULTI-TIER RATE LIMITING FRAMEWORK                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  TIER 1: GLOBAL LIMITS (Infrastructure Protection)              │
│  └─ Requests per second across entire service                   │
│                                                                 │
│  TIER 2: IP-BASED LIMITS (DDoS Protection)                      │
│  ├─ Short window: 100 requests per second per IP                │
│  └─ Long window: 10,000 requests per hour per IP                │
│                                                                 │
│  TIER 3: USER-BASED LIMITS (Abuse Prevention)                   │
│  ├─ Authenticated: 1000 requests per minute                     │
│  ├─ Anonymous: 60 requests per minute                           │
│  └─ Premium tiers get higher limits                             │
│                                                                 │
│  TIER 4: ENDPOINT-SPECIFIC LIMITS (Resource Protection)         │
│  ├─ Login: 5 attempts per minute per username                   │
│  ├─ Password reset: 3 per hour per email                        │
│  ├─ Search: 30 per minute                                       │
│  └─ Export: 5 per hour                                          │
│                                                                 │
│  ALGORITHMS:                                                    │
│  ├─ Token Bucket: Allows bursts, smooths over time              │
│  ├─ Sliding Window: More accurate, higher memory                │
│  └─ Leaky Bucket: Constant rate, no bursts                      │
│                                                                 │
│  RESPONSE:                                                      │
│  ├─ HTTP 429 Too Many Requests                                  │
│  ├─ Retry-After header                                          │
│  ├─ X-RateLimit-* headers for visibility                        │
│  └─ Exponential backoff recommendation                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// Production-ready multi-tier rate limiter
package ratelimit

import (
    "context"
    "fmt"
    "net"
    "net/http"
    "strings"
    "sync"
    "time"
)

// RateLimitConfig defines limits for an endpoint
type RateLimitConfig struct {
    RequestsPerSecond int
    RequestsPerMinute int
    RequestsPerHour   int
    BurstSize         int
}

// MultiTierRateLimiter implements comprehensive rate limiting
type MultiTierRateLimiter struct {
    globalLimiter   *SlidingWindowLimiter
    ipLimiters      sync.Map // IP -> *TokenBucket
    userLimiters    sync.Map // UserID -> *TokenBucket
    endpointConfigs map[string]RateLimitConfig
    defaultConfig   RateLimitConfig
}

func NewMultiTierRateLimiter() *MultiTierRateLimiter {
    return &MultiTierRateLimiter{
        globalLimiter: NewSlidingWindowLimiter(10000, time.Second),
        endpointConfigs: map[string]RateLimitConfig{
            "POST /auth/login": {
                RequestsPerMinute: 5,
                BurstSize:         3,
            },
            "POST /auth/password-reset": {
                RequestsPerHour: 3,
                BurstSize:       1,
            },
            "GET /search": {
                RequestsPerMinute: 30,
                BurstSize:         10,
            },
            "POST /export": {
                RequestsPerHour: 5,
                BurstSize:       2,
            },
        },
        defaultConfig: RateLimitConfig{
            RequestsPerMinute: 60,
            BurstSize:         20,
        },
    }
}

// RateLimitResult contains rate limit status information
type RateLimitResult struct {
    Allowed      bool
    Remaining    int
    ResetAt      time.Time
    RetryAfter   time.Duration
    LimitType    string // "global", "ip", "user", "endpoint"
}

// Check performs multi-tier rate limit check
func (rl *MultiTierRateLimiter) Check(ctx context.Context, req *http.Request) RateLimitResult {
    // Tier 1: Global limit
    if !rl.globalLimiter.Allow() {
        return RateLimitResult{
            Allowed:    false,
            RetryAfter: time.Second,
            LimitType:  "global",
        }
    }

    // Get identifiers
    ip := GetRealIP(req)
    userID := getUserIDFromContext(ctx)
    endpoint := fmt.Sprintf("%s %s", req.Method, req.URL.Path)

    // Tier 2: IP-based limit
    ipResult := rl.checkIPLimit(ip)
    if !ipResult.Allowed {
        ipResult.LimitType = "ip"
        return ipResult
    }

    // Tier 3: User-based limit (if authenticated)
    if userID != "" {
        userResult := rl.checkUserLimit(userID)
        if !userResult.Allowed {
            userResult.LimitType = "user"
            return userResult
        }
    }

    // Tier 4: Endpoint-specific limit
    endpointResult := rl.checkEndpointLimit(endpoint, ip, userID)
    if !endpointResult.Allowed {
        endpointResult.LimitType = "endpoint"
        return endpointResult
    }

    return RateLimitResult{
        Allowed:   true,
        Remaining: endpointResult.Remaining,
        ResetAt:   endpointResult.ResetAt,
    }
}

// Middleware wraps handlers with rate limiting
func (rl *MultiTierRateLimiter) Middleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        result := rl.Check(r.Context(), r)

        // Set rate limit headers for visibility
        w.Header().Set("X-RateLimit-Remaining", fmt.Sprintf("%d", result.Remaining))
        w.Header().Set("X-RateLimit-Reset", result.ResetAt.Format(time.RFC3339))

        if !result.Allowed {
            w.Header().Set("Retry-After", fmt.Sprintf("%d", int(result.RetryAfter.Seconds())))
            w.Header().Set("X-RateLimit-Type", result.LimitType)

            http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
            return
        }

        next.ServeHTTP(w, r)
    })
}

// SlidingWindowLimiter provides accurate rate limiting
type SlidingWindowLimiter struct {
    mu          sync.Mutex
    requests    []time.Time
    limit       int
    windowSize  time.Duration
}

func NewSlidingWindowLimiter(limit int, window time.Duration) *SlidingWindowLimiter {
    return &SlidingWindowLimiter{
        requests:   make([]time.Time, 0),
        limit:      limit,
        windowSize: window,
    }
}

func (sw *SlidingWindowLimiter) Allow() bool {
    sw.mu.Lock()
    defer sw.mu.Unlock()

    now := time.Now()
    windowStart := now.Add(-sw.windowSize)

    // Remove old requests
    validRequests := make([]time.Time, 0)
    for _, t := range sw.requests {
        if t.After(windowStart) {
            validRequests = append(validRequests, t)
        }
    }
    sw.requests = validRequests

    // Check limit
    if len(sw.requests) >= sw.limit {
        return false
    }

    sw.requests = append(sw.requests, now)
    return true
}

func GetRealIP(r *http.Request) string {
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        parts := strings.Split(xff, ",")
        return strings.TrimSpace(parts[0])
    }
    host, _, err := net.SplitHostPort(r.RemoteAddr)
    if err != nil {
        return r.RemoteAddr
    }
    return host
}

type contextKey string
const userContextKey contextKey = "user_id"

func getUserIDFromContext(ctx context.Context) string {
    if val, ok := ctx.Value(userContextKey).(string); ok {
        return val
    }
    return ""
}

func (rl *MultiTierRateLimiter) checkIPLimit(ip string) RateLimitResult {
    return RateLimitResult{Allowed: true, Remaining: 100, ResetAt: time.Now().Add(time.Minute)}
}

func (rl *MultiTierRateLimiter) checkUserLimit(userID string) RateLimitResult {
    return RateLimitResult{Allowed: true, Remaining: 1000, ResetAt: time.Now().Add(time.Minute)}
}

func (rl *MultiTierRateLimiter) checkEndpointLimit(endpoint, ip, userID string) RateLimitResult {
    return RateLimitResult{Allowed: true, Remaining: 50, ResetAt: time.Now().Add(time.Minute)}
}
```

---

### Question 4: Securing API Endpoints

**What FAANG expects:** Layered: TLS 1.3 everywhere, auth (OAuth 2.1 bearer / mTLS for service-to-service), authorization at both controller and service layer, input validation, rate limits, CORS allow-list (never `*` with credentials), security headers (HSTS, CSP, X-Content-Type-Options), output encoding. Bonus for naming OWASP API Top 10 2023 (BOLA, Broken Authentication, Unrestricted Resource Consumption), and for calling out that BOLA (Broken Object-Level Authorization) is the #1 real-world API vuln. Every request must verify the caller owns the object ID they're asking about.

**Problem**: How do you secure a REST API with proper authentication and authorization?

```
┌─────────────────────────────────────────────────────────────────┐
│           API SECURITY LAYERS FRAMEWORK                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  REQUEST FLOW:                                                  │
│  Client → TLS → Rate Limit → Auth → Authz → Validation → Handler│
│                                                                 │
│  1. TRANSPORT SECURITY                                          │
│     ├─ TLS 1.3 required (reject < 1.2)                          │
│     ├─ Strong cipher suites only                                │
│     └─ Certificate pinning for mobile clients                   │
│                                                                 │
│  2. AUTHENTICATION                                              │
│     ├─ JWT with short expiration (15 min)                       │
│     ├─ Refresh token rotation (single use)                      │
│     ├─ Bearer token in Authorization header                     │
│     └─ API keys for service-to-service                          │
│                                                                 │
│  3. AUTHORIZATION                                               │
│     ├─ RBAC or ABAC model                                       │
│     ├─ Resource-level permissions                               │
│     ├─ Principle of least privilege                             │
│     └─ Audit logging for sensitive operations                   │
│                                                                 │
│  4. REQUEST VALIDATION                                          │
│     ├─ Content-Type enforcement                                 │
│     ├─ Request size limits                                      │
│     ├─ Schema validation (OpenAPI)                              │
│     └─ Sanitize all inputs                                      │
│                                                                 │
│  5. RESPONSE SECURITY                                           │
│     ├─ Filter sensitive fields                                  │
│     ├─ Security headers                                         │
│     └─ Error messages without internals                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// Secure API implementation
package api

import (
    "context"
    "crypto/rsa"
    "encoding/json"
    "errors"
    "net/http"
    "strings"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

type RateLimiter struct{}

func RateLimitMiddleware(rl *RateLimiter) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            next.ServeHTTP(w, r)
        })
    }
}

type AuthorizationService struct{}

func (a *AuthorizationService) GetRequiredPermission(method, path string) string {
    return "read"
}

func (a *AuthorizationService) HasPermission(ctx context.Context, userID, permission string) bool {
    return true
}

// SecurityMiddlewareStack applies all security layers
func SecurityMiddlewareStack(
    rateLimiter *RateLimiter,
    jwtSecret *rsa.PublicKey,
    authzService *AuthorizationService,
) func(http.Handler) http.Handler {
    return func(handler http.Handler) http.Handler {
        // Apply in reverse order (last applied executes first)
        h := handler
        h = RequestValidationMiddleware(h)
        h = AuthorizationMiddleware(authzService)(h)
        h = JWTAuthMiddleware(jwtSecret)(h)
        h = RateLimitMiddleware(rateLimiter)(h)
        h = SecureHeadersMiddleware(h)
        return h
    }
}

// JWTAuthMiddleware validates JWT tokens
func JWTAuthMiddleware(publicKey *rsa.PublicKey) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract token from Authorization header
            authHeader := r.Header.Get("Authorization")
            if authHeader == "" {
                writeError(w, "missing authorization header", http.StatusUnauthorized)
                return
            }

            parts := strings.SplitN(authHeader, " ", 2)
            if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
                writeError(w, "invalid authorization format", http.StatusUnauthorized)
                return
            }

            tokenString := parts[1]

            // Parse and validate token
            token, err := jwt.Parse(tokenString, func(token *jwt.Token) (any, error) {
                // Verify signing algorithm
                if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
                    return nil, errors.New("unexpected signing method")
                }
                return publicKey, nil
            })

            if err != nil || !token.Valid {
                writeError(w, "invalid token", http.StatusUnauthorized)
                return
            }

            claims, ok := token.Claims.(jwt.MapClaims)
            if !ok {
                writeError(w, "invalid token claims", http.StatusUnauthorized)
                return
            }

            // Verify expiration
            if exp, ok := claims["exp"].(float64); ok {
                if time.Unix(int64(exp), 0).Before(time.Now()) {
                    writeError(w, "token expired", http.StatusUnauthorized)
                    return
                }
            }

            // Add user info to context
            ctx := context.WithValue(r.Context(), "user_id", claims["sub"])
            ctx = context.WithValue(ctx, "roles", claims["roles"])

            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// AuthorizationMiddleware checks permissions
func AuthorizationMiddleware(authz *AuthorizationService) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            userID := r.Context().Value("user_id").(string)

            // Determine required permission from route
            permission := authz.GetRequiredPermission(r.Method, r.URL.Path)

            // Check permission
            if !authz.HasPermission(r.Context(), userID, permission) {
                writeError(w, "forbidden", http.StatusForbidden)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// RequestValidationMiddleware validates incoming requests
func RequestValidationMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Enforce Content-Type for requests with body
        if r.ContentLength > 0 {
            contentType := r.Header.Get("Content-Type")
            if !strings.HasPrefix(contentType, "application/json") {
                writeError(w, "unsupported media type", http.StatusUnsupportedMediaType)
                return
            }
        }

        // Limit request body size (prevent DoS)
        r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB

        next.ServeHTTP(w, r)
    })
}

// SecureHeadersMiddleware adds security headers
func SecureHeadersMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json; charset=utf-8")
        w.Header().Set("X-Content-Type-Options", "nosniff")
        w.Header().Set("X-Frame-Options", "DENY")
        w.Header().Set("Cache-Control", "no-store")
        w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

        next.ServeHTTP(w, r)
    })
}

func writeError(w http.ResponseWriter, message string, status int) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(map[string]string{"error": message})
}
```

### Junior → FAANG: Structuring Security Interview Answers

Security design questions in FAANG interviews reward structured thinking over ad-hoc enumeration. Juniors who list security controls randomly signal that they learned them as a list, not as a coherent model.

**Gap to close:** Practice using STRIDE (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege) as a structured enumeration for design questions. For any system you are asked to design securely, walk through each STRIDE category and describe the control you apply. This structure ensures completeness and demonstrates systematic thinking.

**First-job habit:** When preparing for an interview, take the design questions in this section and practice answering them out loud. Time yourself. FAANG interviews are time-bounded, and the ability to structure and deliver a complete answer in 15 minutes requires practice.

**Interview framing:** Before answering a security design question, ask one clarifying question: "What is the primary threat actor?" The answer determines which controls to prioritize. For a public API, bot abuse and credential stuffing are primary. For an internal admin tool, insider threats and privilege escalation are primary. Asking this question signals senior-level thinking regardless of your level.

### Senior @ FAANG: Bar-Raiser Signals in Security Design Interviews

Bar-raisers at FAANG evaluate security design answers on depth, trade-off reasoning, and organizational scalability. The technical answer is necessary but not sufficient.

**Depth signal:** When asked to design a secure authentication system, candidates who reach session management, refresh token rotation, device fingerprinting, and anomaly detection signal L6 depth. Candidates who stop at "hash the password and issue a JWT" signal L4. Know the full design space for common security components before the interview.

**Trade-off reasoning signal:** Any security design has trade-offs between security, usability, and cost. A bar-raiser will probe: "You said to use argon2id with high memory parameters. What's the impact on response time? How do you handle that at scale?" The correct answer involves: understanding the performance cost, describing how you tune parameters to balance security and latency, and describing how you cache authentication results to reduce repeated hashing. Candidates who cannot reason about trade-offs signal that they follow prescriptions rather than understand principles.

**Organizational scale signal:** After describing a design, say explicitly how you would roll it out across a team or organization: "I would build this as a shared auth library that teams import, so the correct implementation is the default and teams cannot accidentally use a weaker approach." This statement elevates the answer from individual design to platform thinking and is a key bar-raising signal.

**Failure mode signal:** For any security mechanism, describe what happens when it fails and how the failure is detected. A bar-raiser asks: "What happens when your token rotation system loses the new token before the client receives it?" The correct answer includes: idempotent token issuance, a grace period for old tokens, and an alert when clients present revoked tokens at an elevated rate. Candidates who have not thought about failure modes have not designed production systems.

---
