## 52C.8 DDD with gRPC and REST

### HTTP Handlers as Thin Adapters

The HTTP layer is a pure adapter - it translates HTTP requests to application commands and application results to HTTP responses. It contains no business logic:

```go
// interfaces/http/order_handler.go

package httphandler

import (
    "encoding/json"
    "errors"
    "log/slog"
    "net/http"

    orderapp "github.com/yourorg/ecommerce/order-service/internal/application/order"
    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
)

// OrderHandler is the HTTP adapter for the order application.
type OrderHandler struct {
    placeOrder   *orderapp.PlaceOrderHandler
    cancelOrder  *orderapp.CancelOrderHandler
    confirmOrder *orderapp.ConfirmOrderHandler
    fulfillOrder *orderapp.FulfillOrderHandler
    getOrder     *orderapp.GetOrderHandler
    logger       *slog.Logger
}

// NewOrderHandler creates a new HTTP order handler.
func NewOrderHandler(
    place *orderapp.PlaceOrderHandler,
    cancel *orderapp.CancelOrderHandler,
    confirm *orderapp.ConfirmOrderHandler,
    fulfill *orderapp.FulfillOrderHandler,
    get *orderapp.GetOrderHandler,
    logger *slog.Logger,
) *OrderHandler {
    return &OrderHandler{
        placeOrder:   place,
        cancelOrder:  cancel,
        confirmOrder: confirm,
        fulfillOrder: fulfill,
        getOrder:     get,
        logger:       logger,
    }
}

// PlaceOrder handles POST /v1/orders
func (h *OrderHandler) PlaceOrder(w http.ResponseWriter, r *http.Request) {
    var body struct {
        CustomerID string `json:"customer_id"`
        Lines      []struct {
            ProductSKU  string  `json:"product_sku"`
            ProductName string  `json:"product_name"`
            Quantity    int     `json:"quantity"`
            UnitPrice   int64   `json:"unit_price"`
            Currency    string  `json:"currency"`
        } `json:"lines"`
        ShippingAddress struct {
            RecipientName string `json:"recipient_name"`
            Street        string `json:"street"`
            City          string `json:"city"`
            State         string `json:"state"`
            PostalCode    string `json:"postal_code"`
            CountryCode   string `json:"country_code"`
        } `json:"shipping_address"`
    }

    if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
        h.writeError(w, http.StatusBadRequest, "invalid_request", "request body is malformed")
        return
    }

    cmd := orderapp.PlaceOrderCommand{
        RequestID:  r.Header.Get("Idempotency-Key"),
        CustomerID: body.CustomerID,
        ShippingAddress: orderapp.AddressInput{
            RecipientName: body.ShippingAddress.RecipientName,
            Street:        body.ShippingAddress.Street,
            City:          body.ShippingAddress.City,
            State:         body.ShippingAddress.State,
            PostalCode:    body.ShippingAddress.PostalCode,
            CountryCode:   body.ShippingAddress.CountryCode,
        },
    }
    for _, l := range body.Lines {
        cmd.Lines = append(cmd.Lines, orderapp.OrderLineInput{
            ProductSKU:  l.ProductSKU,
            ProductName: l.ProductName,
            Quantity:    l.Quantity,
            UnitPrice:   l.UnitPrice,
            Currency:    l.Currency,
        })
    }

    result, err := h.placeOrder.Handle(r.Context(), cmd)
    if err != nil {
        h.handleError(w, r, err)
        return
    }

    h.writeJSON(w, http.StatusCreated, result)
}

// GetOrder handles GET /v1/orders/{id}
func (h *OrderHandler) GetOrder(w http.ResponseWriter, r *http.Request) {
    orderID := r.PathValue("id") // Go 1.22+ pattern matching
    if orderID == "" {
        h.writeError(w, http.StatusBadRequest, "missing_id", "order ID is required")
        return
    }

    view, err := h.getOrder.Handle(r.Context(), orderapp.GetOrderQuery{OrderID: orderID})
    if err != nil {
        h.handleError(w, r, err)
        return
    }

    h.writeJSON(w, http.StatusOK, view)
}

// handleError translates domain and application errors to HTTP responses.
// This is the ACL between domain errors and HTTP protocol semantics.
func (h *OrderHandler) handleError(w http.ResponseWriter, r *http.Request, err error) {
    h.logger.Error("request error",
        "path", r.URL.Path,
        "method", r.Method,
        "error", err.Error(),
    )

    switch {
    case errors.Is(err, order.ErrOrderNotFound):
        h.writeError(w, http.StatusNotFound, "order_not_found", err.Error())

    case errors.Is(err, order.ErrCancellationWindowExpired),
        errors.Is(err, order.ErrOrderAlreadyCanceled),
        errors.Is(err, order.ErrOrderAlreadyFulfilled),
        errors.Is(err, order.ErrEmptyOrder),
        errors.Is(err, order.ErrDuplicateOrderLine),
        errors.Is(err, order.ErrOrderLineTooMany):
        h.writeError(w, http.StatusUnprocessableEntity, "business_rule_violation", err.Error())

    case errors.Is(err, order.ErrOptimisticConcurrencyConflict):
        h.writeError(w, http.StatusConflict, "conflict", "resource was modified concurrently; please retry")

    default:
        h.writeError(w, http.StatusInternalServerError, "internal_error", "an unexpected error occurred")
    }
}

func (h *OrderHandler) writeJSON(w http.ResponseWriter, status int, body any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    if err := json.NewEncoder(w).Encode(body); err != nil {
        h.logger.Error("encode response", "error", err)
    }
}

func (h *OrderHandler) writeError(w http.ResponseWriter, status int, code, message string) {
    h.writeJSON(w, status, map[string]string{
        "error":   code,
        "message": message,
    })
}
```

### gRPC Server Implementation

The gRPC server follows the same adapter pattern as the HTTP handler. It translates protobuf request messages into application commands, delegates to the same command handlers, and maps domain errors to gRPC status codes. Both transports share the application layer, proving the domain model is transport-agnostic.

```go
// interfaces/grpc/order_server.go

package grpcserver

import (
    "context"
    "errors"

    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    orderapp "github.com/yourorg/ecommerce/order-service/internal/application/order"
    "github.com/yourorg/ecommerce/order-service/internal/domain/order"
    pb "github.com/yourorg/ecommerce/order-service/interfaces/grpc/proto"
)

// OrderServer implements the gRPC OrderService.
type OrderServer struct {
    pb.UnimplementedOrderServiceServer
    placeOrder *orderapp.PlaceOrderHandler
    getOrder   *orderapp.GetOrderHandler
    cancelOrder *orderapp.CancelOrderHandler
}

// NewOrderServer creates a new gRPC order server.
func NewOrderServer(
    place *orderapp.PlaceOrderHandler,
    get *orderapp.GetOrderHandler,
    cancel *orderapp.CancelOrderHandler,
) *OrderServer {
    return &OrderServer{
        placeOrder:  place,
        getOrder:    get,
        cancelOrder: cancel,
    }
}

// PlaceOrder handles the PlaceOrder RPC.
func (s *OrderServer) PlaceOrder(ctx context.Context, req *pb.PlaceOrderRequest) (*pb.PlaceOrderResponse, error) {
    cmd := orderapp.PlaceOrderCommand{
        CustomerID: req.CustomerId,
        ShippingAddress: orderapp.AddressInput{
            RecipientName: req.ShippingAddress.RecipientName,
            Street:        req.ShippingAddress.Street,
            City:          req.ShippingAddress.City,
            State:         req.ShippingAddress.State,
            PostalCode:    req.ShippingAddress.PostalCode,
            CountryCode:   req.ShippingAddress.CountryCode,
        },
    }
    for _, l := range req.Lines {
        cmd.Lines = append(cmd.Lines, orderapp.OrderLineInput{
            ProductSKU:  l.ProductSku,
            ProductName: l.ProductName,
            Quantity:    int(l.Quantity),
            UnitPrice:   l.UnitPrice,
            Currency:    l.Currency,
        })
    }

    result, err := s.placeOrder.Handle(ctx, cmd)
    if err != nil {
        return nil, s.domainErrorToGRPC(err)
    }

    return &pb.PlaceOrderResponse{OrderId: result.OrderID}, nil
}

// domainErrorToGRPC translates domain errors to gRPC status codes.
func (s *OrderServer) domainErrorToGRPC(err error) error {
    switch {
    case errors.Is(err, order.ErrOrderNotFound):
        return status.Errorf(codes.NotFound, err.Error())
    case errors.Is(err, order.ErrCancellationWindowExpired),
        errors.Is(err, order.ErrOrderAlreadyCanceled):
        return status.Errorf(codes.FailedPrecondition, err.Error())
    case errors.Is(err, order.ErrOptimisticConcurrencyConflict):
        return status.Errorf(codes.Aborted, err.Error())
    default:
        return status.Errorf(codes.Internal, "internal error")
    }
}
```

---

### Junior → FAANG: Transport Agnosticism is a Design Proof

The fact that the same application-layer command handler is called from both the HTTP handler and the gRPC server is not an accident. It is proof that the design worked. If you find yourself needing to change the application layer when adding a new transport, the application layer has accidentally absorbed transport-specific concerns.

A concrete test of transport agnosticism: write a CLI handler that accepts the same command types as the HTTP handler. If you can do this without touching the application or domain layer, the design is clean. If you need to add a new parameter to `PlaceOrderCommand` because the CLI passes a flag that the HTTP client does not, that flag is either a legitimate extension of the command (add it, make it optional) or a transport-specific concern that should be resolved in the CLI adapter, not the command type.

For interview preparation: know the standard HTTP status code mapping for domain errors. `ErrNotFound` maps to 404. business rule violations (`ErrCancellationWindowExpired`) map to 422 Unprocessable Entity, not 400 Bad Request. 400 means the request was malformed. 422 means the request was syntactically valid but the operation cannot be performed because of a business rule. Optimistic concurrency conflicts map to 409 Conflict. Internal infrastructure errors map to 500. Being precise about this mapping demonstrates that you understand the difference between domain errors and protocol errors, which is exactly what the HTTP adapter is supposed to translate.

### Senior @ FAANG: Interface Layer Governance and API Lifecycle Management

At the staff level, the interface layer is the public API of your service. Every change to the HTTP handler signature or the gRPC proto is a potential breaking change for consumers. Managing API lifecycle is a platform concern that spans the interface layer, the schema registry, and the deployment pipeline.

**Proto governance for gRPC services.** In a platform with multiple gRPC services, protobuf definitions are the API contract. A Staff engineer establishes: (a) a single source of truth for proto files (a `proto/` monorepo or a schema registry), (b) backward-compatibility enforcement using `buf breaking` in CI (reject PRs that rename fields, change field numbers, or remove methods), and (c) a versioning strategy (use package versioning: `order.v1`, `order.v2` for breaking changes, with a migration window during which both versions are supported). The `UnimplementedOrderServiceServer` embedding shown in the code is not just boilerplate: it is a forward-compatibility guard that prevents binary incompatibility when new RPC methods are added to the proto.

**HTTP API versioning strategy.** REST versioning is less standardized than gRPC versioning, which creates platform divergence if not governed. The common patterns: URL versioning (`/v1/orders`, `/v2/orders`) is simple and explicit but creates handler duplication. Header versioning (`Accept: application/vnd.orders.v2+json`) is semantically correct but harder to debug and cache. For most DDD Go platforms, URL versioning is the pragmatic choice. The Staff engineer establishes the policy: new versions are added for breaking changes, old versions are maintained for at least one major release cycle, and the deprecation schedule is published to consumers. The HTTP handler layer maps version-specific request types to the same application command types where possible, minimizing the number of application-layer changes needed for API evolution.

**Error response standardization.** When the platform has multiple services, each with their own HTTP handler, error response formats diverge unless governed centrally. The Staff engineer defines a platform-wide error response schema (following RFC 7807 "Problem Details for HTTP APIs" is a common choice) and provides a shared library that all services use for error serialization. The `handleError` method shown in this section is the right pattern for a single service. At platform scale, the mapping from domain errors to HTTP status codes is also a platform concern: if the Order service returns `application/problem+json` with `status: 422` and the Payment service returns `{"error": "unprocessable"}` with `status: 400`, consuming clients have to handle two different error formats for the same semantic situation.

**API gateway integration.** In a production FAANG-scale deployment, the HTTP and gRPC handlers shown here sit behind an API gateway (Envoy, AWS API Gateway, Kong) that handles authentication, rate limiting, TLS termination, and request routing. The interface layer handlers should be designed for this: they should not re-implement authentication (the gateway validates JWTs before the request reaches the service), but they should extract the authenticated identity from a request header (`X-Authenticated-User-ID`) set by the gateway and pass it into the application command for authorization callouts. A Staff engineer defines this contract between the gateway and the services in a platform ADR, so every service team knows what headers to expect and what they mean.

---
