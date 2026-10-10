## Deployment Architecture

Deploying a social network involves orchestrating many services: the API server, PostgreSQL, Redis, Neo4j, Elasticsearch, MinIO, and monitoring tools. For local development, Docker Compose lets you start all of these services with a single command, giving every developer an identical environment. For production, Kubernetes provides auto-scaling, rolling deployments, health checks, and secret management across a cluster of servers. The configurations below show both approaches so you can develop locally and deploy confidently to production.

### Docker Compose for Development

Docker containerization packages the application and its runtime dependencies into a portable image that runs identically across development and production environments. The multi-stage build separates the compilation environment from the minimal runtime image to reduce the final image size and attack surface.

```yaml
# docker-compose.yml
version: '3.8'

services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: socialnet
      POSTGRES_PASSWORD: socialnet
      POSTGRES_DB: socialnet
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:8-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  neo4j:
    image: neo4j:5
    environment:
      NEO4J_AUTH: neo4j/password
    ports:
      - "7474:7474"
      - "7687:7687"
    volumes:
      - neo4j_data:/data

  elasticsearch:
    image: elasticsearch:8.12.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
    ports:
      - "9200:9200"
    volumes:
      - es_data:/usr/share/elasticsearch/data

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data

  nats:
    image: nats:latest
    ports:
      - "4222:4222"
      - "8222:8222"

  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus_data:/prometheus

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    volumes:
      - grafana_data:/var/lib/grafana

volumes:
  postgres_data:
  redis_data:
  neo4j_data:
  es_data:
  minio_data:
  prometheus_data:
  grafana_data:
```

### Kubernetes Deployment

Kubernetes manifests declare the desired state of the deployment including replica counts, resource limits, liveness probes, and rolling update strategy. Kubernetes continuously reconciles actual cluster state toward this desired state, providing self-healing and zero-downtime deployments.

```yaml
# k8s/deployment.yml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: socialnet-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: socialnet-api
  template:
    metadata:
      labels:
        app: socialnet-api
    spec:
      containers:
      - name: api
        image: socialnet/api:latest
        ports:
        - containerPort: 8080
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: socialnet-secrets
              key: database-url
        - name: REDIS_URL
          value: redis://redis:6379
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: socialnet-api
spec:
  selector:
    app: socialnet-api
  ports:
  - protocol: TCP
    port: 80
    targetPort: 8080
  type: LoadBalancer
```

### Junior → FAANG: Deployment Fundamentals Every Engineer Must Know

Junior engineers often treat deployment as "someone else's job." At FAANG and modern tech companies, every engineer owns their service through production. You write the Dockerfile, the Kubernetes manifests, and the deployment pipeline. Understanding how your service runs in production is a prerequisite for reasoning about failures.

Build the baseline: know what a Deployment, Service, and Ingress are in Kubernetes. A Deployment manages your pod replicas and handles rolling updates. A Service provides a stable DNS name and load balances across pod IPs. An Ingress routes external HTTP traffic to Services. If you cannot draw this and explain each piece in an interview, you need more practice with `kubectl`.

First-job habit: always configure resource requests and limits. Without requests, the Kubernetes scheduler cannot make good placement decisions. Without limits, a single pod can starve its neighbors. The rule of thumb: request what you need at p50 load, set the limit at 2x the request to allow burst.

Entry-level interview signal: when asked about zero-downtime deployment, describe rolling updates with readiness probes. Kubernetes replaces pods incrementally, and readiness probes prevent traffic from routing to a pod before it is ready to serve. This is the default strategy and the right first answer.

### Senior @ FAANG: Deployment Platform Strategy and Release Governance

At FAANG, deployment is a platform capability. The staff-level concern is not "how do I deploy my service" but "how do I ensure that thousands of deployments per day across hundreds of services maintain the reliability bar for users."

**Progressive delivery as the deployment standard.** Rolling updates are not sufficient for high-risk changes. Progressive delivery sends a small percentage of production traffic to the new version before promoting. The stages are: canary (1-5% of traffic), partial rollout (25%), majority (75%), and full rollout (100%). At each stage, automated analysis compares error rate, latency, and business metrics between the canary and baseline. If any metric regresses beyond threshold, the deployment is automatically rolled back. Argo Rollouts and Flagger implement this pattern on Kubernetes. Adopting it as a platform standard requires defining the analysis metrics and thresholds for each service class.

**GitOps as the source of truth for cluster state.** At L6, you recognize the operational risk of `kubectl apply` executed manually or from CI: it creates drift between the declared state in Git and the actual cluster state. GitOps uses a controller (Argo CD, Flux) that continuously reconciles the cluster to match the Git repository. All changes go through Git pull requests, providing an audit log, peer review, and rollback via revert. The ADR decision for adopting GitOps includes cluster bootstrap strategy, secrets management (sealed secrets or external secrets operator), and image update automation.

**Multi-region deployment and traffic management.** Social networks require multi-region deployment for latency and availability. The architectural decisions: active-active (all regions serve write traffic) versus active-passive (one primary region accepts writes, others are read replicas). Active-active requires conflict resolution in the data layer. For most social networks, the user is pinned to a home region for writes, and reads are served from the nearest region with eventual consistency tolerated for feed content but not for financial or authentication data. Define these consistency requirements per data type in an ADR before choosing the deployment topology.

**Kubernetes cluster upgrade governance.** Kubernetes releases minor versions every four months and supports only the last three minor versions. At platform scale, cluster upgrades are a cross-team coordination event. The process: test the new version in a staging cluster running production-like workloads, run the upgrade on non-critical clusters first, communicate the upgrade schedule to all service teams with 30 days notice, and provide a rollback path. The governance model defines which team owns the cluster upgrade schedule and what service teams must do to verify compatibility. Defining this as a published process prevents last-minute surprises and uncoordinated rollbacks.

---
