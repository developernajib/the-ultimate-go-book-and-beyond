## 17.5 Configuration Management

### Environment-Based Configuration

Reading configuration from environment variables is the twelve-factor app approach: settings differ between environments while the binary stays the same. The helper functions below parse each variable into its target type and fall back to a sensible default when the variable is absent, so the application starts cleanly in development without any extra setup.

Two decisions in these helpers are worth stating outright, because the obvious version of each is subtly wrong.

**Use `os.LookupEnv`, not `os.Getenv(k) != ""`.** `Getenv` cannot tell "unset" from "set to the empty string", so an operator who deliberately exports `DB_SSL_MODE=` to clear a default silently gets the default back instead.

**A malformed value is an error, not a reason to use the default.** If `PORT` is set to `8O80` (a capital letter O, a real typo people make), a helper that swallows the parse error hands back 8080 and the service binds the wrong port with no complaint anywhere. The operator set the variable, which is proof they meant something by it. Failing to parse it is a startup error. This is the same fail-fast argument the validation section below makes, and it has to apply to parsing too, otherwise `Validate` never sees the bad value in the first place.

```go
// internal/config/config.go
package config

import (
    "errors"
    "fmt"
    "os"
    "strconv"
    "time"
)

type Config struct {
    Environment string
    Server      ServerConfig
    Database    DatabaseConfig
}

type ServerConfig struct {
    Port         int
    ReadTimeout  time.Duration
    WriteTimeout time.Duration
}

type DatabaseConfig struct {
    Host     string
    Port     int
    User     string
    Password string
    DBName   string
    SSLMode  string
}

func Load() (*Config, error) {
    // errs collects every problem so one restart surfaces all of them,
    // rather than making the operator fix one variable per deploy.
    var errs []error
    fail := func(err error) {
        if err != nil {
            errs = append(errs, err)
        }
    }

    cfg := &Config{Environment: getEnv("ENV", "development")}

    port, err := getEnvInt("PORT", 8080)
    fail(err)
    readTimeout, err := getEnvDuration("READ_TIMEOUT", 30*time.Second)
    fail(err)
    writeTimeout, err := getEnvDuration("WRITE_TIMEOUT", 30*time.Second)
    fail(err)
    dbPort, err := getEnvInt("DB_PORT", 5432)
    fail(err)

    cfg.Server = ServerConfig{
        Port:         port,
        ReadTimeout:  readTimeout,
        WriteTimeout: writeTimeout,
    }
    cfg.Database = DatabaseConfig{
        Host:     getEnv("DB_HOST", "localhost"),
        Port:     dbPort,
        User:     getEnv("DB_USER", "postgres"),
        Password: getEnv("DB_PASSWORD", ""),
        DBName:   getEnv("DB_NAME", "myapp"),
        SSLMode:  getEnv("DB_SSL_MODE", "disable"),
    }

    if len(errs) > 0 {
        return nil, errors.Join(errs...)
    }
    if err := cfg.Validate(); err != nil {
        return nil, err
    }
    return cfg, nil
}

func getEnv(key, defaultVal string) string {
    // LookupEnv, not Getenv: an explicitly empty value is a real choice.
    if val, ok := os.LookupEnv(key); ok {
        return val
    }
    return defaultVal
}

func getEnvInt(key string, defaultVal int) (int, error) {
    val, ok := os.LookupEnv(key)
    if !ok || val == "" {
        return defaultVal, nil
    }
    i, err := strconv.Atoi(val)
    if err != nil {
        return 0, fmt.Errorf("%s: %q is not an integer", key, val)
    }
    return i, nil
}

func getEnvDuration(key string, defaultVal time.Duration) (time.Duration, error) {
    val, ok := os.LookupEnv(key)
    if !ok || val == "" {
        return defaultVal, nil
    }
    d, err := time.ParseDuration(val)
    if err != nil {
        // A bare "30" lands here. Duration needs a unit: "30s".
        return 0, fmt.Errorf("%s: %q is not a duration (want e.g. \"30s\")", key, val)
    }
    return d, nil
}
```

`errors.Join` matters more than it looks. A loader that returns on the first bad variable forces a fix-deploy-discover-the-next-one loop. Collecting them means one restart tells the operator everything that is wrong.

Note the `"30"` case specifically. `time.ParseDuration` requires a unit, so a bare number is invalid, and the original swallow-the-error version turned that into the 30-second default purely by coincidence. Someone who wrote `READ_TIMEOUT=30` meaning 30 seconds would have been right by accident, and someone who wrote `READ_TIMEOUT=5` meaning 5 seconds would silently get 30. That is the kind of bug that survives for years.

### Using Viper for Complex Configuration

When a project needs to merge settings from YAML files, environment variables, and command-line flags, Viper handles the precedence rules automatically. Calling `AutomaticEnv` with a key replacer lets an environment variable like `DATABASE_HOST` override the nested YAML key `database.host`, keeping the configuration layer unified without hand-writing every mapping.

```go
import (
    "errors"
    "strings"

    "github.com/spf13/viper"
)

func LoadWithViper() (*Config, error) {
    viper.SetConfigName("config")
    viper.SetConfigType("yaml")
    viper.AddConfigPath("./configs")
    viper.AddConfigPath("/etc/myapp")

    viper.AutomaticEnv()
    viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))

    if err := viper.ReadInConfig(); err != nil {
        // A missing file is fine, env vars alone may be enough.
        // Anything else (malformed YAML, unreadable file) is fatal.
        var notFound viper.ConfigFileNotFoundError
        if !errors.As(err, &notFound) {
            return nil, err
        }
    }

    var cfg Config
    if err := viper.Unmarshal(&cfg); err != nil {
        return nil, err
    }
    if err := cfg.Validate(); err != nil {
        return nil, err
    }

    return &cfg, nil
}
```

Prefer `errors.As` to a bare type assertion here. They behave the same today, but `errors.As` keeps working if the error ever arrives wrapped, and it costs nothing to write.

One caveat worth knowing before you reach for Viper: `AutomaticEnv` only consults the environment for keys Viper already knows about, meaning keys present in the config file or registered via `SetDefault` or `BindEnv`. A key that exists only in your `Config` struct, with no default and no file entry, will not be populated from the environment as you might expect. Set defaults for everything you intend to be environment-overridable.

### Validate Configuration at Startup

A service that starts with invalid configuration often runs successfully for a while, then fails mysteriously when it first tries to use the bad setting. Validate at startup, against the actual struct shape:

```go
func (c *Config) Validate() error {
    var errs []error

    if c.Server.Port < 1 || c.Server.Port > 65535 {
        errs = append(errs, fmt.Errorf("server port %d out of range 1-65535", c.Server.Port))
    }
    if c.Database.Host == "" {
        errs = append(errs, errors.New("DB_HOST required"))
    }
    if c.Database.DBName == "" {
        errs = append(errs, errors.New("DB_NAME required"))
    }
    // Production must never fall back to a passwordless, unencrypted database.
    if c.Environment == "production" {
        if c.Database.Password == "" {
            errs = append(errs, errors.New("DB_PASSWORD required in production"))
        }
        if c.Database.SSLMode == "disable" {
            errs = append(errs, errors.New("DB_SSL_MODE must not be 'disable' in production"))
        }
    }

    return errors.Join(errs...)
}
```

`errors.Join` returns nil when the slice is empty, so there is no special case for the happy path.

That production block is the point of the whole section. The development defaults in `Load` are conveniences (`localhost`, no password, TLS off) and every one of them is a security incident if it survives to production. Validation is where a convenient default gets converted back into a hard requirement once the environment says it matters. Fail fast here, and an operator sees the error on deploy. Skip it, and the service happily connects to production over an unencrypted link.

### Staff Lens: Config Structure Matches Service Boundaries

Organize config by subsystem (database, HTTP server, external clients), not by environment. Environments are handled by layering config sources (defaults, file, env vars). The struct shape is the same across dev, staging, and prod. Only the values differ.

### Never Commit Secrets

Secrets belong in environment variables or a secret manager (Vault, AWS Secrets Manager, Google Secret Manager), never in the config file checked into source control. The config file contains placeholders and non-secret defaults. The secrets are injected at runtime. This is table-stakes discipline every Go service should follow.

---
