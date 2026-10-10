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
