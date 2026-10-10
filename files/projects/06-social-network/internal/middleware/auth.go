// internal/middleware/auth.go
package middleware

import (
    "net/http"

    "github.com/go-chi/jwtauth/v5"
)

func Authenticator(ja *jwtauth.JWTAuth) func(next http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return jwtauth.Verify(ja, jwtauth.TokenFromHeader)(
            jwtauth.Authenticator(ja)(next),
        )
    }
}
