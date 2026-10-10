## Feature Flag Pitfalls: When Configuration Goes Wrong

This section covers the most dangerous feature flag and configuration mistakes that cause outages and security incidents.

### The Stale Flag Accumulation

**The Problem**: Feature flags never get cleaned up. After 2 years, there are 500 flags, nobody knows what they do, and some are load-bearing.

```go
// WRONG: Flags added but never removed

func processPayment(ctx context.Context, payment Payment) error {
    // Added 2019, migration complete
    if featureFlags.Get("use_new_payment_processor") {
        // ... new path
    }

    // Added 2020, who knows what this does
    if featureFlags.Get("enable_payment_retries_v2") {
        // ...
    }

    // Added 2021, owner left company
    if featureFlags.Get("experimental_fraud_check") {
        // ...
    }

    // Added 2022, temporary workaround?
    if featureFlags.Get("skip_payment_validation_hotfix") {
        // 🚨 Security vulnerability if this is still enabled!
    }
}
```

```go
// CORRECT: Feature flags with metadata and lifecycle

type FeatureFlag struct {
    Name        string
    Description string
    Owner       string    // Who to contact
    Team        string    // Owning team
    CreatedAt   time.Time
    ExpiresAt   time.Time // When should this be removed?
    Ticket      string    // Cleanup ticket
    IsTemporary bool      // Permanent feature or temporary flag?

    Enabled bool // Current state
}

// IsEnabled reports the flag's current state.
func (f *FeatureFlag) IsEnabled() bool {
    return f.Enabled
}

type FlagRegistry struct {
    flags map[string]*FeatureFlag
    mu    sync.RWMutex
}

func (r *FlagRegistry) Get(name string) bool {
    r.mu.RLock()
    flag, exists := r.flags[name]
    r.mu.RUnlock()

    if !exists {
        return false
    }

    // Alert if flag is past expiration
    if !flag.ExpiresAt.IsZero() && time.Now().After(flag.ExpiresAt) {
        metrics.FlagExpired.WithLabelValues(name).Inc()
        log.Warn("Feature flag past expiration",
            "flag", name,
            "expires", flag.ExpiresAt,
            "ticket", flag.Ticket,
        )
    }

    return flag.IsEnabled()
}

// Periodic cleanup report
func (r *FlagRegistry) CleanupReport() []FeatureFlag {
    r.mu.RLock()
    defer r.mu.RUnlock()

    var stale []FeatureFlag
    for _, flag := range r.flags {
        if flag.IsTemporary && time.Since(flag.CreatedAt) > 90*24*time.Hour {
            stale = append(stale, *flag)
        }
    }
    return stale
}
```

### The Environment Variable Chaos

**The Problem**: Environment variables silently default to unsafe values when not set.

```go
// WRONG: Silent defaults

func loadConfig() Config {
    return Config{
        DatabaseURL: os.Getenv("DATABASE_URL"),  // Empty string if not set!
        Debug:       os.Getenv("DEBUG") == "true",  // Defaults to false
        MaxConns:    atoi(os.Getenv("MAX_CONNS")),  // 0 if not set!
    }
}

func atoi(s string) int {
    n, _ := strconv.Atoi(s)  // 🚨 Returns 0 on error, silently
    return n
}

// Result: App starts with empty database URL, 0 connections
// Fails in mysterious ways later
```

```go
// CORRECT: Explicit validation and required fields

type Config struct {
    DatabaseURL string `env:"DATABASE_URL" required:"true"`
    Debug       bool   `env:"DEBUG" default:"false"`
    MaxConns    int    `env:"MAX_CONNS" default:"10" validate:"min=1,max=100"`
}

func LoadConfig() (*Config, error) {
    cfg := &Config{}

    // Required fields
    dbURL := os.Getenv("DATABASE_URL")
    if dbURL == "" {
        return nil, fmt.Errorf("DATABASE_URL is required but not set")
    }
    cfg.DatabaseURL = dbURL

    // Optional with defaults
    cfg.Debug = os.Getenv("DEBUG") == "true"

    // Numeric with validation
    maxConns := os.Getenv("MAX_CONNS")
    if maxConns == "" {
        cfg.MaxConns = 10  // Explicit default
    } else {
        n, err := strconv.Atoi(maxConns)
        if err != nil {
            return nil, fmt.Errorf("MAX_CONNS must be a number: %w", err)
        }
        if n < 1 || n > 100 {
            return nil, fmt.Errorf("MAX_CONNS must be between 1 and 100, got %d", n)
        }
        cfg.MaxConns = n
    }

    return cfg, nil
}

// Startup fails fast with clear error
// func main() {
//     cfg, err := LoadConfig()
//     if err != nil {
//         log.Fatalf("Configuration error: %v", err)
//     }
// }
```

### The Secret in Environment Variable

**The Incident**: Secrets logged when printing environment variables. API keys exposed in error messages.

```go
// WRONG: Secrets treated as regular config

type Config struct {
    APIKey      string
    DatabaseURL string  // Contains password!
}

func (c Config) String() string {
    return fmt.Sprintf("APIKey=%s, DatabaseURL=%s", c.APIKey, c.DatabaseURL)
    // 🚨 Logs the password!
}

func main() {
    cfg := loadConfig()
    log.Printf("Starting with config: %+v", cfg)
    // Output: Starting with config: {APIKey:sk_live_xxx DatabaseURL:postgres://user:password123@host/db}
}
```

```go
// CORRECT: Secret-aware configuration

type Secret string

func (s Secret) String() string {
    if len(s) == 0 {
        return "[NOT SET]"
    }
    return "[REDACTED]"
}

func (s Secret) MarshalJSON() ([]byte, error) {
    return []byte(`"[REDACTED]"`), nil
}

func (s Secret) Value() string {
    return string(s)
}

type Config struct {
    APIKey      Secret
    DatabaseURL Secret
    Debug       bool
}

func (c Config) String() string {
    return fmt.Sprintf("APIKey=%s, DatabaseURL=%s, Debug=%v",
        c.APIKey, c.DatabaseURL, c.Debug)
    // Output: APIKey=[REDACTED], DatabaseURL=[REDACTED], Debug=false
}

// When you need the actual value:
func (s *Service) Connect() error {
    return db.Connect(s.config.DatabaseURL.Value())
}
```

### The Percentage Rollout Bug

**The Problem**: Percentage rollout is not consistent, so the same user gets different experiences on each request.

```go
// WRONG: Random rollout per request

func isFeatureEnabled(userID string) bool {
    // 🚨 Different result each time for same user!
    return rand.Float64() < 0.10  // 10% rollout
}

// User experience:
// Request 1: Feature ON
// Request 2: Feature OFF
// Request 3: Feature ON
// Confusing and breaks stateful features
```

```go
// CORRECT: Consistent rollout using hashing

func isFeatureEnabled(featureName, userID string) bool {
    // Hash feature + user for consistent assignment. The ":" delimiter is
    // required, not cosmetic: writing the two fields back to back makes the
    // boundary between them ambiguous, so ("new", "checkout1") and
    // ("newcheckout", "1") hash identical bytes and share a bucket.
    h := fnv.New32a()
    h.Write([]byte(featureName))
    h.Write([]byte{':'})
    h.Write([]byte(userID))
    hash := h.Sum32()

    // 10000 buckets, expressed as a percentage with two decimals (0-99.99).
    // This is what lets you run a 0.5% rollout: 100 integer buckets cannot.
    percentage := float64(hash%10000) / 100.0

    return percentage < getFeaturePercentage(featureName)
}

// Same user ALWAYS gets same result for same feature
// Different features get independent assignment (that is what mixing
//   featureName into the hash buys you: without it, one unlucky cohort
//   would be enrolled in every rollout you ever run)
// Can adjust percentage without changing existing user assignments
```

### Quick Reference: Configuration Pitfalls

| Pitfall | Impact | Fix |
|---------|--------|-----|
| Stale flags | Unknown code paths, tech debt | Expiration dates, cleanup reports |
| Silent defaults | Silent failures, wrong behavior | Required validation, explicit defaults |
| Secrets in logs | Credential exposure | Secret type with redacted String() |
| Random rollout | Inconsistent UX | Hash-based assignment |
| No validation | Invalid config at runtime | Validate all config at startup |
| No audit trail | Unknown changes | Log all config changes |

### Staff Lens: Configuration Is Production Change

A config change is a production change. Treat it that way: review, audit, test, monitor. Many incidents trace to "just a config change" that turned out to be impactful.

---
