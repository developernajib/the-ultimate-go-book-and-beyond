// internal/plugins/cache/cache.go
package cache

import (
    "bytes"
    "context"
    "crypto/sha256"
    "fmt"
    "io"
    "net/http"
    "sync"
    "time"

    "github.com/example/api-gateway/internal/plugin"
)

// CacheEntry represents a cached response
type CacheEntry struct {
    StatusCode int
    Headers    http.Header
    Body       []byte
    CreatedAt  time.Time
    TTL        time.Duration
}

func (e *CacheEntry) IsExpired() bool {
    return time.Since(e.CreatedAt) > e.TTL
}

// CachePlugin caches responses
type CachePlugin struct {
    mu       sync.RWMutex
    cache    map[string]*CacheEntry
    ttl      time.Duration
    methods  map[string]bool
    statuses map[int]bool
}

func NewCachePlugin() plugin.Plugin {
    return &CachePlugin{
        cache: make(map[string]*CacheEntry),
        methods: map[string]bool{
            "GET":  true,
            "HEAD": true,
        },
        statuses: map[int]bool{
            200: true,
            203: true,
            204: true,
            206: true,
            300: true,
            301: true,
            404: true,
            405: true,
            410: true,
            414: true,
            501: true,
        },
    }
}

func (p *CachePlugin) Name() string {
    return "cache"
}

func (p *CachePlugin) Priority() int {
    return 500
}

func (p *CachePlugin) Init(config map[string]any) error {
    if ttl, ok := config["ttl"].(string); ok {
        dur, err := time.ParseDuration(ttl)
        if err != nil {
            return fmt.Errorf("invalid ttl: %w", err)
        }
        p.ttl = dur
    } else {
        p.ttl = 5 * time.Minute
    }

    if methods, ok := config["methods"].([]any); ok {
        p.methods = make(map[string]bool)
        for _, m := range methods {
            p.methods[m.(string)] = true
        }
    }

    if statuses, ok := config["statuses"].([]any); ok {
        p.statuses = make(map[int]bool)
        for _, s := range statuses {
            if status, ok := s.(int); ok {
                p.statuses[status] = true
            } else if status, ok := s.(float64); ok {
                p.statuses[int(status)] = true
            }
        }
    }

    // Start cleanup goroutine
    go p.cleanupExpired()

    return nil
}

func (p *CachePlugin) ProcessRequest(ctx context.Context, req *http.Request) (*http.Request, error) {
    // Only cache configured methods
    if !p.methods[req.Method] {
        return req, nil
    }

    // Generate cache key
    key := p.cacheKey(req)

    // Check cache
    p.mu.RLock()
    entry, exists := p.cache[key]
    p.mu.RUnlock()

    if exists && !entry.IsExpired() {
        // Cache hit - store entry in context for ProcessResponse
        ctx = context.WithValue(ctx, "cache_entry", entry)
        ctx = context.WithValue(ctx, "cache_hit", true)
        return req.WithContext(ctx), nil
    }

    // Cache miss - store key in context for ProcessResponse
    ctx = context.WithValue(ctx, "cache_key", key)
    return req.WithContext(ctx), nil
}

func (p *CachePlugin) ProcessResponse(ctx context.Context, resp *http.Response) (*http.Response, error) {
    // Check if this was a cache hit
    if hit, ok := ctx.Value("cache_hit").(bool); ok && hit {
        if entry, ok := ctx.Value("cache_entry").(*CacheEntry); ok {
            // Return cached response
            resp.StatusCode = entry.StatusCode
            resp.Header = entry.Headers.Clone()
            resp.Body = io.NopCloser(bytes.NewReader(entry.Body))
            resp.Header.Set("X-Cache", "HIT")
            return resp, nil
        }
    }

    // Not cacheable
    if !p.shouldCache(resp) {
        resp.Header.Set("X-Cache", "SKIP")
        return resp, nil
    }

    // Read and cache response
    key, ok := ctx.Value("cache_key").(string)
    if !ok {
        return resp, nil
    }

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return resp, err
    }
    resp.Body.Close()

    // Create cache entry
    entry := &CacheEntry{
        StatusCode: resp.StatusCode,
        Headers:    resp.Header.Clone(),
        Body:       body,
        CreatedAt:  time.Now(),
        TTL:        p.ttl,
    }

    // Store in cache
    p.mu.Lock()
    p.cache[key] = entry
    p.mu.Unlock()

    // Restore response body
    resp.Body = io.NopCloser(bytes.NewReader(body))
    resp.Header.Set("X-Cache", "MISS")

    return resp, nil
}

func (p *CachePlugin) shouldCache(resp *http.Response) bool {
    // Check status code
    if !p.statuses[resp.StatusCode] {
        return false
    }

    // Check Cache-Control header
    cacheControl := resp.Header.Get("Cache-Control")
    if cacheControl == "no-cache" || cacheControl == "no-store" || cacheControl == "private" {
        return false
    }

    return true
}

func (p *CachePlugin) cacheKey(req *http.Request) string {
    // Generate key from method, host, path, and query
    key := fmt.Sprintf("%s:%s%s?%s", req.Method, req.Host, req.URL.Path, req.URL.RawQuery)
    hash := sha256.Sum256([]byte(key))
    return fmt.Sprintf("%x", hash)
}

func (p *CachePlugin) cleanupExpired() {
    ticker := time.NewTicker(1 * time.Minute)
    defer ticker.Stop()

    for range ticker.C {
        p.mu.Lock()
        for key, entry := range p.cache {
            if entry.IsExpired() {
                delete(p.cache, key)
            }
        }
        p.mu.Unlock()
    }
}

func init() {
    plugin.Register("cache", NewCachePlugin)
}
