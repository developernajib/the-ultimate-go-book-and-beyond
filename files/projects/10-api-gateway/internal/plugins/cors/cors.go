// internal/plugins/cors/cors.go
package cors

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/example/api-gateway/internal/plugin"
)

// CORSPlugin handles Cross-Origin Resource Sharing
type CORSPlugin struct {
    allowOrigins     []string
    allowMethods     []string
    allowHeaders     []string
    exposeHeaders    []string
    allowCredentials bool
    maxAge           int
}

func NewCORSPlugin() plugin.Plugin {
    return &CORSPlugin{
        allowOrigins: []string{"*"},
        allowMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
        allowHeaders: []string{"*"},
        maxAge:       3600,
    }
}

func (p *CORSPlugin) Name() string {
    return "cors"
}

func (p *CORSPlugin) Priority() int {
    return 50 // Run early, before auth
}

func (p *CORSPlugin) Init(config map[string]any) error {
    if origins, ok := config["allow_origins"].([]any); ok {
        p.allowOrigins = make([]string, len(origins))
        for i, origin := range origins {
            p.allowOrigins[i] = origin.(string)
        }
    }

    if methods, ok := config["allow_methods"].([]any); ok {
        p.allowMethods = make([]string, len(methods))
        for i, method := range methods {
            p.allowMethods[i] = method.(string)
        }
    }

    if headers, ok := config["allow_headers"].([]any); ok {
        p.allowHeaders = make([]string, len(headers))
        for i, header := range headers {
            p.allowHeaders[i] = header.(string)
        }
    }

    if expose, ok := config["expose_headers"].([]any); ok {
        p.exposeHeaders = make([]string, len(expose))
        for i, header := range expose {
            p.exposeHeaders[i] = header.(string)
        }
    }

    if creds, ok := config["allow_credentials"].(bool); ok {
        p.allowCredentials = creds
    }

    if maxAge, ok := config["max_age"].(int); ok {
        p.maxAge = maxAge
    }

    return nil
}

func (p *CORSPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    origin := req.Header.Get("Origin")

    // Handle preflight request
    if req.Method == "OPTIONS" {
        // This will be handled in ProcessResponse
        return req, nil
    }

    // Check if origin is allowed
    if origin != "" && !p.isOriginAllowed(origin) {
        return nil, &CORSError{Origin: origin}
    }

    return req, nil
}

func (p *CORSPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    req := resp.Request
    origin := req.Header.Get("Origin")

    if origin == "" {
        return resp, nil
    }

    // Set CORS headers
    if p.isOriginAllowed(origin) {
        if len(p.allowOrigins) == 1 && p.allowOrigins[0] == "*" {
            resp.Header.Set("Access-Control-Allow-Origin", "*")
        } else {
            resp.Header.Set("Access-Control-Allow-Origin", origin)
            resp.Header.Set("Vary", "Origin")
        }
    }

    if req.Method == "OPTIONS" {
        resp.Header.Set("Access-Control-Allow-Methods", strings.Join(p.allowMethods, ", "))
        resp.Header.Set("Access-Control-Allow-Headers", strings.Join(p.allowHeaders, ", "))

        if p.maxAge > 0 {
            resp.Header.Set("Access-Control-Max-Age", fmt.Sprintf("%d", p.maxAge))
        }
    }

    if len(p.exposeHeaders) > 0 {
        resp.Header.Set("Access-Control-Expose-Headers", strings.Join(p.exposeHeaders, ", "))
    }

    if p.allowCredentials {
        resp.Header.Set("Access-Control-Allow-Credentials", "true")
    }

    return resp, nil
}

func (p *CORSPlugin) isOriginAllowed(origin string) bool {
    for _, allowed := range p.allowOrigins {
        if allowed == "*" || allowed == origin {
            return true
        }

        // Support wildcard subdomains: *.example.com
        if strings.HasPrefix(allowed, "*.") {
            suffix := allowed[1:] // .example.com
            if strings.HasSuffix(origin, suffix) {
                return true
            }
        }
    }
    return false
}

type CORSError struct {
    Origin string
}

func (e *CORSError) Error() string {
    return fmt.Sprintf("origin not allowed: %s", e.Origin)
}

func init() {
    plugin.Register("cors", NewCORSPlugin)
}
