## 98.19 Interview Questions: Kubernetes

### Fundamental Questions

**Q1: Explain the difference between a Deployment and a StatefulSet.**

Answer:
```
DEPLOYMENT vs STATEFULSET:

DEPLOYMENT:
├── Pods are interchangeable (no identity)
├── Pod names: myapp-7d6f8b8c9-abc123 (random)
├── All pods share the same PVC (if any)
├── Scale up/down in any order
├── Best for: stateless applications
└── Example: Web servers, API services

STATEFULSET:
├── Each pod has a stable identity
├── Pod names: myapp-0, myapp-1, myapp-2 (ordinal)
├── Each pod can have its own PVC
├── Scale up in order (0, 1, 2), down reverse (2, 1, 0)
├── Stable network identity (myapp-0.myapp-headless)
├── Best for: databases, distributed systems
└── Example: PostgreSQL, Kafka, Elasticsearch

USE STATEFULSET WHEN:
- Pods need stable network identities
- Pods need stable, persistent storage
- Ordered deployment/scaling is required
- Ordered, graceful deletion is required
```

**Q2: How does Kubernetes handle pod networking?**

Answer:
```
KUBERNETES NETWORKING MODEL:

FUNDAMENTAL RULES:
1. Every pod gets its own IP address
2. Pods can communicate without NAT
3. Nodes can communicate with pods without NAT
4. Pod's IP is same inside and outside the pod

COMPONENTS:

1. POD NETWORKING (CNI):
   ├── Each pod gets IP from pod CIDR
   ├── Containers in pod share network namespace
   ├── CNI plugins: Calico, Cilium, Flannel
   └── Pod-to-pod: direct routing or overlay

2. SERVICE NETWORKING:
   ├── ClusterIP: Internal virtual IP
   ├── kube-proxy maintains iptables/IPVS rules
   ├── Service → Endpoints → Pod IPs
   └── DNS: service.namespace.svc.cluster.local

3. EXTERNAL ACCESS:
   ├── NodePort: Opens port on all nodes
   ├── LoadBalancer: Cloud provider LB
   ├── Ingress: HTTP/HTTPS routing
   └── Gateway API: Advanced L4/L7 routing

TRAFFIC FLOW:
Client → Ingress → Service → Endpoints → Pod
```

### Intermediate Questions

**Q3: How do you implement zero-downtime deployments?**

Answer:
```yaml
# REQUIREMENTS FOR ZERO-DOWNTIME:

1. ROLLING UPDATE STRATEGY:
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%       # Extra pods during update
      maxUnavailable: 0   # Never below desired count

2. PROPER READINESS PROBE:
readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 5
# Pod only receives traffic when ready

3. GRACEFUL SHUTDOWN:
- Handle SIGTERM in app
- Drain connections before exit
spec:
  terminationGracePeriodSeconds: 30
  containers:
  - lifecycle:
      preStop:
        exec:
          command: ["sleep", "5"]

4. POD DISRUPTION BUDGET:
apiVersion: policy/v1
kind: PodDisruptionBudget
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: myapp

5. MULTIPLE REPLICAS:
spec:
  replicas: 3  # At minimum

DEPLOYMENT FLOW:
1. New pod created (maxSurge)
2. New pod passes readiness
3. Old pod marked for termination
4. preStop hook runs (sleep 5)
5. SIGTERM sent to container
6. App drains connections (30s)
7. Old pod removed from endpoints
8. Repeat until all updated
```

**Q4: How do you debug a pod that keeps crashing?**

Answer:
```bash
# DEBUGGING CRASHLOOPBACKOFF:

# 1. Check events
kubectl describe pod <pod-name>
# Look at Events section for errors

# 2. Check previous logs
kubectl logs <pod-name> --previous
# See what happened before crash

# 3. Check resource usage
kubectl top pod <pod-name>
# OOMKilled if exceeded memory limit

# 4. Run with shell to debug
kubectl run debug --rm -it --image=<your-image> -- sh
# Test app manually inside container

# 5. Check for missing config
kubectl get cm,secret
kubectl exec <pod> -- env

# 6. Check probe configuration
# Too aggressive probes can cause restarts
livenessProbe:
  failureThreshold: 3  # Increase if app slow to start
  initialDelaySeconds: 60

# 7. Common causes:
# - Missing environment variables
# - Wrong command/args
# - Missing config files
# - Resource limits too low
# - Probe failing during startup
# - Dependency (DB, Redis) not ready
```

### Advanced Questions

**Q5: Design a highly available Kubernetes deployment for a critical service.**

Answer:
```yaml
# HIGH AVAILABILITY DESIGN:

# 1. Multiple replicas across zones
apiVersion: apps/v1
kind: Deployment
metadata:
  name: critical-service
spec:
  replicas: 6  # 2 per AZ
  selector:
    matchLabels:
      app: critical-service
  template:
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: critical-service
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app: critical-service

# 2. Pod anti-affinity
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: critical-service
              topologyKey: kubernetes.io/hostname

# 3. Resource guarantees
      containers:
        - resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi

# 4. Pod Disruption Budget
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: critical-service-pdb
spec:
  minAvailable: 4  # Always have 4 pods
  selector:
    matchLabels:
      app: critical-service

# 5. Horizontal Pod Autoscaler
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: critical-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: critical-service
  minReplicas: 6
  maxReplicas: 30
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60

# RESULT:
# - 6+ pods always running
# - Spread across 3 AZs (2 per zone)
# - No two pods on same node
# - Scales 6→30 based on load
# - At least 4 pods during disruptions
```

**Q6: How would you implement a blue-green deployment in Kubernetes?**

Answer:
```yaml
# BLUE-GREEN DEPLOYMENT PATTERN:

# Service (traffic router)
apiVersion: v1
kind: Service
metadata:
  name: myapp
spec:
  selector:
    app: myapp
    version: blue  # Switch between blue/green
  ports:
    - port: 80
      targetPort: 8080

---
# Blue deployment (current production)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-blue
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      version: blue
  template:
    metadata:
      labels:
        app: myapp
        version: blue
    spec:
      containers:
        - name: myapp
          image: myapp:v1.0.0

---
# Green deployment (new version)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp-green
spec:
  replicas: 3
  selector:
    matchLabels:
      app: myapp
      version: green
  template:
    metadata:
      labels:
        app: myapp
        version: green
    spec:
      containers:
        - name: myapp
          image: myapp:v1.1.0

# SWITCH TRAFFIC:
kubectl patch service myapp -p '{"spec":{"selector":{"version":"green"}}}'

# INSTANT ROLLBACK:
kubectl patch service myapp -p '{"spec":{"selector":{"version":"blue"}}}'

# CLEANUP OLD VERSION:
kubectl delete deployment myapp-blue
```

### Junior → FAANG: Kubernetes Interview Preparation Strategy

Kubernetes interview questions at entry to mid level cluster around three themes: conceptual understanding (explain the Deployment controller loop), debugging scenarios (why is my pod in CrashLoopBackOff), and configuration questions (what is the difference between liveness and readiness probes). Prepare for all three.

For conceptual questions, the test is whether you can explain the system clearly to someone unfamiliar with it. Practice explaining the Pod scheduling process (API server receives Pod spec, scheduler assigns a node, kubelet on that node starts the container, status is written back to API server) in under two minutes without using jargon.

For debugging scenarios, have a mental checklist: exit code, recent events, logs, resource usage, dependency availability. Being able to apply this checklist systematically under interview pressure is the goal. Practice by deliberately breaking deployments in a local kind cluster and running through the checklist.

For configuration questions, the payoff is in understanding the consequences of each setting. Not just "what does maxUnavailable do" but "what happens to user traffic if you set maxUnavailable to 50% and the new version fails its health checks on the first half of the rollout."

### Senior @ FAANG: Bar-Raiser Kubernetes Interview Signals

At staff level, Kubernetes interview questions test architectural judgment and organizational impact, not configuration knowledge. "Design a Kubernetes platform for 200 engineering teams" tests whether you think about multi-tenancy, access control, standards governance, and operational sustainability simultaneously.

The bar-raiser patterns: unprompted consideration of failure modes and operational burden, explicit trade-off analysis (every architectural choice has a cost), reference to organizational and process concerns alongside technical ones, and evidence of actual experience at scale (specific numbers, specific incidents, specific outcomes from platform investments).

A bar-raiser response to "how would you handle Kubernetes cluster upgrades for a 500-engineer organization" covers: the full upgrade process (staging first, burn-in, production), API deprecation management (automated scanning, CI gates), the communication plan (advance notice, migration support for affected teams), the rollback criteria (what triggers aborting the production upgrade mid-way), and the organizational ownership model (who is responsible, what escalation path exists). Each of these represents real engineering and organizational work, and the ability to describe it concretely demonstrates L6/L7 operational maturity.

---
