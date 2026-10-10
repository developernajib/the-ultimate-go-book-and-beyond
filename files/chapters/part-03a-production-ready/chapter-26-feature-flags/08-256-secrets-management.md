## 26.6 Secrets Management

### Environment-Based Secrets

The simplest secrets management strategy reads all secrets from environment variables at startup. Environment variables are not stored in version control, are visible only to the process and its children, and integrate naturally with Kubernetes secrets and Docker secrets. Binary secrets such as encryption keys are passed as hex or base64 strings and decoded to bytes during loading.

```go
package config

import (
    "encoding/hex"
    "fmt"
    "os"
)

type Secrets struct {
    DatabasePassword string
    APIKey           string
    JWTSecret        string
    EncryptionKey    []byte
}

func LoadSecrets() (*Secrets, error) {
    secrets := &Secrets{
        DatabasePassword: os.Getenv("DATABASE_PASSWORD"),
        APIKey:           os.Getenv("API_KEY"),
        JWTSecret:        os.Getenv("JWT_SECRET"),
    }

    // Encryption key from hex or base64
    if keyHex := os.Getenv("ENCRYPTION_KEY"); keyHex != "" {
        key, err := hex.DecodeString(keyHex)
        if err != nil {
            return nil, fmt.Errorf("decode encryption key: %w", err)
        }
        secrets.EncryptionKey = key
    }

    return secrets, nil
}
```

### Vault Integration

HashiCorp Vault provides dynamic secret generation, fine-grained access policies, and audit logging that environment variables cannot offer. A thin `VaultSecrets` wrapper caches fetched secret values locally to avoid a Vault call on every request, and a `Refresh` method re-reads the path so that rotated values are picked up.

Read the cache in this example as a teaching skeleton rather than a finished component. It has no expiry, which is a deliberate simplification with a real consequence, spelled out after the code.

```go
package config

import (
    "context"
    "fmt"
    "sync"

    vault "github.com/hashicorp/vault/api"
)

type VaultSecrets struct {
    client     *vault.Client
    secretPath string
    cache      map[string]string
    mu         sync.RWMutex
}

func NewVaultSecrets(address, token, secretPath string) (*VaultSecrets, error) {
    config := vault.DefaultConfig()
    config.Address = address

    client, err := vault.NewClient(config)
    if err != nil {
        return nil, err
    }

    client.SetToken(token)

    return &VaultSecrets{
        client:     client,
        secretPath: secretPath,
        cache:      make(map[string]string),
    }, nil
}

func (v *VaultSecrets) Get(ctx context.Context, key string) (string, error) {
    // Check cache first
    v.mu.RLock()
    if value, ok := v.cache[key]; ok {
        v.mu.RUnlock()
        return value, nil
    }
    v.mu.RUnlock()

    // Fetch from Vault
    secret, err := v.client.KVv2("secret").Get(ctx, v.secretPath)
    if err != nil {
        return "", err
    }

    value, ok := secret.Data[key].(string)
    if !ok {
        return "", fmt.Errorf("secret %s not found", key)
    }

    // Cache the value
    v.mu.Lock()
    v.cache[key] = value
    v.mu.Unlock()

    return value, nil
}

func (v *VaultSecrets) Refresh(ctx context.Context) error {
    secret, err := v.client.KVv2("secret").Get(ctx, v.secretPath)
    if err != nil {
        return err
    }

    v.mu.Lock()
    defer v.mu.Unlock()

    for k, val := range secret.Data {
        if str, ok := val.(string); ok {
            v.cache[k] = str
        }
    }

    return nil
}
```

> **This cache never expires, and that quietly cancels rotation.** `Get` populates `v.cache[key]` on first read and no code path ever removes it. Once a key is cached, the process will serve that value until it restarts. So when you rotate the database password in Vault, or revoke a lease after an incident, every running instance keeps using the old credential and keeps succeeding until the database itself rejects it. The revocation you performed during the incident did not take effect anywhere it mattered, and nothing told you so.
>
> `Refresh` exists to fix this, but only if something calls it. Wire it to a ticker at startup (`for range time.NewTicker(5*time.Minute).C { v.Refresh(ctx) }`) rather than trusting callers to remember. Better, give each entry a fetch timestamp and let `Get` treat entries past their TTL as misses, so freshness is a property of the type rather than of somebody's goroutine. Best of all, use Vault's dynamic secrets engine, where credentials carry a lease and the client library renews or re-issues them, and let the library own the lifecycle.
>
> The general rule: **a cache of security-relevant state needs an expiry, because the whole point of revocation is that it must eventually reach every reader.** An unbounded cache turns "revoke this credential" into a suggestion.

### Production Rules for Secrets in 2026

Environment variables are the minimum bar. For anything beyond a hobby project, follow these non-negotiable rules:

1. **Never hardcode, never commit**. Not in source, not in Dockerfiles, not in CI YAML. Use a scanner (gitleaks, trufflehog) in pre-commit and CI to enforce this.
2. **Fetch at runtime, not build time**. Baked-in secrets turn every container image into a credential leak surface.
3. **Prefer short-lived credentials over static ones**. On AWS, use IAM Roles for Service Accounts (IRSA) on EKS or EKS Pod Identity. On GCP, use Workload Identity. On Kubernetes, use the projected service account token. The mechanism is that the platform exchanges a signed, short-lived identity token for temporary credentials, which the SDK caches and refreshes automatically before expiry (on the order of an hour, not per call). You never hold a long-lived key, so there is nothing to rotate and nothing durable to leak. This is the single most impactful change on this list.
4. **Rotate what cannot be short-lived**. Database passwords and third-party API keys should rotate on a schedule (30, 60, 90 days). Vault's dynamic secrets engine issues per-connection DB credentials that expire automatically.
5. **Layer the secret store**. Vault, AWS Secrets Manager, GCP Secret Manager, or Kubernetes Secrets with encryption at rest (KMS-backed) plus `kubectl` RBAC. For GitOps workflows, use SOPS or Sealed Secrets so encrypted values can safely live in Git.
6. **Scrub from logs and errors**. Wrap secret types in a `String()` method that returns `"[REDACTED]"`. Never log config structs directly.
7. **Audit access**. Vault and AWS Secrets Manager emit access logs. Pipe them to SIEM and alert on anomalies (secret accessed from a new region, off-hours access, etc.).

```go
// Redacted secret type: safe to log, never prints the underlying value.
type Secret string

func (s Secret) String() string         { return "[REDACTED]" }
func (s Secret) GoString() string       { return "[REDACTED]" }
func (s Secret) MarshalJSON() ([]byte, error) {
    return []byte(`"[REDACTED]"`), nil
}
func (s Secret) Reveal() string         { return string(s) }
```

### AWS Secrets Manager with IRSA (EKS)

On EKS, attach an IAM role to the pod's service account (IRSA). The Go SDK picks up the role automatically via the default credential chain. No static access key, no rotation, no leak surface.

```go
import (
    "context"
    "errors"

    awscfg "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

func FetchSecret(ctx context.Context, name string) (Secret, error) {
    cfg, err := awscfg.LoadDefaultConfig(ctx) // Uses IRSA role.
    if err != nil {
        return "", err
    }
    client := secretsmanager.NewFromConfig(cfg)
    out, err := client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
        SecretId: &name,
    })
    if err != nil {
        return "", err
    }
    // SecretString is nil for secrets stored as binary: the value arrives in
    // SecretBinary instead. Dereferencing blind panics on a perfectly valid
    // secret that someone happened to create with --secret-binary.
    if out.SecretString == nil {
        if len(out.SecretBinary) > 0 {
            return Secret(out.SecretBinary), nil
        }
        return "", errors.New("secret has neither SecretString nor SecretBinary")
    }
    return Secret(*out.SecretString), nil
}
```

Two details in that snippet are load-bearing. The AWS SDK's `config` package is aliased to `awscfg` because this code lives in a package already named `config`, and the collision is a compile error rather than something subtle. And the return type is `Secret`, not `string`, so the value is redaction-protected from the moment it enters the process. A secret that spends even one function call as a plain `string` is a secret that can reach a log line.

> **Senior track**: The question "how do you rotate a database password with zero downtime" has one correct answer: dual-credential rotation. Issue a new credential alongside the old one, roll pods to pick it up, then revoke the old one. Vault's dynamic secrets engine automates this. Never rotate by "restart everything at 3am and hope."

### Staff Lens: Secrets Audit

Audit every service for hardcoded secrets. Audit CI for secrets in logs. Audit git history for accidentally-committed secrets. Rotate any found. This is security hygiene that should happen quarterly.

---
