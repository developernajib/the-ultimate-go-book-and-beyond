## Part 2: Plugin System Architecture

The plugin system is the heart of our API gateway. It allows for extensible request/response processing. Every request that flows through the gateway passes through a chain of plugins, each of which can inspect, modify, or reject the request before it reaches the backend service. This is the same pattern used by production gateways like Kong and Envoy, where plugins handle cross-cutting concerns such as authentication, rate limiting, and request transformation. By defining a clean plugin interface, we make it easy to add new behaviors without modifying the core gateway code.

### Plugin Interface
This interface definition establishes the contract between Plugin Interface and its consumers. Depending on interfaces rather than concrete types enables dependency injection in tests and allows alternative implementations to be substituted without modifying calling code.

```go
// internal/plugin/plugin.go
package plugin

import (
    "context"
    "net/http"
)

// Plugin is the interface that all plugins must implement
type Plugin interface {
    // Name returns the plugin name
    Name() string

    // Priority returns the execution priority (lower runs first)
    Priority() int

    // Init initializes the plugin with configuration
    Init(config map[string]any) error

    // ProcessRequest processes the request before proxying
    ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error)

    // ProcessResponse processes the response after proxying
    ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error)
}

// Phase represents the plugin execution phase
type Phase int

const (
    PhasePreRequest Phase = iota
    PhaseRequest
    PhasePostRequest
    PhasePreResponse
    PhaseResponse
    PhasePostResponse
)

// Result represents the result of plugin execution
type Result struct {
    ShouldContinue bool
    StatusCode     int
    Body           []byte
    Headers        http.Header
    Error          error
}

// Stop returns a result that stops the plugin chain
func Stop(statusCode int, body []byte) *Result {
    return &Result{
        ShouldContinue: false,
        StatusCode:     statusCode,
        Body:           body,
    }
}

// Continue returns a result that continues the plugin chain
func Continue() *Result {
    return &Result{
        ShouldContinue: true,
    }
}

// Error returns a result with an error
func Error(err error) *Result {
    return &Result{
        ShouldContinue: false,
        Error:          err,
    }
}
```

### Plugin Registry

The plugin registry maps plugin names to factory functions so plugins can be instantiated from configuration at runtime. Registration happens at init time, and lookups are thread-safe via `sync.RWMutex`.

```go
// internal/plugin/registry.go
package plugin

import (
    "fmt"
    "sync"
)

// Factory is a function that creates a plugin instance
type Factory func() Plugin

// Registry holds all registered plugins
type Registry struct {
    mu        sync.RWMutex
    factories map[string]Factory
}

// NewRegistry creates a new plugin registry
func NewRegistry() *Registry {
    return &Registry{
        factories: make(map[string]Factory),
    }
}

// Register registers a plugin factory
func (r *Registry) Register(name string, factory Factory) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if _, exists := r.factories[name]; exists {
        return fmt.Errorf("plugin %s already registered", name)
    }

    r.factories[name] = factory
    return nil
}

// Create creates a plugin instance by name
func (r *Registry) Create(name string) (Plugin, error) {
    r.mu.RLock()
    factory, exists := r.factories[name]
    r.mu.RUnlock()

    if !exists {
        return nil, fmt.Errorf("plugin %s not found", name)
    }

    return factory(), nil
}

// List returns all registered plugin names
func (r *Registry) List() []string {
    r.mu.RLock()
    defer r.mu.RUnlock()

    names := make([]string, 0, len(r.factories))
    for name := range r.factories {
        names = append(names, name)
    }
    return names
}

// Global registry instance
var globalRegistry = NewRegistry()

// Register registers a plugin in the global registry
func Register(name string, factory Factory) error {
    return globalRegistry.Register(name, factory)
}

// Create creates a plugin from the global registry
func Create(name string) (Plugin, error) {
    return globalRegistry.Create(name)
}

// List returns all registered plugins
func List() []string {
    return globalRegistry.List()
}
```

### Plugin Chain

The plugin chain executes plugins in order, passing each request through the configured middleware stack. Each plugin can modify the request, short-circuit the chain, or pass control to the next plugin.

```go
// internal/plugin/chain.go
package plugin

import (
    "context"
    "fmt"
    "net/http"
    "sort"
)

// Chain represents an ordered sequence of plugins
type Chain struct {
    plugins []Plugin
}

// NewChain creates a new plugin chain
func NewChain(plugins []Plugin) *Chain {
    // Sort plugins by priority
    sorted := make([]Plugin, len(plugins))
    copy(sorted, plugins)
    sort.Slice(sorted, func(i, j int) bool {
        return sorted[i].Priority() < sorted[j].Priority()
    })

    return &Chain{
        plugins: sorted,
    }
}

// ProcessRequest executes all plugins' ProcessRequest methods
func (c *Chain) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, *Result) {
    currentReq := req

    for _, plugin := range c.plugins {
        modifiedReq, err := plugin.ProcessRequest(ctx, currentReq)
        if err != nil {
            return currentReq, Error(fmt.Errorf("plugin %s: %w", plugin.Name(), err))
        }

        if modifiedReq != nil {
            currentReq = modifiedReq
        }
    }

    return currentReq, Continue()
}

// ProcessResponse executes all plugins' ProcessResponse methods in reverse order
func (c *Chain) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, *Result) {
    currentResp := resp

    // Execute in reverse order for response processing
    for i := len(c.plugins) - 1; i >= 0; i-- {
        plugin := c.plugins[i]
        modifiedResp, err := plugin.ProcessResponse(ctx, currentResp)
        if err != nil {
            return currentResp, Error(fmt.Errorf("plugin %s: %w", plugin.Name(), err))
        }

        if modifiedResp != nil {
            currentResp = modifiedResp
        }
    }

    return currentResp, Continue()
}

// Add adds a plugin to the chain and re-sorts
func (c *Chain) Add(plugin Plugin) {
    c.plugins = append(c.plugins, plugin)
    sort.Slice(c.plugins, func(i, j int) bool {
        return c.plugins[i].Priority() < c.plugins[j].Priority()
    })
}

// Remove removes a plugin from the chain by name
func (c *Chain) Remove(name string) {
    for i, plugin := range c.plugins {
        if plugin.Name() == name {
            c.plugins = append(c.plugins[:i], c.plugins[i+1:]...)
            return
        }
    }
}

// Plugins returns all plugins in the chain
func (c *Chain) Plugins() []Plugin {
    return c.plugins
}
```
