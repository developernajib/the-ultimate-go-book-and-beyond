## 97.6 Configuration Management

### Environment Variables

Environment variables are the standard way to pass configuration into Docker containers. Instead of hardcoding values like database URLs, ports, or log levels into your code, you read them from the environment at startup. This lets you use the exact same Docker image across development, staging, and production by simply changing the environment variables. The following Go code shows a clean pattern for loading configuration with sensible defaults when an environment variable is not set.

```go
package config

import (
    "os"
    "strconv"
    "time"
)

type Config struct {
    Port            int
    DatabaseURL     string
    LogLevel        string
    ReadTimeout     time.Duration
    WriteTimeout    time.Duration
}

func Load() *Config {
    return &Config{
        Port:         getEnvInt("PORT", 8080),
        DatabaseURL:  getEnv("DATABASE_URL", "postgres://localhost/mydb"),
        LogLevel:     getEnv("LOG_LEVEL", "info"),
        ReadTimeout:  getEnvDuration("READ_TIMEOUT", 5*time.Second),
        WriteTimeout: getEnvDuration("WRITE_TIMEOUT", 10*time.Second),
    }
}

func getEnv(key, defaultVal string) string {
    if val := os.Getenv(key); val != "" {
        return val
    }
    return defaultVal
}

func getEnvInt(key string, defaultVal int) int {
    if val := os.Getenv(key); val != "" {
        if i, err := strconv.Atoi(val); err == nil {
            return i
        }
    }
    return defaultVal
}

func getEnvDuration(key string, defaultVal time.Duration) time.Duration {
    if val := os.Getenv(key); val != "" {
        if d, err := time.ParseDuration(val); err == nil {
            return d
        }
    }
    return defaultVal
}
```

### Docker Compose for Development

Docker Compose is a tool that lets you define and run multi-container applications using a single YAML file. Instead of manually starting a database, a cache, and your Go service one at a time, you describe all of them in `docker-compose.yml` and bring everything up with `docker compose up`. Compose also handles networking between services automatically, so your Go application can reach the database simply by using the service name (like `db`) as the hostname.

```yaml
# docker-compose.yml
version: '3.8'

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=postgres://user:pass@db:5432/mydb
      - LOG_LEVEL=debug
      - PORT=8080
    depends_on:
      db:
        condition: service_healthy

  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
      POSTGRES_DB: mydb
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U user -d mydb"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:

### Junior → FAANG: Configuration Management Fundamentals in Containerized Go

The rule that needs to be internalized early: never bake secrets into an image. An image is an artifact that is stored in a registry, potentially for years, and its layers can be inspected by anyone with pull access. Using `ARG` to pass a secret at build time is equally bad: build arguments are stored in the image history (`docker history --no-trunc`). The correct patterns are runtime environment variables for non-sensitive config, and a secrets manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault) or Kubernetes secrets mounted as files for sensitive values.

The practical first-job habit is to configure your Go application to read configuration from environment variables using a library like `viper` or a simple `os.Getenv` wrapper with defaults. This makes the application container-native: the same binary runs with different configurations in different environments without rebuilding.

Interview entry point: be able to explain the difference between an environment variable and a secret, and why a database password should never be in an environment variable in production (it appears in process listings, crash dumps, and container inspect output). Knowing that Kubernetes secrets are base64-encoded (not encrypted) by default, and that proper encryption-at-rest requires additional configuration, is a reliable mid-level differentiator.

### Senior @ FAANG: Configuration Architecture Across Environments

At senior level, configuration management is a problem of consistency, auditability, and least-privilege access at scale. The question is not "how does one service read its config" but "how do 300 services with different config profiles get the right values in the right environments without manual intervention and without secrets sprawl."

The architectural pattern that scales is a centralized secrets store with per-service identities. Each service has an IAM role or Kubernetes service account with a policy that grants access only to the specific secrets it needs. The provisioning of those identities and policies is owned by the platform team and expressed as IaC (Terraform, Pulumi). Service teams request access by declaring their needs in a service manifest, not by directly modifying IAM policies.

Dynamic secrets are the L6/L7 pattern for high-security environments. Instead of storing a long-lived database password, Vault (or a cloud-native equivalent) generates short-lived credentials for each service instance on startup. The credentials expire and are automatically renewed. This eliminates entire classes of secret-rotation problems and limits the blast radius of a compromised credential to the lifetime of that instance. Implementing dynamic secrets requires integration with the application startup sequence and robust handling of credential expiry during runtime, which is a non-trivial engineering problem that benefits from a platform-level library rather than each team solving it independently.
```

---
