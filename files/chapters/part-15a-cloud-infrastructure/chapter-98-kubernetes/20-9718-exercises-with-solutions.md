## 98.20 Exercises with Solutions

### Exercise 1: Complete Production Deployment

**Task**: Create a production-ready Kubernetes deployment for a Go service with:
1. 3 replicas spread across zones
2. Proper health checks
3. Resource limits
4. Pod Disruption Budget
5. Horizontal Pod Autoscaler

**Solution**:

```yaml
# production-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-service
  labels:
    app: go-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: go-service
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: go-service
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
    spec:
      serviceAccountName: go-service
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: go-service
      containers:
        - name: go-service
          image: myregistry/go-service:v1.0.0
          ports:
            - containerPort: 8080
              name: http
          env:
            - name: GOMAXPROCS
              valueFrom:
                resourceFieldRef:
                  resource: limits.cpu
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
          livenessProbe:
            httpGet:
              path: /health/live
              port: http
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health/ready
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          volumeMounts:
            - name: tmp
              mountPath: /tmp
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
      volumes:
        - name: tmp
          emptyDir: {}
      terminationGracePeriodSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: go-service
spec:
  selector:
    app: go-service
  ports:
    - port: 80
      targetPort: http
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: go-service-pdb
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: go-service
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: go-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: go-service
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
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 10
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100
          periodSeconds: 15
```

### Exercise 2: Implement Health Checks

**Task**: Create a Go service with proper Kubernetes health checks.

**Solution**:

```go
// main.go
package main

import (
    "context"
    "database/sql"
    "encoding/json"
    "log"
    "net/http"
    "os"
    "os/signal"
    "sync/atomic"
    "syscall"
    "time"

    _ "github.com/lib/pq"
    "github.com/redis/go-redis/v9"
)

type HealthChecker struct {
    db    *sql.DB
    redis *redis.Client
    ready atomic.Bool
}

type HealthResponse struct {
    Status string            `json:"status"`
    Checks map[string]string `json:"checks,omitempty"`
}

func (h *HealthChecker) LiveHandler(w http.ResponseWriter, r *http.Request) {
    // Liveness: Is the process alive and not deadlocked?
    // Should be fast and not check dependencies
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

func (h *HealthChecker) ReadyHandler(w http.ResponseWriter, r *http.Request) {
    if !h.ready.Load() {
        http.Error(w, "Not ready", http.StatusServiceUnavailable)
        return
    }

    ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
    defer cancel()

    response := HealthResponse{
        Status: "healthy",
        Checks: make(map[string]string),
    }
    allHealthy := true

    // Check database
    if err := h.db.PingContext(ctx); err != nil {
        response.Checks["database"] = err.Error()
        allHealthy = false
    } else {
        response.Checks["database"] = "ok"
    }

    // Check Redis
    if err := h.redis.Ping(ctx).Err(); err != nil {
        response.Checks["redis"] = err.Error()
        allHealthy = false
    } else {
        response.Checks["redis"] = "ok"
    }

    w.Header().Set("Content-Type", "application/json")
    if !allHealthy {
        response.Status = "unhealthy"
        w.WriteHeader(http.StatusServiceUnavailable)
    }
    json.NewEncoder(w).Encode(response)
}

func main() {
    // Initialize database
    db, err := sql.Open("postgres", os.Getenv("DATABASE_URL"))
    if err != nil {
        log.Fatal(err)
    }
    defer db.Close()

    // Initialize Redis
    redisClient := redis.NewClient(&redis.Options{
        Addr: os.Getenv("REDIS_URL"),
    })
    defer redisClient.Close()

    health := &HealthChecker{
        db:    db,
        redis: redisClient,
    }

    // Setup routes
    mux := http.NewServeMux()
    mux.HandleFunc("/health/live", health.LiveHandler)
    mux.HandleFunc("/health/ready", health.ReadyHandler)
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        w.Write([]byte("Hello, World!"))
    })

    server := &http.Server{
        Addr:         ":8080",
        Handler:      mux,
        ReadTimeout:  5 * time.Second,
        WriteTimeout: 10 * time.Second,
    }

    // Start server
    go func() {
        log.Printf("Starting server on %s", server.Addr)
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatal(err)
        }
    }()

    // Wait for dependencies to be ready
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    for {
        if err := db.PingContext(ctx); err == nil {
            if err := redisClient.Ping(ctx).Err(); err == nil {
                break
            }
        }
        select {
        case <-ctx.Done():
            log.Fatal("Dependencies not ready within timeout")
        case <-time.After(time.Second):
            continue
        }
    }
    health.ready.Store(true)
    log.Println("Service ready")

    // Graceful shutdown
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGTERM, syscall.SIGINT)
    <-quit

    log.Println("Shutting down...")
    health.ready.Store(false) // Stop accepting new requests

    shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer shutdownCancel()

    if err := server.Shutdown(shutdownCtx); err != nil {
        log.Printf("Shutdown error: %v", err)
    }
    log.Println("Server stopped")
}
```

### Exercise 3: Network Policy Implementation

**Task**: Create network policies for a three-tier application (web, api, database).

**Solution**:

```yaml
# network-policies.yaml

# Default deny all ingress and egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: myapp
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
# Web tier: allow ingress from internet, egress to API
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: web-policy
  namespace: myapp
spec:
  podSelector:
    matchLabels:
      tier: web
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx
      ports:
        - port: 8080
  egress:
    - to:
        - podSelector:
            matchLabels:
              tier: api
      ports:
        - port: 8080
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
---
# API tier: allow from web, egress to database
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-policy
  namespace: myapp
spec:
  podSelector:
    matchLabels:
      tier: api
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              tier: web
      ports:
        - port: 8080
  egress:
    - to:
        - podSelector:
            matchLabels:
              tier: database
      ports:
        - port: 5432
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
---
# Database tier: only allow from API
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: database-policy
  namespace: myapp
spec:
  podSelector:
    matchLabels:
      tier: database
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              tier: api
      ports:
        - port: 5432
  egress:
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
```

---

### Junior → FAANG: Making Exercises Effective Learning Experiences

Kubernetes exercises are most valuable when done on a real cluster, not just read. The recommended environment is kind (Kubernetes in Docker), which runs a full Kubernetes cluster on your laptop in about 30 seconds. Install kind, create a cluster, and work through each exercise against the real API server.

The learning moment in each exercise is the failure, not the success. When the deployment does not behave as expected (health check not triggering restart, HPA not scaling, network policy blocking the wrong traffic), the diagnostic process builds real fluency. Read `kubectl describe`, read events, read logs, and iterate. This debugging practice is what makes Kubernetes knowledge operational rather than theoretical.

After completing each exercise successfully, introduce a deliberate failure: misconfigure the health check, set resource requests higher than the node can accommodate, write a network policy with the wrong label selector. Then diagnose and fix each failure using only kubectl commands, without looking at the manifest you wrote. This tests whether you can recover from incidents, not just whether you can write YAML.

### Senior @ FAANG: Using Exercise Scenarios as Platform Design Tests

At staff level, exercises like these are templates for platform design tests. Each exercise scenario, when scaled from one service to 300 services, reveals a platform challenge.

The production deployment exercise: at 300 services, who ensures every deployment has PDBs, topology spread constraints, and proper resource limits? The answer is admission controllers and deployment templates, not documentation.

The HPA exercise: at 300 services, how do you know which services are correctly configured with HPA and which are missing it? The answer is a compliance scan across all Deployments, surfaced in a dashboard that is reviewed as part of the platform's quarterly health review.

The network policy exercise: at 300 namespaces, how do you verify that all namespaces have default-deny policies in place? The answer is an automated audit that runs continuously and alerts on missing policies, with the platform team owning remediation of any gap.

Running through these exercises with the "300 services" lens is an effective technique for identifying platform investments. Each exercise reveals a gap that manual per-service work cannot fill at scale, and therefore a place where platform automation provides compounding returns across the entire organization.
