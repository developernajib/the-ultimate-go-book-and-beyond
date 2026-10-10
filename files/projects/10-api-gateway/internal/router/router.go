// internal/router/router.go
package router

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Route represents a routing rule (mirrors gateway.Route to avoid import cycle)
type Route struct {
	ID           string            `json:"id" yaml:"id"`
	Name         string            `json:"name" yaml:"name"`
	Paths        []string          `json:"paths" yaml:"paths"`
	Methods      []string          `json:"methods" yaml:"methods"`
	Hosts        []string          `json:"hosts,omitempty" yaml:"hosts,omitempty"`
	Headers      map[string]string `json:"headers,omitempty" yaml:"headers,omitempty"`
	UpstreamID   string            `json:"upstream_id" yaml:"upstream_id"`
	Plugins      []PluginConfig    `json:"plugins,omitempty" yaml:"plugins,omitempty"`
	StripPath    bool              `json:"strip_path" yaml:"strip_path"`
	PreserveHost bool              `json:"preserve_host" yaml:"preserve_host"`
	Priority     int               `json:"priority" yaml:"priority"`
	Enabled      bool              `json:"enabled" yaml:"enabled"`
	CreatedAt    time.Time         `json:"created_at" yaml:"created_at"`
	UpdatedAt    time.Time         `json:"updated_at" yaml:"updated_at"`
}

// PluginConfig represents plugin configuration in a route
type PluginConfig struct {
	Name    string         `json:"name" yaml:"name"`
	Enabled bool           `json:"enabled" yaml:"enabled"`
	Config  map[string]any `json:"config,omitempty" yaml:"config,omitempty"`
}

// Router handles request routing
type Router struct {
    mu      sync.RWMutex
    trie    *Trie
    routes  map[string]*Route // route ID -> route
    matcher *Matcher
}

// NewRouter creates a new router
func NewRouter() *Router {
    return &Router{
        trie:    NewTrie(),
        routes:  make(map[string]*Route),
        matcher: NewMatcher(),
    }
}

// AddRoute adds a route to the router
func (r *Router) AddRoute(route *Route) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if _, exists := r.routes[route.ID]; exists {
        return fmt.Errorf("route %s already exists", route.ID)
    }

    // Insert all paths into trie
    for _, path := range route.Paths {
        r.trie.Insert(path, route)
    }

    r.routes[route.ID] = route
    return nil
}

// RemoveRoute removes a route from the router
func (r *Router) RemoveRoute(routeID string) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    route, exists := r.routes[routeID]
    if !exists {
        return fmt.Errorf("route %s not found", routeID)
    }

    // Remove all paths from trie
    for _, path := range route.Paths {
        r.trie.Delete(path)
    }

    delete(r.routes, routeID)
    return nil
}

// UpdateRoute updates an existing route
func (r *Router) UpdateRoute(route *Route) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    oldRoute, exists := r.routes[route.ID]
    if !exists {
        return fmt.Errorf("route %s not found", route.ID)
    }

    // Remove old paths
    for _, path := range oldRoute.Paths {
        r.trie.Delete(path)
    }

    // Insert new paths
    for _, path := range route.Paths {
        r.trie.Insert(path, route)
    }

    r.routes[route.ID] = route
    return nil
}

// Match finds the best matching route for a request
func (r *Router) Match(req *http.Request) (*Route, map[string]string, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    // Find routes matching the path
    route, params := r.trie.Search(req.URL.Path)
    if route == nil {
        return nil, nil, fmt.Errorf("no route found for path: %s", req.URL.Path)
    }

    // Check if route is enabled
    if !route.Enabled {
        return nil, nil, fmt.Errorf("route %s is disabled", route.ID)
    }

    // Additional matching criteria (method, host, headers)
    if !r.matcher.Match(req, route) {
        return nil, nil, fmt.Errorf("request does not match route criteria")
    }

    return route, params, nil
}

// MatchAll finds all matching routes (for priority-based selection)
func (r *Router) MatchAll(req *http.Request) ([]*Route, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    var matches []*Route

    // Check all routes
    for _, route := range r.routes {
        if !route.Enabled {
            continue
        }

        // Check if any path matches
        pathMatch := false
        for _, path := range route.Paths {
            if routeMatch, _ := r.trie.Search(path); routeMatch != nil {
                pathMatch = true
                break
            }
        }

        if pathMatch && r.matcher.Match(req, route) {
            matches = append(matches, route)
        }
    }

    if len(matches) == 0 {
        return nil, fmt.Errorf("no routes match request")
    }

    // Sort by priority (higher priority first)
    sort.Slice(matches, func(i, j int) bool {
        return matches[i].Priority > matches[j].Priority
    })

    return matches, nil
}

// GetRoute returns a route by ID
func (r *Router) GetRoute(routeID string) (*Route, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    route, exists := r.routes[routeID]
    if !exists {
        return nil, fmt.Errorf("route %s not found", routeID)
    }

    return route, nil
}

// ListRoutes returns all routes
func (r *Router) ListRoutes() []*Route {
    r.mu.RLock()
    defer r.mu.RUnlock()

    routes := make([]*Route, 0, len(r.routes))
    for _, route := range r.routes {
        routes = append(routes, route)
    }

    return routes
}

// RouteContext adds route information to the request context
type routeContextKey struct{}

// RouteParams holds route parameters extracted from the path
type RouteParams map[string]string

// WithRoute adds route and params to context
func WithRoute(ctx context.Context, route *Route, params map[string]string) context.Context {
    ctx = context.WithValue(ctx, routeContextKey{}, route)
    if params != nil {
        ctx = context.WithValue(ctx, paramsContextKey{}, RouteParams(params))
    }
    return ctx
}

// GetRoute retrieves route from context
func GetRoute(ctx context.Context) (*Route, bool) {
    route, ok := ctx.Value(routeContextKey{}).(*Route)
    return route, ok
}

type paramsContextKey struct{}

// GetParams retrieves route params from context
func GetParams(ctx context.Context) RouteParams {
    params, _ := ctx.Value(paramsContextKey{}).(RouteParams)
    return params
}
