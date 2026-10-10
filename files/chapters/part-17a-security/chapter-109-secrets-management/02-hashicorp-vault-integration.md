## 109.2 HashiCorp Vault Integration

HashiCorp Vault is the industry-standard secret management solution, offering dynamic secrets, encryption as a service, and fine-grained access control.

### Installing Vault Client

The Vault client library is the only dependency Go services need to talk to Vault. The command below adds it to the module.
```bash
go get github.com/hashicorp/vault/api@latest
```

### Basic Vault Client

The client below is configured with a Vault address and a token, then reads and writes secrets on a KV v2 mount, returning the current version's data map. A static token keeps the example focused on the secret operations. In production you would obtain the token via an auth method such as AppRole or Kubernetes auth and renew it before expiry, and Vault's dynamic database credentials feature (shown next) can replace the static `Secret.Data["password"]` pattern with credentials that are generated per-use and expire after the lease duration, eliminating long-lived credential exposure entirely.

```go
// pkg/vault/client.go
package vault

import (
    "context"
    "fmt"

    vault "github.com/hashicorp/vault/api"
)

// Client wraps the Vault API client with application-specific logic
type Client struct {
    client *vault.Client
    token  string
}

// Config holds Vault configuration
type Config struct {
    Address   string
    Token     string
    Namespace string // Vault Enterprise
}

// NewClient creates a new Vault client
func NewClient(cfg Config) (*Client, error) {
    config := vault.DefaultConfig()
    config.Address = cfg.Address

    if cfg.Namespace != "" {
        config.Headers = map[string]string{
            "X-Vault-Namespace": cfg.Namespace,
        }
    }

    client, err := vault.NewClient(config)
    if err != nil {
        return nil, fmt.Errorf("failed to create vault client: %w", err)
    }

    client.SetToken(cfg.Token)

    return &Client{
        client: client,
        token:  cfg.Token,
    }, nil
}

// GetSecret retrieves a secret from Vault KV v2
func (c *Client) GetSecret(ctx context.Context, path string) (map[string]any, error) {
    secret, err := c.client.KVv2("secret").Get(ctx, path)
    if err != nil {
        return nil, fmt.Errorf("failed to read secret at %s: %w", path, err)
    }

    if secret == nil || secret.Data == nil {
        return nil, fmt.Errorf("no data found at %s", path)
    }

    return secret.Data, nil
}

// GetSecretField retrieves a specific field from a secret
func (c *Client) GetSecretField(ctx context.Context, path, field string) (string, error) {
    data, err := c.GetSecret(ctx, path)
    if err != nil {
        return "", err
    }

    value, ok := data[field].(string)
    if !ok {
        return "", fmt.Errorf("field %s not found or not a string", field)
    }

    return value, nil
}

// WriteSecret writes a secret to Vault KV v2
func (c *Client) WriteSecret(ctx context.Context, path string, data map[string]any) error {
    _, err := c.client.KVv2("secret").Put(ctx, path, data)
    if err != nil {
        return fmt.Errorf("failed to write secret to %s: %w", path, err)
    }

    return nil
}

// DeleteSecret permanently deletes a secret's metadata and all versions
func (c *Client) DeleteSecret(ctx context.Context, path string) error {
    err := c.client.KVv2("secret").DeleteMetadata(ctx, path)
    if err != nil {
        return fmt.Errorf("failed to delete secret at %s: %w", path, err)
    }

    return nil
}
```

### Dynamic Database Credentials

One of Vault's most powerful features is generating dynamic, short-lived credentials:

```go
// pkg/vault/database.go
package vault

import (
    "context"
    "database/sql"
    "fmt"
    "time"

    _ "github.com/lib/pq"
)

// DatabaseCredentials represents dynamic database credentials
type DatabaseCredentials struct {
    Username  string
    Password  string
    LeaseID   string
    LeaseDuration time.Duration
    Renewable bool
}

// GetDatabaseCredentials retrieves dynamic database credentials from Vault
func (c *Client) GetDatabaseCredentials(ctx context.Context, role string) (*DatabaseCredentials, error) {
    path := fmt.Sprintf("database/creds/%s", role)

    secret, err := c.client.Logical().ReadWithContext(ctx, path)
    if err != nil {
        return nil, fmt.Errorf("failed to generate database credentials: %w", err)
    }

    if secret == nil {
        return nil, fmt.Errorf("no credentials generated for role %s", role)
    }

    username, ok := secret.Data["username"].(string)
    if !ok {
        return nil, fmt.Errorf("username not found in response")
    }

    password, ok := secret.Data["password"].(string)
    if !ok {
        return nil, fmt.Errorf("password not found in response")
    }

    return &DatabaseCredentials{
        Username:      username,
        Password:      password,
        LeaseID:       secret.LeaseID,
        LeaseDuration: time.Duration(secret.LeaseDuration) * time.Second,
        Renewable:     secret.Renewable,
    }, nil
}

// RenewLease renews a Vault lease
func (c *Client) RenewLease(ctx context.Context, leaseID string, increment int) error {
    _, err := c.client.Sys().RenewWithContext(ctx, leaseID, increment)
    if err != nil {
        return fmt.Errorf("failed to renew lease %s: %w", leaseID, err)
    }

    return nil
}

// RevokeLease revokes a Vault lease immediately
func (c *Client) RevokeLease(ctx context.Context, leaseID string) error {
    err := c.client.Sys().RevokeWithContext(ctx, leaseID)
    if err != nil {
        return fmt.Errorf("failed to revoke lease %s: %w", leaseID, err)
    }

    return nil
}

// ManagedDBConnection manages a database connection with automatic renewal
type ManagedDBConnection struct {
    db          *sql.DB
    client      *Client
    role        string
    credentials *DatabaseCredentials
    stopCh      chan struct{}
}

// NewManagedDBConnection creates a database connection with auto-renewing credentials
func (c *Client) NewManagedDBConnection(ctx context.Context, role, host, dbname string, port int) (*ManagedDBConnection, error) {
    creds, err := c.GetDatabaseCredentials(ctx, role)
    if err != nil {
        return nil, err
    }

    dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=require",
        host, port, creds.Username, creds.Password, dbname)

    db, err := sql.Open("postgres", dsn)
    if err != nil {
        return nil, fmt.Errorf("failed to open database: %w", err)
    }

    if err := db.PingContext(ctx); err != nil {
        db.Close()
        return nil, fmt.Errorf("failed to ping database: %w", err)
    }

    managed := &ManagedDBConnection{
        db:          db,
        client:      c,
        role:        role,
        credentials: creds,
        stopCh:      make(chan struct{}),
    }

    // Start automatic renewal
    go managed.renewLoop()

    return managed, nil
}

// DB returns the underlying database connection
func (m *ManagedDBConnection) DB() *sql.DB {
    return m.db
}

// Close closes the connection and stops renewal
func (m *ManagedDBConnection) Close() error {
    close(m.stopCh)

    ctx := context.Background()
    if err := m.client.RevokeLease(ctx, m.credentials.LeaseID); err != nil {
        // Log but don't fail on revocation error
        fmt.Printf("warning: failed to revoke lease: %v\n", err)
    }

    return m.db.Close()
}

// renewLoop automatically renews the lease
func (m *ManagedDBConnection) renewLoop() {
    // Renew at 90% of lease duration
    renewInterval := time.Duration(float64(m.credentials.LeaseDuration) * 0.9)
    ticker := time.NewTicker(renewInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            ctx := context.Background()
            if err := m.client.RenewLease(ctx, m.credentials.LeaseID, int(m.credentials.LeaseDuration.Seconds())); err != nil {
                fmt.Printf("error: failed to renew database credentials lease: %v\n", err)
                // In production, trigger alert and graceful shutdown
            }
        case <-m.stopCh:
            return
        }
    }
}
```

### Junior → FAANG: Vault Integration Patterns That Matter

HashiCorp Vault is the most commonly referenced secrets management system in FAANG interviews and in enterprise engineering. Understanding the integration patterns rather than just the API is what distinguishes interview-ready knowledge.

**Gap to close:** Know the difference between Vault AppRole authentication (service uses a role ID and secret ID to authenticate, suitable for services that cannot use a cloud provider identity) and Kubernetes service account authentication (service uses its Kubernetes service account JWT to authenticate, the Vault Kubernetes auth method validates it against the Kubernetes API, no static secrets required for authentication). The Kubernetes auth method is preferred in Kubernetes environments because it eliminates the bootstrap secret problem.

**Dynamic secrets as the key Vault differentiator:** Vault's database secrets engine generates a unique database credential for each service instance with a configurable TTL. The credential is created on first use and revoked when the TTL expires. This means there is no static database password to manage. If the credential is compromised, it expires shortly. If you revoke the lease manually, cleanup is immediate. This pattern is not possible with AWS Secrets Manager or GCP Secret Manager without custom integration.

**Interview framing:** When asked "how would you eliminate static database passwords from your Go microservices?", describe Vault's database secrets engine: configure Vault to connect to the database and create credentials on demand, have each service instance fetch a unique credential at startup using its Kubernetes service account, use the credential for the connection lifetime (or renew it before expiry), and let Vault revoke it automatically at TTL expiry. This answer demonstrates production-level Vault knowledge.

### Senior @ FAANG: Vault Infrastructure Design and Operations

At senior level, Vault is not just an integration target: it is infrastructure that you own and operate. Vault availability, performance, and security are your responsibility.

**Vault HA architecture:** Production Vault runs in HA mode with multiple nodes and an integrated storage backend (Vault Integrated Storage using Raft consensus). Design for: auto-unseal using a cloud KMS (eliminates the operational burden of manual unseal but adds a dependency on the KMS), cross-region replication for disaster recovery, and separate Vault clusters per environment (dev, staging, production). Document the RTO/RPO for each environment and validate it with a DR exercise.

**Policy design at scale:** Vault policies determine what each authenticating entity can access. At scale, policies are generated from a higher-level configuration (Terraform, a custom policy generator) rather than written manually. Each service has a policy that allows access to exactly its required secrets, nothing more. Review policies quarterly and remove access to secrets that are no longer needed. Accumulating unnecessary access in policies is a least-privilege violation that increases blast radius.

**Secrets engine selection ADR:** When onboarding a new secret type (a new database, a new cloud provider credential, a new certificate need), write an ADR that specifies which Vault secrets engine is appropriate and why. Some secrets (cloud provider credentials) are best managed by cloud-native identity (IAM roles, workload identity) rather than Vault. Others (database credentials, PKI certificates) are well-served by Vault's native engines. Having an ADR per secret type prevents ad-hoc decisions that create management inconsistency.

---
