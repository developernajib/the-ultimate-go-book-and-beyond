// internal/plugins/auth/apikey.go
package auth

import (
    "context"
    "fmt"
    "net/http"

    "github.com/example/api-gateway/internal/plugin"
)

// APIKeyAuthPlugin validates API keys
type APIKeyAuthPlugin struct {
    keys   map[string]bool
    header string
    query  string
}

func NewAPIKeyAuthPlugin() plugin.Plugin {
    return &APIKeyAuthPlugin{
        header: "X-API-Key",
        query:  "api_key",
        keys:   make(map[string]bool),
    }
}

func (p *APIKeyAuthPlugin) Name() string {
    return "api_key_auth"
}

func (p *APIKeyAuthPlugin) Priority() int {
    return 100
}

func (p *APIKeyAuthPlugin) Init(config map[string]any) error {
    if keys, ok := config["keys"].([]any); ok {
        for _, key := range keys {
            if keyStr, ok := key.(string); ok {
                p.keys[keyStr] = true
            }
        }
    }

    if len(p.keys) == 0 {
        return fmt.Errorf("at least one API key required")
    }

    if header, ok := config["header"].(string); ok {
        p.header = header
    }

    if query, ok := config["query"].(string); ok {
        p.query = query
    }

    return nil
}

func (p *APIKeyAuthPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    // Try header first
    apiKey := req.Header.Get(p.header)

    // Fallback to query parameter
    if apiKey == "" {
        apiKey = req.URL.Query().Get(p.query)
    }

    if apiKey == "" {
        return nil, fmt.Errorf("missing API key")
    }

    if !p.keys[apiKey] {
        return nil, fmt.Errorf("invalid API key")
    }

    return req, nil
}

func (p *APIKeyAuthPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    return resp, nil
}

func init() {
    plugin.Register("api_key_auth", NewAPIKeyAuthPlugin)
}
