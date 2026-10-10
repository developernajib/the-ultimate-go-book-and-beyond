package middleware

import (
	"context"
	"net/http"

	"github.com/google/uuid"
)

type requestIDKey string

const requestIDKeyValue requestIDKey = "request_id"

// RequestID middleware
func RequestID() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestID := r.Header.Get("X-Request-ID")
			if requestID == "" {
				requestID = uuid.New().String()
			}

			w.Header().Set("X-Request-ID", requestID)

			ctx := context.WithValue(r.Context(), requestIDKeyValue, requestID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetRequestID gets the request ID from context
func GetRequestID(ctx context.Context) string {
	requestID, _ := ctx.Value(requestIDKeyValue).(string)
	return requestID
}
