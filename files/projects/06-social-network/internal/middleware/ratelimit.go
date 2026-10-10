// internal/middleware/ratelimit.go
package middleware

import (
    "net/http"
    "time"

    "github.com/go-chi/httprate"
)

func RateLimit() func(next http.Handler) http.Handler {
    return httprate.LimitByIP(100, 1*time.Minute)
}

func RateLimitStrict() func(next http.Handler) http.Handler {
    return httprate.LimitByIP(10, 1*time.Minute)
}
