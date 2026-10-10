## 111.9 Production Pitfalls: Zero Trust Failures

### Pitfall 1: Trusting the Internal Network

**Real Incident Report**: A company's internal services communicated without authentication because they were "behind the firewall." An attacker gained access through a compromised developer laptop and moved laterally across 40+ services undetected for 6 months.

**The Anti-Pattern**:
```go
// WRONG: No authentication for internal services
func internalHandler(w http.ResponseWriter, r *http.Request) {
    // "It's internal, so it's safe"
    data := fetchSensitiveData()
    json.NewEncoder(w).Encode(data)
}

// WRONG: Only checking origin IP
func isInternal(r *http.Request) bool {
    ip := net.ParseIP(r.RemoteAddr)
    _, internal, _ := net.ParseCIDR("10.0.0.0/8")
    return internal.Contains(ip) // Easily spoofable
}
```

**The Better Approach**:
```go
// RIGHT: mTLS for all service-to-service communication
func setupMTLS() *tls.Config {
    caCert, _ := os.ReadFile("ca.crt")
    caCertPool := x509.NewCertPool()
    caCertPool.AppendCertsFromPEM(caCert)

    cert, _ := tls.LoadX509KeyPair("service.crt", "service.key")

    return &tls.Config{
        Certificates: []tls.Certificate{cert},
        ClientCAs:    caCertPool,
        ClientAuth:   tls.RequireAndVerifyClientCert,
        MinVersion:   tls.VersionTLS13,
    }
}

// RIGHT: Verify service identity from certificate
func authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
            http.Error(w, "Client certificate required", http.StatusUnauthorized)
            return
        }

        serviceID := r.TLS.PeerCertificates[0].Subject.CommonName
        if !isAllowedService(serviceID) {
            http.Error(w, "Service not authorized", http.StatusForbidden)
            return
        }

        ctx := context.WithValue(r.Context(), "service_id", serviceID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

**Key Insight**: Network location is not identity. Every service-to-service call must be authenticated, even within "trusted" networks.

---

### Pitfall 2: Long-Lived Service Credentials

**Real Incident Report**: A service account key with admin privileges was created during initial deployment and never rotated. Three years later, the key was found in a public GitHub repository. The attacker had full access before anyone noticed.

**The Anti-Pattern**:
```go
// WRONG: Static service credentials
const (
    serviceKey    = "sk_live_abc123..." // Never changes
    serviceSecret = "secret_xyz789..."  // Created 3 years ago
)

func authenticate() {
    // Same credentials forever
    client.SetCredentials(serviceKey, serviceSecret)
}
```

**The Better Approach**:
```go
// RIGHT: Short-lived, automatically rotated credentials
type DynamicCredentials struct {
    client *spiffe.Client
}

func (d *DynamicCredentials) GetIdentity(ctx context.Context) (*tls.Certificate, error) {
    // SPIFFE provides short-lived identity (hours, not years)
    svid, err := d.client.FetchX509SVID(ctx)
    if err != nil {
        return nil, err
    }

    // Automatic rotation before expiry
    go d.watchForRotation(ctx)

    return svid.Certificates[0], nil
}

// Cloud workload identity - no static keys
func getGCPCredentials(ctx context.Context) (*google.Credentials, error) {
    // Uses GKE workload identity - no JSON key files
    return google.FindDefaultCredentials(ctx,
        "https://www.googleapis.com/auth/cloud-platform")
}

// AWS IRSA - no access keys
func getAWSCredentials(ctx context.Context) aws.CredentialsProvider {
    // Uses IAM Roles for Service Accounts
    return stscreds.NewWebIdentityRoleProvider(
        sts.NewFromConfig(cfg),
        os.Getenv("AWS_ROLE_ARN"),
        stscreds.IdentityTokenFile(os.Getenv("AWS_WEB_IDENTITY_TOKEN_FILE")),
    )
}
```

**Key Insight**: Static credentials are liability accumulation. Use SPIFFE/SPIRE or cloud workload identity for automatic, short-lived credentials.

---

### Pitfall 3: Coarse-Grained Authorization

**Real Incident Report**: A monitoring service needed read access to one metric endpoint. It was granted "internal-service" role which allowed access to all internal APIs. The service was compromised and used to access payment data.

**The Anti-Pattern**:
```go
// WRONG: All-or-nothing authorization
func authorize(serviceID string) bool {
    // "internal" role = access to everything
    return hasRole(serviceID, "internal-service")
}

// WRONG: Path-based authorization only
func authorizeRequest(path string, serviceID string) bool {
    // Any internal service can access any /api/* endpoint
    return strings.HasPrefix(path, "/api/") && isInternalService(serviceID)
}
```

**The Better Approach**:
```go
// RIGHT: Fine-grained, resource-specific authorization
type Permission struct {
    Service    string   // e.g., "monitoring-service"
    Actions    []string // e.g., ["read"]
    Resources  []string // e.g., ["/metrics/cpu", "/metrics/memory"]
    Conditions map[string]string // e.g., {"method": "GET"}
}

func authorizeRequest(ctx context.Context, req *Request) error {
    serviceID := ctx.Value("service_id").(string)

    // Look up specific permissions for this service
    permissions, err := getPermissions(serviceID)
    if err != nil {
        return err
    }

    for _, perm := range permissions {
        if matchesPermission(perm, req) {
            return nil
        }
    }

    // Log denied requests for audit
    audit.Log("authorization_denied",
        "service", serviceID,
        "resource", req.Resource,
        "action", req.Action)

    return ErrNotAuthorized
}

// OPA policy for declarative authorization
// policy.rego
/*
package authz

default allow := false

allow if {
    input.service == "monitoring-service"
    input.action == "read"
    startswith(input.resource, "/metrics/")
}
*/
```

**Key Insight**: Every service should have minimum necessary permissions. Use policy engines like OPA for declarative, auditable authorization.

---

### Pitfall 4: Missing Certificate Validation

**Real Incident Report**: A service configured mTLS but set `InsecureSkipVerify: true` during development and forgot to remove it. An attacker performed a MITM attack and intercepted sensitive API traffic for 2 weeks.

**The Anti-Pattern**:
```go
// WRONG: Disabled certificate validation
func createClient() *http.Client {
    return &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: &tls.Config{
                InsecureSkipVerify: true, // "Just for testing"
            },
        },
    }
}

// WRONG: No certificate expiry monitoring
func loadCerts() *tls.Config {
    cert, _ := tls.LoadX509KeyPair("cert.pem", "key.pem")
    // Certificate expires, nobody notices
    return &tls.Config{Certificates: []tls.Certificate{cert}}
}
```

**The Better Approach**:
```go
// RIGHT: Strict certificate validation
func createClient(caCertPath string) (*http.Client, error) {
    caCert, err := os.ReadFile(caCertPath)
    if err != nil {
        return nil, fmt.Errorf("failed to read CA cert: %w", err)
    }

    caCertPool := x509.NewCertPool()
    if !caCertPool.AppendCertsFromPEM(caCert) {
        return nil, errors.New("failed to parse CA cert")
    }

    return &http.Client{
        Transport: &http.Transport{
            TLSClientConfig: &tls.Config{
                RootCAs:    caCertPool,
                MinVersion: tls.VersionTLS13,
                // Never set InsecureSkipVerify: true
            },
        },
    }, nil
}

// RIGHT: Monitor certificate expiry
func monitorCertExpiry(certPath string) {
    ticker := time.NewTicker(1 * time.Hour)
    for range ticker.C {
        cert, err := loadCertificate(certPath)
        if err != nil {
            alerting.Alert("cert_load_failed", certPath)
            continue
        }

        daysUntilExpiry := time.Until(cert.NotAfter).Hours() / 24

        metrics.SetGauge("cert_days_until_expiry", daysUntilExpiry,
            "path", certPath)

        if daysUntilExpiry < 30 {
            alerting.Alert("cert_expiring_soon", certPath, daysUntilExpiry)
        }
    }
}
```

**Key Insight**: `InsecureSkipVerify` should never exist in production code. Monitor certificate expiry and automate rotation.

---

### Pitfall 5: No Audit Trail for Authentication Decisions

**Real Incident Report**: A breach occurred via a compromised service identity. Without authentication logs, the company couldn't determine which services were accessed, when, or by whom. Incident response took 3 weeks instead of hours.

**The Anti-Pattern**:
```go
// WRONG: Silent authentication decisions
func authenticate(r *http.Request) (*Identity, error) {
    identity, err := validateToken(r.Header.Get("Authorization"))
    if err != nil {
        return nil, err // No record of failed attempt
    }
    return identity, nil // No record of successful auth
}
```

**The Better Approach**:
```go
// RIGHT: Comprehensive authentication logging
func authenticate(ctx context.Context, r *http.Request) (*Identity, error) {
    startTime := time.Now()
    token := r.Header.Get("Authorization")

    identity, err := validateToken(token)

    // Log every authentication decision
    event := AuthEvent{
        Timestamp:  startTime,
        Duration:   time.Since(startTime),
        SourceIP:   getClientIP(r),
        UserAgent:  r.UserAgent(),
        Resource:   r.URL.Path,
        Method:     r.Method,
        TraceID:    trace.SpanFromContext(ctx).SpanContext().TraceID().String(),
    }

    if err != nil {
        event.Success = false
        event.FailureReason = err.Error()
        event.TokenHash = hashToken(token) // For correlation, not security

        audit.Log(event)

        // Increment failure metrics for alerting
        metrics.Increment("auth_failures",
            "reason", categorizeError(err),
            "source_ip", event.SourceIP)

        return nil, err
    }

    event.Success = true
    event.IdentityID = identity.ID
    event.IdentityType = identity.Type

    audit.Log(event)

    metrics.Increment("auth_successes",
        "identity_type", identity.Type)

    return identity, nil
}

// Alert on suspicious patterns
func detectAnomalies(events []AuthEvent) {
    // Multiple failures from same IP
    // Unusual geographic origin
    // Authentication outside business hours
    // Service accessing resources it never accessed before
}
```

**Key Insight**: Every authentication decision must be logged with full context. These logs are essential for incident response and security monitoring.

---

### Zero Trust Pitfall Quick Reference

| Pitfall | Result | Fix |
|---------|--------|-----|
| Trusting internal network | Lateral movement attacks | mTLS everywhere |
| Long-lived credentials | Permanent breach exposure | SPIFFE, workload identity |
| Coarse-grained authz | Excessive access on breach | Fine-grained OPA policies |
| Disabled cert validation | MITM attacks | Strict validation, expiry monitoring |
| No authentication audit | Blind incident response | Log every auth decision |

### Junior → FAANG: Zero Trust Pitfalls as Design Lessons

The pitfalls in this section are the most common failure modes when transitioning from a perimeter model to zero trust. Understanding them prevents making the same mistakes in your first zero-trust implementation.

**Gap to close:** The "trusting the internal network" pitfall is the most fundamental. It happens when engineers say "this service is internal, it doesn't need authentication." In a zero-trust model, there is no such thing as an internal service: all services are potentially reachable by compromised services, and all services must authenticate callers. Internalize this before your first zero-trust design.

**Interview preparation:** Be able to describe "trust the internal network" as an anti-pattern and explain why it fails: a single compromised service can make arbitrary requests to all "internal" services. Then describe the zero-trust replacement: mTLS plus service account tokens, where each service authenticates itself and each call is authorized based on the caller's verified identity.

### Senior @ FAANG: Preventing Zero Trust Pitfalls Systematically

At senior level, preventing zero-trust pitfalls requires policies and automation, not individual vigilance.

**Enforcement over education:** The "trusting the internal network" pitfall is prevented by removing the option: configure your service mesh to require mTLS for all in-mesh traffic by default, with an opt-out process that requires security review. Engineers cannot accidentally skip authentication because the platform does not allow it without an explicit override. This is the systematic prevention of a pitfall that education alone cannot reliably prevent.

**Certificate expiry monitoring:** Disabled cert validation is often a quick fix for an expired certificate. Prevent both the quick fix and the underlying cause: monitor certificate expiry for all services, alert 30 days before expiry, automate renewal where possible (SPIRE does this automatically). When a certificate expires and a service goes down, the post-incident review should identify why the certificate was not renewed before expiry. The systematic fix is monitoring and automation, not "be more careful."

---
