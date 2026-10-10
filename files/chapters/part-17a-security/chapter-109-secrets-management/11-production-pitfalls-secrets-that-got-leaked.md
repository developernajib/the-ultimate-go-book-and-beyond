## 109.11 Production Pitfalls: Secrets That Got Leaked

### Pitfall 1: Secrets in Environment Variable Dumps

**Real Incident Report**: A debugging endpoint exposed all environment variables including database passwords, API keys, and JWT secrets. An attacker discovered it through Google dorking and exfiltrated credentials for dozens of production services.

**The Anti-Pattern**:
```go
// WRONG: Debug endpoint exposes everything
func debugHandler(w http.ResponseWriter, r *http.Request) {
    // "Helpful" debug endpoint in production
    envVars := os.Environ()
    for _, env := range envVars {
        fmt.Fprintf(w, "%s\n", env) // Exposes DATABASE_URL, API_KEY, etc.
    }
}

// WRONG: Logging environment on startup
func main() {
    log.Printf("Starting with environment: %v", os.Environ())
    // Now your secrets are in CloudWatch/Datadog/Splunk forever
}
```

**The Better Approach**:
```go
// RIGHT: Never expose raw environment
var sensitivePatterns = []string{
    "PASSWORD", "SECRET", "KEY", "TOKEN", "CREDENTIAL",
    "DATABASE", "REDIS", "API_KEY", "PRIVATE",
}

func isSensitive(key string) bool {
    upperKey := strings.ToUpper(key)
    for _, pattern := range sensitivePatterns {
        if strings.Contains(upperKey, pattern) {
            return true
        }
    }
    return false
}

func safeDebugHandler(w http.ResponseWriter, r *http.Request) {
    // Require authentication and authorization
    if !isAdmin(r.Context()) {
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }

    for _, env := range os.Environ() {
        parts := strings.SplitN(env, "=", 2)
        key := parts[0]

        if isSensitive(key) {
            fmt.Fprintf(w, "%s=[REDACTED]\n", key)
        } else {
            fmt.Fprintf(w, "%s\n", env)
        }
    }
}

// Better: Don't expose environment at all
// Use structured health checks instead
```

**Key Insight**: Debug endpoints are the #1 source of credential leaks. Never expose environment variables, and if you must have debug endpoints, require strong authentication and redact sensitive values.

---

### Pitfall 2: Committing .env Files or Secrets to Git

**Real Incident Report**: A developer committed AWS credentials in a `.env` file. Even though they deleted it in the next commit, an attacker used `git log` to find the credentials and spun up tens of thousands of dollars worth of cryptocurrency mining instances.

**The Anti-Pattern**:
```bash
# .env file committed to repository
DATABASE_URL=postgres://admin:SuperSecret123@prod-db.example.com:5432/app
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
STRIPE_SECRET_KEY=sk_live_abc123def456

# Even worse: config.go with embedded secrets
const (
    dbPassword    = "SuperSecret123"
    stripeKey     = "sk_live_abc123def456"
)
```

**The Better Approach**:
```go
// RIGHT: Use secret managers, never hardcode

// 1. Create comprehensive .gitignore
// .gitignore
// .env
// .env.*
// !.env.example
// *.pem
// *.key
// credentials.json

// 2. Pre-commit hook to detect secrets
// .pre-commit-config.yaml
/*
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks
*/

// 3. Load secrets from secret manager
func loadSecrets(ctx context.Context) (*Secrets, error) {
    client, err := secretmanager.NewClient(ctx)
    if err != nil {
        return nil, err
    }
    defer client.Close()

    secrets := &Secrets{}

    // Load each secret individually
    dbPass, err := accessSecret(ctx, client, "database-password")
    if err != nil {
        return nil, err
    }
    secrets.DatabasePassword = dbPass

    return secrets, nil
}

// 4. If you must use env vars, validate they're not in code
func init() {
    // Fail fast if secrets are missing
    required := []string{"DATABASE_URL", "API_KEY"}
    for _, env := range required {
        if os.Getenv(env) == "" {
            log.Fatalf("Required environment variable %s not set", env)
        }
    }
}
```

**Key Insight**: Git never forgets. Even deleted files exist in history forever. Use secret scanning tools in CI/CD and never commit secrets, even in "private" repositories.

---

### Pitfall 3: Secrets in Container Images

**Real Incident Report**: A company baked API keys into their Docker image for "convenience." The image was pushed to a public ECR registry by mistake. Attackers extracted credentials using `docker history` and accessed production systems.

**The Anti-Pattern**:
```dockerfile
# WRONG: Secrets baked into image
FROM golang:1.27.1

# These are visible in docker history!
ENV DATABASE_PASSWORD=secret123
ENV API_KEY=sk_live_abc123

COPY . .
RUN go build -o /app

# WRONG: Copying secret files
COPY .env /app/.env
COPY credentials.json /app/credentials.json
```

**The Better Approach**:
```dockerfile
# RIGHT: Multi-stage build, no secrets in image
FROM golang:1.27.1 AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o /app

# Final image: minimal attack surface
FROM gcr.io/distroless/static:nonroot

COPY --from=builder /app /app

# Secrets provided at runtime, not build time
USER nonroot:nonroot
ENTRYPOINT ["/app"]
```

```go
// RIGHT: Secrets injected at runtime
func main() {
    // From Kubernetes secret mount
    dbPassword, err := os.ReadFile("/secrets/db-password")
    if err != nil {
        log.Fatal("Failed to read database password")
    }

    // From environment (set by orchestrator)
    apiKey := os.Getenv("API_KEY")
    if apiKey == "" {
        log.Fatal("API_KEY not set")
    }
}
```

```yaml
# Kubernetes: Mount secrets at runtime
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: app
    image: myapp:latest
    env:
    - name: API_KEY
      valueFrom:
        secretKeyRef:
          name: app-secrets
          key: api-key
    volumeMounts:
    - name: secrets
      mountPath: /secrets
      readOnly: true
  volumes:
  - name: secrets
    secret:
      secretName: app-secrets
```

**Key Insight**: Container images are not secure storage. Anyone with image access can extract every layer. Secrets must be injected at runtime through orchestrator mechanisms.

---

### Pitfall 4: Logging Secrets in Error Messages

**Real Incident Report**: Database connection errors included the full connection string with password. These errors were sent to a third-party logging service whose access controls were later compromised, exposing years of retained credentials in log history.

**The Anti-Pattern**:
```go
// WRONG: Secrets in error messages
func connectDB(connStr string) (*sql.DB, error) {
    db, err := sql.Open("postgres", connStr)
    if err != nil {
        // Logs: "failed to connect: postgres://user:P@ssw0rd!@host:5432/db"
        return nil, fmt.Errorf("failed to connect: %s: %w", connStr, err)
    }
    return db, nil
}

// WRONG: Secrets in request logging
func apiMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Logs Authorization header with bearer token
        log.Printf("Request: %s %s Headers: %v", r.Method, r.URL, r.Header)
        next.ServeHTTP(w, r)
    })
}
```

**The Better Approach**:
```go
// RIGHT: Redact secrets from errors and logs
type RedactedConnString string

func (r RedactedConnString) String() string {
    u, err := url.Parse(string(r))
    if err != nil {
        return "[invalid-connection-string]"
    }
    if u.User != nil {
        u.User = url.UserPassword(u.User.Username(), "[REDACTED]")
    }
    return u.String()
}

func connectDB(connStr string) (*sql.DB, error) {
    db, err := sql.Open("postgres", connStr)
    if err != nil {
        // Logs: "failed to connect to postgres://user:[REDACTED]@host:5432/db"
        return nil, fmt.Errorf("failed to connect to %s: %w",
            RedactedConnString(connStr), err)
    }
    return db, nil
}

// Redact sensitive headers
var sensitiveHeaders = map[string]bool{
    "Authorization": true,
    "Cookie":        true,
    "X-Api-Key":     true,
}

func redactHeaders(headers http.Header) http.Header {
    redacted := make(http.Header)
    for k, v := range headers {
        if sensitiveHeaders[k] {
            redacted[k] = []string{"[REDACTED]"}
        } else {
            redacted[k] = v
        }
    }
    return redacted
}
```

**Key Insight**: Logs are often sent to third-party services and retained for years. Treat logs as public and ensure no secrets can ever appear in them.

---

### Pitfall 5: No Secret Rotation Strategy

**Real Incident Report**: A company used the same API key for 4 years. When an employee left and took the key, they couldn't rotate it because no rotation mechanism existed. They had to coordinate a "big bang" rotation across 200 services during a weekend maintenance window.

**The Anti-Pattern**:
```go
// WRONG: Static secrets with no rotation
type Config struct {
    APIKey string // Set once, never changes
}

func (c *Config) GetAPIKey() string {
    return c.APIKey // Same key forever
}
```

**The Better Approach**:
```go
// RIGHT: Support secret rotation with overlap period
type RotatingSecret struct {
    mu       sync.RWMutex
    current  string
    previous string // Accept during rotation period
    rotateAt time.Time
}

func (r *RotatingSecret) Validate(provided string) bool {
    r.mu.RLock()
    defer r.mu.RUnlock()

    // Accept current secret
    if subtle.ConstantTimeCompare([]byte(provided), []byte(r.current)) == 1 {
        return true
    }

    // Accept previous secret during rotation window
    if time.Now().Before(r.rotateAt) {
        if subtle.ConstantTimeCompare([]byte(provided), []byte(r.previous)) == 1 {
            return true
        }
    }

    return false
}

func (r *RotatingSecret) Rotate(newSecret string, gracePeriod time.Duration) {
    r.mu.Lock()
    defer r.mu.Unlock()

    r.previous = r.current
    r.current = newSecret
    r.rotateAt = time.Now().Add(gracePeriod)
}

// Vault dynamic database credentials: automatic rotation
type DynamicDBCredentials struct {
    client *vault.Client
    path   string
    creds  atomic.Value // *DBCreds
    stopCh chan struct{}
}

func (d *DynamicDBCredentials) Start(ctx context.Context) {
    go func() {
        for {
            secret, err := d.client.Logical().Read(d.path)
            if err != nil || secret == nil {
                // Back off and retry, alert in production
                select {
                case <-time.After(10 * time.Second):
                    continue
                case <-ctx.Done():
                    return
                }
            }

            d.creds.Store(&DBCreds{
                Username: secret.Data["username"].(string),
                Password: secret.Data["password"].(string),
            })

            // Fetch fresh credentials at 2/3 of lease duration
            renewIn := time.Duration(secret.LeaseDuration) * time.Second * 2 / 3
            select {
            case <-time.After(renewIn):
            case <-ctx.Done():
                return
            }
        }
    }()
}
```

**Key Insight**: Every secret must have a rotation mechanism before it's deployed. Dynamic secrets (like Vault database credentials) eliminate long-lived passwords entirely.

---

### Secrets Management Pitfall Quick Reference

| Pitfall | Impact | Fix |
|---------|--------|-----|
| Debug endpoints exposing env | Full credential leak | Redact or remove debug endpoints |
| Secrets in git history | Permanent exposure | Pre-commit hooks, secret scanning |
| Secrets in Docker images | Image = credential theft | Runtime injection only |
| Secrets in logs | Third-party exposure | Structured logging with redaction |
| No rotation strategy | Breach = forever compromised | Dynamic secrets, overlap periods |

### Junior → FAANG: Pitfalls as Interview Preparation

The pitfalls in this section have ended careers at real companies. Juniors who can name these pitfalls, describe the root cause, and explain the prevention demonstrate security awareness beyond their experience level.

**Gap to close:** The "secrets in environment variable dumps" pitfall is the subtlest. When a Go service panics, the default panic handler in many frameworks (or a misconfigured APM agent) may dump the entire environment. A secret in an environment variable becomes visible in your error tracking system, which may be a third-party service with different access controls than your production infrastructure. The fix is to strip secrets from the environment at process startup: copy the values you need to struct fields, then `os.Unsetenv` them.

**Interview anecdote:** If asked "describe a security mistake you've seen or made," one of these pitfalls makes an excellent answer because you can describe the root cause specifically and describe the systemic fix without admitting personal wrongdoing. "I found that our staging environment was logging AWS credentials in the startup log. I implemented structured logging with field redaction and added a CI test that checks for credential patterns in staging logs."

### Senior @ FAANG: Pitfall Prevention as Organizational Infrastructure

At senior level, preventing these pitfalls organization-wide requires infrastructure that makes the mistakes impossible, not training that hopes engineers remember to avoid them.

**Structural prevention of each pitfall:**
- Environment variable dumps: process hardening that strips secrets at startup (copy to struct, then unsetenv), combined with APM agent configuration that excludes environment variables from panic reports.
- Secrets in logs: mandatory structured logger with redaction, linter rule against `fmt.Sprintf("%+v", ...)` on config structs, log sampling tests in CI.
- Version control exposure: gitleaks in pre-commit and CI, combined with an organizational policy that any detected secret triggers an immediate rotation (not a "we'll check if it was real" delay).
- No rotation: secrets manager with rotation enabled for all secrets, monitoring for secrets approaching expiration, quarterly rotation audit.

When each pitfall has a structural prevention, the organization's security posture does not depend on individual engineers remembering the lessons of this section.

---
