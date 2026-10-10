## Deployment

Deploying a CI/CD platform involves orchestrating multiple services: the API server, worker processes, PostgreSQL, Redis, and MinIO for artifact storage. Docker Compose provides a convenient way to define and run all these services together with proper networking, volume mounts, and environment configuration. The production setup below includes health checks, resource limits, restart policies, and proper secret management. For larger deployments, you would migrate this configuration to Kubernetes, but Docker Compose is an excellent starting point.

### Docker Compose Production Setup

Create `deployments/docker-compose.prod.yml`:

```yaml
name: cicd-platform

services:
  api-server:
    build:
      context: ..
      dockerfile: deployments/Dockerfile.apiserver
    restart: always
    ports:
      - "8080:8080"
    environment:
      DATABASE_URL: postgresql://cicd:${DB_PASSWORD}@postgres:5432/cicd?sslmode=disable
      REDIS_URL: redis://redis:6379/0
      S3_ENDPOINT: minio:9000
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      WEBHOOK_SECRET: ${WEBHOOK_SECRET}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY}
    depends_on:
      - postgres
      - redis
      - minio
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '2'
          memory: 2G

  worker:
    build:
      context: ..
      dockerfile: deployments/Dockerfile.worker
    restart: always
    environment:
      DATABASE_URL: postgresql://cicd:${DB_PASSWORD}@postgres:5432/cicd?sslmode=disable
      REDIS_URL: redis://redis:6379/0
      S3_ENDPOINT: minio:9000
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      WORKER_CAPACITY: 5
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - worker_workspace:/workspace
    depends_on:
      - postgres
      - redis
      - minio
    deploy:
      replicas: 5
      resources:
        limits:
          cpus: '4'
          memory: 8G

  postgres:
    image: postgres:18-alpine
    restart: always
    environment:
      POSTGRES_DB: cicd
      POSTGRES_USER: cicd
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G

  redis:
    image: redis:8-alpine
    restart: always
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 1G

  minio:
    image: minio/minio:latest
    restart: always
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${S3_ACCESS_KEY}
      MINIO_ROOT_PASSWORD: ${S3_SECRET_KEY}
    volumes:
      - minio_data:/data
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G

volumes:
  postgres_data:
  redis_data:
  minio_data:
  worker_workspace:
```

### Kubernetes Deployment

Create `deployments/kubernetes/api-server.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cicd-api-server
  namespace: cicd
spec:
  replicas: 3
  selector:
    matchLabels:
      app: cicd-api-server
  template:
    metadata:
      labels:
        app: cicd-api-server
    spec:
      containers:
      - name: api-server
        image: cicd-platform/api-server:latest
        ports:
        - containerPort: 8080
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: cicd-secrets
              key: database-url
        - name: REDIS_URL
          value: redis://cicd-redis:6379/0
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
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
apiVersion: v1
kind: Service
metadata:
  name: cicd-api-server
  namespace: cicd
spec:
  type: LoadBalancer
  ports:
  - port: 80
    targetPort: 8080
  selector:
    app: cicd-api-server
```

---
