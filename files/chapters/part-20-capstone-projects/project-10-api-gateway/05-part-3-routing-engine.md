## Part 3: Routing Engine

The routing engine matches incoming requests to configured routes. When a request arrives at the gateway, the router must quickly determine which backend service should handle it based on the URL path, HTTP method, hostname, and custom headers. We use a trie (prefix tree) data structure for path matching because it provides O(n) lookup time where n is the number of path segments, making it far more efficient than checking every route one by one. The router also supports dynamic path parameters (like `/users/:id`) and wildcard paths (like `/api/*`), which are essential for real-world API routing.

### Route Matcher

The routing engine matches incoming requests to configured routes based on host, path patterns, and HTTP methods using a radix tree for O(k) lookup time where k is the path depth. Matching precedence rules ensure that specific routes take priority over wildcard patterns.

```go
// internal/router/matcher.go
package router

import (
    "net/http"
    "strings"
)

// Matcher matches a request against route criteria
type Matcher struct{}

// NewMatcher creates a new matcher
func NewMatcher() *Matcher {
    return &Matcher{}
}

// Match checks if a request matches the route
func (m *Matcher) Match(req *http.Request, route *Route) bool {
    // Check method
    if len(route.Methods) > 0 && !m.matchMethod(req.Method, route.Methods) {
        return false
    }

    // Check host
    if len(route.Hosts) > 0 && !m.matchHost(req.Host, route.Hosts) {
        return false
    }

    // Check headers
    if len(route.Headers) > 0 && !m.matchHeaders(req.Header, route.Headers) {
        return false
    }

    // Check path (handled by trie in router)
    return true
}

func (m *Matcher) matchMethod(method string, methods []string) bool {
    for _, m := range methods {
        if strings.EqualFold(m, method) {
            return true
        }
    }
    return false
}

func (m *Matcher) matchHost(host string, hosts []string) bool {
    // Remove port from host if present
    if idx := strings.Index(host, ":"); idx != -1 {
        host = host[:idx]
    }

    for _, h := range hosts {
        if m.matchPattern(host, h) {
            return true
        }
    }
    return false
}

func (m *Matcher) matchHeaders(reqHeaders http.Header, routeHeaders map[string]string) bool {
    for key, value := range routeHeaders {
        reqValue := reqHeaders.Get(key)
        if !m.matchPattern(reqValue, value) {
            return false
        }
    }
    return true
}

func (m *Matcher) matchPattern(value, pattern string) bool {
    // Support wildcard patterns
    if pattern == "*" {
        return true
    }

    // Support prefix wildcard: *.example.com
    if strings.HasPrefix(pattern, "*.") {
        suffix := pattern[1:] // .example.com
        return strings.HasSuffix(value, suffix)
    }

    // Exact match
    return value == pattern
}
```

### Path Trie for Efficient Routing

Autocomplete relies on a trie (prefix tree) to perform O(k) prefix lookups where k is the length of the query prefix, independent of the number of indexed terms. This implementation stores term frequencies at leaf nodes to rank suggestions by popularity rather than returning them in arbitrary order.

```go
// internal/router/trie.go
package router

import (
    "strings"
)

// TrieNode represents a node in the routing trie
type TrieNode struct {
    children    map[string]*TrieNode
    wildcardChild *TrieNode
    route       *Route
    isWildcard  bool
    param       string // parameter name for :param patterns
}

// Trie implements a prefix tree for route matching
type Trie struct {
    root *TrieNode
}

// NewTrie creates a new routing trie
func NewTrie() *Trie {
    return &Trie{
        root: &TrieNode{
            children: make(map[string]*TrieNode),
        },
    }
}

// Insert adds a route to the trie
func (t *Trie) Insert(path string, route *Route) {
    parts := splitPath(path)
    node := t.root

    for _, part := range parts {
        if part == "" {
            continue
        }

        // Handle wildcard: /api/*/users
        if part == "*" {
            if node.wildcardChild == nil {
                node.wildcardChild = &TrieNode{
                    children:   make(map[string]*TrieNode),
                    isWildcard: true,
                }
            }
            node = node.wildcardChild
            continue
        }

        // Handle parameter: /api/:id/users
        if strings.HasPrefix(part, ":") {
            paramName := part[1:]
            if node.wildcardChild == nil {
                node.wildcardChild = &TrieNode{
                    children:   make(map[string]*TrieNode),
                    isWildcard: true,
                    param:      paramName,
                }
            }
            node = node.wildcardChild
            continue
        }

        // Regular path segment
        if node.children[part] == nil {
            node.children[part] = &TrieNode{
                children: make(map[string]*TrieNode),
            }
        }
        node = node.children[part]
    }

    node.route = route
}

// Search finds a route matching the path
func (t *Trie) Search(path string) (*Route, map[string]string) {
    parts := splitPath(path)
    params := make(map[string]string)

    route := t.searchNode(t.root, parts, 0, params)
    if route == nil {
        return nil, nil
    }

    return route, params
}

func (t *Trie) searchNode(node *TrieNode, parts []string, index int, params map[string]string) *Route {
    // Reached end of path
    if index == len(parts) {
        return node.route
    }

    part := parts[index]
    if part == "" {
        return t.searchNode(node, parts, index+1, params)
    }

    // Try exact match first
    if child, exists := node.children[part]; exists {
        if route := t.searchNode(child, parts, index+1, params); route != nil {
            return route
        }
    }

    // Try wildcard/parameter match
    if node.wildcardChild != nil {
        if node.wildcardChild.param != "" {
            params[node.wildcardChild.param] = part
        }
        if route := t.searchNode(node.wildcardChild, parts, index+1, params); route != nil {
            return route
        }
        if node.wildcardChild.param != "" {
            delete(params, node.wildcardChild.param)
        }
    }

    return nil
}

// Delete removes a route from the trie
func (t *Trie) Delete(path string) bool {
    parts := splitPath(path)
    return t.deleteNode(t.root, parts, 0)
}

func (t *Trie) deleteNode(node *TrieNode, parts []string, index int) bool {
    if index == len(parts) {
        if node.route != nil {
            node.route = nil
            return true
        }
        return false
    }

    part := parts[index]
    if part == "" {
        return t.deleteNode(node, parts, index+1)
    }

    if part == "*" || strings.HasPrefix(part, ":") {
        if node.wildcardChild != nil {
            if t.deleteNode(node.wildcardChild, parts, index+1) {
                // Clean up empty nodes
                if len(node.wildcardChild.children) == 0 && node.wildcardChild.route == nil {
                    node.wildcardChild = nil
                }
                return true
            }
        }
        return false
    }

    if child, exists := node.children[part]; exists {
        if t.deleteNode(child, parts, index+1) {
            // Clean up empty nodes
            if len(child.children) == 0 && child.route == nil {
                delete(node.children, part)
            }
            return true
        }
    }

    return false
}

func splitPath(path string) []string {
    path = strings.Trim(path, "/")
    if path == "" {
        return []string{}
    }
    return strings.Split(path, "/")
}
```

### Router Implementation

HTTP handlers at this layer translate between the wire protocol and domain types, performing input validation, invoking service methods, and serializing responses. Keeping handlers thin ensures that business logic is testable independently of the HTTP framework.

```go
// internal/router/router.go
package router

import (
    "context"
    "fmt"
    "net/http"
    "sort"
    "sync"

    "github.com/yourusername/gatewaygo/internal/gateway"
)

// Route alias for gateway.Route
type Route = gateway.Route

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
```
