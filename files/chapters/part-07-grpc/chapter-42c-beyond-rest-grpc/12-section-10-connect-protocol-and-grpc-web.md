## Section 10: Connect Protocol and gRPC-Web

The Connect protocol (from Buf) is a superset of gRPC that works natively over HTTP/1.1 and HTTP/2 without a special proxy. A single handler built with the connect-go library (import path `connectrpc.com/connect`) transparently serves **three protocols on the same endpoint**: native Connect (HTTP/1.1 or HTTP/2, with a JSON mode for curl-debuggability), standard gRPC (for existing Go/Java/Python services), and gRPC-Web (for browser clients) - no Envoy, no side-car, no content-type routing code. In 2026 this is the recommended default for any web-facing protobuf service.

### 10.1 Why Connect?

Unlike gRPC-Web, which requires an Envoy or nginx proxy to translate the framing before reaching the backend, Connect handles HTTP/1.1 and HTTP/2 natively so the same server binary serves both browser clients and gRPC clients without any proxy layer.

```
┌───────────────────────────────────────────────────────────────────┐
│              gRPC-Web vs Connect Protocol                         │
│                                                                   │
│  gRPC:     HTTP/2 only, binary framing, not browser-native        │
│  gRPC-Web: Requires Envoy/nginx proxy for browser clients         │
│  Connect:  HTTP/1.1 + HTTP/2, no proxy needed, curl-friendly      │
│                                                                   │
│  Connect is backward compatible with gRPC - a Connect server      │
│  speaks both gRPC and Connect protocols on the same port.         │
│  Buf's connect-go (connectrpc.com/connect) implements this.       │
│                                                                   │
│  Use Connect when:                                                │
│  • Browser clients need to call gRPC services directly            │
│  • You want curl-friendly JSON endpoints for debugging            │
│  • You want gRPC compatibility without requiring a proxy          │
│  • Teams new to gRPC want an easier onboarding experience         │
└───────────────────────────────────────────────────────────────────┘
```

### 10.2 Connect Server in Go

A Connect server implementation uses `connectrpc.com/connect` generated handlers and registers them on a standard `net/http` mux, so any HTTP/1.1 or HTTP/2 server works without additional proxies. The same handler binary serves gRPC clients via `Content-Type: application/grpc` and Connect clients via `application/connect+proto` or `application/json` by inspecting the content type on each request.

```go
package connectserver

import (
	"context"
	"fmt"
	"net/http"

	"connectrpc.com/connect"
	orderv1 "github.com/example/order/v1"
	"github.com/example/order/v1/orderv1connect"
)

// OrderServiceHandler implements connect.Handler interface.
type OrderServiceHandler struct {
	service OrderService
}

// CreateOrder handles both gRPC and Connect protocol clients.
func (h *OrderServiceHandler) CreateOrder(
	ctx context.Context,
	req *connect.Request[orderv1.CreateOrderRequest],
) (*connect.Response[orderv1.CreateOrderResponse], error) {
	// Access headers the same way regardless of protocol.
	traceID := req.Header().Get("X-Trace-ID")
	_ = traceID

	r := req.Msg
	if r.CustomerId == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("customer_id required"))
	}

	order, err := h.service.Create(ctx, r.CustomerId, r.Items)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	resp := connect.NewResponse(&orderv1.CreateOrderResponse{
		OrderId:    order.ID,
		TotalCents: order.TotalCents,
	})
	resp.Header().Set("X-Order-Version", "v1")
	return resp, nil
}

// WatchOrder handles server-streaming with Connect.
func (h *OrderServiceHandler) WatchOrder(
	ctx context.Context,
	req *connect.Request[orderv1.WatchOrderRequest],
	stream *connect.ServerStream[orderv1.OrderEvent],
) error {
	eventCh, unsub := h.service.Subscribe(req.Msg.OrderId)
	defer unsub()

	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-eventCh:
			if !ok {
				return nil
			}
			if err := stream.Send(&orderv1.OrderEvent{
				OrderId:   req.Msg.OrderId,
				EventType: event.Type,
				NewStatus: event.NewStatus,
			}); err != nil {
				return err
			}
		}
	}
}

// RegisterHandlers mounts the Connect handlers on an HTTP mux.
// The same server speaks gRPC, gRPC-Web, and Connect over HTTP/2 and HTTP/1.1.
func RegisterHandlers(mux *http.ServeMux, svc OrderService) {
	handler := &OrderServiceHandler{service: svc}

	path, h := orderv1connect.NewOrderServiceHandler(handler,
		connect.WithCompressMinBytes(1024), // compress payloads > 1KB
		connect.WithInterceptors(
			connect.UnaryInterceptorFunc(loggingInterceptor),
		),
	)

	mux.Handle(path, h)
}

func loggingInterceptor(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		resp, err := next(ctx, req)
		if err != nil {
			fmt.Printf("RPC error: %v\n", err)
		}
		return resp, err
	}
}
```

---

### Junior → FAANG: Why Connect Exists and When to Choose It

The original gRPC-Web specification solved a real problem (browsers cannot speak HTTP/2 with raw gRPC framing natively) but required an Envoy proxy to translate between the browser's gRPC-Web requests and the backend's native gRPC. That proxy is an additional moving part, an additional configuration surface, and an additional failure point.

Connect removes the proxy requirement by handling HTTP/1.1 and HTTP/2 natively in the same handler. The framing format is different from gRPC, but the server negotiates the correct format per request based on the `Content-Type` header. A browser calling with `application/connect+json` gets a JSON response. An existing gRPC service calling with `application/grpc+proto` gets a binary protobuf response. The same server binary handles both.

For FAANG interviews, the key distinction to articulate is: Connect is a protocol, not just a library. The library, connect-go (import path `connectrpc.com/connect`), implements the protocol, but the protocol itself is an open specification that any implementation can follow. This means a browser using the Buf Connect TypeScript client and a Go service using the standard gRPC client can both call the same Connect server.

The JSON mode is particularly useful for debugging: `curl -H 'Content-Type: application/json' -d '{"customerId":"123"}' https://api.example.com/order.v1.OrderService/CreateOrder` works without any special tools. This is not possible with standard gRPC binary encoding.

### Senior @ FAANG: Connect Adoption Strategy, Envoy Trade-offs, and Protocol Governance

At senior level, the decision to adopt Connect rather than standard gRPC plus Envoy is an ADR with organizational implications beyond the immediate service.

The case for Connect: eliminates the Envoy dependency for browser-facing services, simplifies the deployment topology (no sidecar or separate proxy needed), makes gRPC services debuggable with standard HTTP tools, and reduces the operational surface that SREs must manage. For organizations that are not already running Istio or have a dedicated Envoy fleet, Connect is the cleaner path.

The case against Connect (or for continuing to use Envoy): Envoy provides L7 features beyond protocol translation: rate limiting, circuit breaking, retry policy, fault injection, traffic mirroring, and L7 access logs. If your service mesh depends on Envoy for these features, replacing the Envoy proxy with a Connect handler means reimplementing those features in application code (or in interceptors). The organizational cost of that reimplementation must be weighed against the operational simplicity of removing the proxy.

For organizations already running Istio with Envoy sidecars, the practical question is whether Connect replaces the Envoy sidecar entirely or sits alongside it. The answer is typically alongside: Istio continues to handle mTLS, service discovery, and traffic policy. Connect replaces the gRPC-Web framing translation that Envoy was doing, which removes one specific Envoy responsibility without removing the mesh.

The protocol governance concern: adopting Connect introduces two protocol variants into the fleet (gRPC and Connect), and teams must know which services speak which protocol. A platform decision to standardize on Connect for all new web-facing services and standard gRPC for all internal services is the kind of ADR that simplifies this: internal-only services use `grpc.NewClient`, web-facing services use Connect. The schema (`.proto` files) is identical in both cases, so the developer experience for defining services is unchanged.
