## 111.8 Company Case Studies: Zero-Trust at Scale

### Google BeyondCorp: The Zero-Trust Pioneer

Google implemented BeyondCorp after the 2009 Operation Aurora attack, eliminating VPN-based perimeter security:

```go
// Google BeyondCorp-style access decisions
package beyondcorp

import (
    "context"
    "log/slog"
    "time"
)

// AccessDecisionEngine implements Google's BeyondCorp model
type AccessDecisionEngine struct {
    userInventory      *UserInventory
    deviceInventory    *DeviceInventory
    resourceInventory  *ResourceInventory
    accessPolicy       *AccessPolicy
    trustInference     *TrustInferenceEngine
    logger             *slog.Logger
}

// AccessRequest represents a request for resource access
type AccessRequest struct {
    UserID       string
    DeviceID     string
    ResourceID   string
    Action       string
    SourceIP     string
    Timestamp    time.Time
    ClientCert   string
}

// AccessDecision contains the authorization result
type AccessDecision struct {
    Allowed    bool
    Reason     string
    TrustLevel string
    Conditions []string
}

// Evaluate makes access decisions based on multiple signals
func (e *AccessDecisionEngine) Evaluate(ctx context.Context, req AccessRequest) *AccessDecision {
    // Signal 1: User identity verification
    user := e.userInventory.GetUser(req.UserID)
    if user == nil || !user.IsActive {
        return &AccessDecision{
            Allowed: false,
            Reason:  "user not found or inactive",
        }
    }

    // Signal 2: Device trust verification
    device := e.deviceInventory.GetDevice(req.DeviceID)
    if device == nil {
        return &AccessDecision{
            Allowed: false,
            Reason:  "unknown device",
        }
    }

    deviceTrust := e.evaluateDeviceTrust(device)

    // Signal 3: Resource access level requirements
    resource := e.resourceInventory.GetResource(req.ResourceID)
    requiredTrust := resource.RequiredTrustLevel

    // Signal 4: Dynamic trust inference
    userTrust := e.trustInference.CalculateUserTrust(user, req)

    // Combine signals for access decision
    combinedTrust := e.combineTrustLevels(deviceTrust, userTrust)

    if trustRank(combinedTrust) < trustRank(requiredTrust) {
        return &AccessDecision{
            Allowed:    false,
            Reason:     "insufficient trust level",
            TrustLevel: combinedTrust,
            Conditions: []string{"step_up_auth_required"},
        }
    }

    e.logger.Info("access granted",
        "user", req.UserID,
        "device", req.DeviceID,
        "resource", req.ResourceID,
        "trust_level", combinedTrust)

    return &AccessDecision{
        Allowed:    true,
        TrustLevel: combinedTrust,
    }
}

// trustRank orders trust levels so they can be compared numerically
// (comparing the strings directly would order them alphabetically)
func trustRank(level string) int {
    switch level {
    case "high":
        return 3
    case "medium":
        return 2
    default:
        return 1
    }
}

// evaluateDeviceTrust checks device security posture
func (e *AccessDecisionEngine) evaluateDeviceTrust(device *Device) string {
    trustScore := 1.0

    // Check OS patching status
    if !device.IsOSPatched {
        trustScore -= 0.3
    }

    // Check encryption status
    if !device.IsEncrypted {
        trustScore -= 0.3
    }

    // Check endpoint protection
    if !device.HasEDR {
        trustScore -= 0.2
    }

    // Check certificate validity
    if device.CertExpiry.Before(time.Now().Add(7 * 24 * time.Hour)) {
        trustScore -= 0.1
    }

    switch {
    case trustScore >= 0.8:
        return "high"
    case trustScore >= 0.5:
        return "medium"
    default:
        return "low"
    }
}
```

### Uber: Service Mesh Zero-Trust

Uber implements zero-trust between thousands of microservices:

```go
// Uber-style service mesh authentication
package mesh

import (
    "context"
    "crypto/x509"
    "fmt"
    "time"
)

// ServiceMeshAuth handles inter-service authentication
type ServiceMeshAuth struct {
    spiffeSource   *SPIFFESource
    policyEngine   *PolicyEngine
    telemetry      *Telemetry
}

// ServiceIdentity represents a verified service
type ServiceIdentity struct {
    SpiffeID    string
    ServiceName string
    Namespace   string
    Environment string
    TrustDomain string
}

// AuthenticateService verifies service identity from mTLS
func (m *ServiceMeshAuth) AuthenticateService(cert *x509.Certificate) (*ServiceIdentity, error) {
    // Extract SPIFFE ID from certificate SAN
    if len(cert.URIs) == 0 {
        return nil, fmt.Errorf("no SPIFFE ID in certificate")
    }

    spiffeID := cert.URIs[0].String()

    // Parse SPIFFE ID: spiffe://trust-domain/ns/namespace/sa/service
    identity, err := ParseSpiffeID(spiffeID)
    if err != nil {
        return nil, fmt.Errorf("invalid SPIFFE ID: %w", err)
    }

    // Verify certificate chain
    if err := m.verifyCertificateChain(cert); err != nil {
        return nil, fmt.Errorf("certificate verification failed: %w", err)
    }

    return identity, nil
}

// AuthorizeRequest checks if calling service can access target service
func (m *ServiceMeshAuth) AuthorizeRequest(
    ctx context.Context,
    caller *ServiceIdentity,
    target string,
    method string,
) error {
    start := time.Now()
    defer func() {
        m.telemetry.RecordAuthzLatency(time.Since(start))
    }()

    // Check policy engine
    decision := m.policyEngine.Evaluate(PolicyRequest{
        Caller:    caller.SpiffeID,
        Target:    target,
        Method:    method,
        Namespace: caller.Namespace,
    })

    if !decision.Allowed {
        m.telemetry.RecordAuthzDenied(caller.ServiceName, target, method)
        return fmt.Errorf("access denied: %s", decision.Reason)
    }

    m.telemetry.RecordAuthzAllowed(caller.ServiceName, target, method)
    return nil
}

// Uber's service-to-service policy definition
type ServicePolicy struct {
    SourceService      string   `yaml:"source_service"`
    TargetService      string   `yaml:"target_service"`
    AllowedMethods     []string `yaml:"allowed_methods"`
    AllowedNamespaces  []string `yaml:"allowed_namespaces"`
    RequireEncryption  bool     `yaml:"require_encryption"`
    RateLimit          int      `yaml:"rate_limit"`
}

// PolicyEngine evaluates service-to-service policies
type PolicyEngine struct {
    policies map[string][]ServicePolicy
}

func (p *PolicyEngine) Evaluate(req PolicyRequest) PolicyDecision {
    policies := p.policies[req.Target]

    for _, policy := range policies {
        if policy.SourceService == req.Caller || policy.SourceService == "*" {
            // Check namespace
            if !contains(policy.AllowedNamespaces, req.Namespace) &&
               !contains(policy.AllowedNamespaces, "*") {
                continue
            }

            // Check method
            if !contains(policy.AllowedMethods, req.Method) &&
               !contains(policy.AllowedMethods, "*") {
                continue
            }

            return PolicyDecision{Allowed: true}
        }
    }

    return PolicyDecision{
        Allowed: false,
        Reason:  "no matching policy",
    }
}
```

### Netflix: Dynamic Access Control

Netflix implements dynamic, context-aware access control:

```go
// Netflix-style dynamic access control
package dynamicaccess

import (
    "context"
    "sync"
    "time"
)

// DynamicAccessController adjusts access based on real-time signals
type DynamicAccessController struct {
    mu              sync.RWMutex
    anomalyDetector *AnomalyDetector
    riskScorer      *RiskScorer
    accessCache     *AccessCache
    config          *DynamicConfig
}

// AccessContext captures all signals for access decision
type AccessContext struct {
    UserID          string
    ServiceID       string
    RequestedAction string
    SourceIP        string
    DeviceFingerprint string
    GeoLocation     string
    TimeOfDay       time.Time
    SessionAge      time.Duration
    RequestPattern  []string
}

// EvaluateDynamicAccess makes context-aware access decisions
func (c *DynamicAccessController) EvaluateDynamicAccess(
    ctx context.Context,
    baseAccess bool,
    accessCtx AccessContext,
) (bool, []string) {
    var conditions []string

    // Check for anomalies
    if anomaly := c.anomalyDetector.Detect(accessCtx); anomaly != nil {
        // Don't immediately deny, but add conditions
        conditions = append(conditions, "anomaly_detected")

        if anomaly.Severity == "high" {
            conditions = append(conditions, "mfa_required")
        }
    }

    // Calculate risk score
    riskScore := c.riskScorer.Calculate(accessCtx)

    // High risk: require additional verification
    if riskScore > 0.7 {
        return baseAccess, append(conditions, "step_up_auth_required")
    }

    // Medium risk: add monitoring
    if riskScore > 0.4 {
        conditions = append(conditions, "enhanced_logging")
    }

    // Check impossible travel
    if c.detectImpossibleTravel(accessCtx) {
        return false, []string{"impossible_travel_detected"}
    }

    return baseAccess, conditions
}

// detectImpossibleTravel checks for physically impossible location changes
func (c *DynamicAccessController) detectImpossibleTravel(ctx AccessContext) bool {
    lastAccess := c.accessCache.GetLastAccess(ctx.UserID)
    if lastAccess == nil {
        return false
    }

    // Calculate distance and time
    distance := calculateGeoDistance(lastAccess.GeoLocation, ctx.GeoLocation)
    timeDiff := ctx.TimeOfDay.Sub(lastAccess.Timestamp)

    // Check if travel is physically possible
    maxPossibleSpeed := 1000.0 // km/h (faster than commercial flights)
    requiredTime := time.Duration(distance / maxPossibleSpeed * float64(time.Hour))

    return timeDiff < requiredTime && distance > 100 // More than 100km
}

// AnomalyDetector identifies unusual access patterns
type AnomalyDetector struct {
    userBaselines map[string]*UserBaseline
}

type UserBaseline struct {
    TypicalHours      []int
    TypicalLocations  []string
    TypicalDevices    []string
    TypicalActions    map[string]int
}

func (d *AnomalyDetector) Detect(ctx AccessContext) *Anomaly {
    baseline := d.userBaselines[ctx.UserID]
    if baseline == nil {
        return nil // New user, no baseline yet
    }

    anomalyScore := 0.0

    // Check time anomaly
    hour := ctx.TimeOfDay.Hour()
    if !contains(baseline.TypicalHours, hour) {
        anomalyScore += 0.3
    }

    // Check location anomaly
    if !containsString(baseline.TypicalLocations, ctx.GeoLocation) {
        anomalyScore += 0.3
    }

    // Check device anomaly
    if !containsString(baseline.TypicalDevices, ctx.DeviceFingerprint) {
        anomalyScore += 0.4
    }

    if anomalyScore > 0.5 {
        return &Anomaly{
            Score:    anomalyScore,
            Severity: getSeverity(anomalyScore),
            Factors:  []string{"unusual_time", "unusual_location", "unknown_device"},
        }
    }

    return nil
}
```

### Stripe: Workload Identity Federation

Stripe uses workload identity for secure cross-cloud access:

```go
// Stripe-style workload identity federation
package workloadid

import (
    "context"
    "crypto/rsa"
    "fmt"
    "time"

    "github.com/golang-jwt/jwt/v5"
)

// WorkloadIdentityProvider manages federated workload identities
type WorkloadIdentityProvider struct {
    privateKey    *rsa.PrivateKey
    publicKey     *rsa.PublicKey
    issuer        string
    trustedIssuers map[string]*rsa.PublicKey
}

// WorkloadToken represents a federated identity token
type WorkloadToken struct {
    jwt.RegisteredClaims
    WorkloadID    string   `json:"wid"`
    ServiceName   string   `json:"svc"`
    Environment   string   `json:"env"`
    Capabilities  []string `json:"caps"`
    CloudProvider string   `json:"cloud"`
}

// IssueToken creates a token for a workload
func (p *WorkloadIdentityProvider) IssueToken(
    workloadID, serviceName, environment string,
    capabilities []string,
) (string, error) {
    claims := WorkloadToken{
        RegisteredClaims: jwt.RegisteredClaims{
            Issuer:    p.issuer,
            Subject:   workloadID,
            Audience:  jwt.ClaimStrings{"stripe-internal"},
            ExpiresAt: jwt.NewNumericDate(time.Now().Add(15 * time.Minute)),
            IssuedAt:  jwt.NewNumericDate(time.Now()),
            ID:        generateTokenID(),
        },
        WorkloadID:   workloadID,
        ServiceName:  serviceName,
        Environment:  environment,
        Capabilities: capabilities,
    }

    token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
    return token.SignedString(p.privateKey)
}

// ExchangeForCloudCredentials exchanges workload token for cloud credentials
func (p *WorkloadIdentityProvider) ExchangeForCloudCredentials(
    ctx context.Context,
    workloadToken string,
    targetCloud string,
    targetRole string,
) (*CloudCredentials, error) {
    // Validate workload token
    claims, err := p.ValidateToken(workloadToken)
    if err != nil {
        return nil, fmt.Errorf("invalid workload token: %w", err)
    }

    // Check if workload can assume target role
    if !canAssume(claims.Capabilities, targetRole) {
        return nil, fmt.Errorf("workload not authorized for role: %s", targetRole)
    }

    // Exchange for cloud-specific credentials
    switch targetCloud {
    case "aws":
        return p.exchangeForAWSCredentials(ctx, claims, targetRole)
    case "gcp":
        return p.exchangeForGCPCredentials(ctx, claims, targetRole)
    default:
        return nil, fmt.Errorf("unsupported cloud: %s", targetCloud)
    }
}

func (p *WorkloadIdentityProvider) exchangeForAWSCredentials(
    ctx context.Context,
    claims *WorkloadToken,
    role string,
) (*CloudCredentials, error) {
    // Use AWS STS AssumeRoleWithWebIdentity
    // This allows the workload to get temporary AWS credentials
    // without storing any AWS secrets

    // In production: call AWS STS API
    return &CloudCredentials{
        Provider:   "aws",
        AccessKey:  "ASIA...",
        SecretKey:  "...",
        Token:      "...",
        Expiration: time.Now().Add(1 * time.Hour),
    }, nil
}

// CloudCredentials represents temporary cloud provider credentials
type CloudCredentials struct {
    Provider   string
    AccessKey  string
    SecretKey  string
    Token      string
    Expiration time.Time
}
```

### Amazon: Network Micro-Segmentation

Amazon implements strict network policies for service isolation:

```go
// Amazon-style network micro-segmentation
package microsegmentation

import (
    "context"
    "fmt"
    "net"
    "sync"
)

// NetworkPolicy defines allowed network communications
type NetworkPolicy struct {
    Name           string
    SourceLabels   map[string]string
    TargetLabels   map[string]string
    AllowedPorts   []int
    AllowedProtos  []string
    Direction      string // ingress, egress
}

// MicroSegmentationController enforces network policies
type MicroSegmentationController struct {
    mu       sync.RWMutex
    policies []NetworkPolicy
    services map[string]*ServiceEndpoint
}

// ServiceEndpoint represents a service's network identity
type ServiceEndpoint struct {
    ServiceName string
    Labels      map[string]string
    IPAddresses []net.IP
    Ports       []int
}

// EvaluateConnection checks if network connection is allowed
func (c *MicroSegmentationController) EvaluateConnection(
    ctx context.Context,
    srcService, dstService string,
    dstPort int,
    proto string,
) (bool, string) {
    c.mu.RLock()
    defer c.mu.RUnlock()

    src := c.services[srcService]
    dst := c.services[dstService]

    if src == nil || dst == nil {
        return false, "unknown service"
    }

    // Find matching policy
    for _, policy := range c.policies {
        if c.matchesPolicy(policy, src, dst, dstPort, proto) {
            return true, fmt.Sprintf("allowed by policy: %s", policy.Name)
        }
    }

    // Default deny
    return false, "no matching policy"
}

func (c *MicroSegmentationController) matchesPolicy(
    policy NetworkPolicy,
    src, dst *ServiceEndpoint,
    port int,
    proto string,
) bool {
    // Check source labels
    if !matchLabels(src.Labels, policy.SourceLabels) {
        return false
    }

    // Check target labels
    if !matchLabels(dst.Labels, policy.TargetLabels) {
        return false
    }

    // Check port
    if !containsInt(policy.AllowedPorts, port) {
        return false
    }

    // Check protocol
    if !containsString(policy.AllowedProtos, proto) {
        return false
    }

    return true
}

// GenerateNetworkPolicies creates Kubernetes NetworkPolicy resources
func (c *MicroSegmentationController) GenerateNetworkPolicies() []NetworkPolicySpec {
    var specs []NetworkPolicySpec

    for _, policy := range c.policies {
        spec := NetworkPolicySpec{
            Name: policy.Name,
            PodSelector: PodSelector{
                MatchLabels: policy.TargetLabels,
            },
            PolicyTypes: []string{policy.Direction},
        }

        if policy.Direction == "ingress" {
            spec.Ingress = []IngressRule{{
                From: []NetworkPolicyPeer{{
                    PodSelector: PodSelector{
                        MatchLabels: policy.SourceLabels,
                    },
                }},
                Ports: toPolicyPorts(policy.AllowedPorts, policy.AllowedProtos),
            }}
        }

        specs = append(specs, spec)
    }

    return specs
}

func matchLabels(actual, required map[string]string) bool {
    for key, value := range required {
        if actual[key] != value {
            return false
        }
    }
    return true
}
```

### Junior → FAANG: Learning From BeyondCorp and Cloudflare

Google's BeyondCorp is the most cited zero-trust architecture in the industry. Understanding its core concepts, even at a high level, demonstrates that you are familiar with current security thinking.

**Gap to close:** BeyondCorp's key insight is that access decisions should be based on user identity plus device trust plus context, not on network location. A corporate laptop on a coffee shop WiFi should have the same access as the same laptop on the corporate network, if the device trust posture is the same. This is why VPNs are a legacy control in BeyondCorp-style architectures: they provide network location but not the richer context that zero trust requires.

**Interview framing:** When asked "what is zero trust and where did it come from?", describe BeyondCorp: Google published the BeyondCorp papers starting in 2014 describing their journey from a perimeter-based model to identity and device-based access control. The key outcomes were: employees can work from any network, access decisions are made based on verified identity and device health, and the internal network is treated as untrusted. This context shows you understand the historical development of zero trust, not just the marketing term.

### Senior @ FAANG: Applying BeyondCorp Principles to Service Mesh

At senior level, BeyondCorp's principles for user access extend naturally to service-to-service access in a microservices architecture. Staff engineers apply these principles to design zero-trust service meshes.

**Service identity as the BeyondCorp equivalent of user+device identity:** In BeyondCorp, a user must prove their identity (user identity) and their device must be healthy (device trust). In a service mesh, a service must prove its identity (SVID or cloud workload identity) and its runtime must be healthy (container scanning, admission control, runtime security). The two-factor model from BeyondCorp applies: identity alone is not sufficient. Runtime health matters too.

**Context-based access control:** BeyondCorp uses context (time of day, location, device health score) to make access decisions. In a service mesh, context includes: which Kubernetes namespace is the calling service in, what is its SLSA provenance level, is it running a compliant container image, has it had any recent security findings? OPA policies can incorporate this context to make richer authorization decisions than simple identity-based RBAC. This is the frontier of zero-trust service mesh design.

---
