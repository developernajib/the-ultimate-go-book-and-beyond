## Deployment Guide

This section walks you through deploying GoCache in three progressively more complex environments: a single node on your local machine, a multi-node cluster using Docker Compose, and a production-grade Kubernetes deployment. Start with the single node to verify everything works, then scale up to a cluster when you are ready.

### 1. Single Node Deployment

A single-node deployment is the simplest way to get GoCache running. You compile the binary, run it with your desired configuration, and connect using any Redis-compatible client such as `redis-cli`. This is ideal for local development and testing.

```bash
# Build
go build -o gocache ./cmd/gocache

# Run
./gocache -addr :6379 -maxmemory 1073741824

# Test with redis-cli
redis-cli -p 6379
> SET mykey "Hello"
> GET mykey
```

### 2. Cluster Deployment

Docker Compose makes it easy to run a multi-node cluster locally. The three cache nodes will each run on different ports, and Prometheus and Grafana provide observability out of the box.

```bash
# Start with Docker Compose
docker-compose up -d

# Check cluster status
docker-compose ps

# Test cluster
go run examples/cluster_example.go
```

### 3. Kubernetes Deployment

For production environments, Kubernetes provides automatic scaling, self-healing, and rolling updates. The configuration below uses a StatefulSet instead of a Deployment because cache nodes need stable network identities for cluster membership. A headless Service (with `clusterIP: None`) gives each pod a predictable DNS name like `gocache-0.gocache`, which is essential for nodes to discover and communicate with each other.

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: gocache
spec:
  serviceName: gocache
  replicas: 3
  selector:
    matchLabels:
      app: gocache
  template:
    metadata:
      labels:
        app: gocache
    spec:
      containers:
      - name: gocache
        image: gocache:latest
        ports:
        - containerPort: 6379
        env:
        - name: MAX_MEMORY
          value: "1073741824"
        resources:
          limits:
            memory: "2Gi"
            cpu: "1000m"
---
apiVersion: v1
kind: Service
metadata:
  name: gocache
spec:
  clusterIP: None
  selector:
    app: gocache
  ports:
  - port: 6379
```

---

### Junior → FAANG: Progressive Deployment Complexity

Starting with a single-node local deployment and progressing to Docker Compose cluster to Kubernetes production deployment is the right learning sequence. Each step adds complexity that is justified by a specific operational need: Docker Compose adds multi-node coordination, Kubernetes adds autoscaling, rolling deploys, and health-check-gated traffic.

For interviews, describe your deployment progression and what each step taught you. "I started with a single binary, moved to Docker Compose for multi-node testing, and designed the Kubernetes manifests for production" shows operational maturity. Be specific about one challenge at each step: "Kubernetes sticky sessions for consistent hashing was the hardest part because the standard Service load balancer doesn't support it without additional configuration."

The progression from docker run to Kubernetes is also a conceptual progression: from "how do I run this" to "how do I operate this at scale, with health checks, resource limits, and rolling deploys."

### Senior @ FAANG: Deployment as a Production Readiness Gate

At senior level, the deployment guide is a production readiness gate. Before a service is deployed to production, it must pass all items in the deployment checklist: health endpoints return 200 before traffic is routed, resource requests and limits are set appropriately, secrets are injected from the secrets manager (not hardcoded), and runbooks exist for the top 3 failure scenarios.

Kubernetes StatefulSets for cache nodes (as opposed to Deployments) preserve pod identity and persistent volume attachments across restarts. For GoCache with AOF persistence (if you add it later), StatefulSets ensure that node-1 always gets the same persistent volume containing its WAL data, enabling recovery after a pod restart without data loss.

Multi-availability-zone deployment is a production requirement for any service with an availability SLA above 99.5%. Kubernetes pod anti-affinity rules (requiring cache pods to spread across availability zones) ensure that an AZ failure does not take down the entire cache cluster. This configuration should be part of the deployment template, not an afterthought added after the first AZ outage.

---
