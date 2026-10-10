// internal/security/headers.go
package security

import (
    "net/http"
)

// SecurityHeadersMiddleware adds security headers to responses
type SecurityHeadersMiddleware struct{}

func (m *SecurityHeadersMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Prevent clickjacking
        w.Header().Set("X-Frame-Options", "DENY")

        // Prevent MIME sniffing
        w.Header().Set("X-Content-Type-Options", "nosniff")

        // Enable XSS protection
        w.Header().Set("X-XSS-Protection", "1; mode=block")

        // HSTS
        w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")

        // CSP
        w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'")

        // Referrer policy
        w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")

        // Permissions policy
        w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")

        next.ServeHTTP(w, r)
    })
}
