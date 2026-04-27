export default `## 4.8 Complete Application: Type-Safe Configuration System

This example ties together named types, struct tags, embedding, and custom JSON marshaling into a single configuration system. The \`Config\` struct uses typed keys (preventing typos), a custom \`Duration\` type (parsing both strings and numbers from JSON), environment variable overrides, and a \`Validate\` method that enforces business rules at startup. This pattern is common in production Go services where configuration errors should fail fast rather than surface as runtime bugs.

\`\`\`go
// config/types.go
package config

import (
    "encoding/json"
    "fmt"
    "os"
    "strconv"
    "time"
)

// Type-safe configuration keys
type Key string

const (
    KeyServerPort     Key = "SERVER_PORT"
    KeyDatabaseURL    Key = "DATABASE_URL"
    KeyRedisURL       Key = "REDIS_URL"
    KeyLogLevel       Key = "LOG_LEVEL"
    KeyReadTimeout    Key = "READ_TIMEOUT"
    KeyWriteTimeout   Key = "WRITE_TIMEOUT"
    KeyMaxConnections Key = "MAX_CONNECTIONS"
    KeyEnableMetrics  Key = "ENABLE_METRICS"
)

// Duration wraps time.Duration with JSON/env parsing
type Duration time.Duration

func (d Duration) Duration() time.Duration {
    return time.Duration(d)
}

func (d *Duration) UnmarshalJSON(b []byte) error {
    var v any
    if err := json.Unmarshal(b, &v); err != nil {
        return err
    }
    switch value := v.(type) {
    case float64:
        *d = Duration(time.Duration(value))
    case string:
        dur, err := time.ParseDuration(value)
        if err != nil {
            return err
        }
        *d = Duration(dur)
    default:
        return fmt.Errorf("invalid duration: %v", v)
    }
    return nil
}

func (d Duration) MarshalJSON() ([]byte, error) {
    return json.Marshal(time.Duration(d).String())
}

// Config holds all application configuration
type Config struct {
    Server   ServerConfig   \`json:"server"\`
    Database DatabaseConfig \`json:"database"\`
    Redis    RedisConfig    \`json:"redis"\`
    Logging  LoggingConfig  \`json:"logging"\`
    Features FeatureFlags   \`json:"features"\`
}

type ServerConfig struct {
    Port         int      \`json:"port"\`
    Host         string   \`json:"host"\`
    ReadTimeout  Duration \`json:"read_timeout"\`
    WriteTimeout Duration \`json:"write_timeout"\`
    IdleTimeout  Duration \`json:"idle_timeout"\`
}

type DatabaseConfig struct {
    URL             string \`json:"url"\`
    MaxOpenConns    int    \`json:"max_open_conns"\`
    MaxIdleConns    int    \`json:"max_idle_conns"\`
    ConnMaxLifetime Duration \`json:"conn_max_lifetime"\`
}

type RedisConfig struct {
    URL          string   \`json:"url"\`
    MaxRetries   int      \`json:"max_retries"\`
    ReadTimeout  Duration \`json:"read_timeout"\`
    WriteTimeout Duration \`json:"write_timeout"\`
}

type LoggingConfig struct {
    Level  string \`json:"level"\`
    Format string \`json:"format"\` // "json" or "text"
}

type FeatureFlags struct {
    EnableMetrics     bool \`json:"enable_metrics"\`
    EnableTracing     bool \`json:"enable_tracing"\`
    EnableProfiling   bool \`json:"enable_profiling"\`
    EnableRateLimiting bool \`json:"enable_rate_limiting"\`
}

// Default returns a Config with sensible defaults
func Default() *Config {
    return &Config{
        Server: ServerConfig{
            Port:         8080,
            Host:         "0.0.0.0",
            ReadTimeout:  Duration(15 * time.Second),
            WriteTimeout: Duration(15 * time.Second),
            IdleTimeout:  Duration(60 * time.Second),
        },
        Database: DatabaseConfig{
            MaxOpenConns:    25,
            MaxIdleConns:    5,
            ConnMaxLifetime: Duration(5 * time.Minute),
        },
        Redis: RedisConfig{
            MaxRetries:   3,
            ReadTimeout:  Duration(3 * time.Second),
            WriteTimeout: Duration(3 * time.Second),
        },
        Logging: LoggingConfig{
            Level:  "info",
            Format: "json",
        },
        Features: FeatureFlags{
            EnableMetrics:     true,
            EnableTracing:     false,
            EnableProfiling:   false,
            EnableRateLimiting: true,
        },
    }
}

// LoadFromEnv overrides config with environment variables
func (c *Config) LoadFromEnv() error {
    if port := os.Getenv(string(KeyServerPort)); port != "" {
        p, err := strconv.Atoi(port)
        if err != nil {
            return fmt.Errorf("invalid %s: %w", KeyServerPort, err)
        }
        c.Server.Port = p
    }

    if url := os.Getenv(string(KeyDatabaseURL)); url != "" {
        c.Database.URL = url
    }

    if url := os.Getenv(string(KeyRedisURL)); url != "" {
        c.Redis.URL = url
    }

    if level := os.Getenv(string(KeyLogLevel)); level != "" {
        c.Logging.Level = level
    }

    if timeout := os.Getenv(string(KeyReadTimeout)); timeout != "" {
        d, err := time.ParseDuration(timeout)
        if err != nil {
            return fmt.Errorf("invalid %s: %w", KeyReadTimeout, err)
        }
        c.Server.ReadTimeout = Duration(d)
    }

    if timeout := os.Getenv(string(KeyWriteTimeout)); timeout != "" {
        d, err := time.ParseDuration(timeout)
        if err != nil {
            return fmt.Errorf("invalid %s: %w", KeyWriteTimeout, err)
        }
        c.Server.WriteTimeout = Duration(d)
    }

    if maxConns := os.Getenv(string(KeyMaxConnections)); maxConns != "" {
        n, err := strconv.Atoi(maxConns)
        if err != nil {
            return fmt.Errorf("invalid %s: %w", KeyMaxConnections, err)
        }
        c.Database.MaxOpenConns = n
    }

    if enable := os.Getenv(string(KeyEnableMetrics)); enable != "" {
        c.Features.EnableMetrics = enable == "true" || enable == "1"
    }

    return nil
}

// Validate checks that required fields are set
func (c *Config) Validate() error {
    if c.Database.URL == "" {
        return fmt.Errorf("database URL is required")
    }
    if c.Server.Port < 1 || c.Server.Port > 65535 {
        return fmt.Errorf("server port must be between 1 and 65535")
    }
    if c.Database.MaxOpenConns < 1 {
        return fmt.Errorf("max open connections must be at least 1")
    }
    return nil
}
\`\`\`

### Read the Code Like a Reviewer

The configuration system above is a solid starting point. A senior reviewer would flag the following before approving it for production:

1. **The \`Key\` type is a stringly-typed shadow.** The pattern of \`const KeyServerPort Key = "SERVER_PORT"\` gives type safety to the constant identifier but not to the actual env-var string. Typos in the literal (\`"SEVER_PORT"\`) still compile and silently load nothing. The fix is a test that round-trips every key through a known configuration, or a registry that lists every expected key in one place.
2. **The \`LoadFromEnv\` method has repetitive structure.** Every key handler is the same shape: read env var, parse, assign. Extract to a helper or use a library like \`kelseyhightower/envconfig\` that uses struct tags. The repetition here is a lint smell that compounds as more keys are added.
3. **\`Duration\` accepts both float and string in JSON.** This is convenient but ambiguous. A \`15\` in JSON could mean 15 nanoseconds (the float path) or 15 seconds (the \`15s\` string path). Pick one and document it at the type's doc comment.
4. **Validation is minimal.** The rules cover only the most obvious invalid states. Real validation would check URL well-formedness, time-out sanity (not zero, not unreasonably large), feature-flag dependencies, and relationships between fields (if the Redis URL is empty, disable caching rather than failing later).
5. **Configuration is mutable after load.** The \`Config\` struct exposes public fields, so any code with a \`*Config\` can mutate it. For production services, consider hiding the fields behind accessor methods or returning a deep-copied immutable view to callers.
6. **No config-source priority.** The method reads from env vars but not from files, secrets stores, or remote config services. For real services the order matters (file defaults override env, env overrides flags, secrets override all of them in specific scopes). Make the order explicit.
7. **Sensitive values in config logs.** At startup, services typically log the resolved configuration for incident debugging. A \`Config\` struct that includes \`DATABASE_URL\` (which contains credentials) will log them. Add a \`String()\` method that redacts sensitive fields, and use it for the startup dump.

### How to Extend This (Exercises for the Reader)

For the mid-level track, try these additions one at a time, each taking 30 to 60 minutes:

1. **Add a \`LoadFromFile(path string)\` method** that reads YAML or JSON and layers over defaults. Decide the merge semantics (deep merge or replace) and document them.
2. **Add a \`Redact() string\` method** that returns a log-safe representation of the config with credentials stripped. Wire it into the startup log.
3. **Replace the manual env-var reading with \`envconfig\` struct tags.** Compare the diff. Notice how much code the library replaces.
4. **Add a watch-for-changes mode** that reloads the config when the underlying file changes. Use \`fsnotify\`. Think about how to safely swap the config while handlers are running (hint: atomic pointer swap).

For the senior track, the higher-leverage exercises are:

5. **Document the team's config discipline in a 500-word note.** Which fields are required, which are optional, which have defaults, which are secrets, which are feature flags. The note is the artifact. The config code just implements it.
6. **Wire validation into the type system itself.** Instead of a \`Validate()\` method that runs at startup, make invalid states unrepresentable. For example, \`Duration\` could be a type with a constructor that returns an error for negative values, so the struct cannot hold a negative duration.
7. **Measure the config surface.** Count the number of env vars, the number of feature flags, and the rate of change over the last year. A service with 150 env vars and 50 feature flags has a config complexity problem that deserves its own discussion.

---
`;
