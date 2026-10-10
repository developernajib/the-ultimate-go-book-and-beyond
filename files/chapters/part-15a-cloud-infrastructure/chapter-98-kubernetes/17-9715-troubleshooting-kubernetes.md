## 98.17 Troubleshooting Kubernetes

### Common Issues and Solutions

Kubernetes problems generally fall into four categories: pods that refuse to start, pods that start but misbehave, networking faults, and resource exhaustion. Each category has a characteristic set of status conditions and `kubectl` commands that expose the root cause quickly. The decision tree below maps each symptom to the most targeted diagnostic command, helping you avoid trial-and-error and reach a resolution in fewer steps.

```
┌──────────────────────────────────────────────────────────────────┐
│                KUBERNETES TROUBLESHOOTING                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  POD WON'T START:                                                │
│  ├── kubectl describe pod <name> - Check events                  │
│  ├── kubectl logs <pod> --previous - See crash logs              │
│  ├── Common causes:                                              │
│  │   ├── ImagePullBackOff - Wrong image/no auth                  │
│  │   ├── CrashLoopBackOff - App crashes on start                 │
│  │   ├── Pending - No node resources/affinity                    │
│  │   └── Init:Error - Init container failed                      │
│                                                                  │
│  POD RUNNING BUT NOT WORKING:                                    │
│  ├── kubectl exec -it <pod> -- sh - Debug inside                 │
│  ├── kubectl port-forward <pod> 8080:8080 - Test locally         │
│  ├── Common causes:                                              │
│  │   ├── Wrong env vars/config                                   │
│  │   ├── Network policy blocking                                 │
│  │   └── Service misconfigured                                   │
│                                                                  │
│  NETWORKING ISSUES:                                              │
│  ├── kubectl get svc,ep - Check endpoints                        │
│  ├── kubectl run test --rm -it --image=busybox -- sh             │
│  │   └── nslookup <service> - Test DNS                           │
│  │   └── wget <service>:port - Test connectivity                 │
│  ├── Common causes:                                              │
│  │   ├── Service selector doesn't match pods                     │
│  │   ├── NetworkPolicy blocking traffic                          │
│  │   └── Pod not ready (failing readiness)                       │
│                                                                  │
│  RESOURCE ISSUES:                                                │
│  ├── kubectl top pods - Resource usage                           │
│  ├── kubectl describe node - Node capacity                       │
│  ├── Common causes:                                              │
│  │   ├── OOMKilled - Memory limit too low                        │
│  │   ├── CPU throttling - CPU limit too low                      │
│  │   └── Evicted - Node under pressure                           │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Debug Commands Reference

Having a reliable set of `kubectl` one-liners reduces mean time to resolution significantly. The commands below cover the most common investigation steps: inspecting pod events and logs, forwarding ports for local testing, probing DNS and connectivity from an ephemeral netshoot pod, and validating RBAC permissions for a service account. Running `kubectl get events --sort-by='.lastTimestamp'` is often the fastest way to see what the control plane noticed most recently.

```bash
# Pod debugging
kubectl describe pod <pod>
kubectl logs <pod> -c <container>
kubectl logs <pod> --previous
kubectl exec -it <pod> -- sh
kubectl port-forward <pod> 8080:8080

# Service debugging
kubectl get endpoints <service>
kubectl describe svc <service>

# Run debug pod
kubectl run debug --rm -it --image=nicolaka/netshoot -- sh

# Inside debug pod:
nslookup <service>
curl <service>:80
tcpdump -i any port 80

# Check events
kubectl get events --sort-by='.lastTimestamp'

# Resource usage
kubectl top pods
kubectl top nodes

# Check RBAC
kubectl auth can-i --list --as=system:serviceaccount:default:myapp

# Dry run to validate manifests
kubectl apply --dry-run=client -f deployment.yaml
kubectl apply --dry-run=server -f deployment.yaml
```

### Go Debug Container

When `kubectl exec` and log inspection are not enough, you need a container image that carries full debugging tooling alongside a Go binary built with debug symbols intact. This Dockerfile starts from the Go Alpine image, adds network utilities (`curl`, `netcat`, `tcpdump`), installs Delve, and compiles the server with `-gcflags="all=-N -l"` to disable optimizations and inlining. The resulting container exposes port 2345 for a remote Delve session so you can attach from VS Code or any DAP-compatible editor without modifying the cluster.

```dockerfile
# Dockerfile.debug
FROM golang:1.27.1-alpine

# Install debugging tools
RUN apk add --no-cache curl wget netcat-openbsd bind-tools tcpdump strace

# Install delve
RUN go install github.com/go-delve/delve/cmd/dlv@latest

# Install kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && mv kubectl /usr/local/bin/

WORKDIR /app
COPY . .

# Build with debug symbols
RUN go build -gcflags="all=-N -l" -o /app/server ./cmd/server

EXPOSE 8080 2345

CMD ["dlv", "--listen=:2345", "--headless=true", "--api-version=2", "exec", "/app/server"]
```

### Junior → FAANG: A Systematic Debugging Process That Works Every Time

Kubernetes debugging is easiest with a fixed investigation sequence that you follow every time, regardless of the specific symptom. The sequence: (1) `kubectl get pod <name> -o wide` to see the pod's node, IP, and status. (2) `kubectl describe pod <name>` to see events, which usually contain the specific error. (3) `kubectl logs <name>` (or `kubectl logs <name> --previous` for crash loops) to see application output. (4) `kubectl get events --sort-by=.lastTimestamp -n <namespace>` to see cluster-level events. (5) Check node conditions if the pod is in Pending state.

This sequence catches 90% of common issues. The remaining 10% require network debugging (can the pod reach its dependencies?) or control plane debugging (is the API server healthy, are controllers running?). Having the sequence memorized and executed automatically under pressure is the skill that makes an on-call engineer effective.

The most underused tool in the sequence is `kubectl describe`. Its Events section contains exactly the error that Kubernetes encountered, in human-readable form. Reading it carefully before trying anything else saves significant time.

### Senior @ FAANG: Troubleshooting Infrastructure and Incident Response Design

At staff level, troubleshooting Kubernetes is a process design problem. When an incident happens, the outcome should not depend on which engineer is on call or how much Kubernetes expertise they have. The outcome should be determined by the quality of the runbooks, dashboards, and automated diagnostics available.

The investment that pays off most during incidents: pre-built dashboards that answer specific diagnostic questions visually. "Is this pod OOM killed?" should be answered by a dashboard, not by memorizing the right kubectl command. "Is the HPA scaled to max replicas?" should be a Grafana panel, not an investigation step. Building these dashboards before incidents happen, testing them by simulating failures in staging, and making them part of the standard runbook is an L6/L7 observability engineering contribution.

For complex platform-level issues (API server latency spike, etcd cluster instability, node-level resource exhaustion), the troubleshooting process requires cluster-level observability that most application-focused engineers do not have access to. The platform team's responsibility is to maintain runbooks for these cluster-level failures, test them periodically (game days, chaos engineering), and ensure that the on-call escalation path from application incidents to cluster incidents is clear and well-documented.

---
