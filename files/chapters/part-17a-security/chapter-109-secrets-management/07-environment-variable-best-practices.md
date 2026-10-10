## 109.7 Environment Variable Best Practices

Environment variables are convenient but require careful handling.

### Secure Environment Variable Loading

Environment variables are the standard mechanism for injecting configuration into twelve-factor applications, but require care to prevent leakage through process listings, error logs, and child process inheritance. The following best practices demonstrate safe environment variable handling in Go services, including validation at startup and safe logging.

```go
// pkg/config/env.go
package config

import (
    "fmt"
    "os"
    "strconv"
    "strings"
)

// Config holds application configuration
type Config struct {
    DatabaseURL    string
    APIKey         string
    RedisURL       string
    Port           int
    Environment    string
}

// LoadFromEnv loads configuration from environment variables
func LoadFromEnv() (*Config, error) {
    cfg := &Config{}

    var missing []string

    // Required secrets
    if cfg.DatabaseURL = os.Getenv("DATABASE_URL"); cfg.DatabaseURL == "" {
        missing = append(missing, "DATABASE_URL")
    }

    if cfg.APIKey = os.Getenv("API_KEY"); cfg.APIKey == "" {
        missing = append(missing, "API_KEY")
    }

    // Optional with defaults
    cfg.RedisURL = getEnvOrDefault("REDIS_URL", "redis://localhost:6379")
    cfg.Environment = getEnvOrDefault("ENVIRONMENT", "development")

    portStr := getEnvOrDefault("PORT", "8080")
    port, err := strconv.Atoi(portStr)
    if err != nil {
        return nil, fmt.Errorf("invalid PORT value: %w", err)
    }
    cfg.Port = port

    if len(missing) > 0 {
        return nil, fmt.Errorf("missing required environment variables: %s", strings.Join(missing, ", "))
    }

    return cfg, nil
}

func getEnvOrDefault(key, defaultValue string) string {
    if value := os.Getenv(key); value != "" {
        return value
    }
    return defaultValue
}

// Redact returns a redacted version of config for logging
func (c *Config) Redact() map[string]string {
    return map[string]string{
        "DatabaseURL": redactURL(c.DatabaseURL),
        "APIKey":      redactSecret(c.APIKey),
        "RedisURL":    redactURL(c.RedisURL),
        "Port":        strconv.Itoa(c.Port),
        "Environment": c.Environment,
    }
}

func redactSecret(secret string) string {
    if len(secret) <= 4 {
        return "****"
    }
    return secret[:4] + "****"
}

func redactURL(urlStr string) string {
    // Redact password from database URLs
    if idx := strings.Index(urlStr, "@"); idx != -1 {
        if colon := strings.LastIndex(urlStr[:idx], ":"); colon != -1 {
            return urlStr[:colon] + ":****" + urlStr[idx:]
        }
    }
    return urlStr
}
```

### Junior → FAANG: Environment Variables as a Transitional Pattern

Environment variables are better than hardcoded secrets but worse than a dedicated secrets manager. Understanding where they are appropriate and where they are not is essential for any production engineering role.

**Gap to close:** Environment variables are readable by any process running as the same user (via `/proc/self/environ`), can appear in crash dumps, can be logged by container orchestration systems, and are shared with all child processes. For secrets that are highly sensitive (private keys, database credentials for a production database with PII), this exposure surface is too large. For less sensitive configuration (feature flags, non-secret API endpoints), environment variables are acceptable.

**First-job habit:** Add a `.gitignore` entry for `.env` files and set up a pre-commit hook that blocks commits containing common secret patterns (using `gitleaks` or `detect-secrets`). This is a 15-minute setup that prevents a career-defining mistake.

**URL scrubbing:** As shown in the code above, always scrub secrets from URLs before logging. URLs appear in access logs, error messages, and distributed traces. A database connection URL with a password in it should never appear in any log.

### Senior @ FAANG: Moving Beyond Environment Variables

At senior level, the goal is to reduce reliance on environment variables for secrets to zero in production, replacing them with a dedicated secrets management system.

**Migration path:** The migration from environment variable secrets to a secrets manager is incremental: (1) Identify all environment variables that contain secrets. (2) For each one, create the corresponding secret in your secrets manager. (3) Update the service to fetch from the secrets manager with a fallback to the environment variable during the transition. (4) After all instances are running the new code, remove the environment variable. (5) Remove the fallback code. This migration can be done one secret at a time without a big-bang change.

**Container environment variable audit:** In containerized deployments, environment variables are visible in `docker inspect`, in Kubernetes pod specifications, and in orchestration logs. Any secret stored in an environment variable in a container can be viewed by anyone with access to the orchestration API. In a Kubernetes environment, this means anyone with `get pod` permission on the namespace. Audit your container configurations for secrets in environment variables and migrate them to the Secrets Store CSI Driver or Vault Agent Injector.

---
