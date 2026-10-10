## Part 14: Deployment

Getting your gateway from source code to a running production service requires proper containerization and orchestration. In this section, we create a multi-stage Dockerfile that compiles the Go binary in a builder stage and copies only the final binary into a minimal Alpine image, keeping the container small and secure. We then set up Docker Compose for local development with multiple backend services, and provide Kubernetes manifests and a Helm chart for production deployment with replicas, health probes, and resource limits.

### Dockerfile
Docker containerization packages the application and its runtime dependencies into a portable image that runs identically across development and production environments. The multi-stage build separates the compilation environment from the minimal runtime image to reduce the final image size and attack surface.

```dockerfile
# Dockerfile
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

# Install dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build binary
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o gatewaygo ./cmd/gateway

# Final stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binary from builder
COPY --from=builder /app/gatewaygo .

# Copy config
COPY configs/gateway.yaml ./configs/

# Expose ports
EXPOSE 8080 9090

# Run
CMD ["./gatewaygo", "-config", "./configs/gateway.yaml"]
```

### Docker Compose

Docker containerization packages the application and its runtime dependencies into a portable image that runs identically across development and production environments. The multi-stage build separates the compilation environment from the minimal runtime image to reduce the final image size and attack surface.

```yaml
# docker-compose.yml
version: '3.8'

services:
  gateway:
    build: .
    ports:
      - "8080:8080"
      - "9090:9090"
    volumes:
      - ./configs:/root/configs
    environment:
      - LOG_LEVEL=info
    depends_on:
      - backend1
      - backend2
      - redis
      - jaeger

  backend1:
    image: nginx:alpine
    ports:
      - "8081:80"

  backend2:
    image: nginx:alpine
    ports:
      - "8082:80"

  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"
      - "14268:14268"

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9091:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-storage:/var/lib/grafana

volumes:
  grafana-storage:
```

### Kubernetes Deployment

Kubernetes manifests declare the desired state of the deployment including replica counts, resource limits, liveness probes, and rolling update strategy. Kubernetes continuously reconciles actual cluster state toward this desired state, providing self-healing and zero-downtime deployments.

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gatewaygo
  labels:
    app: gatewaygo
spec:
  replicas: 3
  selector:
    matchLabels:
      app: gatewaygo
  template:
    metadata:
      labels:
        app: gatewaygo
    spec:
      containers:
      - name: gatewaygo
        image: gatewaygo:latest
        ports:
        - containerPort: 8080
          name: http
        - containerPort: 9090
          name: admin
        env:
        - name: LOG_LEVEL
          value: "info"
        volumeMounts:
        - name: config
          mountPath: /root/configs
        livenessProbe:
          httpGet:
            path: /health
            port: 9090
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 9090
          initialDelaySeconds: 5
          periodSeconds: 5
        resources:
          requests:
            cpu: "500m"
            memory: "512Mi"
          limits:
            cpu: "1000m"
            memory: "1Gi"
      volumes:
      - name: config
        configMap:
          name: gatewaygo-config
---
apiVersion: v1
kind: Service
metadata:
  name: gatewaygo
spec:
  type: LoadBalancer
  ports:
  - port: 80
    targetPort: 8080
    name: http
  - port: 9090
    targetPort: 9090
    name: admin
  selector:
    app: gatewaygo
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: gatewaygo-config
data:
  gateway.yaml: |
    server:
      host: 0.0.0.0
      port: 8080
    admin:
      enabled: true
      port: 9090
    logging:
      level: info
      format: json
    # ... rest of config
```

### Helm Chart

Packaging the operator as a Helm chart simplifies installation by parameterizing RBAC rules, resource limits, image tags, and feature flags. Chart versioning aligns operator and CRD releases so that upgrade procedures are predictable and rollback is possible.

```yaml
# helm/gatewaygo/Chart.yaml
apiVersion: v2
name: gatewaygo
description: A production-ready API Gateway
version: 1.0.0
appVersion: "1.0.0"
```

```yaml
# helm/gatewaygo/values.yaml
replicaCount: 3

image:
  repository: gatewaygo
  pullPolicy: IfNotPresent
  tag: "latest"

service:
  type: LoadBalancer
  port: 80
  adminPort: 9090

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  hosts:
    - host: api.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: api-tls
      hosts:
        - api.example.com

resources:
  requests:
    cpu: 500m
    memory: 512Mi
  limits:
    cpu: 1000m
    memory: 1Gi

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 10
  targetCPUUtilizationPercentage: 80

config:
  server:
    host: 0.0.0.0
    port: 8080
  admin:
    enabled: true
    port: 9090
```
