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
