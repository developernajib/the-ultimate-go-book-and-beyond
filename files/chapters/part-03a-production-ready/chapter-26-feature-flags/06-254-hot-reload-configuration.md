## 26.4 Hot-Reload Configuration

### File-Based Hot Reload

Hot-reload configuration allows operators to change application behavior without a deployment or restart. `fsnotify` watches for changes and triggers an in-memory reload, protecting the current config under a `RWMutex` so requests reading the config concurrently see either the old or the new version consistently, never a partial update.

The critical detail is *what* you watch. The obvious code watches the config file itself, and it works exactly until the first real deployment. Watch the containing directory instead, then filter events by filename. The next section explains why in detail, because the reason is not obvious and the failure is silent.

```go
package config

import (
    "context"
    "log/slog"
    "os"
    "path/filepath"
    "sync"

    "github.com/fsnotify/fsnotify"
    "gopkg.in/yaml.v3"
)

type HotReloadConfig struct {
    mu       sync.RWMutex
    config   *Config
    path     string
    logger   *slog.Logger
    onChange func(*Config)
}

func NewHotReloadConfig(path string, logger *slog.Logger) (*HotReloadConfig, error) {
    h := &HotReloadConfig{
        path:   path,
        logger: logger,
    }

    // Load initial config
    if err := h.load(); err != nil {
        return nil, err
    }

    return h, nil
}

func (h *HotReloadConfig) load() error {
    data, err := os.ReadFile(h.path)
    if err != nil {
        return err
    }

    var config Config
    if err := yaml.Unmarshal(data, &config); err != nil {
        return err
    }

    h.mu.Lock()
    h.config = &config
    h.mu.Unlock()

    if h.onChange != nil {
        h.onChange(&config)
    }

    return nil
}

func (h *HotReloadConfig) Get() *Config {
    h.mu.RLock()
    defer h.mu.RUnlock()
    return h.config
}

func (h *HotReloadConfig) OnChange(fn func(*Config)) {
    h.onChange = fn
}

func (h *HotReloadConfig) Watch(ctx context.Context) error {
    watcher, err := fsnotify.NewWatcher()
    if err != nil {
        return err
    }
    defer watcher.Close()

    // Watch the DIRECTORY, not the file. An fsnotify watch is bound to the
    // inode behind the path, so an atomic rename over the file leaves the
    // watch pointing at an orphaned inode and no event ever fires again.
    target := filepath.Clean(h.path)
    if err := watcher.Add(filepath.Dir(target)); err != nil {
        return err
    }

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case event, ok := <-watcher.Events:
            if !ok {
                return nil
            }
            if filepath.Clean(event.Name) != target {
                continue // some other file in the directory
            }
            // CREATE matters as much as WRITE: an atomic rename into place
            // arrives as CREATE, and that is how most deployments update config.
            if event.Op&(fsnotify.Write|fsnotify.Create) == 0 {
                continue
            }
            h.logger.Info("config file changed, reloading")
            if err := h.load(); err != nil {
                // Keep serving the last known-good config. A malformed edit
                // must not blank out configuration mid-flight.
                h.logger.Error("reload failed, keeping previous config", "error", err)
            }
        case err, ok := <-watcher.Errors:
            if !ok {
                return nil
            }
            h.logger.Error("watcher error", "error", err)
        }
    }
}
```

> **Why watching the file path silently stops working.** An fsnotify watch binds to the *inode*, not the name. Nearly nothing updates a config file with an in-place write. `vim`, `sed -i`, and most config-management tools write a temp file and `rename(2)` it into place, because that is how you make an update atomic for readers. Kubernetes ConfigMap volumes go further and swap a symlink to a new timestamped directory. In every one of those cases the name now points at a *new* inode while your watch still holds the old one.
>
> Running the original code against the three cases makes the failure concrete. An in-place write produces `WRITE` and reloads correctly. An atomic rename produces `CHMOD` and `REMOVE`, both of which the original's `event.Op&fsnotify.Write` filter discards. And every subsequent write produces **no events at all, forever**: the watch is now attached to an unlinked inode that nothing will ever touch again.
>
> That last part is what makes this dangerous rather than merely buggy. There is no error, no log line, and no crash. The service keeps happily serving the configuration it loaded at startup while operators edit the file and watch nothing happen. Every kill switch in this chapter is dead in exactly the moment you need it. Watching the directory and filtering by name fixes all three cases, and treating `CREATE` as a reload trigger alongside `WRITE` catches the rename.
>
> Two follow-ups for production. Editors often fire several events per save, so debounce reloads with a short timer (roughly 100 ms) and coalesce. And because `fsnotify` on a Kubernetes ConfigMap symlink swap is fiddly to get right, many teams pair the watcher with a low-frequency poll (`load()` every 30 seconds) as a backstop. The watcher gives you latency, the poll gives you a guarantee.

### Remote Config with Polling

A remote configuration store centralizes flag management across multiple service instances. A `RemoteConfig` fetches a JSON payload on startup and then polls at a configured interval, updating the in-memory cache under a mutex. On fetch failure the existing cache is preserved, so service instances continue operating with stale configuration rather than losing all flags on a transient network error. Stale flags are almost always better than absent flags: absent flags mean every evaluation falls to its default, which silently reverts every rollout in your system at once.

That last property is the whole design, and it is easy to destroy by accident. Two guards below deserve attention because their absence is a common production incident:

```go
package config

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "log/slog"
    "net/http"
    "sync"
    "time"
)

type RemoteConfig struct {
    mu           sync.RWMutex
    config       map[string]any
    url          string
    pollInterval time.Duration
    httpClient   *http.Client
    logger       *slog.Logger
}

func NewRemoteConfig(url string, pollInterval time.Duration, logger *slog.Logger) *RemoteConfig {
    return &RemoteConfig{
        config:       make(map[string]any),
        url:          url,
        pollInterval: pollInterval,
        httpClient:   &http.Client{Timeout: 10 * time.Second},
        logger:       logger,
    }
}

func (r *RemoteConfig) Start(ctx context.Context) error {
    // Initial fetch
    if err := r.fetch(ctx); err != nil {
        return err
    }

    // Start polling
    go r.poll(ctx)

    return nil
}

func (r *RemoteConfig) fetch(ctx context.Context) error {
    req, err := http.NewRequestWithContext(ctx, "GET", r.url, nil)
    if err != nil {
        return err
    }

    resp, err := r.httpClient.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    // Check the status BEFORE decoding. An error response is usually valid
    // JSON, and decoding it would replace every flag with nothing.
    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("config fetch: unexpected status %s", resp.Status)
    }

    var config map[string]any
    if err := json.NewDecoder(resp.Body).Decode(&config); err != nil {
        return err
    }

    // An empty ruleset is almost always a bug upstream, not an instruction to
    // turn every feature off. Refuse it and keep the last known-good config.
    if len(config) == 0 {
        return errors.New("config fetch: refusing to apply empty config")
    }

    r.mu.Lock()
    r.config = config
    r.mu.Unlock()

    r.logger.Debug("remote config updated", "keys", len(config))

    return nil
}

func (r *RemoteConfig) poll(ctx context.Context) {
    ticker := time.NewTicker(r.pollInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            if err := r.fetch(ctx); err != nil {
                r.logger.Error("failed to fetch remote config", "error", err)
            }
        }
    }
}

func (r *RemoteConfig) GetString(key string) string {
    r.mu.RLock()
    defer r.mu.RUnlock()

    if value, ok := r.config[key].(string); ok {
        return value
    }
    return ""
}

func (r *RemoteConfig) GetBool(key string) bool {
    r.mu.RLock()
    defer r.mu.RUnlock()

    if value, ok := r.config[key].(bool); ok {
        return value
    }
    return false
}

func (r *RemoteConfig) GetInt(key string) int {
    r.mu.RLock()
    defer r.mu.RUnlock()

    if value, ok := r.config[key].(float64); ok {
        return int(value)
    }
    return 0
}
```

> **The status check is not boilerplate.** Without it, the decoder happily parses whatever the server sent. When your flag service returns `500` with a body of `{"error":"database unavailable"}`, that is perfectly valid JSON, so `Decode` succeeds and `r.config` is replaced by a one-key map containing `error`. Every real flag is now gone. `GetBool` returns `false` for all of them, and since `false` is the "feature off" value, a *partial* outage in your flag service instantly becomes a *total* rollback of every feature across every instance that happened to poll during the window. The same applies to a captive-portal or proxy that returns `200` with an HTML body, and to an empty `{}` from a service that has lost its backing store. Check the status, refuse empty payloads, and keep the last known-good value. Fetching config is one of the few places where doing nothing is strictly better than doing what you were told.

### Staff Lens: Hot Reload Must Degrade Gracefully

Config service unavailable, service falls back to last-known-good. Invalid config pushed, service rejects it. These degradation paths prevent bad config from breaking production. Without them, a config error becomes an outage.

Push the reasoning one step further and a policy falls out: **the flag system's failure mode must be "nothing changes", never "everything changes"**. Losing the config, receiving a corrupt config, and failing to parse a config must all land on the same outcome, which is that the currently running configuration keeps running and a human gets paged. Any code path that turns a flag service problem into a *fleet-wide behavioral change* is a bug even when each individual step looks reasonable. That is the lens to bring to code review here, because every incident in this space is assembled from individually reasonable steps.

---
