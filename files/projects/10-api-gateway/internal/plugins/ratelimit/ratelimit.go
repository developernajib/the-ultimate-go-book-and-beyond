// internal/plugins/ratelimit/ratelimit.go
package ratelimit

import (
    "context"
    "fmt"
    "net/http"
    "sync"
    "time"

    "github.com/example/api-gateway/internal/plugin"
    "golang.org/x/time/rate"
)

// RateLimitPlugin implements token bucket rate limiting
type RateLimitPlugin struct {
    limiters sync.Map // key -> *rate.Limiter
    rps      float64
    burst    int
    keyFunc  KeyFunc
}

// KeyFunc extracts a rate limit key from the request
type KeyFunc func(*http.Request) string

func NewRateLimitPlugin() plugin.Plugin {
    return &RateLimitPlugin{
        keyFunc: ipKeyFunc,
    }
}

func (p *RateLimitPlugin) Name() string {
    return "rate_limit"
}

func (p *RateLimitPlugin) Priority() int {
    return 200
}

func (p *RateLimitPlugin) Init(config map[string]any) error {
    if rps, ok := config["requests_per_second"].(float64); ok {
        p.rps = rps
    } else if rps, ok := config["requests_per_second"].(int); ok {
        p.rps = float64(rps)
    } else {
        p.rps = 100 // default
    }

    if burst, ok := config["burst"].(int); ok {
        p.burst = burst
    } else if burst, ok := config["burst"].(float64); ok {
        p.burst = int(burst)
    } else {
        p.burst = int(p.rps * 2) // default: 2x rate
    }

    // Configure key function
    if keyType, ok := config["key"].(string); ok {
        switch keyType {
        case "ip":
            p.keyFunc = ipKeyFunc
        case "header":
            if header, ok := config["header"].(string); ok {
                p.keyFunc = headerKeyFunc(header)
            }
        case "path":
            p.keyFunc = pathKeyFunc
        }
    }

    return nil
}

func (p *RateLimitPlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    key := p.keyFunc(req)

    limiter := p.getLimiter(key)

    if !limiter.Allow() {
        return nil, &RateLimitError{
            RetryAfter: time.Second / time.Duration(p.rps),
        }
    }

    return req, nil
}

func (p *RateLimitPlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    return resp, nil
}

func (p *RateLimitPlugin) getLimiter(key string) *rate.Limiter {
    if limiter, ok := p.limiters.Load(key); ok {
        return limiter.(*rate.Limiter)
    }

    limiter := rate.NewLimiter(rate.Limit(p.rps), p.burst)
    p.limiters.Store(key, limiter)
    return limiter
}

// RateLimitError represents a rate limit exceeded error
type RateLimitError struct {
    RetryAfter time.Duration
}

func (e *RateLimitError) Error() string {
    return fmt.Sprintf("rate limit exceeded, retry after %v", e.RetryAfter)
}

// Key extraction functions
func ipKeyFunc(req *http.Request) string {
    ip := req.Header.Get("X-Forwarded-For")
    if ip == "" {
        ip = req.Header.Get("X-Real-IP")
    }
    if ip == "" {
        ip = req.RemoteAddr
    }
    return ip
}

func headerKeyFunc(header string) KeyFunc {
    return func(req *http.Request) string {
        return req.Header.Get(header)
    }
}

func pathKeyFunc(req *http.Request) string {
    return req.URL.Path
}

func init() {
    plugin.Register("rate_limit", NewRateLimitPlugin)
}
