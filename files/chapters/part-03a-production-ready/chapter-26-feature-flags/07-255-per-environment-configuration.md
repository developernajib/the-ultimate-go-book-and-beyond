## 26.5 Per-Environment Configuration

### Environment-Specific Files

Layered configuration merging allows a base `config.yaml` to define defaults while environment-specific files override only the values that differ per environment. `config.local.yaml` gives individual developers a git-ignored escape hatch for local overrides without polluting shared configuration, following the override hierarchy: base → environment → local.

The merge step is where this pattern usually goes wrong, so the implementation below leans on a property of the YAML decoder rather than on hand-written merge code. Read the warning after it before writing your own.

```go
package config

import (
    "errors"
    "fmt"
    "os"
    "path/filepath"

    "gopkg.in/yaml.v3"
)

func LoadForEnvironment(basePath string) (*Config, error) {
    env := os.Getenv("ENVIRONMENT")
    if env == "" {
        env = "development"
    }

    var cfg Config

    // Layer 1: base config. This one is required.
    if err := overlayFile(&cfg, filepath.Join(basePath, "config.yaml")); err != nil {
        return nil, fmt.Errorf("load base config: %w", err)
    }

    // Layer 2: environment overrides. Optional, but a malformed file is fatal.
    envPath := filepath.Join(basePath, fmt.Sprintf("config.%s.yaml", env))
    if err := overlayFile(&cfg, envPath); err != nil && !errors.Is(err, os.ErrNotExist) {
        return nil, fmt.Errorf("load env config: %w", err)
    }

    // Layer 3: local developer overrides. Never consulted outside development.
    if env == "development" {
        localPath := filepath.Join(basePath, "config.local.yaml")
        if err := overlayFile(&cfg, localPath); err != nil && !errors.Is(err, os.ErrNotExist) {
            return nil, fmt.Errorf("load local config: %w", err)
        }
    }

    return &cfg, nil
}

// overlayFile decodes path onto an existing Config. yaml.Unmarshal only
// assigns fields that are actually present in the document, so keys the
// override omits keep their previous value and keys it sets win, including
// when the value it sets is false or 0. That is the whole trick: it makes
// "absent" and "explicitly zero" different things without any merge code.
func overlayFile(cfg *Config, path string) error {
    data, err := os.ReadFile(path)
    if err != nil {
        return err // wraps fs.ErrNotExist when missing; callers use errors.Is
    }
    if err := yaml.Unmarshal(data, cfg); err != nil {
        return fmt.Errorf("parse %s: %w", path, err)
    }
    return nil
}
```

> **You cannot merge structs by testing for zero values, and a feature flag chapter is the worst possible place to try.** The tempting version decodes each file into its own `Config` and merges field by field:

```go
func mergeConfigs(base, override *Config) {
    if override.Port != 0 { base.Port = override.Port }           // broken
    if override.DatabaseURL != "" { base.DatabaseURL = override.DatabaseURL } // broken
}
```

> Once decoded into a struct, `Port: 0` and "the override file said nothing about Port" are *the same value*. The guard cannot distinguish them, so it resolves the ambiguity by always assuming "absent". The consequence is that **the override layer can only ever turn things on, never off**. Given a base of `debug: true, features.new_ui: true` and a `config.production.yaml` that explicitly says `debug: false, features.new_ui: false`, this merge produces `Debug:true, NewUI:true`. Production ships with debug logging on and an unreleased feature enabled, the config file plainly says otherwise, and nothing logs a warning. The struct merge silently discards precisely the overrides you most cared about, because "off" and "unset" are both the zero value.
>
> Decoding each layer onto the *same* struct sidesteps the problem entirely. The decoder is working from the YAML document, where a key is genuinely present or genuinely absent, so it assigns `false` when the file says `false` and leaves the field alone when the file omits it. Verify both directions: an override of `port: 7070` alone must leave `debug` and `new_ui` at their base values, and an override of `debug: false` must actually stick.
>
> If you truly need a standalone merge function, the ambiguity has to be encoded in the type. Use pointer fields (`Debug *bool`), where `nil` means absent and `&false` means explicitly off. That is why config libraries and Kubernetes API types are full of `*bool`. It is not style, it is the only way a struct can represent three states.

### Configuration Hierarchy

The directory layout enforces an explicit merge order: `config.yaml` provides the stable baseline for every environment, and each environment-specific file overrides only the fields that actually differ (e.g., `config.production.yaml` raises connection pool sizes and sets `ssl_mode: require`). `config.local.yaml` is listed in `.gitignore` so developers can point their local instances at test databases or enable experimental flags without polluting shared configuration. This structure means a production deployment only reads two files, `config.yaml` and `config.production.yaml`, keeping secret surface area minimal.

```
config/
├── config.yaml           # Base configuration
├── config.development.yaml
├── config.staging.yaml
├── config.production.yaml
└── config.local.yaml     # Git-ignored, local overrides
```

### Staff Lens: Environment Parity Matters

Dev, staging, production should be identical except for values. Different libraries, different databases, different auth means "works in dev, fails in prod" surprises. Keep parity. Override values, not structure.

---
