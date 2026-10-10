## Chapter 9: Kubernetes Deployment

While Docker Compose is great for local development, Kubernetes is the industry standard for running containers in production. Kubernetes provides automatic scaling, self-healing (restarting crashed containers), rolling deployments with zero downtime, and declarative configuration through YAML manifests. In this chapter, we define all the Kubernetes resources needed to deploy our URL shortener: Deployments, Services, ConfigMaps, Secrets, a Horizontal Pod Autoscaler, an Ingress, and StatefulSets for the database and cache.

### 9.1 Kubernetes Manifests

The manifests below define the core Kubernetes resources for the API layer. A ConfigMap holds non-sensitive configuration values like log level and database URLs, while a Secret stores sensitive values like passwords. The Deployment describes how many replicas of the API server to run, what container image to use, and what resource limits to enforce. The Service exposes the Deployment inside the cluster, and the Ingress makes it accessible from the internet with TLS encryption.

```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: goshort

---
# k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: goshort-config
  namespace: goshort
data:
  APP_ENV: "production"
  LOG_LEVEL: "info"
  REDIS_URL: "redis://redis-service:6379"
  DATABASE_URL: "postgres://goshort:password@postgres-service:5432/goshort?sslmode=disable"

---
# k8s/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: goshort-secrets
  namespace: goshort
type: Opaque
stringData:
  db-password: "your-secure-password"
  api-secret-key: "your-secret-key"

---
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: goshort-api
  namespace: goshort
spec:
  replicas: 3
  selector:
    matchLabels:
      app: goshort-api
  template:
    metadata:
      labels:
        app: goshort-api
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      containers:
      - name: api
        image: goshort:latest
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 8080
          name: http
        envFrom:
        - configMapRef:
            name: goshort-config
        env:
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: goshort-secrets
              key: db-password
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10

---
# k8s/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: goshort-api-service
  namespace: goshort
spec:
  selector:
    app: goshort-api
  ports:
  - protocol: TCP
    port: 80
    targetPort: 8080
  type: ClusterIP

---
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: goshort-api-hpa
  namespace: goshort
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: goshort-api
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80

---
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: goshort-ingress
  namespace: goshort
  annotations:
    nginx.ingress.kubernetes.io/rate-limit: "100"
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - goshort.io
    secretName: goshort-tls
  rules:
  - host: goshort.io
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: goshort-api-service
            port:
              number: 80
```

### 9.2 PostgreSQL StatefulSet

Unlike Deployments, a StatefulSet guarantees stable network identities and persistent storage for each pod. This is essential for databases because you do not want Kubernetes to lose your data when it restarts a pod. The `volumeClaimTemplates` section automatically provisions a 10 GB persistent disk for PostgreSQL data, and the headless Service (`clusterIP: None`) gives the database a stable DNS name that other services can connect to.

```yaml
# k8s/postgres-statefulset.yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres-service
  namespace: goshort
spec:
  selector:
    app: postgres
  ports:
  - port: 5432
  clusterIP: None

---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: goshort
spec:
  serviceName: postgres-service
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:18-alpine
        ports:
        - containerPort: 5432
        env:
        - name: POSTGRES_DB
          value: goshort
        - name: POSTGRES_USER
          value: goshort
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: goshort-secrets
              key: db-password
        volumeMounts:
        - name: postgres-storage
          mountPath: /var/lib/postgresql/data
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
  volumeClaimTemplates:
  - metadata:
      name: postgres-storage
    spec:
      accessModes: ["ReadWriteOnce"]
      resources:
        requests:
          storage: 10Gi
```

### 9.3 Redis Deployment

Redis is deployed as a standard Deployment rather than a StatefulSet because the cache data can be safely rebuilt from the database if lost. The `maxmemory-policy allkeys-lru` flag tells Redis to automatically evict the least recently used keys when memory is full, which is exactly the behavior we want for a URL cache. In a production environment, you might use Redis Sentinel or Redis Cluster for high availability, but a single replica is sufficient for getting started.

```yaml
# k8s/redis-deployment.yaml
apiVersion: v1
kind: Service
metadata:
  name: redis-service
  namespace: goshort
spec:
  selector:
    app: redis
  ports:
  - port: 6379
  clusterIP: None

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: goshort
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:8-alpine
        ports:
        - containerPort: 6379
        command:
        - redis-server
        - --appendonly
        - "yes"
        - --maxmemory
        - "512mb"
        - --maxmemory-policy
        - "allkeys-lru"
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        volumeMounts:
        - name: redis-storage
          mountPath: /data
      volumes:
      - name: redis-storage
        emptyDir: {}
```

---

### Junior → FAANG: Kubernetes as the Production Baseline

FAANG deployments run on Kubernetes. Understanding the resource model (Deployments, Services, ConfigMaps, Secrets, HPA, Ingress) is not optional for backend engineers at these companies. The manifest files in this chapter are your working reference for how those resources connect.

ConfigMaps for non-sensitive config and Secrets for sensitive values is the minimum security baseline. In interviews, if asked "how do you manage configuration," describe this split and mention that Secrets should ideally be injected from a secrets manager (AWS Secrets Manager, HashiCorp Vault) rather than stored as Kubernetes Secrets (which are base64-encoded, not encrypted by default).

Resource limits (CPU and memory requests and limits) are required for stable shared cluster operation. Setting them correctly requires profiling your application under expected load. Without limits, a single misbehaving pod can exhaust node resources and affect neighboring pods.

### Senior @ FAANG: Kubernetes as a Platform Engineering Domain

At senior level, Kubernetes manifests are not written by application teams in isolation. They are governed by platform templates that enforce organizational standards: resource quotas, network policies, pod disruption budgets, security contexts (non-root user, read-only root filesystem, dropped capabilities), and image pull policies. Application teams fill in the gaps (image name, replica count, environment-specific config). The platform team owns the template.

The Horizontal Pod Autoscaler in this chapter scales on CPU utilization, which is a reasonable default but often the wrong signal for a URL shortener. The correct scaling signal is request rate (RPS) or redirect latency p99. Scaling on CPU lags the actual load by seconds or minutes as CPU warms up. Scaling on custom metrics (via the Prometheus Adapter or KEDA) reacts to the business-relevant signal directly. The ADR for autoscaling should document the chosen metric and the target value with justification.

StatefulSets for PostgreSQL and Redis in a self-managed Kubernetes cluster introduce significant operational complexity: volume provisioning, backup and restore procedures, failover coordination, and upgrade procedures. At FAANG, stateful workloads almost always run on managed services (RDS, ElastiCache, Cloud SQL) rather than in-cluster StatefulSets. The ADR for data tier placement should document the build-vs-buy decision: what you gain from managed services (backup, failover, scaling handled by the cloud provider) versus what you give up (less control, higher cost, vendor lock-in).

Progressive delivery (canary deployments, blue-green deployments) is a deployment governance concern. Rolling updates (the Kubernetes default) can expose a breaking API change to production traffic during the transition window. Canary deployments route a small percentage of traffic to the new version before fully rolling out, allowing validation against real traffic before full exposure. Implementing this with Argo Rollouts or Flagger is a platform engineering capability that application teams benefit from but should not need to implement themselves.

---
