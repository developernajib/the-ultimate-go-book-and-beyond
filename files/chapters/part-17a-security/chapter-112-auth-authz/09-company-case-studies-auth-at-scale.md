## 112.9 Company Case Studies: Auth at Scale

### Google: Zanzibar Authorization System

Google's Zanzibar handles authorization for Google Drive, YouTube, and Cloud:

```go
// Google Zanzibar-style relationship-based access control
package zanzibar

import (
    "context"
    "fmt"
    "sync"
)

// Tuple represents a relationship: user:alice is owner of document:readme
type Tuple struct {
    ObjectType   string
    ObjectID     string
    Relation     string
    SubjectType  string
    SubjectID    string
    SubjectRelation string // For indirect relations
}

// ZanzibarEngine implements Google-style ReBAC
type ZanzibarEngine struct {
    mu         sync.RWMutex
    tuples     map[string][]Tuple // objectKey -> tuples
    schema     *Schema
    cache      *CheckCache
    namespace  string
}

// Schema defines object types and their relations
type Schema struct {
    Definitions map[string]*ObjectDefinition
}

type ObjectDefinition struct {
    Type      string
    Relations map[string]*RelationDefinition
}

type RelationDefinition struct {
    Name            string
    DirectTypes     []string
    ComputedUserset *ComputedUserset
}

type ComputedUserset struct {
    Union       []string
    Intersection []string
    Difference  []string
}

// Check verifies if subject has permission on object
func (z *ZanzibarEngine) Check(
    ctx context.Context,
    object, permission, subject string,
) (bool, error) {
    // Check cache first
    cacheKey := fmt.Sprintf("%s#%s@%s", object, permission, subject)
    if result, found := z.cache.Get(cacheKey); found {
        return result, nil
    }

    // Parse object and subject
    objType, objID := parseObjectRef(object)
    subType, subID := parseSubjectRef(subject)

    // Get schema definition
    def := z.schema.Definitions[objType]
    if def == nil {
        return false, fmt.Errorf("unknown object type: %s", objType)
    }

    relation := def.Relations[permission]
    if relation == nil {
        return false, fmt.Errorf("unknown permission: %s", permission)
    }

    // Check direct relationship
    if z.hasDirectRelation(objType, objID, permission, subType, subID) {
        z.cache.Set(cacheKey, true)
        return true, nil
    }

    // Check computed relations (union, intersection)
    if relation.ComputedUserset != nil {
        result := z.checkComputedUserset(ctx, objType, objID, relation.ComputedUserset, subType, subID)
        z.cache.Set(cacheKey, result)
        return result, nil
    }

    z.cache.Set(cacheKey, false)
    return false, nil
}

func (z *ZanzibarEngine) hasDirectRelation(
    objType, objID, relation, subType, subID string,
) bool {
    z.mu.RLock()
    defer z.mu.RUnlock()

    key := fmt.Sprintf("%s:%s", objType, objID)
    tuples := z.tuples[key]

    for _, t := range tuples {
        if t.Relation == relation &&
            t.SubjectType == subType &&
            t.SubjectID == subID {
            return true
        }
    }

    return false
}

func (z *ZanzibarEngine) checkComputedUserset(
    ctx context.Context,
    objType, objID string,
    userset *ComputedUserset,
    subType, subID string,
) bool {
    // Union: ANY of the relations must be true
    for _, rel := range userset.Union {
        if z.hasDirectRelation(objType, objID, rel, subType, subID) {
            return true
        }
    }

    // Intersection: ALL relations must be true
    if len(userset.Intersection) > 0 {
        for _, rel := range userset.Intersection {
            if !z.hasDirectRelation(objType, objID, rel, subType, subID) {
                return false
            }
        }
        return true
    }

    return false
}

// Example schema for Google Drive-like system
func NewDriveSchema() *Schema {
    return &Schema{
        Definitions: map[string]*ObjectDefinition{
            "document": {
                Type: "document",
                Relations: map[string]*RelationDefinition{
                    "owner":  {Name: "owner", DirectTypes: []string{"user"}},
                    "editor": {Name: "editor", DirectTypes: []string{"user", "group#member"}},
                    "viewer": {Name: "viewer", DirectTypes: []string{"user", "group#member"}},
                    "can_view": {
                        Name: "can_view",
                        ComputedUserset: &ComputedUserset{
                            Union: []string{"viewer", "editor", "owner"},
                        },
                    },
                    "can_edit": {
                        Name: "can_edit",
                        ComputedUserset: &ComputedUserset{
                            Union: []string{"editor", "owner"},
                        },
                    },
                },
            },
        },
    }
}
```

### Stripe: API Key Authentication

Stripe's API key system handles billions of API requests:

```go
// Stripe-style API key authentication
package apiauth

import (
    "context"
    "crypto/rand"
    "crypto/sha256"
    "crypto/subtle"
    "encoding/hex"
    "fmt"
    "strings"
    "time"
)

// APIKeyType represents different key types
type APIKeyType string

const (
    KeyTypePublishable APIKeyType = "pk"  // Client-side, limited scope
    KeyTypeSecret      APIKeyType = "sk"  // Server-side, full access
    KeyTypeRestricted  APIKeyType = "rk"  // Limited permissions
)

// APIKey represents an API key with metadata
type APIKey struct {
    ID           string
    Prefix       string     // pk_live_, sk_test_, etc.
    HashedKey    string     // Only store hash
    Type         APIKeyType
    AccountID    string
    Environment  string     // live, test
    Permissions  []string
    RateLimit    int
    CreatedAt    time.Time
    LastUsedAt   *time.Time
    ExpiresAt    *time.Time
}

// APIKeyManager handles key lifecycle
type APIKeyManager struct {
    store       KeyStore
    hasher      *KeyHasher
}

// GenerateKey creates a new API key
func (m *APIKeyManager) GenerateKey(
    accountID string,
    keyType APIKeyType,
    environment string,
    permissions []string,
) (*APIKey, string, error) {
    // Generate random key bytes
    keyBytes := make([]byte, 24)
    if _, err := rand.Read(keyBytes); err != nil {
        return nil, "", err
    }

    // Create key with prefix: sk_live_abc123...
    prefix := fmt.Sprintf("%s_%s_", keyType, environment)
    rawKey := prefix + hex.EncodeToString(keyBytes)

    // Hash for storage
    hashedKey := m.hasher.Hash(rawKey)

    key := &APIKey{
        ID:          generateKeyID(),
        Prefix:      prefix,
        HashedKey:   hashedKey,
        Type:        keyType,
        AccountID:   accountID,
        Environment: environment,
        Permissions: permissions,
        RateLimit:   getRateLimitForType(keyType),
        CreatedAt:   time.Now(),
    }

    if err := m.store.Save(key); err != nil {
        return nil, "", err
    }

    // Return key and raw value (only returned once!)
    return key, rawKey, nil
}

// ValidateKey verifies an API key
func (m *APIKeyManager) ValidateKey(ctx context.Context, rawKey string) (*APIKey, error) {
    // Parse prefix to determine key type
    parts := strings.SplitN(rawKey, "_", 3)
    if len(parts) != 3 {
        return nil, fmt.Errorf("invalid key format")
    }

    prefix := parts[0] + "_" + parts[1] + "_"

    // Hash the provided key
    hashedKey := m.hasher.Hash(rawKey)

    // Look up by prefix and hash
    key, err := m.store.FindByHash(prefix, hashedKey)
    if err != nil {
        return nil, fmt.Errorf("key not found")
    }

    // Check expiration
    if key.ExpiresAt != nil && time.Now().After(*key.ExpiresAt) {
        return nil, fmt.Errorf("key expired")
    }

    // Update last used
    now := time.Now()
    key.LastUsedAt = &now
    m.store.UpdateLastUsed(key.ID, now)

    return key, nil
}

// KeyHasher provides secure key hashing
type KeyHasher struct {
    pepper []byte
}

func (h *KeyHasher) Hash(key string) string {
    // Use SHA-256 with pepper
    hasher := sha256.New()
    hasher.Write([]byte(key))
    hasher.Write(h.pepper)
    return hex.EncodeToString(hasher.Sum(nil))
}

// SecureCompare performs constant-time comparison
func SecureCompare(a, b string) bool {
    return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
```

### Netflix: Device Authorization

Netflix implements device-specific authorization for streaming:

```go
// Netflix-style device authorization
package deviceauth

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// DeviceType represents supported device types
type DeviceType string

const (
    DeviceTypeTV       DeviceType = "tv"
    DeviceTypeMobile   DeviceType = "mobile"
    DeviceTypeWeb      DeviceType = "web"
    DeviceTypeGameConsole DeviceType = "console"
)

// DeviceProfile represents a registered device
type DeviceProfile struct {
    DeviceID        string
    AccountID       string
    DeviceType      DeviceType
    DeviceName      string
    DeviceModel     string
    ESN             string     // Electronic Serial Number
    Capabilities    []string   // 4K, HDR, Dolby Atmos
    MaxResolution   string
    DRMType         string
    RegisteredAt    time.Time
    LastActiveAt    time.Time
    IsActive        bool
}

// DeviceAuthManager handles device authorization
type DeviceAuthManager struct {
    mu              sync.RWMutex
    devices         map[string]*DeviceProfile // deviceID -> profile
    accountDevices  map[string][]string       // accountID -> deviceIDs
    maxDevices      map[string]int            // plan -> max devices
}

// RegisterDevice authorizes a new device
func (m *DeviceAuthManager) RegisterDevice(
    ctx context.Context,
    accountID string,
    deviceType DeviceType,
    deviceInfo map[string]string,
) (*DeviceProfile, error) {
    m.mu.Lock()
    defer m.mu.Unlock()

    // Check device limit for account
    currentDevices := m.accountDevices[accountID]
    maxAllowed := m.getMaxDevices(ctx, accountID)

    if len(currentDevices) >= maxAllowed {
        return nil, fmt.Errorf("device limit reached: %d/%d", len(currentDevices), maxAllowed)
    }

    // Generate device ID
    deviceID := generateDeviceID()

    profile := &DeviceProfile{
        DeviceID:      deviceID,
        AccountID:     accountID,
        DeviceType:    deviceType,
        DeviceName:    deviceInfo["name"],
        DeviceModel:   deviceInfo["model"],
        ESN:           deviceInfo["esn"],
        Capabilities:  parseCapabilities(deviceInfo["capabilities"]),
        MaxResolution: determineMaxResolution(deviceType, deviceInfo),
        DRMType:       deviceInfo["drm"],
        RegisteredAt:  time.Now(),
        LastActiveAt:  time.Now(),
        IsActive:      true,
    }

    m.devices[deviceID] = profile
    m.accountDevices[accountID] = append(m.accountDevices[accountID], deviceID)

    return profile, nil
}

// AuthorizePlayback checks if device can play content
func (m *DeviceAuthManager) AuthorizePlayback(
    ctx context.Context,
    deviceID string,
    contentID string,
    requestedQuality string,
) (*PlaybackAuthorization, error) {
    m.mu.RLock()
    device := m.devices[deviceID]
    m.mu.RUnlock()

    if device == nil {
        return nil, fmt.Errorf("device not registered")
    }

    if !device.IsActive {
        return nil, fmt.Errorf("device deactivated")
    }

    // Check concurrent streams
    activeStreams := m.countActiveStreams(device.AccountID)
    maxStreams := m.getMaxConcurrentStreams(ctx, device.AccountID)

    if activeStreams >= maxStreams {
        return nil, fmt.Errorf("concurrent stream limit reached")
    }

    // Determine allowed quality based on device capabilities
    allowedQuality := m.determineAllowedQuality(device, requestedQuality)

    // Generate playback session
    sessionID := generateSessionID()

    return &PlaybackAuthorization{
        SessionID:     sessionID,
        DeviceID:      deviceID,
        ContentID:     contentID,
        Quality:       allowedQuality,
        DRMConfig:     m.getDRMConfig(device),
        ExpiresAt:     time.Now().Add(4 * time.Hour),
        LicenseURL:    fmt.Sprintf("/license/%s", sessionID),
    }, nil
}

// PlaybackAuthorization contains playback session details
type PlaybackAuthorization struct {
    SessionID   string
    DeviceID    string
    ContentID   string
    Quality     string
    DRMConfig   *DRMConfig
    ExpiresAt   time.Time
    LicenseURL  string
}

func (m *DeviceAuthManager) determineAllowedQuality(
    device *DeviceProfile,
    requested string,
) string {
    // Device capability checks
    if requested == "4K" {
        if !contains(device.Capabilities, "4K") {
            return "1080p"
        }
        if device.MaxResolution != "4K" {
            return device.MaxResolution
        }
    }

    return requested
}
```

### Uber: Multi-Factor Step-Up Authentication

Uber implements risk-based step-up authentication:

```go
// Uber-style step-up authentication
package stepup

import (
    "context"
    "fmt"
    "time"
)

// RiskLevel represents calculated risk
type RiskLevel string

const (
    RiskLow      RiskLevel = "low"
    RiskMedium   RiskLevel = "medium"
    RiskHigh     RiskLevel = "high"
    RiskCritical RiskLevel = "critical"
)

// StepUpRequirement defines what additional auth is needed
type StepUpRequirement struct {
    Required    bool
    Methods     []string  // sms, totp, push, biometric
    Reason      string
    Challenge   *Challenge
    ExpiresAt   time.Time
}

// StepUpAuthManager handles risk-based authentication
type StepUpAuthManager struct {
    riskEngine   *RiskEngine
    mfaProvider  *MFAProvider
    auditLog     *AuditLog
}

// EvaluateStepUp determines if step-up auth is needed
func (m *StepUpAuthManager) EvaluateStepUp(
    ctx context.Context,
    userID string,
    action string,
    authCtx AuthContext,
) (*StepUpRequirement, error) {
    // Calculate risk score
    riskScore := m.riskEngine.CalculateRisk(userID, action, authCtx)

    // Determine if step-up is required
    requirement := &StepUpRequirement{}

    switch {
    case riskScore.Level == RiskCritical:
        // Block action, require identity verification
        requirement.Required = true
        requirement.Methods = []string{"video_verification", "id_document"}
        requirement.Reason = "high_risk_action"

    case riskScore.Level == RiskHigh:
        // Require strong MFA
        requirement.Required = true
        requirement.Methods = []string{"biometric", "hardware_key"}
        requirement.Reason = "elevated_risk"

    case riskScore.Level == RiskMedium:
        // Require any MFA
        requirement.Required = true
        requirement.Methods = []string{"sms", "totp", "push"}
        requirement.Reason = "moderate_risk"

    case action == "payment" && authCtx.Amount > 1000:
        // High-value transactions always require step-up
        requirement.Required = true
        requirement.Methods = []string{"push", "biometric"}
        requirement.Reason = "high_value_transaction"

    default:
        requirement.Required = false
    }

    if requirement.Required {
        // Generate challenge
        challenge, err := m.mfaProvider.CreateChallenge(userID, requirement.Methods)
        if err != nil {
            return nil, err
        }
        requirement.Challenge = challenge
        requirement.ExpiresAt = time.Now().Add(5 * time.Minute)

        m.auditLog.Log(userID, "step_up_required", map[string]any{
            "action": action,
            "reason": requirement.Reason,
            "risk_level": riskScore.Level,
        })
    }

    return requirement, nil
}

// VerifyStepUp validates step-up authentication
func (m *StepUpAuthManager) VerifyStepUp(
    ctx context.Context,
    userID string,
    challengeID string,
    response string,
) error {
    // Verify challenge response
    if err := m.mfaProvider.VerifyChallenge(challengeID, response); err != nil {
        m.auditLog.Log(userID, "step_up_failed", map[string]any{
            "challenge_id": challengeID,
            "error": err.Error(),
        })
        return fmt.Errorf("step-up verification failed: %w", err)
    }

    m.auditLog.Log(userID, "step_up_success", map[string]any{
        "challenge_id": challengeID,
    })

    return nil
}

// RiskEngine calculates risk scores
type RiskEngine struct {
    userProfiles map[string]*UserRiskProfile
}

type RiskScore struct {
    Level    RiskLevel
    Score    float64
    Factors  []string
}

func (e *RiskEngine) CalculateRisk(
    userID string,
    action string,
    ctx AuthContext,
) *RiskScore {
    score := 0.0
    factors := []string{}

    profile := e.userProfiles[userID]

    // Factor 1: Unknown device
    if !profile.IsKnownDevice(ctx.DeviceID) {
        score += 0.3
        factors = append(factors, "unknown_device")
    }

    // Factor 2: Unusual location
    if !profile.IsUsualLocation(ctx.Location) {
        score += 0.2
        factors = append(factors, "unusual_location")
    }

    // Factor 3: Unusual time
    if !profile.IsUsualTime(ctx.Timestamp) {
        score += 0.1
        factors = append(factors, "unusual_time")
    }

    // Factor 4: Sensitive action
    if isSensitiveAction(action) {
        score += 0.2
        factors = append(factors, "sensitive_action")
    }

    // Factor 5: Recent account changes
    if profile.HasRecentAccountChanges() {
        score += 0.2
        factors = append(factors, "recent_account_changes")
    }

    return &RiskScore{
        Level:   scoreToLevel(score),
        Score:   score,
        Factors: factors,
    }
}

func scoreToLevel(score float64) RiskLevel {
    switch {
    case score >= 0.8:
        return RiskCritical
    case score >= 0.6:
        return RiskHigh
    case score >= 0.3:
        return RiskMedium
    default:
        return RiskLow
    }
}
```

### Amazon: Cross-Account Access with IAM

Amazon implements fine-grained cross-account access:

```go
// Amazon IAM-style cross-account access
package crossaccount

import (
    "context"
    "fmt"
    "time"
)

// AssumeRoleRequest represents a cross-account access request
type AssumeRoleRequest struct {
    RoleArn         string
    ExternalID      string
    SessionName     string
    DurationSeconds int
    Policy          string // Optional session policy
}

// AssumedRole represents temporary credentials from assume role
type AssumedRole struct {
    Credentials     *TemporaryCredentials
    AssumedRoleUser *AssumedRoleUser
    PackedPolicySize int
}

type TemporaryCredentials struct {
    AccessKeyID     string
    SecretAccessKey string
    SessionToken    string
    Expiration      time.Time
}

type AssumedRoleUser struct {
    AssumedRoleId string
    Arn          string
}

// CrossAccountAccessManager handles IAM assume role
type CrossAccountAccessManager struct {
    trustPolicies   map[string]*TrustPolicy
    credentialStore *CredentialStore
}

// TrustPolicy defines who can assume a role
type TrustPolicy struct {
    RoleArn         string
    TrustedPrincipals []string // Account IDs or ARNs
    Conditions       map[string]map[string]string
    ExternalIDRequired bool
    MFARequired      bool
}

// AssumeRole generates temporary credentials for cross-account access
func (m *CrossAccountAccessManager) AssumeRole(
    ctx context.Context,
    callerIdentity *CallerIdentity,
    request *AssumeRoleRequest,
) (*AssumedRole, error) {
    // Get trust policy for role
    policy := m.trustPolicies[request.RoleArn]
    if policy == nil {
        return nil, fmt.Errorf("role not found: %s", request.RoleArn)
    }

    // Verify caller is trusted
    if !m.isTrustedPrincipal(callerIdentity, policy) {
        return nil, fmt.Errorf("access denied: caller not trusted")
    }

    // Verify external ID if required
    if policy.ExternalIDRequired {
        expectedID := policy.Conditions["StringEquals"]["sts:ExternalId"]
        if request.ExternalID != expectedID {
            return nil, fmt.Errorf("access denied: invalid external ID")
        }
    }

    // Verify MFA if required
    if policy.MFARequired && !callerIdentity.MFAAuthenticated {
        return nil, fmt.Errorf("access denied: MFA required")
    }

    // Generate temporary credentials
    duration := time.Duration(request.DurationSeconds) * time.Second
    if duration == 0 {
        duration = 1 * time.Hour
    }
    if duration > 12*time.Hour {
        duration = 12 * time.Hour
    }

    creds := &TemporaryCredentials{
        AccessKeyID:     generateAccessKeyID(),
        SecretAccessKey: generateSecretAccessKey(),
        SessionToken:    generateSessionToken(request, duration),
        Expiration:      time.Now().Add(duration),
    }

    // Store credentials for validation
    m.credentialStore.Store(creds)

    return &AssumedRole{
        Credentials: creds,
        AssumedRoleUser: &AssumedRoleUser{
            AssumedRoleId: fmt.Sprintf("AROA:%s", request.SessionName),
            Arn:           fmt.Sprintf("%s/%s", request.RoleArn, request.SessionName),
        },
    }, nil
}

func (m *CrossAccountAccessManager) isTrustedPrincipal(
    caller *CallerIdentity,
    policy *TrustPolicy,
) bool {
    for _, trusted := range policy.TrustedPrincipals {
        // Check if account ID matches
        if trusted == caller.AccountID {
            return true
        }
        // Check if specific ARN matches
        if trusted == caller.Arn {
            return true
        }
    }
    return false
}

// CallerIdentity represents the authenticated caller
type CallerIdentity struct {
    AccountID        string
    Arn              string
    UserID           string
    MFAAuthenticated bool
}
```

### Junior → FAANG: Zanzibar as a Design Benchmark

Google's Zanzibar paper is required reading for engineers who will design authorization systems at FAANG companies. Understanding its key innovations at a conceptual level is expected.

**Gap to close:** Know two Zanzibar innovations: (1) the tuple-based data model (permissions are stored as relationship tuples: subject, relation, object), which enables a unified representation for any sharing model. (2) Zookies (consistency tokens), which enable read-your-writes consistency without requiring synchronous global consistency. These innovations solved specific problems at Google's scale that simpler authorization models could not address.

**Interview framing:** When asked "how does Google's Zanzibar work?", describe: relationship tuples stored in a distributed database, permission checks evaluate the tuple graph using BFS/DFS, consistency is provided through zookies (the token from a write operation is presented with subsequent read operations to ensure the read sees the write). Mention SpiceDB as the open-source implementation you would use in a Go service.

### Senior @ FAANG: Learning From Authorization at Scale

At senior level, case studies from Google, Auth0, and other companies are inputs to your own authorization architecture decisions. The patterns they use solve real problems at real scale.

**Auth0's multi-tenancy architecture:** Auth0 serves thousands of tenants with different identity requirements (different IdPs, different token formats, different MFA policies). Their architecture separates the tenant configuration layer (how does this tenant authenticate?) from the core identity infrastructure (the JWT issuance, JWKS, token validation). This separation allows per-tenant customization without per-tenant code. Apply this pattern to your own auth platform design: make tenant-specific behavior data-driven, not code-driven.

**Scale inflection points:** Authorization systems that work well at 1000 users may fail at 1 million. The inflection points are: permission check latency (graph traversal grows with graph complexity), permission data volume (millions of relationship tuples require efficient storage and query planning), and consistency (eventual consistency is acceptable for most permissions but not for security-critical ones). Design your authorization system for 10x your current scale, not just your current scale.

---
