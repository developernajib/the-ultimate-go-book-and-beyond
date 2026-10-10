## 98.2 Basic Deployment

### Deployment Manifest

A Kubernetes Deployment declaratively manages a ReplicaSet, ensuring the desired number of pod replicas are always running and that rolling updates proceed without downtime. The `resources.requests` values drive the scheduler's bin-packing decisions, a pod without requests can be scheduled onto an already-saturated node, causing OOM kills. The liveness and readiness probes serve distinct purposes: the liveness probe restarts a deadlocked container, while the readiness probe gates traffic from the Service, preventing requests from reaching a pod that has started but is not yet warmed up.

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
  labels:
    app: myapp
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
      - name: myapp
        image: myapp:1.0.0
        ports:
        - containerPort: 8080
        env:
        - name: LOG_LEVEL
          value: "info"
        resources:
          requests:
            memory: "64Mi"
            cpu: "100m"
          limits:
            memory: "256Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
```

### Service and Ingress

A `ClusterIP` Service provides a stable virtual IP and DNS name (`myapp.default.svc.cluster.local`) that survives pod restarts and re-schedules, decoupling consumers from ephemeral pod IPs. The Ingress resource sits in front of the Service and handles external HTTP/HTTPS routing: the `ssl-redirect` annotation forces TLS termination at the Nginx ingress controller, and the `tls` block references a Kubernetes Secret containing the certificate, so the Go application itself never handles TLS negotiation.

```yaml
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: myapp
spec:
  selector:
    app: myapp
  ports:
  - port: 80
    targetPort: 8080
  type: ClusterIP
---
# ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: myapp
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  rules:
  - host: myapp.example.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: myapp
            port:
              number: 80
  tls:
  - hosts:
    - myapp.example.com
    secretName: myapp-tls
```

---

### Junior → FAANG: Reading and Writing Deployment Manifests With Confidence

The YAML for a Kubernetes Deployment is verbose, but most fields have clear default values and the required fields are few: `apiVersion`, `kind`, `metadata.name`, `spec.selector`, `spec.template.metadata.labels`, and `spec.template.spec.containers`. Everything else is optional but important for production.

The habit to build: always explicitly set `resources.requests` and `resources.limits` on every container. Without requests, the scheduler places pods without knowing their resource needs and produces suboptimal placement. Without limits, a runaway container can impact other pods on the same node.

The common first-job mistake with labels: the `spec.selector.matchLabels` must match the `spec.template.metadata.labels`. If they do not match, the Deployment cannot find its own pods and the rollout either hangs or creates orphaned pods. Always verify this relationship after writing a new Deployment manifest.

### Senior @ FAANG: Deployment Strategy as an Availability Engineering Decision

At staff level, the Deployment spec is a contract for availability during deployments. The `strategy.rollingUpdate.maxUnavailable` and `maxSurge` fields define the blast radius of a bad deployment: how many instances can be broken simultaneously before the system as a whole is degraded.

For services with strict availability requirements (SLO of 99.9% or higher), the correct defaults are `maxUnavailable: 0` (never take a pod down before a new one is healthy) and `maxSurge: 1` (add one pod at a time). This produces a slow, safe rollout. For batch services or internal tooling with relaxed SLOs, more aggressive settings reduce rollout time.

The interaction between Deployment rollout strategy and the horizontal pod autoscaler is a subtle correctness concern. If HPA scales the Deployment to 20 replicas during a rollout with `maxSurge: 1`, the rollout proceeds one pod at a time and takes 20x longer than expected. Designing the rollout strategy to account for HPA-driven scale is an architectural detail that belongs in the service's deployment runbook and in the platform's deployment guide for service owners.
