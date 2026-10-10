## 28.6 Configuration Management

### Config Files

Configuration is expressed as a struct to provide compile-time type safety and enable validation at startup. Grouping all parameters in one place makes it easy to inject them from environment variables, config files, or command-line flags through a single construction path.

```go
package main

import (
    "encoding/json"
    "os"
    "path/filepath"

    "gopkg.in/yaml.v3"
)

type Config struct {
    Server   string `json:"server" yaml:"server"`
    Port     int    `json:"port" yaml:"port"`
    Username string `json:"username" yaml:"username"`
    APIKey   string `json:"api_key" yaml:"api_key"`
}

func loadConfig() (*Config, error) {
    // Try multiple locations
    locations := []string{
        "config.yaml",
        filepath.Join(os.Getenv("HOME"), ".myapp", "config.yaml"),
        "/etc/myapp/config.yaml",
    }

    for _, loc := range locations {
        if config, err := loadConfigFile(loc); err == nil {
            return config, nil
        }
    }

    return &Config{
        Server: "localhost",
        Port:   8080,
    }, nil // Return defaults
}

func loadConfigFile(path string) (*Config, error) {
    data, err := os.ReadFile(path)
    if err != nil {
        return nil, err
    }

    var config Config

    ext := filepath.Ext(path)
    switch ext {
    case ".json":
        err = json.Unmarshal(data, &config)
    case ".yaml", ".yml":
        err = yaml.Unmarshal(data, &config)
    }

    if err != nil {
        return nil, err
    }

    return &config, nil
}

func saveConfig(config *Config) error {
    configDir := filepath.Join(os.Getenv("HOME"), ".myapp")
    if err := os.MkdirAll(configDir, 0755); err != nil {
        return err
    }

    data, err := yaml.Marshal(config)
    if err != nil {
        return err
    }

    return os.WriteFile(filepath.Join(configDir, "config.yaml"), data, 0600)
}
```

### XDG Base Directory

The XDG Base Directory Specification defines standard locations for configuration, data, and cache files on Unix systems. Instead of scattering dotfiles directly in `$HOME`, well-behaved tools store configs under `$XDG_CONFIG_HOME` (defaulting to `~/.config`), persistent data under `$XDG_DATA_HOME` (`~/.local/share`), and disposable caches under `$XDG_CACHE_HOME` (`~/.cache`). Following this convention keeps home directories clean and makes it straightforward for users to back up or wipe application state.

```go
package main

import (
    "os"
    "path/filepath"
)

type Paths struct {
    Config string
    Data   string
    Cache  string
}

func getXDGPaths(appName string) Paths {
    home := os.Getenv("HOME")

    configHome := os.Getenv("XDG_CONFIG_HOME")
    if configHome == "" {
        configHome = filepath.Join(home, ".config")
    }

    dataHome := os.Getenv("XDG_DATA_HOME")
    if dataHome == "" {
        dataHome = filepath.Join(home, ".local", "share")
    }

    cacheHome := os.Getenv("XDG_CACHE_HOME")
    if cacheHome == "" {
        cacheHome = filepath.Join(home, ".cache")
    }

    return Paths{
        Config: filepath.Join(configHome, appName),
        Data:   filepath.Join(dataHome, appName),
        Cache:  filepath.Join(cacheHome, appName),
    }
}

func ensurePaths(paths Paths) error {
    for _, dir := range []string{paths.Config, paths.Data, paths.Cache} {
        if err := os.MkdirAll(dir, 0755); err != nil {
            return err
        }
    }
    return nil
}
```

### Junior to FAANG: config fundamentals and pitfalls

The example uses `os.Getenv("HOME")` which breaks on Windows and in containers. Use `os.UserHomeDir()` and `os.UserConfigDir()` from the standard library. They handle Windows (`%APPDATA%`), macOS (`~/Library/Application Support`), and Linux (XDG) correctly. This is a one-line change that saves a day of Windows bug triage.

Worked example. A user reports the tool ignores their config on Windows. Diagnosis. You used `~/.myapp/config.yaml` which on Windows resolves to something nonsensical. The fix is `os.UserConfigDir()` plus your app name, which returns `C:\Users\Name\AppData\Roaming\myapp` on Windows, `~/Library/Application Support/myapp` on macOS, and `~/.config/myapp` on Linux. One stdlib call replaces three env vars and the XDG logic.

Secrets in config files. API keys in YAML are fine for personal tools, catastrophic in shared repos or container images. The rule. Secrets go in one of three places, and nowhere else. The OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret). An environment variable injected at runtime by the shell or secret manager. A separate secrets file with 0600 permissions never committed to git. Your config loader should warn if a field matching `*_KEY`, `*_TOKEN`, `*_SECRET`, or `PASSWORD` appears in plaintext in a config file, because users will do this by accident.

File permissions on Linux and macOS. When you write a config with secrets, the file must be 0600 (readable by owner only). The config directory should be 0700. A file with 0644 is world-readable on multi-user systems. Always set perms explicitly with `os.WriteFile(path, data, 0600)` and never rely on umask. Linters like gosec flag this, adopt them in CI.

Interview entry point. "Where does `kubectl` look for its config?" Answer. `$KUBECONFIG` env var (colon-separated list), else `~/.kube/config`. Bonus. The value can be a list, and entries are merged with earlier entries winning. This is the multi-cluster pattern. Know it because any platform tool you build will eventually face the same problem.

### Senior at FAANG: configuration as a distributed system problem

At scale, config is not a file, it is a resolved view over a hierarchy of sources, some of which are remote and dynamic. Staff concerns.

Precedence is a spec, not an implementation detail. Document every source, every precedence level, and why. Example from a staff RFC. "Precedence, highest to lowest. Command-line flags. Environment variables prefixed `MYAPP_`. User config at `$XDG_CONFIG_HOME/myapp/config.yaml`. Organizational policy file at `/etc/myapp/policy.yaml` (cannot be overridden for security-critical fields marked `policy: enforced`). Remote config fetched from `https://config.mycompany.internal/myapp` cached for 24 hours (used for default endpoints, feature flags). Compiled-in defaults." Publish a `myapp config debug KEY` subcommand that prints the value and its source. Without it, users cannot diagnose why a setting is not taking effect.

Organizational policy layer. Enterprise customers need to mandate certain settings (TLS minimum version, allowed endpoints, required telemetry). Support a policy file whose specific fields cannot be overridden by user config, the way managed enterprise deployments lock down tool settings. The staff ADR. "Fields marked `enforced: true` in `/etc/myapp/policy.yaml` cannot be overridden by flags or user config. Attempts log a warning. Fields marked `default: VALUE` set a default but allow override."

Remote config ethics. If your tool fetches defaults from a server, document it in privacy policy, cache aggressively (24 hours minimum), fall back to last good config on network failure, and allow offline operation. Users on airplanes should not be blocked. Never fetch on every invocation, that is a DDoS vector and a latency tax.

Schema validation. Config files deserve JSON Schema or CUE validation. At load time, validate against the schema and emit field-level errors. `myapp config validate` subcommand runs the schema against the current config, useful in CI to catch config drift before deployment. Ship the schema alongside your tool for editor integration (VS Code YAML extension picks it up automatically).

Migrations. When config schema changes, provide a migration path. `myapp config migrate` detects old schema versions and rewrites them. Version your config format explicitly (`schemaVersion: 2`) so the tool knows whether to migrate. Keep the migration code forever, because someone will upgrade from version 1 to version 5 years later.

Config file locking and atomicity. Writing a config must be atomic. Write to `config.yaml.tmp`, then rename to `config.yaml`. On Windows, rename across drives fails. Use `renameio` library or equivalent. Concurrent writes from two parallel processes must not corrupt the file. File locking via `flock` on Unix and `LockFileEx` on Windows. Staff-level review catch. "This config write is not atomic, a Ctrl+C mid-write leaves the file truncated."

XDG on Windows and macOS. The XDG spec is Linux-centric. On macOS, native convention is `~/Library/Application Support/AppName`. On Windows, `%APPDATA%\AppName`. Users are divided. Some prefer XDG everywhere for consistency, others prefer native. The compromise, many tools now support both. On macOS, check `$XDG_CONFIG_HOME` first, fall back to `~/Library/Application Support`. Document the behavior.

Secrets rotation. If your tool caches credentials, it must handle rotation. Tokens expire, keys rotate, MFA devices reset. The rule. Never hardcode a token lifetime. Always respect the `expires_at` from the issuer. Refresh proactively before expiry. Fall back to re-prompting when refresh fails. `gh` handles this well, mirror its pattern.

Audit logging of config changes. For tools used in regulated environments, every config change must be logged with who, what, when, and where. `myapp config set endpoint foo` should write a JSON audit line to `$XDG_STATE_HOME/myapp/audit.log`. Rotate the log weekly. This is a compliance requirement for SOC 2, HIPAA, and PCI contexts.

Config as code. Advanced users want to check their config into git. Make sure your config is deterministic (no random field ordering on write), comments are preserved (YAML round-trips comments via `gopkg.in/yaml.v3` with `Node` types), and secrets are separable (`include: secrets.enc.yaml` with external encryption). Support this from day one, it is a prerequisite for GitOps adoption.

Feature flag integration. The senior pattern. Config resolves feature flags. `myapp foo --experimental-bar` is wrong, `myapp foo` with `features.bar: true` in config is right, because it lets the org enable features per user without CLI args. The flag is a convenience, the config is the source of truth. It is the same principle behind `gcloud`'s alpha and beta release tracks and Kubernetes feature gates: experimental behavior is opted into explicitly, never on by default.

Config versioning and deprecation. A config key renamed is a breaking change. Support old keys with deprecation warnings for at least two minor versions. Provide automatic migration. Publish a deprecated-keys document in your docs site. This applies equally to flag names, env var names, and config keys. All three are the same public API.

---
