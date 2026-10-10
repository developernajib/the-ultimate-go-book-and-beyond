## Part 10: Configuration Hot Reload

In a production environment, you do not want to restart the gateway every time you change a routing rule or update a plugin setting. Hot reload lets the gateway watch its configuration file for changes and automatically apply the new settings without dropping any in-flight requests. We use the `fsnotify` library to detect file system changes, and we include a debounce mechanism to avoid reloading multiple times when an editor saves the file in several write operations. When a change is detected, the watcher reads the new configuration and calls a reload function that safely swaps in the updated routes, upstreams, and plugin settings.

```go
// internal/config/watcher.go
package config

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/fsnotify/fsnotify"
    "github.com/yourusername/gatewaygo/internal/gateway"
    "go.uber.org/zap"
)

// Watcher watches configuration files for changes
type Watcher struct {
    configPath string
    reloadFunc func(*gateway.Config) error
    watcher    *fsnotify.Watcher
    logger     *zap.Logger
    mu         sync.Mutex
    lastReload time.Time
    debounce   time.Duration
}

// NewWatcher creates a new config watcher
func NewWatcher(configPath string, reloadFunc func(*gateway.Config) error, logger *zap.Logger) (*Watcher, error) {
    fsWatcher, err := fsnotify.NewWatcher()
    if err != nil {
        return nil, fmt.Errorf("create fs watcher: %w", err)
    }

    w := &Watcher{
        configPath: configPath,
        reloadFunc: reloadFunc,
        watcher:    fsWatcher,
        logger:     logger,
        debounce:   1 * time.Second,
    }

    if err := fsWatcher.Add(configPath); err != nil {
        return nil, fmt.Errorf("watch config file: %w", err)
    }

    return w, nil
}

// Start starts watching for config changes
func (w *Watcher) Start(ctx context.Context) {
    go func() {
        for {
            select {
            case event, ok := <-w.watcher.Events:
                if !ok {
                    return
                }

                if event.Op&fsnotify.Write == fsnotify.Write {
                    w.handleConfigChange()
                }

            case err, ok := <-w.watcher.Errors:
                if !ok {
                    return
                }
                w.logger.Error("watcher error", zap.Error(err))

            case <-ctx.Done():
                return
            }
        }
    }()
}

func (w *Watcher) handleConfigChange() {
    w.mu.Lock()
    defer w.mu.Unlock()

    // Debounce: ignore if reloaded recently
    if time.Since(w.lastReload) < w.debounce {
        return
    }

    w.logger.Info("config file changed, reloading...")

    config, err := gateway.LoadConfig(w.configPath)
    if err != nil {
        w.logger.Error("load config failed", zap.Error(err))
        return
    }

    if err := w.reloadFunc(config); err != nil {
        w.logger.Error("reload config failed", zap.Error(err))
        return
    }

    w.lastReload = time.Now()
    w.logger.Info("config reloaded successfully")
}

// Stop stops the watcher
func (w *Watcher) Stop() error {
    return w.watcher.Close()
}
```
