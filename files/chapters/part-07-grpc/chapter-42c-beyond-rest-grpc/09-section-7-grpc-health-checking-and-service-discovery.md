## Section 7: gRPC Health Checking and Service Discovery

### 7.1 Health Checking (grpc-health-probe compatible)

The gRPC health checking protocol is a standard that Kubernetes probes, load balancers, and monitoring systems understand natively.

```go
package grpchealth

import (
	"net"
	"net/http"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	"google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
)

// SetupHealthServer adds health checking to a gRPC server.
// The health server tracks per-service status and responds to
// grpc-health-probe and kubernetes liveness/readiness probes.
func SetupHealthServer(server *grpc.Server, serviceName string) *health.Server {
	healthSrv := health.NewServer()

	// Register the health service implementation.
	grpc_health_v1.RegisterHealthServer(server, healthSrv)

	// Register reflection so grpcurl can list services.
	// Disable in production or restrict to internal networks.
	reflection.Register(server)

	// Set initial status to SERVING.
	healthSrv.SetServingStatus(serviceName, grpc_health_v1.HealthCheckResponse_SERVING)

	return healthSrv
}

// HTTPHealthHandler exposes gRPC health as an HTTP /healthz endpoint.
// Useful for HTTP load balancers that cannot speak the gRPC health protocol.
func HTTPHealthHandler(conn *grpc.ClientConn) http.HandlerFunc {
	client := grpc_health_v1.NewHealthClient(conn)

	return func(w http.ResponseWriter, r *http.Request) {
		resp, err := client.Check(r.Context(), &grpc_health_v1.HealthCheckRequest{})
		if err != nil || resp.Status != grpc_health_v1.HealthCheckResponse_SERVING {
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte("NOT_SERVING"))
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("SERVING"))
	}
}

// GracefulDrain transitions the service to NOT_SERVING before shutdown
// so load balancers stop sending new requests before the process exits.
func GracefulDrain(healthSrv *health.Server, serviceName string, server *grpc.Server) {
	// Signal NOT_SERVING to stop new requests.
	healthSrv.SetServingStatus(serviceName, grpc_health_v1.HealthCheckResponse_NOT_SERVING)

	// Wait for in-flight RPCs to complete.
	server.GracefulStop()
}

// ExampleMain demonstrates the full server lifecycle.
func ExampleMain() {
	server := grpc.NewServer()
	healthSrv := SetupHealthServer(server, "order.v1.OrderService")

	// Handle SIGTERM for graceful shutdown.
	go func() {
		<-shutdownSignal()
		GracefulDrain(healthSrv, "order.v1.OrderService", server)
	}()

	lis, _ := net.Listen("tcp", ":50051")
	server.Serve(lis)
}

func shutdownSignal() <-chan struct{} {
	ch := make(chan struct{})
	// Wire os.Signal in real code.
	return ch
}
```

### 7.2 Kubernetes Deployment with gRPC Health Probes

A Kubernetes Deployment manifest specifies the desired replica count, container image, resource requests and limits, and liveness/readiness probes. Rolling update parameters (`maxSurge` and `maxUnavailable`) control how new versions replace old pods.

```yaml
# k8s-grpc-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: order-service
        image: order-service:latest
        ports:
        - containerPort: 50051
          name: grpc
        livenessProbe:
          grpc:
            port: 50051
            service: order.v1.OrderService
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          grpc:
            port: 50051
            service: order.v1.OrderService
          initialDelaySeconds: 5
          periodSeconds: 5
        lifecycle:
          preStop:
            # Give load balancers time to drain connections.
            exec:
              command: ["/bin/sleep", "5"]
```

---

### Junior → FAANG: Why Health Checking and Graceful Shutdown Are Production Requirements

A service that does not implement the gRPC health protocol is effectively invisible to Kubernetes from a health perspective. Without `livenessProbe.grpc`, Kubernetes has no way to distinguish a live-but-degraded service (database connection pool exhausted, downstream dependency down) from a healthy one. It will keep routing traffic to the broken pod until the pod crashes.

The most common first-job mistake with Kubernetes gRPC services is implementing health checking as an HTTP endpoint at `/healthz` but not registering the gRPC health server. This works for HTTP-native health probes but fails for gRPC-native probes and for `grpc-health-probe` in environments that predate the Kubernetes 1.24 native gRPC probe support.

The ordering in `GracefulDrain` is not optional: `NOT_SERVING` must be set before `GracefulStop` is called. The reason: Kubernetes removes a pod from service endpoints after the readiness probe fails, but that removal takes time (typically 5-30 seconds depending on endpoint controller convergence and the probe period). If you call `GracefulStop` immediately on SIGTERM, you will reject in-flight RPCs from callers that have not yet learned the pod is draining. The `preStop` sleep in the Kubernetes manifest buys time for the endpoint controller to propagate the removal before the process starts refusing connections.

For FAANG interviews: explain the race condition between SIGTERM delivery and endpoint removal without being prompted. This is the kind of distributed systems reasoning that separates candidates who have run services in production from those who have only read about it.

### Senior @ FAANG: Health Check Architecture, Service Mesh Integration, and Drain Orchestration

At senior level, health checking is not just about liveness and readiness probes. It is about the full lifecycle of a service instance from startup to shutdown and the orchestration of traffic shifts around that lifecycle.

A production health check architecture distinguishes three states. Liveness indicates whether the process is alive and should be restarted if unhealthy. Readiness indicates whether the process is ready to receive traffic. A started service can be live but not ready: it may be warming up a connection pool, loading configuration from a remote config service, or waiting for a database migration to complete. Readiness gates prevent a pod from receiving production traffic until it is genuinely ready, which eliminates a class of cold-start errors that cause latency spikes on rollout. The gRPC health protocol's per-service status granularity supports this: you can set `NOT_SERVING` for the order service while the health server itself (which Kubernetes is probing) is `SERVING`, indicating the pod is alive but the specific service is not ready.

Service mesh integration changes the health check topology. When Istio or Linkerd is in the mesh, the sidecar proxy intercepts all gRPC traffic and applies its own health check and circuit-breaking logic. You need to ensure that your gRPC health server is accessible to the mesh control plane for endpoint health signaling, which sometimes requires specific port naming conventions (e.g., the port must be named `grpc` in the Kubernetes service spec for Istio to apply L7 routing). Failing to follow the naming convention causes the mesh to treat the port as opaque TCP and bypass all L7 features.

Drain orchestration for long-lived streaming connections is a separate concern from unary RPC drain. `server.GracefulStop()` waits for all active RPCs to complete, including streaming RPCs that may be waiting for events indefinitely. A streaming RPC for `WatchOrder` that is waiting for the next order event may never terminate on its own, blocking the drain indefinitely and preventing the rollout from completing. The production solution is a bounded drain timeout: if drain is not complete after N seconds, cancel all remaining streaming contexts and force stop. This requires both a server-level timeout and context cancellation in each streaming handler that checks `ctx.Done()` and exits cleanly when canceled.
