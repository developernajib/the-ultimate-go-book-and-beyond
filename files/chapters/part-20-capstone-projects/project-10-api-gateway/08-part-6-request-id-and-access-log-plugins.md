## Part 6: Request ID and Access Log Plugins

When debugging production issues, you need a way to trace a single request as it flows through the gateway, across multiple plugins, and into backend services. The Request ID plugin solves this by assigning a unique identifier to every incoming request. If the client already provides a request ID header, the plugin preserves it. Otherwise, it generates a new UUID. This ID is then attached to the response headers and stored in the request context, making it available to all downstream plugins and backend services. The access log plugin works alongside it to record every request with timing information, status codes, and that same request ID for easy correlation.

```go
// internal/plugins/requestid/requestid.go
package requestid

import (
    "context"
    "net/http"
    "github.com/google/uuid"

    "github.com/yourusername/gatewaygo/internal/plugin"
)

// RequestIDPlugin adds a unique request ID to each request
type RequestIDPlugin struct {
    header string
}

func NewRequestIDPlugin() plugin.Plugin {
    return &RequestIDPlugin{
        header: "X-Request-ID",
    }
}

func (p *RequestIDPlugin) Name() string {
    return "request_id"
}

func (p *RequestIDPlugin) Priority() int {
    return 10 // Run very early
}

func (p *RequestIDPlugin) Init(config map[string]any) error {
    if header, ok := config["header"].(string); ok {
        p.header = header
    }
    return nil
}

func (p *RequestIDPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    // Check if request already has an ID
    requestID := req.Header.Get(p.header)
    if requestID == "" {
        requestID = uuid.New().String()
        req.Header.Set(p.header, requestID)
    }

    // Add to context
    ctx = context.WithValue(ctx, "request_id", requestID)
    return req.WithContext(ctx), nil
}

func (p *RequestIDPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    // Add request ID to response
    if requestID, ok := ctx.Value("request_id").(string); ok {
        resp.Header.Set(p.header, requestID)
    }
    return resp, nil
}

func init() {
    plugin.Register("request_id", NewRequestIDPlugin)
}
```
