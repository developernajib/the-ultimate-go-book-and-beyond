## Section 1: Production gRPC Service

### 1.1 Proto Definition

A `.proto` file defines the service contract: message types with typed fields and RPC methods that specify request and response message types. The `protoc` compiler with Go plugins generates Go types and server/client stubs from this definition.

```protobuf
// order.proto
syntax = "proto3";
package order.v1;
option go_package = "github.com/example/order/v1;orderv1";

import "google/protobuf/timestamp.proto";

service OrderService {
  // Unary RPC
  rpc CreateOrder(CreateOrderRequest) returns (CreateOrderResponse);
  rpc GetOrder(GetOrderRequest) returns (GetOrderResponse);

  // Server streaming: stream order status updates
  rpc WatchOrder(WatchOrderRequest) returns (stream OrderEvent);

  // Client streaming: batch create orders
  rpc BatchCreateOrders(stream CreateOrderRequest) returns (BatchCreateResponse);

  // Bidirectional streaming: order processing pipeline
  rpc ProcessOrders(stream OrderInput) returns (stream OrderOutput);
}

message CreateOrderRequest {
  string customer_id = 1;
  repeated OrderItem items = 2;
  string currency = 3;
}

message OrderItem {
  string product_id = 1;
  int32 quantity = 2;
  int64 price_cents = 3;
}

message CreateOrderResponse {
  string order_id = 1;
  int64 total_cents = 2;
  google.protobuf.Timestamp created_at = 3;
}

message GetOrderRequest { string order_id = 1; }

message GetOrderResponse {
  string order_id = 1;
  string status = 2;
  int64 total_cents = 3;
  google.protobuf.Timestamp created_at = 4;
}

message WatchOrderRequest { string order_id = 1; }

message OrderEvent {
  string order_id = 1;
  string event_type = 2;
  string new_status = 3;
  google.protobuf.Timestamp occurred_at = 4;
}

message BatchCreateResponse {
  int32 created = 1;
  int32 failed = 2;
  repeated string order_ids = 3;
}

message OrderInput { string product_id = 1; int32 quantity = 2; }
message OrderOutput { string order_id = 1; string status = 2; }
```

### 1.2 gRPC Server Implementation

Implementing a gRPC server requires defining a struct that embeds the generated `Unimplemented*Server` type and overrides the RPC methods. The `Unimplemented` embedding ensures forward compatibility when new methods are added to the proto without updating the server immediately.

```go
package grpcserver

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	orderv1 "github.com/example/order/v1"
)

// OrderServiceServer implements the gRPC service
type OrderServiceServer struct {
	orderv1.UnimplementedOrderServiceServer
	service OrderService
	events  EventBus
	logger  *slog.Logger
}

type OrderService interface {
	Create(ctx context.Context, customerID string, items []Item) (*Order, error)
	Get(ctx context.Context, orderID string) (*Order, error)
	Process(ctx context.Context, productID string, qty int) (*Order, error)
}

type Item struct {
	ProductID  string
	Quantity   int
	PriceCents int64
}

type Order struct {
	ID         string
	Status     string
	TotalCents int64
	CreatedAt  time.Time
}

type EventBus interface {
	Subscribe(orderID string) (<-chan OrderEvent, func())
}

type OrderEvent struct {
	Type      string
	NewStatus string
	At        time.Time
}

func NewOrderServiceServer(svc OrderService, events EventBus) *OrderServiceServer {
	return &OrderServiceServer{
		service: svc,
		events:  events,
		logger:  slog.Default(),
	}
}

// CreateOrder handles unary RPC
func (s *OrderServiceServer) CreateOrder(ctx context.Context, req *orderv1.CreateOrderRequest) (*orderv1.CreateOrderResponse, error) {
	// Validate
	if req.CustomerId == "" {
		return nil, status.Error(codes.InvalidArgument, "customer_id is required")
	}
	if len(req.Items) == 0 {
		return nil, status.Error(codes.InvalidArgument, "at least one item required")
	}

	items := make([]Item, len(req.Items))
	for i, item := range req.Items {
		items[i] = Item{
			ProductID:  item.ProductId,
			Quantity:   int(item.Quantity),
			PriceCents: item.PriceCents,
		}
	}

	order, err := s.service.Create(ctx, req.CustomerId, items)
	if err != nil {
		s.logger.Error("create order", "error", err)
		return nil, status.Errorf(codes.Internal, "create order: %v", err)
	}

	return &orderv1.CreateOrderResponse{
		OrderId:    order.ID,
		TotalCents: order.TotalCents,
		CreatedAt:  timestamppb.New(order.CreatedAt),
	}, nil
}

// WatchOrder implements server streaming
func (s *OrderServiceServer) WatchOrder(req *orderv1.WatchOrderRequest, stream orderv1.OrderService_WatchOrderServer) error {
	if req.OrderId == "" {
		return status.Error(codes.InvalidArgument, "order_id is required")
	}

	// Set initial metadata
	header := metadata.Pairs("order-id", req.OrderId, "stream-id", generateStreamID())
	stream.SendHeader(header)

	// Subscribe to events
	eventCh, unsubscribe := s.events.Subscribe(req.OrderId)
	defer unsubscribe()

	for {
		select {
		case <-stream.Context().Done():
			return nil

		case event, ok := <-eventCh:
			if !ok {
				return nil // Channel closed - order processing complete
			}

			if err := stream.Send(&orderv1.OrderEvent{
				OrderId:    req.OrderId,
				EventType:  event.Type,
				NewStatus:  event.NewStatus,
				OccurredAt: timestamppb.New(event.At),
			}); err != nil {
				return status.Errorf(codes.Unavailable, "send event: %v", err)
			}
		}
	}
}

// BatchCreateOrders implements client streaming
func (s *OrderServiceServer) BatchCreateOrders(stream orderv1.OrderService_BatchCreateOrdersServer) error {
	var created, failed int
	var orderIDs []string

	for {
		req, err := stream.Recv()
		if err == io.EOF {
			// Client done sending - return response
			return stream.SendAndClose(&orderv1.BatchCreateResponse{
				Created:  int32(created),
				Failed:   int32(failed),
				OrderIds: orderIDs,
			})
		}
		if err != nil {
			return status.Errorf(codes.Unavailable, "recv: %v", err)
		}

		items := make([]Item, len(req.Items))
		for i, item := range req.Items {
			items[i] = Item{ProductID: item.ProductId, Quantity: int(item.Quantity)}
		}

		order, err := s.service.Create(stream.Context(), req.CustomerId, items)
		if err != nil {
			failed++
		} else {
			created++
			orderIDs = append(orderIDs, order.ID)
		}
	}
}

// ProcessOrders implements bidirectional streaming
func (s *OrderServiceServer) ProcessOrders(stream orderv1.OrderService_ProcessOrdersServer) error {
	for {
		in, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}

		order, err := s.service.Process(stream.Context(), in.ProductId, int(in.Quantity))
		if err != nil {
			// Send error status but continue processing
			stream.Send(&orderv1.OrderOutput{
				OrderId: "error",
				Status:  fmt.Sprintf("failed: %v", err),
			})
			continue
		}

		if err := stream.Send(&orderv1.OrderOutput{
			OrderId: order.ID,
			Status:  order.Status,
		}); err != nil {
			return err
		}
	}
}

// StartServer launches the gRPC server with all middleware
func StartServer(svc OrderService, events EventBus, addr string) error {
	// Server interceptors
	server := grpc.NewServer(
		// Keepalive for long-lived connections
		grpc.KeepaliveParams(keepalive.ServerParameters{
			MaxConnectionIdle:     15 * time.Minute,
			MaxConnectionAge:      30 * time.Minute,
			MaxConnectionAgeGrace: 5 * time.Second,
			Time:                  5 * time.Second,
			Timeout:               1 * time.Second,
		}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
			MinTime:             5 * time.Second,
			PermitWithoutStream: true,
		}),
		// Interceptors. Recovery is outermost so it catches panics from every
		// other interceptor and the handler. Logging sits above auth so
		// authentication failures are still observed.
		grpc.ChainUnaryInterceptor(
			recoveryInterceptor,
			loggingInterceptor,
			authInterceptor,
		),
		grpc.ChainStreamInterceptor(
			streamLoggingInterceptor,
			streamAuthInterceptor,
		),
		// Max message size
		grpc.MaxRecvMsgSize(16*1024*1024),
		grpc.MaxSendMsgSize(16*1024*1024),
	)

	orderv1.RegisterOrderServiceServer(server, NewOrderServiceServer(svc, events))

	// Enable server reflection for grpcurl/grpc-web
	reflection.Register(server)

	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	slog.Info("gRPC server starting", "addr", addr)
	return server.Serve(lis)
}

// ─── Interceptors ───

func loggingInterceptor(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	start := time.Now()
	resp, err := handler(ctx, req)

	code := codes.OK
	if err != nil {
		code = status.Code(err)
	}

	slog.Info("gRPC unary",
		"method", info.FullMethod,
		"duration_ms", time.Since(start).Milliseconds(),
		"code", code,
	)
	return resp, err
}

func recoveryInterceptor(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("gRPC panic recovered", "method", info.FullMethod, "panic", r)
			err = status.Errorf(codes.Internal, "internal server error")
		}
	}()
	return handler(ctx, req)
}

func authInterceptor(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	// Skip auth for health checks
	if info.FullMethod == "/grpc.health.v1.Health/Check" {
		return handler(ctx, req)
	}

	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "no metadata")
	}

	tokens := md.Get("authorization")
	if len(tokens) == 0 {
		return nil, status.Error(codes.Unauthenticated, "authorization required")
	}

	// Validate token (simplified)
	_ = tokens[0]
	return handler(ctx, req)
}

func streamLoggingInterceptor(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
	start := time.Now()
	err := handler(srv, ss)
	slog.Info("gRPC stream",
		"method", info.FullMethod,
		"duration_ms", time.Since(start).Milliseconds(),
		"error", err,
	)
	return err
}

func streamAuthInterceptor(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
	md, _ := metadata.FromIncomingContext(ss.Context())
	_ = md
	return handler(srv, ss)
}

func generateStreamID() string {
	return fmt.Sprintf("stream-%d", time.Now().UnixNano())
}
```

---

### Junior → FAANG: Building the Right Mental Model for gRPC Server Implementation

The single biggest misunderstanding juniors have when first reading a gRPC server implementation is treating it like a normal HTTP handler with a different transport. It is not. The key differences that matter immediately in practice are:

First, the `Unimplemented*Server` embedding is not optional boilerplate. It is the mechanism that prevents your binary from panicking at startup when a new RPC method is added to the proto but your server has not implemented it yet. Without it, the grpc framework will call a nil method pointer. Always embed it.

Second, error handling in gRPC returns explicit status codes, not generic Go errors. Returning `fmt.Errorf("something went wrong")` from a gRPC handler produces a `codes.Unknown` status, which is meaningless to callers. Every error returned from a handler should be a `status.Error(codes.X, msg)` with a code that lets the client make a decision. `codes.NotFound` means the client can stop retrying. `codes.Unavailable` means the client should retry with backoff. `codes.Internal` means something went wrong on the server and the client has no recourse.

Third, streaming handlers are long-lived goroutines. The `WatchOrder` implementation demonstrates the correct pattern: always select on both the event channel and `stream.Context().Done()`. If you only loop on the event channel without checking context cancellation, you will leak goroutines when clients disconnect.

For FAANG interviews, be prepared to explain why `UnimplementedOrderServiceServer` exists and what would happen without it. This signals that you understand the code generation contract rather than just copying boilerplate.

### Senior @ FAANG: Production Service Hardening, Interceptor Architecture, and Rollout Discipline

The implementation shown in this section is a correct starting point but requires additional hardening for production at serious scale. The areas that senior engineers focus on are: interceptor chain composition, panic recovery scope, streaming backpressure, and service versioning.

Interceptor chain ordering matters more than most engineers realize. The outermost interceptor runs first on the way in and last on the way out. Recovery interceptors should be outermost so they catch panics from all subsequent interceptors and handlers. Logging should run above auth so that authentication failures are still recorded, which is what lets you detect a credential-stuffing attack rather than being blind to it. The logging interceptor must sanitize request payloads so that an unauthenticated request body is never emitted in full. Rate limiting should run after auth so you can apply per-tenant limits rather than per-IP limits. Tracing should run before auth so the span captures the full lifecycle including auth latency.

The recovery interceptor in the example logs and returns `codes.Internal`. In production, you also want to increment a counter metric so you have alerting on panic rate, and you want to capture a stack trace in a low-overhead way. The `runtime/debug.Stack()` call is expensive under load. A pragmatic approach is to rate-limit stack trace capture: capture the first N panics per minute and drop the rest, logging only the error type for the remainder.

For streaming handlers at scale, the bounded channel in the `Client.send` field is critical. The example uses `make(chan Message, 32)`. The right buffer size depends on your expected burst: too small and you drop messages or close connections under load spikes, too large and you risk OOM under sustained slow consumers. The production pattern is to instrument the channel depth as a metric and alert when it consistently exceeds 80% capacity.

Service versioning across a large fleet is a governance concern that the code alone cannot solve. The proto package is `order.v1`. When you need a breaking change, you create `order.v2`, deploy a v2 server alongside the v1 server, and migrate callers incrementally. The v1 server stays running until all callers have moved and its traffic drops to zero. Shadow traffic replay from v1 to v2 during the migration detects behavioral regressions before committing. This is the same pattern as REST versioning but enforced at compile time because callers that import `order/v1` get a compile error if they try to call a v2-only method.
