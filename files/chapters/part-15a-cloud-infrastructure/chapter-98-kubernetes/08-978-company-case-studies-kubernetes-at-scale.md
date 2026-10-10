## 98.8 Company Case Studies: Kubernetes at Scale

### Google: The Birthplace of Kubernetes

Google created Kubernetes based on 15+ years of experience running containers with Borg, open-sourcing it in 2014 to share the operational patterns that enabled them to run millions of containers reliably. Google's Kubernetes deployments follow a set of best practices distilled from Borg: resource limits on every container, pod disruption budgets for safe rolling updates, and workload identity instead of long-lived service account keys. The YAML below reflects the production manifest style used across Google's GKE-hosted services.

```yaml
# Google-style deployment with best practices
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-service
  labels:
    app.kubernetes.io/name: go-service
    app.kubernetes.io/version: "1.0.0"
    app.kubernetes.io/managed-by: kubernetes
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 0  # Zero-downtime deployments
  selector:
    matchLabels:
      app.kubernetes.io/name: go-service
  template:
    metadata:
      labels:
        app.kubernetes.io/name: go-service
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
    spec:
      serviceAccountName: go-service
      securityContext:
        runAsNonRoot: true
        fsGroup: 65534
      containers:
      - name: go-service
        image: gcr.io/project/go-service:v1.0.0
        imagePullPolicy: IfNotPresent
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          runAsNonRoot: true
          capabilities:
            drop: ["ALL"]
        ports:
        - containerPort: 8080
          protocol: TCP
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        livenessProbe:
          httpGet:
            path: /healthz
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 10"]
      terminationGracePeriodSeconds: 30
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app.kubernetes.io/name: go-service
```

**Key Google Patterns**:
- Zero-downtime deployments with `maxUnavailable: 0`
- Pod disruption budgets for high availability
- Topology spread constraints for zone distribution
- Strict security contexts (non-root, read-only filesystem)

### Uber: 4,000+ Microservices on Kubernetes

Uber runs one of the largest Kubernetes deployments with Go microservices:

```go
// Uber-style health check with dependency tracking
package health

import (
    "context"
    "encoding/json"
    "net/http"
    "sync"
    "time"
)

type DependencyStatus struct {
    Name    string `json:"name"`
    Healthy bool   `json:"healthy"`
    Latency string `json:"latency,omitempty"`
    Error   string `json:"error,omitempty"`
}

type HealthResponse struct {
    Status       string             `json:"status"`
    Version      string             `json:"version"`
    Uptime       string             `json:"uptime"`
    Dependencies []DependencyStatus `json:"dependencies"`
}

type HealthChecker struct {
    startTime    time.Time
    version      string
    dependencies []DependencyCheck
    mu           sync.RWMutex
}

type DependencyCheck struct {
    Name  string
    Check func(context.Context) error
}

func (h *HealthChecker) ReadinessHandler(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    var deps []DependencyStatus
    allHealthy := true

    for _, dep := range h.dependencies {
        start := time.Now()
        err := dep.Check(ctx)
        latency := time.Since(start)

        status := DependencyStatus{
            Name:    dep.Name,
            Healthy: err == nil,
            Latency: latency.String(),
        }
        if err != nil {
            status.Error = err.Error()
            allHealthy = false
        }
        deps = append(deps, status)
    }

    response := HealthResponse{
        Status:       "healthy",
        Version:      h.version,
        Uptime:       time.Since(h.startTime).String(),
        Dependencies: deps,
    }

    if !allHealthy {
        response.Status = "degraded"
        w.WriteHeader(http.StatusServiceUnavailable)
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(response)
}
```

**Uber's Kubernetes Practices**:
- Dedicated clusters per business domain
- Custom autoscaler based on business metrics
- Canary deployments with traffic shifting
- Extensive pod anti-affinity rules

### Netflix: Container Orchestration with Titus

Netflix runs Titus (built on Kubernetes) for their Go services:

```yaml
# Netflix-style deployment with Titus patterns
apiVersion: apps/v1
kind: Deployment
metadata:
  name: streaming-service
  annotations:
    netflix.com/team: platform
    netflix.com/oncall: streaming-oncall
spec:
  replicas: 10
  selector:
    matchLabels:
      app: streaming-service
  template:
    metadata:
      annotations:
        # Netflix chaos engineering annotations
        chaosmonkey.netflix.com/enabled: "true"
        chaosmonkey.netflix.com/group: streaming
    spec:
      containers:
      - name: streaming-service
        image: netflix/streaming-service:v1.0.0
        resources:
          requests:
            cpu: "2"
            memory: 4Gi
          limits:
            cpu: "4"
            memory: 8Gi
        env:
        - name: NETFLIX_ENVIRONMENT
          value: production
        - name: NETFLIX_REGION
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['topology.kubernetes.io/region']
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                app: streaming-service
            topologyKey: kubernetes.io/hostname
```

### Stripe: Financial-Grade Kubernetes

Stripe's Kubernetes deployment prioritizes reliability and security:

```yaml
# Stripe-style deployment with strict security
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments-service
  namespace: payments
spec:
  replicas: 5
  selector:
    matchLabels:
      app: payments-service
  template:
    metadata:
      labels:
        app: payments-service
        pci-scope: "true"
    spec:
      serviceAccountName: payments-service
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: payments-service
        image: stripe/payments-service:v1.0.0
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
        volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: vault-secrets
          mountPath: /secrets
          readOnly: true
      volumes:
      - name: tmp
        emptyDir: {}
      - name: vault-secrets
        csi:
          driver: secrets-store.csi.k8s.io
          readOnly: true
          volumeAttributes:
            secretProviderClass: vault-payments
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payments-service-pdb
spec:
  minAvailable: 80%
  selector:
    matchLabels:
      app: payments-service
```

### Amazon: EKS Best Practices

Amazon's EKS patterns for Go microservices:

```yaml
# AWS EKS deployment with Karpenter autoscaling
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-gateway
  annotations:
    eks.amazonaws.com/compute-type: ec2
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
      serviceAccountName: api-gateway
      containers:
      - name: api-gateway
        image: 123456789.dkr.ecr.us-west-2.amazonaws.com/api-gateway:v1.0.0
        ports:
        - containerPort: 8080
        env:
        - name: AWS_REGION
          value: us-west-2
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 1Gi
      nodeSelector:
        karpenter.sh/provisioner-name: default
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: topology.kubernetes.io/zone
        whenUnsatisfiable: ScheduleAnyway
        labelSelector:
          matchLabels:
            app: api-gateway
---
# Karpenter NodePool (v1 API - replaces deprecated Provisioner/v1alpha5)
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: default
spec:
  template:
    spec:
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default
  limits:
    cpu: 1000
    memory: 1000Gi
  disruption:
    consolidateAfter: 30s
```

**Key Takeaways from Top Companies**:

| Company | Focus Area | Key Pattern |
|---------|-----------|-------------|
| Google | Security | Non-root containers, read-only filesystems |
| Uber | Scale | Custom autoscaling, domain-based clusters |
| Netflix | Resilience | Chaos engineering, zone distribution |
| Stripe | Compliance | PCI scoping, secrets management |
| Amazon | Efficiency | Karpenter, spot instances, ARM64 |

---

### Junior → FAANG: Extracting Transferable Lessons From Scale Case Studies

The Kubernetes case studies from Google, Stripe, and others operate at scales that are 100x to 10,000x what most engineers will encounter in their first few years. The risk of reading them uncritically is assuming that their solutions are appropriate for any scale.

The transferable lessons are in the categories of problems, not the specific solutions. Multi-tenancy isolation (how do you prevent one team's misconfiguration from affecting another team's service) is a problem at any scale above 5-10 teams. Autoscaling accuracy (CPU utilization is a poor proxy for load in I/O-bound services) applies to any team with variable traffic. Compliance scoping (PCI, SOC 2, HIPAA requirements constrain which workloads can run together) is a problem any company in a regulated industry faces regardless of scale.

For interviews, citing these case studies demonstrates awareness of production reality, but the impressive answer includes "and here is how I would adapt that pattern for an earlier-stage company with fewer resources and simpler requirements."

### Senior @ FAANG: Platform Maturity and the Kubernetes Platform Investment Curve

At staff level, Kubernetes case studies map to a platform maturity investment curve. The early stage is getting workloads running consistently with basic resource management and health checks. The middle stage is reliability engineering: HPA, PodDisruptionBudgets, topology spread constraints, and graduated rollouts. The late stage is efficiency and compliance engineering: cost optimization (Karpenter, spot instances, VPA-based right-sizing), multi-cluster federation, and policy-based governance.

The staff engineer responsibility is to assess where the organization is on this curve, make the case for the next stage investment (with specific risk reduction or cost reduction as the justification), and design the migration path from the current state to the target state without disrupting running services.

The Stripe example of PCI scoping is a particularly instructive case for regulated industries. The technical decision (use separate node pools with taints and tolerations to prevent PCI-scoped workloads from co-locating with non-PCI workloads) is straightforward once the requirement is understood. The organizational challenge is getting the security team, the compliance team, and the engineering teams to agree on what "PCI scoped" means and which workloads fall in scope. That cross-functional alignment is the staff engineer's contribution, not the YAML that implements it.
