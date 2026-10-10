// internal/gateway/grpc.go
package gateway

import (
	"net/http"
	"strings"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

// IsGRPCRequest checks if request is gRPC
func IsGRPCRequest(r *http.Request) bool {
    return r.ProtoMajor == 2 && strings.HasPrefix(r.Header.Get("Content-Type"), "application/grpc")
}

// CreateGRPCHandler creates an HTTP/2 handler for gRPC
func (s *Server) createGRPCHandler() http.Handler {
    h2s := &http2.Server{}
    return h2c.NewHandler(s, h2s)
}
