## Section 11: API Gateway Pattern

An API gateway sits in front of multiple backend services and handles cross-cutting concerns: routing, authentication, rate limiting, protocol translation (REST→gRPC), and response aggregation.

```go
package apigateway

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	orderv1 "github.com/example/order/v1"
	userv1  "github.com/example/user/v1"
)

// Gateway routes HTTP requests to gRPC backends with REST transcoding.
type Gateway struct {
	orderClient orderv1.OrderServiceClient
	userClient  userv1.UserServiceClient
	mux         *http.ServeMux
}

func NewGateway(orderAddr, userAddr string) (*Gateway, error) {
	orderConn, err := grpc.NewClient(orderAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}

	userConn, err := grpc.NewClient(userAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}

	gw := &Gateway{
		orderClient: orderv1.NewOrderServiceClient(orderConn),
		userClient:  userv1.NewUserServiceClient(userConn),
		mux:         http.NewServeMux(),
	}

	// Route REST calls to gRPC backends.
	gw.mux.HandleFunc("POST /v1/orders", gw.createOrder)
	gw.mux.HandleFunc("GET /v1/orders/{id}", gw.getOrder)
	gw.mux.HandleFunc("GET /v1/users/{id}", gw.getUser)

	return gw, nil
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Apply global middleware: auth, rate limiting, tracing.
	token := r.Header.Get("Authorization")
	if token == "" {
		http.Error(w, `{"error":"authorization required"}`, http.StatusUnauthorized)
		return
	}

	g.mux.ServeHTTP(w, r)
}

// createOrder transcodes a REST POST /v1/orders to a gRPC CreateOrder call.
func (g *Gateway) createOrder(w http.ResponseWriter, r *http.Request) {
	var body struct {
		CustomerID string `json:"customer_id"`
		Items      []struct {
			ProductID  string `json:"product_id"`
			Quantity   int32  `json:"quantity"`
			PriceCents int64  `json:"price_cents"`
		} `json:"items"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}

	// Forward trace ID from HTTP to gRPC metadata.
	ctx := metadata.AppendToOutgoingContext(r.Context(),
		"x-trace-id", r.Header.Get("X-Trace-ID"),
		"x-user-id", r.Header.Get("X-User-ID"),
	)

	items := make([]*orderv1.OrderItem, len(body.Items))
	for i, item := range body.Items {
		items[i] = &orderv1.OrderItem{
			ProductId:  item.ProductID,
			Quantity:   item.Quantity,
			PriceCents: item.PriceCents,
		}
	}

	resp, err := g.orderClient.CreateOrder(ctx, &orderv1.CreateOrderRequest{
		CustomerId: body.CustomerID,
		Items:      items,
	})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"order_id":    resp.OrderId,
		"total_cents": resp.TotalCents,
		"created_at":  resp.CreatedAt.AsTime().Format(time.RFC3339),
	})
}

func (g *Gateway) getOrder(w http.ResponseWriter, r *http.Request) {
	orderID := r.PathValue("id")

	ctx := metadata.AppendToOutgoingContext(r.Context(),
		"x-trace-id", r.Header.Get("X-Trace-ID"),
	)

	resp, err := g.orderClient.GetOrder(ctx, &orderv1.GetOrderRequest{OrderId: orderID})
	if err != nil {
		writeGRPCError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (g *Gateway) getUser(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	resp, err := g.userClient.GetUser(r.Context(), &userv1.GetUserRequest{UserId: userID})
	if err != nil {
		writeGRPCError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeGRPCError(w http.ResponseWriter, err error) {
	// Map gRPC status codes to HTTP status codes.
	httpStatus := grpcStatusToHTTP(err)
	writeJSON(w, httpStatus, map[string]string{"error": err.Error()})
}

func grpcStatusToHTTP(err error) int {
	// Simplified - use status.Code(err) with a full mapping in production.
	msg := err.Error()
	switch {
	case strings.Contains(msg, "NotFound"):
		return http.StatusNotFound
	case strings.Contains(msg, "InvalidArgument"):
		return http.StatusBadRequest
	case strings.Contains(msg, "Unauthenticated"):
		return http.StatusUnauthorized
	case strings.Contains(msg, "PermissionDenied"):
		return http.StatusForbidden
	case strings.Contains(msg, "ResourceExhausted"):
		return http.StatusTooManyRequests
	default:
		return http.StatusInternalServerError
	}
}
```

---

### Junior → FAANG: Understanding the API Gateway Role and Its Failure Modes

The API gateway pattern addresses a specific problem: external callers (browsers, mobile apps, partner integrations) speak different protocols and have different authentication requirements than the internal gRPC services they ultimately call. Rather than teaching every internal service to speak REST and handle external auth, the gateway translates and enforces policy at the edge.

The `grpcStatusToHTTP` function in the example uses string matching on the error message, which is fragile: if the error message format changes, the mapping silently breaks. The correct production approach uses `status.Code(err)` to extract the numeric gRPC status code and maps that to HTTP, not the error string. This is one of the common pitfalls to catch in code review.

The metadata forwarding pattern (`metadata.AppendToOutgoingContext`) is critical for observability: trace IDs set by the gateway must propagate to backend services so distributed traces are correlated. If the gateway strips or ignores the incoming `X-Trace-ID` header, every backend span appears as a disconnected root span in the APM system, and debugging latency issues requires manual correlation.

For FAANG interviews, if asked to design an API gateway, articulate what it should and should not do. It should do: auth enforcement, rate limiting, protocol translation, request routing, and observability injection (trace context, request ID). It should not do: business logic, data transformation beyond protocol adaptation, or long-running computation. The gateway is a policy and routing layer, not a backend.

### Senior @ FAANG: API Gateway Architecture, BFF Pattern, and Build vs Buy

At staff level, the API gateway decision is a build-vs-buy decision with organizational implications. The example in this section is a custom Go gateway, which gives maximum control and eliminates external dependencies. The cost is that it must be maintained, operated, and evolved by the platform team.

Commercial and open-source alternatives (Envoy, Kong, AWS API Gateway, Google Cloud Endpoints, grpc-gateway) each make different trade-offs. grpc-gateway generates REST transcoding code directly from `.proto` annotations, which means the REST API is derived from the gRPC schema automatically and stays in sync as the schema evolves. Kong provides plugin-based extensibility for auth, rate limiting, and transformation without writing Go code. AWS API Gateway and Cloud Endpoints integrate with their respective cloud provider's auth and observability ecosystems.

The Backend for Frontend (BFF) pattern is the staff-level evolution of the API gateway: instead of one gateway that serves all external callers, each client type (mobile app, web app, partner integration) has a dedicated BFF that aggregates and adapts the internal APIs to that client's specific needs. A mobile BFF may return denormalized responses tuned for low-bandwidth connections. A partner BFF may apply additional schema versioning and rate limiting not needed for internal clients. This separation allows the mobile and web teams to own their BFF and evolve it without coordinating with other clients.

The organizational design of the gateway team matters as much as the technical design. A gateway operated as a shared platform service becomes a bottleneck if teams must request gateway configuration changes through a ticket queue. The better model is self-service: teams define their gateway routes and policies as code (Kubernetes CRDs, configuration files, or proto annotations), and the gateway picks up changes automatically. This is how Istio's `VirtualService` and `AuthorizationPolicy` resources work: teams configure their own routing rules without involving the platform team for each change.
