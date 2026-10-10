## 26.2 Configuration Libraries

### Using Viper

Viper merges configuration from multiple sources, defaults, YAML files, environment variables, and flags, into a single typed struct. The `SetEnvKeyReplacer` call maps the dot-separated config key `server.port` to the environment variable `MYAPP_SERVER_PORT`, so the same struct covers both file-based development configuration and environment-variable-based production deployment without code duplication.

```go
package config

import (
    "fmt"
    "strings"
    "time"

    "github.com/spf13/viper"
)

type Config struct {
    Server   ServerConfig   `mapstructure:"server"`
    Database DatabaseConfig `mapstructure:"database"`
    Redis    RedisConfig    `mapstructure:"redis"`
    Features FeaturesConfig `mapstructure:"features"`
}

type ServerConfig struct {
    Port         int           `mapstructure:"port"`
    ReadTimeout  time.Duration `mapstructure:"read_timeout"`
    WriteTimeout time.Duration `mapstructure:"write_timeout"`
}

type DatabaseConfig struct {
    Host         string `mapstructure:"host"`
    Port         int    `mapstructure:"port"`
    User         string `mapstructure:"user"`
    Password     string `mapstructure:"password"`
    Name         string `mapstructure:"name"`
    SSLMode      string `mapstructure:"ssl_mode"`
    MaxOpenConns int    `mapstructure:"max_open_conns"`
}

type RedisConfig struct {
    URL      string `mapstructure:"url"`
    Password string `mapstructure:"password"`
}

type FeaturesConfig struct {
    NewUI      bool `mapstructure:"new_ui"`
    BetaAPI    bool `mapstructure:"beta_api"`
    Experiment bool `mapstructure:"experiment"`
}

func LoadWithViper() (*Config, error) {
    v := viper.New()

    // Set defaults
    v.SetDefault("server.port", 8080)
    v.SetDefault("server.read_timeout", "30s")
    v.SetDefault("server.write_timeout", "30s")
    v.SetDefault("database.ssl_mode", "disable")
    v.SetDefault("database.max_open_conns", 25)

    // Config file
    v.SetConfigName("config")
    v.SetConfigType("yaml")
    v.AddConfigPath(".")
    v.AddConfigPath("/etc/myapp/")

    // Environment variables
    v.SetEnvPrefix("MYAPP")
    v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
    v.AutomaticEnv()

    // Read config file
    if err := v.ReadInConfig(); err != nil {
        if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
            return nil, fmt.Errorf("read config: %w", err)
        }
        // Config file not found - use defaults and env
    }

    var config Config
    if err := v.Unmarshal(&config); err != nil {
        return nil, fmt.Errorf("unmarshal config: %w", err)
    }

    return &config, nil
}
```

### Config File (config.yaml)

The YAML configuration file serves as the canonical source of defaults and structure. Note what is *not* here: `database.password` has no entry at all. Secrets are supplied only through the environment, and the struct field is filled by `AutomaticEnv` from `MYAPP_DATABASE_PASSWORD`.

```yaml
server:
  port: 8080
  read_timeout: 30s
  write_timeout: 30s

database:
  host: localhost
  port: 5432
  user: postgres
  # No password key. Supply it as MYAPP_DATABASE_PASSWORD in the environment.
  # Do NOT write `password: ${DATABASE_PASSWORD}` here: see the warning below.
  name: myapp
  ssl_mode: disable
  max_open_conns: 25

redis:
  url: redis://localhost:6379

features:
  new_ui: false
  beta_api: false
  experiment: false
```

> **Viper does not expand `${VAR}` in config files.** This is worth stating flatly because the pattern is copied constantly from other ecosystems (Docker Compose, Kubernetes manifests, Spring) where it does work. Viper has no interpolation step. Write `password: ${DATABASE_PASSWORD}` in a YAML file and, unless a *prefixed* variable happens to override the key, `cfg.Database.Password` is the literal 21-character string `${DATABASE_PASSWORD}`. Your service then tries to authenticate to PostgreSQL with that string and fails at startup, which is the good outcome. The bad outcome is the same placeholder reaching a system that accepts it.
>
> The mechanism that actually works is `AutomaticEnv` plus `SetEnvPrefix`, and it works on *keys*, not on file contents. The key `database.password` is mapped through the replacer to `MYAPP_DATABASE_PASSWORD`, so you export that name and omit the key from the file entirely. Note the prefix: exporting `DATABASE_PASSWORD` alone does nothing here.
>
> One sharp edge that follows: `AutomaticEnv` only resolves keys Viper already knows about from a file, a default, or a bound flag. A key that exists *only* in the environment is invisible to `Unmarshal`. If you omit `database.password` from the file, also add `v.SetDefault("database.password", "")` or call `v.BindEnv("database.password")` so Viper knows the key exists and will look it up.

### Using envconfig

`envconfig` uses struct tags to declare the environment variable name, default value, and whether the field is required. It is a leaner alternative to Viper for projects that only need environment variable configuration without file loading. The `required:"true"` tag causes `Process` to return an error if the variable is absent, enforcing the fail-fast pattern declaratively.

```go
package config

import (
    "time"

    "github.com/kelseyhightower/envconfig"
)

type Config struct {
    Port         int           `envconfig:"PORT" default:"8080"`
    DatabaseURL  string        `envconfig:"DATABASE_URL" required:"true"`
    RedisURL     string        `envconfig:"REDIS_URL" default:"redis://localhost:6379"`
    LogLevel     string        `envconfig:"LOG_LEVEL" default:"info"`
    Debug        bool          `envconfig:"DEBUG" default:"false"`
    Timeout      time.Duration `envconfig:"TIMEOUT" default:"30s"`
    AllowedHosts []string      `envconfig:"ALLOWED_HOSTS" default:"localhost"`
}

func LoadWithEnvconfig() (*Config, error) {
    var config Config
    if err := envconfig.Process("myapp", &config); err != nil {
        return nil, err
    }
    return &config, nil
}

// Usage:
// MYAPP_PORT=3000 MYAPP_DATABASE_URL=postgres://... ./myapp
```

### Using Koanf (Recommended for New Projects in 2026)

Viper is the incumbent, but many Go teams have moved to `koanf` (knadh/koanf) for new services. Koanf has a cleaner modular API (separate Providers and Parsers), does not force lowercase all config keys (Viper breaks YAML/JSON specs by doing this), produces binaries roughly 3x smaller, and pulls in a fraction of Viper's transitive dependencies. Pick Viper only when you need its `WatchConfig` ergonomics or when working inside a codebase that already depends on it.

```go
package config

import (
    "fmt"
    "strings"

    "github.com/knadh/koanf/v2"
    "github.com/knadh/koanf/parsers/yaml"
    "github.com/knadh/koanf/providers/env"
    "github.com/knadh/koanf/providers/file"
)

func LoadWithKoanf(path string) (*Config, error) {
    k := koanf.New(".")

    // 1. Load YAML file (optional).
    if err := k.Load(file.Provider(path), yaml.Parser()); err != nil {
        // Missing file is OK in container deployments.
    }

    // 2. Overlay environment variables: MYAPP_SERVER_PORT overrides server.port.
    err := k.Load(env.Provider("MYAPP_", ".", func(s string) string {
        return strings.ReplaceAll(strings.ToLower(
            strings.TrimPrefix(s, "MYAPP_")), "_", ".")
    }), nil)
    if err != nil {
        return nil, fmt.Errorf("load env: %w", err)
    }

    var cfg Config
    if err := k.Unmarshal("", &cfg); err != nil {
        return nil, fmt.Errorf("unmarshal: %w", err)
    }
    return &cfg, nil
}
```

### Choosing a Library

| Library | Best For | Avoid When |
|---------|----------|------------|
| `envconfig` | Pure twelve-factor services, K8s deployments, smallest surface area | You need file + env merging |
| `koanf` | New projects, complex multi-source config, want small binaries | Legacy codebase already uses Viper |
| `viper` | Projects that already depend on it, need `WatchConfig` out of the box | New greenfield services (prefer koanf) |

> **Senior track**: Configuration libraries are a dependency risk. Viper pulls in AWS SDK, HCL, etcd, Consul, and more transitively. Audit `go mod graph` before adopting any config library, a 40 MB binary bloat from config is not hypothetical, it is common.

### Staff Lens: One Config Library Per Org

Standardize. Engineers learn one library. Services look similar. Supply chain risk managed at one place.

---
