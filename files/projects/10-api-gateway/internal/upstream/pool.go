// internal/upstream/pool.go
package upstream

import (
    "net"
    "net/http"
    "time"
)

// CreateOptimizedTransport creates an optimized HTTP transport
func CreateOptimizedTransport() *http.Transport {
    return &http.Transport{
        Proxy: http.ProxyFromEnvironment,
        DialContext: (&net.Dialer{
            Timeout:   30 * time.Second,
            KeepAlive: 30 * time.Second,
        }).DialContext,
        ForceAttemptHTTP2:     true,
        MaxIdleConns:          100,
        MaxIdleConnsPerHost:   10,
        IdleConnTimeout:       90 * time.Second,
        TLSHandshakeTimeout:   10 * time.Second,
        ExpectContinueTimeout: 1 * time.Second,
        ResponseHeaderTimeout: 30 * time.Second,
    }
}
