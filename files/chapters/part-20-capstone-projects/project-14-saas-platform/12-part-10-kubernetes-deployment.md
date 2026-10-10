## Part 10: Kubernetes Deployment

Deploying a multi-tenant SaaS platform requires an orchestration system that can manage multiple services, scale them independently, and provide isolation between components. Kubernetes is the industry standard for this. This section covers the Kubernetes manifests that define how your services run, the Helm charts that package them for repeatable deployments, and the configuration needed for auto-scaling, health checks, and namespace-based tenant isolation.

### Kubernetes Manifests

Kubernetes manifests are YAML files that describe the desired state of your cluster: which containers to run, how many replicas, what environment variables they need, and how they connect to each other. The manifests below set up the namespace, configuration, secrets, deployments, and services for the TenantFlow platform. Pay attention to the resource limits and health check probes, as these ensure your services behave well under load and recover automatically from failures.

```yaml

```
# deploy/kubernetes/base/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: tenantflow
  labels:
    name: tenantflow

---
# deploy/kubernetes/base/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: tenantflow-config
  namespace: tenantflow
data:
  BASE_DOMAIN: "tenantflow.io"
  DATABASE_HOST: "postgres-service"
  DATABASE_PORT: "5432"
  REDIS_HOST: "redis-service"
  REDIS_PORT: "6379"
  NATS_URL: "nats://nats-service:4222"

---
# deploy/kubernetes/base/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: tenantflow-secrets
  namespace: tenantflow
type: Opaque
stringData:
  DATABASE_PASSWORD: "changeme"
  JWT_ACCESS_SECRET: "changeme"
  JWT_REFRESH_SECRET: "changeme"
  STRIPE_API_KEY: "sk_test_..."
  STRIPE_WEBHOOK_SECRET: "whsec_..."

---
# deploy/kubernetes/base/api-gateway-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  namespace: tenantflow
  labels:
    app: api-gateway
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-gateway
  template:
    metadata:
      labels:
        app: api-gateway
    spec:
      containers:
      - name: api-gateway
        image: tenantflow/api-gateway:latest
        ports:
        - containerPort: 8080
          name: http
        envFrom:
        - configMapRef:
            name: tenantflow-config
        - secretRef:
            name: tenantflow-secrets
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
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
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5

---
# deploy/kubernetes/base/api-gateway-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: api-gateway
  namespace: tenantflow
spec:
  selector:
    app: api-gateway
  ports:
  - protocol: TCP
    port: 80
    targetPort: 8080
  type: LoadBalancer

---
# deploy/kubernetes/base/tenant-service-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tenant-service
  namespace: tenantflow
  labels:
    app: tenant-service
spec:
  replicas: 2
  selector:
    matchLabels:
      app: tenant-service
  template:
    metadata:
      labels:
        app: tenant-service
    spec:
      containers:
      - name: tenant-service
        image: tenantflow/tenant-service:latest
        ports:
        - containerPort: 8081
          name: http
        - containerPort: 9090
          name: metrics
        envFrom:
        - configMapRef:
            name: tenantflow-config
        - secretRef:
            name: tenantflow-secrets
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"

---
# deploy/kubernetes/base/postgres-statefulset.yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: tenantflow
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
        image: postgres:18
        ports:
        - containerPort: 5432
          name: postgres
        env:
        - name: POSTGRES_DB
          value: tenantflow
        - name: POSTGRES_USER
          value: tenantflow
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: tenantflow-secrets
              key: DATABASE_PASSWORD
        volumeMounts:
        - name: postgres-data
          mountPath: /var/lib/postgresql/data
  volumeClaimTemplates:
  - metadata:
      name: postgres-data
    spec:
      accessModes: [ "ReadWriteOnce" ]
      resources:
        requests:
          storage: 100Gi

---
# deploy/kubernetes/base/redis-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: tenantflow
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
          name: redis
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "1Gi"
            cpu: "500m"

---
# deploy/kubernetes/base/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-gateway-hpa
  namespace: tenantflow
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
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
# deploy/kubernetes/base/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tenantflow-ingress
  namespace: tenantflow
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - "*.tenantflow.io"
    - "tenantflow.io"
    secretName: tenantflow-tls
  rules:
  - host: "*.tenantflow.io"
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: api-gateway
            port:
              number: 80
```

### Helm Chart

Helm is a package manager for Kubernetes that lets you template your manifests and manage deployments as versioned releases. Instead of manually editing YAML files for each environment (development, staging, production), you define variables in a `values.yaml` file and Helm fills them in. The chart below packages the entire TenantFlow platform into a single deployable unit, with configurable replica counts, resource limits, and feature toggles for each environment.

```

```yaml
# deploy/helm/tenantflow/Chart.yaml
apiVersion: v2
name: tenantflow
description: Multi-tenant SaaS platform
type: application
version: 1.0.0
appVersion: "1.0.0"

dependencies:
  - name: postgresql
    version: "12.x.x"
    repository: "https://charts.bitnami.com/bitnami"
  - name: redis
    version: "17.x.x"
    repository: "https://charts.bitnami.com/bitnami"
  - name: nats
    version: "0.19.x"
    repository: "https://nats-io.github.io/k8s/helm/charts/"

---
# deploy/helm/tenantflow/values.yaml
replicaCount: 3

image:
  repository: tenantflow/api-gateway
  pullPolicy: IfNotPresent
  tag: "latest"

service:
  type: LoadBalancer
  port: 80

ingress:
  enabled: true
  className: "nginx"
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
  hosts:
    - host: "*.tenantflow.io"
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: tenantflow-tls
      hosts:
        - "*.tenantflow.io"

resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 100m
    memory: 128Mi

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70
  targetMemoryUtilizationPercentage: 80

postgresql:
  enabled: true
  auth:
    username: tenantflow
    password: changeme
    database: tenantflow
  primary:
    persistence:
      size: 100Gi

redis:
  enabled: true
  auth:
    enabled: false
  master:
    persistence:
      size: 10Gi
```
