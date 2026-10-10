## 97.15 Secrets Management in Containers

### Environment Variables vs. Secret Files

Secrets like database passwords, API keys, and TLS certificates need special handling in containers. While environment variables are the simplest approach, they have security drawbacks: they are visible in `docker inspect` output, can appear in log files, and are inherited by child processes. Secret files mounted at runtime (especially via tmpfs so they never touch disk) are more secure. For production systems, dedicated secret managers like HashiCorp Vault provide features like automatic rotation, audit logging, and dynamic credential generation.

```
┌──────────────────────────────────────────────────────────────────┐
│                SECRETS IN CONTAINERS                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ENVIRONMENT VARIABLES (Simpler but less secure):                │
│  ├── Visible in `docker inspect`                                 │
│  ├── Can leak in logs, crash dumps                               │
│  ├── Inherited by child processes                                │
│  └── OK for: Non-sensitive config                                │
│                                                                  │
│  SECRET FILES (More secure):                                     │
│  ├── Mounted at runtime                                          │
│  ├── Can use tmpfs (never on disk)                               │
│  ├── More complex to manage                                      │
│  └── OK for: API keys, passwords, certificates                   │
│                                                                  │
│  SECRET MANAGERS (Production recommended):                       │
│  ├── HashiCorp Vault                                             │
│  ├── AWS Secrets Manager                                         │
│  ├── GCP Secret Manager                                          │
│  └── Azure Key Vault                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Reading Secrets from Files in Go

A well-designed Go application should support reading secrets from both environment variables and files, falling back gracefully between the two. The convention used by Docker Swarm and many orchestrators is to mount secret files at `/run/secrets/<secret_name>`. Your code checks for the file first, and if it does not exist, falls back to an environment variable. This pattern lets the same code work in local development (where you use environment variables) and in production (where secrets are mounted as files).

```go
package config

import (
    "os"
    "strings"
)

type Config struct {
    DatabasePassword string
    APIKey           string
    JWTSecret        []byte
}

func LoadSecrets() (*Config, error) {
    cfg := &Config{}

    // Option 1: Read from secret file
    if dbPassFile := os.Getenv("DB_PASSWORD_FILE"); dbPassFile != "" {
        password, err := os.ReadFile(dbPassFile)
        if err != nil {
            return nil, err
        }
        cfg.DatabasePassword = strings.TrimSpace(string(password))
    } else {
        // Fallback to env var (less secure)
        cfg.DatabasePassword = os.Getenv("DB_PASSWORD")
    }

    // Option 2: Read from Docker secrets path
    if apiKey, err := os.ReadFile("/run/secrets/api_key"); err == nil {
        cfg.APIKey = strings.TrimSpace(string(apiKey))
    } else {
        cfg.APIKey = os.Getenv("API_KEY")
    }

    // Option 3: JWT secret from file
    jwtSecret, err := os.ReadFile("/run/secrets/jwt_secret")
    if err != nil {
        return nil, err
    }
    cfg.JWTSecret = jwtSecret

    return cfg, nil
}
```

### Docker Compose Secrets

Docker Compose has built-in support for secrets through the `secrets` top-level key. You define your secret files in the Compose YAML, and Docker mounts them into the container at `/run/secrets/<secret_name>` as read-only files. This keeps sensitive values out of environment variables and out of your Docker image layers, while still being simple to configure.

```yaml
# docker-compose.yml with secrets
version: '3.8'

services:
  api:
    image: myapp:latest
    secrets:
      - db_password
      - api_key
      - jwt_secret
    environment:
      # Reference secret files
      - DB_PASSWORD_FILE=/run/secrets/db_password

secrets:
  db_password:
    file: ./secrets/db_password.txt
  api_key:
    file: ./secrets/api_key.txt
  jwt_secret:
    file: ./secrets/jwt_secret.txt
```

### Integration with HashiCorp Vault

HashiCorp Vault is a production-grade secrets management system that goes far beyond static secret files. Vault can generate temporary database credentials on demand (so no long-lived passwords exist), automatically rotate secrets, and provide a complete audit trail of which service accessed which secret and when. In containerized environments, your Go application authenticates with Vault using Kubernetes service account tokens or environment-injected tokens, then fetches secrets at startup.

```go
package vault

import (
    "context"
    "fmt"
    "os"

    vault "github.com/hashicorp/vault/api"
)

type VaultClient struct {
    client *vault.Client
}

func NewVaultClient() (*VaultClient, error) {
    config := vault.DefaultConfig()
    config.Address = os.Getenv("VAULT_ADDR")

    client, err := vault.NewClient(config)
    if err != nil {
        return nil, fmt.Errorf("failed to create vault client: %w", err)
    }

    // Authenticate with Kubernetes auth method (for K8s deployments)
    // Or use token from environment
    token := os.Getenv("VAULT_TOKEN")
    if token != "" {
        client.SetToken(token)
    } else {
        // Kubernetes auth
        if err := kubernetesAuth(client); err != nil {
            return nil, err
        }
    }

    return &VaultClient{client: client}, nil
}

func kubernetesAuth(client *vault.Client) error {
    // Read service account token
    jwt, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/token")
    if err != nil {
        return fmt.Errorf("failed to read k8s token: %w", err)
    }

    role := os.Getenv("VAULT_ROLE")

    // Authenticate with Vault
    secret, err := client.Logical().Write("auth/kubernetes/login", map[string]any{
        "role": role,
        "jwt":  string(jwt),
    })
    if err != nil {
        return fmt.Errorf("failed to authenticate with vault: %w", err)
    }

    client.SetToken(secret.Auth.ClientToken)
    return nil
}

func (v *VaultClient) GetSecret(ctx context.Context, path string) (map[string]any, error) {
    secret, err := v.client.KVv2("secret").Get(ctx, path)
    if err != nil {
        return nil, fmt.Errorf("failed to get secret: %w", err)
    }
    return secret.Data, nil
}

func (v *VaultClient) GetDatabaseCredentials(ctx context.Context) (username, password string, err error) {
    // Dynamic database credentials
    secret, err := v.client.Logical().Read("database/creds/myapp-role")
    if err != nil {
        return "", "", err
    }

    username = secret.Data["username"].(string)
    password = secret.Data["password"].(string)

    // These credentials are temporary and will expire
    // TTL: secret.LeaseDuration
    return username, password, nil
}
```

---

### Junior → FAANG: Secrets Management Habits That Prevent Incidents

The most common secret-related incident pattern for junior engineers: a `.env` file with real credentials accidentally committed to a repository because `.gitignore` was not configured, or `docker build --build-arg DB_PASSWORD=...` stored in shell history and visible in `docker history`. Both are preventable with simple habits.

The concrete first-job rules: never store a real secret in a file that is tracked by git, even if the repository is private (it may be made public, or the team may grow). Never use `docker build --build-arg` for secrets (they are stored in the image history). Never set secrets as environment variables in a Dockerfile `ENV` instruction (they are baked into the image). The only correct patterns are: runtime environment variables injected by the orchestrator from a secrets store, or secret files mounted at runtime from a secrets manager or Kubernetes secret volume.

For interviews, being able to explain the difference between a secret at build time (do not do this) and a secret at runtime (acceptable with proper injection) is a clear mid-level signal. Being able to name the tools (AWS Secrets Manager, Vault, Kubernetes Secrets with encryption at rest) and explain their trade-offs is strong.

### Senior @ FAANG: Secrets Management Architecture and Secret Sprawl Prevention

At staff level, secrets management is a governance problem. Secret sprawl, where credentials exist in multiple places (environment variables, config files, scripts, CI variables, developer laptops), is the root cause of most secrets-related incidents. The architectural goal is a single source of truth for every secret, with automated rotation and audited access.

The platform-level design has three components. Centralized storage (Vault, AWS Secrets Manager, GCP Secret Manager) with hierarchical namespacing that mirrors the organizational structure (environment, team, service). Automated rotation with application-level handling of credential updates without restart. Audited access logs for every secret read, searchable by time, service identity, and secret path.

The hard engineering problem is the credential rotation handoff. When a database password rotates, there is a window where the old credential is valid, the new credential is valid, and the application needs to detect the rotation and acquire the new credential. Vault's dynamic secrets model solves this by eliminating long-lived credentials entirely: the application requests a credential on startup, uses it for its TTL, and requests a new one before expiry. Implementing this in Go requires a credential renewal goroutine and careful error handling for the case where renewal fails before expiry (graceful degradation versus immediate failure is a product decision that needs to be made explicitly and documented). This is the kind of platform library that a staff engineer designs, documents, and gets adopted across multiple teams rather than leaving each team to implement independently.
