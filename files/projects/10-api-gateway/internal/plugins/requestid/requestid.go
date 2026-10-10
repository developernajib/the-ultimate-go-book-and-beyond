// internal/plugins/requestid/requestid.go
package requestid

import (
    "context"
    "net/http"
    "uuid"

    "github.com/example/api-gateway/internal/plugin"
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
