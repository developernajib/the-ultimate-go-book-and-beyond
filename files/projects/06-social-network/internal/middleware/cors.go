// internal/middleware/cors.go
package middleware

import (
    "github.com/go-chi/cors"
    "net/http"
)

func CORS() func(next http.Handler) http.Handler {
    return cors.Handler(cors.Options{
        AllowedOrigins:   []string{"https://yourdomain.com"},
        AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
        AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
        ExposedHeaders:   []string{"Link"},
        AllowCredentials: true,
        MaxAge:           300,
    })
}
