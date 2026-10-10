## Section 2: gRPC Client with Load Balancing

Client-side load balancing distributes requests across service instances by maintaining a list of healthy endpoints and applying a selection policy. This avoids a centralized load-balancer bottleneck and provides faster failover when an instance becomes unhealthy. In 2026, `google.golang.org/grpc` is on the v1.70+ series, and `grpc.NewClient` (non-blocking by default) is the idiomatic constructor - the old `grpc.Dial` is retained only for backward compatibility. Retry policy, service config, and load-balancing policy are all configured declaratively via `WithDefaultServiceConfig` so the same JSON can also be served from a config-discovery system like xDS.

For dynamic service discovery at scale (multi-region, locality-aware routing, weighted traffic splits), wire the client to an xDS control plane (Envoy, Istio, or Google Traffic Director). Enable with `grpc.NewClient("xds:///my-service", ...)` plus the `google.golang.org/grpc/xds` import. The control plane pushes endpoint and routing updates over ADS. No client redeploy is needed when backends scale.

```go
package grpcclient

import (
	"context"
	"fmt"
	"io"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"

	orderv1 "github.com/example/order/v1"
)

// OrderClient is a type-safe gRPC client
type OrderClient struct {
	conn   *grpc.ClientConn
	client orderv1.OrderServiceClient
}

func NewOrderClient(target string) (*OrderClient, error) {
	conn, err := grpc.NewClient(target,
		// Load balancing: round-robin across multiple backends
		grpc.WithDefaultServiceConfig(`{
			"loadBalancingPolicy": "round_robin",
			"retryPolicy": {
				"maxAttempts": 3,
				"initialBackoff": "0.1s",
				"maxBackoff": "1s",
				"backoffMultiplier": 2,
				"retryableStatusCodes": ["UNAVAILABLE", "DEADLINE_EXCEEDED"]
			}
		}`),
		grpc.WithTransportCredentials(insecure.NewCredentials()), // Use TLS in production
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                10 * time.Second,
			Timeout:             3 * time.Second,
			PermitWithoutStream: true,
		}),
	)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", target, err)
	}

	return &OrderClient{
		conn:   conn,
		client: orderv1.NewOrderServiceClient(conn),
	}, nil
}

// CreateOrder creates an order
func (c *OrderClient) CreateOrder(ctx context.Context, customerID string, items []orderv1.OrderItem) (*orderv1.CreateOrderResponse, error) {
	itemPtrs := make([]*orderv1.OrderItem, len(items))
	for i := range items {
		itemPtrs[i] = &items[i]
	}

	return c.client.CreateOrder(ctx, &orderv1.CreateOrderRequest{
		CustomerId: customerID,
		Items:      itemPtrs,
	})
}

// WatchOrder streams order events
func (c *OrderClient) WatchOrder(ctx context.Context, orderID string, handler func(*orderv1.OrderEvent)) error {
	stream, err := c.client.WatchOrder(ctx, &orderv1.WatchOrderRequest{OrderId: orderID})
	if err != nil {
		return err
	}

	for {
		event, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		handler(event)
	}
}

// BatchCreate streams multiple orders to the server
func (c *OrderClient) BatchCreate(ctx context.Context, orders []*orderv1.CreateOrderRequest) (*orderv1.BatchCreateResponse, error) {
	stream, err := c.client.BatchCreateOrders(ctx)
	if err != nil {
		return nil, err
	}

	for _, order := range orders {
		if err := stream.Send(order); err != nil {
			return nil, err
		}
	}

	return stream.CloseAndRecv()
}

func (c *OrderClient) Close() error {
	return c.conn.Close()
}
```

---

### Junior → FAANG: What Load Balancing Means for gRPC Clients and Why It Differs from HTTP

HTTP/1.1 clients naturally distribute load across a pool of servers because each request opens a new connection, and a load balancer at the TCP level can direct each connection to a different backend. gRPC clients over HTTP/2 are different: a single persistent connection carries all requests over multiplexed streams. Without explicit client-side load balancing, one gRPC client may send all its traffic to a single backend, even if ten backends are available behind a DNS name.

The service config JSON in the example configures `round_robin` load balancing, which means the gRPC client resolves the target address to a list of endpoints and distributes successive RPCs across them in order. This requires that the target resolves to multiple IPs, which is normal for Kubernetes services via DNS (each pod gets an A record). For this to work, you must use a headless Kubernetes service (no ClusterIP) or configure DNS-based endpoint discovery.

The retry policy in the service config is the other critical piece. Without it, a transient `UNAVAILABLE` from a backend restart or network blip propagates to the caller as a failure. With it, the gRPC layer transparently retries on `UNAVAILABLE` and `DEADLINE_EXCEEDED` up to three times with exponential backoff, and the caller never sees the transient error.

For FAANG interviews, the question "how would you handle a gRPC backend restart without dropping client requests" should lead you to describe client-side retry policy plus health checking, not "use a load balancer in front."

### Senior @ FAANG: xDS, Locality-Aware Routing, and Control Plane Architecture

The round-robin service config is appropriate for single-region services with uniform backends. For multi-region deployments, locality-aware routing (also called locality-weighted load balancing) is necessary: a client in us-east-1 should prefer backends in us-east-1 and only spill over to us-west-2 when local capacity is exhausted. Without this, latency is unpredictable and cross-region bandwidth costs accumulate.

xDS is the control plane protocol originally from Envoy that gRPC now supports natively via `google.golang.org/grpc/xds`. A gRPC client configured with `xds:///my-service` connects to a control plane (Istio, Traffic Director, or a custom implementation) that pushes endpoint lists, routing rules, and load balancing policies dynamically. Changes to backend topology, traffic weights, or routing rules are propagated without restarting or redeploying the client. This is the foundation of progressive delivery at the transport layer: you can shift 10% of traffic to a new service version by updating an xDS routing rule, observe latency and error rate, and roll back or proceed, all without touching client code.

The architectural implication for platform teams is significant: xDS moves load balancing policy from client service config (a per-service configuration checked into source control) to a control plane (a centrally managed system with API-driven configuration). This enables traffic management as a platform capability rather than a per-service concern. The trade-off is operational complexity: the control plane is now a critical dependency of every gRPC service in the fleet, and its availability directly affects the ability of services to discover and route to backends.

Connection pool sizing is an often-overlooked senior concern. A single `grpc.ClientConn` opens one HTTP/2 connection (subchannel) per backend address by default. For very high-throughput services, a single HTTP/2 connection can become a bottleneck because HTTP/2 caps the number of concurrent streams per connection (the server advertises this via `SETTINGS_MAX_CONCURRENT_STREAMS`, commonly 100). At 10,000 RPS per backend with slow calls, in-flight streams can hit that ceiling and later RPCs queue. grpc-go does not expose a simple connections-per-backend knob, so the established techniques are a custom resolver that returns each backend address multiple times (the round-robin balancer then opens one subconnection per entry) or a client-side pool of `grpc.ClientConn` values. Either is a non-trivial architectural change that requires load testing to validate.
