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
