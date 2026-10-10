## 26.1 The 12-Factor App Configuration

### Principles

1. **Store config in environment variables**
2. **Strict separation of config from code**
3. **Never store credentials in code**
4. **Config varies between deploys. Code doesn't**

### Basic Environment Configuration

The twelve-factor app's configuration principle mandates that all values which vary between deployment environments, ports, connection strings, log levels, come exclusively from environment variables rather than config files checked into version control. A thin `Load` function that reads environment variables with typed helpers and sensible defaults is all that most services need. It is stateless, easy to test, and works identically in Docker, Kubernetes, and bare-metal deployments.

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
    RedisURL        string
    LogLevel        string
    Environment     string
    SecretKey       string
    ShutdownTimeout time.Duration
}

func Load() (*Config, error) {
    return &Config{
        Port:            getEnvAsInt("PORT", 8080),
        DatabaseURL:     getEnvOrDefault("DATABASE_URL", "postgres://localhost/myapp"),
        RedisURL:        getEnvOrDefault("REDIS_URL", "redis://localhost:6379"),
        LogLevel:        getEnvOrDefault("LOG_LEVEL", "info"),
        Environment:     getEnvOrDefault("ENVIRONMENT", "development"),
        ShutdownTimeout: getEnvAsDuration("SHUTDOWN_TIMEOUT", 30*time.Second),
    }, nil
}

func getEnvOrDefault(key, defaultValue string) string {
    if value := os.Getenv(key); value != "" {
        return value
    }
    return defaultValue
}

func getEnvAsInt(key string, defaultValue int) int {
    if value := os.Getenv(key); value != "" {
        if intValue, err := strconv.Atoi(value); err == nil {
            return intValue
        }
    }
    return defaultValue
}

func getEnvAsBool(key string, defaultValue bool) bool {
    if value := os.Getenv(key); value != "" {
        if boolValue, err := strconv.ParseBool(value); err == nil {
            return boolValue
        }
    }
    return defaultValue
}

func getEnvAsDuration(key string, defaultValue time.Duration) time.Duration {
    if value := os.Getenv(key); value != "" {
        if duration, err := time.ParseDuration(value); err == nil {
            return duration
        }
    }
    return defaultValue
}
```

> **Read those helpers again before you copy them.** Every one of them swallows the parse error. Set `PORT=8O8O` with letter O instead of zero and `strconv.Atoi` fails, the error is discarded, and the service silently binds to 8080. Set `SHUTDOWN_TIMEOUT=30` (no unit) and `time.ParseDuration` fails, so you silently get the 30 second default rather than the value you thought you set. The failure mode is that a typo in a deployment manifest produces a running service with wrong config and no log line. This is the single most common configuration bug in real systems, and it is why the validation section later in this chapter insists on distinguishing "unset" from "set to garbage":
>
> ```go
> func getEnvAsInt(key string, defaultValue int) (int, error) {
>     value, ok := os.LookupEnv(key)
>     if !ok || value == "" {
>         return defaultValue, nil // unset is fine, use the default
>     }
>     n, err := strconv.Atoi(value)
>     if err != nil {
>         return 0, fmt.Errorf("%s: %q is not an integer: %w", key, value, err)
>     }
>     return n, nil
> }
> ```
>
> Note `os.LookupEnv` rather than `os.Getenv`. `Getenv` cannot tell you whether a variable is unset or set to the empty string, and those deserve different treatment: unset means "use the default", explicitly empty usually means someone's templating broke.

### Required Environment Variables

Failing fast on missing required configuration, at startup rather than at the first use of a nil value, makes deployment errors immediately visible. Collecting all missing keys into a single error message surfaces every problem in one shot rather than requiring repeated restart cycles to discover each missing variable individually.

```go
package config

import (
    "errors"
    "fmt"
    "os"
)

var ErrMissingConfig = errors.New("missing required configuration")

func LoadStrict() (*Config, error) {
    var missing []string

    databaseURL := os.Getenv("DATABASE_URL")
    if databaseURL == "" {
        missing = append(missing, "DATABASE_URL")
    }

    secretKey := os.Getenv("SECRET_KEY")
    if secretKey == "" {
        missing = append(missing, "SECRET_KEY")
    }

    if len(missing) > 0 {
        return nil, fmt.Errorf("%w: %v", ErrMissingConfig, missing)
    }

    return &Config{
        DatabaseURL: databaseURL,
        SecretKey:   secretKey,
        // ... other fields
    }, nil
}
```

### Staff Lens: Config Is Environment-Specific, Code Is Not

12-factor separates config from code. Same binary in dev, staging, and production. Only config differs. Enforce in review: if config is in code, reject.

---
