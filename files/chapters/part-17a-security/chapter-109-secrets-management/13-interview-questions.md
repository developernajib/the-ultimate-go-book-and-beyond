## 109.13 Interview Questions

### Question 1: How would you design a secrets management system for a microservices architecture with 100+ services?

**What FAANG expects:** Centralized vault (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, 1Password Connect) + short-lived dynamic credentials (DB passwords issued per-pod, TTL 1h) + workload identity (SPIFFE/SPIRE, GCP WIF, AWS IRSA). Never ship long-lived API keys in env vars. Bonus for naming External Secrets Operator (ESO) as the Kubernetes-native bridge, and for calling out that the real win is *dynamic* secrets (issued on demand, auto-revoked) over static rotation.

**What interviewers are looking for**:
- Understanding of centralized vs distributed approaches
- Knowledge of secret management tools
- Consideration of scale and reliability

**Strong Answer Framework**:

```
"For a 100+ service architecture, I'd design a centralized secrets management
system with distributed caching:

ARCHITECTURE:
┌──────────────────────────────────────────────────────────────────┐
│                     SECRETS ARCHITECTURE                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐        │
│  │  Service A   │    │  Service B   │    │  Service C   │        │
│  │  ┌────────┐  │    │  ┌────────┐  │    │  ┌────────┐  │        │
│  │  │ Sidecar│  │    │  │ Sidecar│  │    │  │ Sidecar│  │        │
│  │  │ Agent  │  │    │  │ Agent  │  │    │  │ Agent  │  │        │
│  │  └────┬───┘  │    │  └────┬───┘  │    │  └────┬───┘  │        │
│  └───────┼──────┘    └───────┼──────┘    └───────┼──────┘        │
│          │                   │                   │               │
│          └───────────────────┼───────────────────┘               │
│                              │                                   │
│                     ┌────────▼────────┐                          │
│                     │  Vault Cluster  │                          │
│                     │  (HA: 3 nodes)  │                          │
│                     └────────┬────────┘                          │
│                              │                                   │
│                     ┌────────▼────────┐                          │
│                     │   Consul/etcd   │                          │
│                     │   (Backend)     │                          │
│                     └─────────────────┘                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

KEY DESIGN DECISIONS:

1. CENTRALIZED VAULT CLUSTER
   - 3-5 node HA cluster with auto-unseal (AWS KMS or GCP KMS)
   - Separate clusters per environment (dev, staging, prod)
   - Performance replication for geographic distribution

2. SIDECAR PATTERN (VAULT AGENT)
   - Each pod runs Vault Agent sidecar
   - Agent handles authentication and token renewal
   - Secrets rendered to tmpfs (memory-backed filesystem)
   - Application reads from local file, not network

3. AUTHENTICATION
   - Kubernetes auth for services
   - OIDC for humans
   - AppRole for CI/CD systems
   - Each service has unique identity

4. DYNAMIC SECRETS
   - Database credentials generated on-demand
   - Short TTL (1 hour default)
   - Automatic renewal by Vault Agent
   - Zero long-lived credentials

5. CACHING STRATEGY
   - Vault Agent caches secrets locally
   - TTL-based cache invalidation
   - Graceful degradation if Vault unavailable
```

```go
// Vault Agent sidecar configuration
/*
vault {
  address = "https://vault.internal:8200"
}

auto_auth {
  method {
    type = "kubernetes"
    config {
      role = "{{ .ServiceName }}"
    }
  }

  sink {
    type = "file"
    config {
      path = "/vault/token"
    }
  }
}

template {
  source      = "/vault/templates/db-creds.ctmpl"
  destination = "/secrets/db-creds.json"
  perms       = "0400"
}
*/

// Application reads from rendered file
type DBCredentials struct {
    Username string `json:"username"`
    Password string `json:"password"`
}

func loadDBCredentials() (*DBCredentials, error) {
    data, err := os.ReadFile("/secrets/db-creds.json")
    if err != nil {
        return nil, err
    }
    var creds DBCredentials
    return &creds, json.Unmarshal(data, &creds)
}
```

**Key Points to Mention**:
1. "Centralized Vault with distributed agents reduces latency"
2. "Sidecar pattern keeps secrets off the network"
3. "Dynamic secrets eliminate long-lived credentials"
4. "Kubernetes auth provides identity without distributing secrets"
5. "Auto-unseal with cloud KMS prevents human involvement"

---

### Question 2: "A secret was accidentally committed to git. Walk me through your response."

**What interviewers are looking for**:
- Incident response methodology
- Understanding of git history persistence
- Practical remediation steps

**Strong Answer Framework**:

```
"This is a critical security incident. Here's my response process:

IMMEDIATE (First 30 minutes):

1. ASSESS SCOPE
   - What type of secret? (API key, password, private key)
   - Which repository? (public/private)
   - How long has it been exposed?
   - Has the branch been pushed to remote?

2. REVOKE AND ROTATE
   - Immediately revoke/rotate the compromised secret
   - Don't wait for git cleanup: assume it's been captured
   - Update all systems using the old secret

3. CONTAINMENT
   - If public repo: contact GitHub/GitLab to purge from CDN caches
   - Block the old secret in WAF/API gateway
   - Alert affected services

REMEDIATION (First 2 hours):

4. REMOVE FROM GIT HISTORY
```

```bash
# Option 1: BFG Repo-Cleaner (faster, recommended)
bfg --delete-files id_rsa
bfg --replace-text secrets.txt
git reflog expire --expire=now --all
git gc --prune=now --aggressive
git push --force --all

# Option 2: git filter-repo (Git's recommended replacement for filter-branch)
git filter-repo --invert-paths --path path/to/secret

# Force push all branches
git push --force --all
git push --force --tags
```

```
5. NOTIFY STAKEHOLDERS
   - Security team
   - Affected service owners
   - If customer data at risk: legal/compliance

6. VERIFY REMOVAL
   - Check GitHub API for cached content
   - Verify secret not in forks
   - Confirm all team members pulled fresh copies

POST-INCIDENT (Next 24 hours):

7. ROOT CAUSE ANALYSIS
   - Why wasn't this caught?
   - Was secret scanning enabled?
   - Did pre-commit hooks fail?

8. PREVENTIVE MEASURES
   - Enable GitHub secret scanning
   - Add pre-commit hooks (gitleaks)
   - Update .gitignore templates
   - Team training on secret handling
```

```yaml
# Pre-commit hook configuration
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks

# GitHub secret scanning
# Enable in repository settings
# Settings > Security > Code security and analysis
```

**Key Points to Mention**:
1. "Rotation is priority, assume the secret is compromised"
2. "Git history never forgets, you need to rewrite history"
3. "Force push is required, coordinate with the team"
4. "Public repos may have forks with the secret"
5. "Prevention through automation (pre-commit hooks)"

---

### Question 3: "How do you handle database credential rotation without downtime?"

**What interviewers are looking for**:
- Understanding of graceful rotation
- Knowledge of dual-credential patterns
- Practical implementation skills

**Strong Answer Framework**:

```go
// Zero-downtime database credential rotation

/*
ROTATION STRATEGY:

1. DUAL CREDENTIAL SUPPORT
   Database accepts both old and new credentials
   during rotation window

2. ROLLING DEPLOYMENT
   Gradually shift services to new credentials

3. CLEANUP
   Revoke old credentials after all services migrated

TIMELINE:
┌───────────────────────────────────────────────────────────┐
│ T+0    : Create new credentials (old still valid)         │
│ T+1h   : Notify services of new credentials               │
│ T+1-6h : Services reload and use new credentials          │
│ T+6h   : Verify no connections using old credentials      │
│ T+7h   : Revoke old credentials                           │
└───────────────────────────────────────────────────────────┘
*/

package rotation

import (
    "context"
    "database/sql"
    "fmt"
    "log"
    "sync"
    "sync/atomic"
    "time"
)

// RotatingCredentials supports zero-downtime credential rotation
type RotatingCredentials struct {
    current  atomic.Value // *Credentials
    previous atomic.Value // *Credentials

    gracePeriod time.Duration
    rotatedAt   time.Time
    mu          sync.Mutex
}

type Credentials struct {
    Username string
    Password string
}

func NewRotatingCredentials(initial *Credentials) *RotatingCredentials {
    rc := &RotatingCredentials{
        gracePeriod: 1 * time.Hour,
    }
    rc.current.Store(initial)
    return rc
}

// Rotate introduces new credentials while keeping old ones valid
func (rc *RotatingCredentials) Rotate(newCreds *Credentials) {
    rc.mu.Lock()
    defer rc.mu.Unlock()

    oldCreds := rc.current.Load().(*Credentials)
    rc.previous.Store(oldCreds)
    rc.current.Store(newCreds)
    rc.rotatedAt = time.Now()
}

// GetCurrent returns the current (preferred) credentials
func (rc *RotatingCredentials) GetCurrent() *Credentials {
    return rc.current.Load().(*Credentials)
}

// ValidateCredentials checks if provided credentials are valid
func (rc *RotatingCredentials) ValidateCredentials(username, password string) bool {
    // Check current credentials
    current := rc.current.Load().(*Credentials)
    if current != nil && current.Username == username && current.Password == password {
        return true
    }

    // Check previous credentials within grace period
    if time.Since(rc.rotatedAt) < rc.gracePeriod {
        prev := rc.previous.Load()
        if prev != nil {
            previous := prev.(*Credentials)
            if previous.Username == username && previous.Password == password {
                return true
            }
        }
    }

    return false
}

// DBPool manages a connection pool with rotating credentials
type DBPool struct {
    creds    *RotatingCredentials
    host     string
    port     int
    database string

    pool    atomic.Value // *sql.DB
    stopCh  chan struct{}
}

func NewDBPool(host string, port int, database string, creds *RotatingCredentials) *DBPool {
    return &DBPool{
        creds:    creds,
        host:     host,
        port:     port,
        database: database,
        stopCh:   make(chan struct{}),
    }
}

func (p *DBPool) Start(ctx context.Context) error {
    // Create initial connection
    if err := p.reconnect(ctx); err != nil {
        return err
    }

    // Watch for credential changes
    go p.watchCredentials(ctx)

    return nil
}

func (p *DBPool) reconnect(ctx context.Context) error {
    creds := p.creds.GetCurrent()

    dsn := fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=require",
        creds.Username, creds.Password, p.host, p.port, p.database)

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return err
    }

    if err := db.PingContext(ctx); err != nil {
        db.Close()
        return err
    }

    // Close old pool
    if old := p.pool.Load(); old != nil {
        old.(*sql.DB).Close()
    }

    p.pool.Store(db)
    return nil
}

func (p *DBPool) watchCredentials(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    lastCreds := p.creds.GetCurrent()

    for {
        select {
        case <-ticker.C:
            currentCreds := p.creds.GetCurrent()
            if currentCreds != lastCreds {
                log.Println("Credential rotation detected, reconnecting...")
                if err := p.reconnect(ctx); err != nil {
                    log.Printf("Reconnect failed: %v", err)
                } else {
                    lastCreds = currentCreds
                }
            }
        case <-ctx.Done():
            return
        }
    }
}

func (p *DBPool) DB() *sql.DB {
    return p.pool.Load().(*sql.DB)
}
```

**Key Points to Mention**:
1. "Dual credentials during rotation window"
2. "Database must accept both old and new during transition"
3. "Grace period prevents race conditions"
4. "Applications should reload credentials without restart"
5. "Vault dynamic secrets automate this entirely"

---

### Question 4: "Explain the difference between secrets at rest encryption and transit encryption."

**What interviewers are looking for**:
- Clear understanding of encryption concepts
- Practical application knowledge
- Defense in depth thinking

**Strong Answer Framework**:

```
"At-rest and in-transit encryption protect secrets at different stages:

AT-REST ENCRYPTION:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Protects stored data from unauthorized access:

┌──────────────────────────────────────────────────────────────────┐
│  STORAGE                                                         │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  Encrypted: aGVsbG8gd29ybGQ=                            │     │
│  │  (Without key, data is meaningless)                     │     │
│  └─────────────────────────────────────────────────────────┘     │
│                              │                                   │
│                    ┌─────────▼─────────┐                         │
│                    │   Decryption Key  │                         │
│                    │   (stored in KMS) │                         │
│                    └─────────┬─────────┘                         │
│                              │                                   │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  Plaintext: DATABASE_PASSWORD=secret123                 │     │
│  └─────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘

Use cases:
- Database storage encryption
- Disk encryption
- Vault backend storage
- Encrypted environment variables

Protects against:
- Disk theft
- Database dumps
- Backup file access
- Unauthorized storage access

IN-TRANSIT ENCRYPTION:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Protects data moving between systems:

┌──────────┐     TLS 1.3      ┌──────────┐
│  Client  │◄───────────────►│  Server   │
│          │  Encrypted       │          │
│          │  channel         │          │
└──────────┘                  └──────────┘

Components:
- TLS/mTLS for HTTPS
- SSH for remote access
- VPN for network segments
- Encrypted message queues

Protects against:
- Network sniffing
- Man-in-the-middle attacks
- Packet inspection
- Replay attacks

BOTH ARE REQUIRED:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

┌─────────────────────────────────────────────────────────────────┐
│                    DEFENSE IN DEPTH                             │
│                                                                 │
│  ┌─────────┐    TLS    ┌─────────┐    TLS    ┌─────────┐        │
│  │ Client  │◄────────►│ Vault   │◄────────►│ Database│          │
│  └─────────┘          └─────────┘          └─────────┘          │
│                            │                     │              │
│                   ┌────────▼────────┐   ┌───────▼───────┐       │
│                   │ Encrypted at    │   │ Encrypted at  │       │
│                   │ rest (Consul)   │   │ rest (TDE)    │       │
│                   └─────────────────┘   └───────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

```go
// Example: Vault with both at-rest and in-transit encryption
func configureSecureVault() *tls.Config {
    // TLS for in-transit encryption
    // Go selects TLS 1.3 cipher suites automatically, they are not configurable
    tlsConfig := &tls.Config{
        MinVersion: tls.VersionTLS13,
    }

    // Vault backend uses encryption at rest
    // (Integrated Storage or Consul with encryption enabled)

    // Auto-unseal uses HSM/KMS, the key is never exposed
    // seal "awskms" {
    //   region     = "us-west-2"
    //   kms_key_id = "alias/vault-seal"
    // }

    return tlsConfig
}
```

**Key Points to Mention**:
1. "At-rest protects stored data, in-transit protects moving data"
2. "Both are required for defense in depth"
3. "At-rest: backup files, stolen disks"
4. "In-transit: network sniffing, MITM"
5. "Vault encrypts data at rest AND requires TLS for transit"

### Junior → FAANG: Structuring Secrets Management Interview Answers

Secrets management interview questions at FAANG are system design questions, not knowledge recall. The questions test whether you can design a secure, operational, scalable system under constraints.

**Gap to close:** For Question 1 (design a secrets management system for 100+ services), avoid the mistake of describing a single point solution. The answer must address: authentication for services to the secrets manager (workload identity, not static credentials), secret distribution (fetch at startup with TTL-based refresh), rotation (automatic, zero-downtime), audit (who accessed what, when, from where), and failure modes (what happens when the secrets manager is unavailable). An answer that covers all five dimensions is a complete L5/L6 answer.

**Interview time management:** Secrets management system design questions have many dimensions. Prioritize: (1) authentication mechanism, (2) rotation strategy, (3) failure modes. These are the dimensions that interviewers probe most deeply. Cover the others at a high level and go deeper where the interviewer shows interest.

### Senior @ FAANG: Secrets Management Design at L6+

At L6+, secrets management design interviews probe organizational thinking as much as technical thinking. The interviewer is evaluating whether you can design a system that 100+ teams adopt and use correctly without constant hand-holding.

**Developer experience as a design constraint:** The best secrets management system that no one adopts is worse than a mediocre system with 100% adoption. Design the developer experience first: how does a developer on a new service get their first secret into the manager? How do they configure rotation? How do they debug a secret access failure in their service? A system that requires 10 manual steps to onboard a new service will have 60% adoption. A system with a Terraform module and a CLI tool that does it in 3 steps will have 95% adoption.

**Organizational boundary design:** For a 100+-service organization, define the secrets namespace hierarchy: per-environment (dev/staging/production), per-team, per-service. Define which teams have access to which namespaces and who grants that access. Define the process for a new service to request access to a shared secret. These governance boundaries are as important as the technical implementation, and a senior design answer includes them.

---
