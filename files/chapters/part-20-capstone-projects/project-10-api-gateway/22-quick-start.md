## Quick Start

### Prerequisites

- Go 1.27+
- Docker (optional)
- Kubernetes (optional)

### Installation

Clone the repository and use the provided `Makefile` targets to download Go module dependencies, compile the binary, and launch the gateway in a single workflow. The `make build` step produces a statically linked binary under `bin/` that can be deployed as-is or packaged into a minimal container image.

```bash
# Clone the repository
git clone https://github.com/yourusername/gatewaygo.git
cd gatewaygo

# Install dependencies
go mod download

# Build
make build

# Run
make run
```

### Configuration

Edit `configs/gateway.yaml`:

```yaml
server:
  host: 0.0.0.0
  port: 8080

routes:
  - id: api-route
    paths:
      - /api/*
    upstream_id: api-backend

upstreams:
  - id: api-backend
    targets:
      - host: localhost
        port: 8081
```

### Docker

Running the gateway with Docker Compose is the fastest way to spin up the full stack, gateway, upstream stubs, and the Prometheus metrics endpoint, without installing Go locally. The multi-stage `Dockerfile` keeps the final image small by copying only the compiled binary from the builder stage into a distroless base.

```bash
# Build and run with Docker Compose
make docker-run

# Or manually
docker build -t gatewaygo .
docker run -p 8080:8080 -p 9090:9090 gatewaygo
```

### Kubernetes

The `k8s/` directory contains a `Deployment`, `Service`, and `ConfigMap` that mirror the local configuration file structure, making it straightforward to promote from Docker to a production cluster. The Helm chart under `helm/gatewaygo` parameterizes replica count, resource limits, and ingress settings so the same chart can target both staging and production namespaces without manual manifest editing.

```bash
# Apply Kubernetes manifests
kubectl apply -f k8s/

# Or use Helm
helm install gatewaygo ./helm/gatewaygo
```
