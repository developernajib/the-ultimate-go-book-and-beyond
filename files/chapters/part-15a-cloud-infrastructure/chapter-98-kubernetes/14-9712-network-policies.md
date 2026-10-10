## 98.14 Network Policies

### Restricting Pod Communication

By default, Kubernetes allows unrestricted pod-to-pod communication across the entire cluster, any pod can reach any other pod on any port. The two-policy pattern below enforces a default-deny stance by first blocking all ingress and egress for every pod in the namespace, then carving out precise allow rules only for the `go-service`. This zero-trust approach means a compromised pod cannot pivot to other services, databases, or external endpoints unless explicitly permitted, significantly containing the blast radius of a breach.

```yaml
# network-policies/deny-all.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-all
  namespace: production
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
---
# network-policies/go-service.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: go-service-policy
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: go-service
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow from ingress controller
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
      ports:
        - protocol: TCP
          port: 8080
    # Allow from other services in same namespace
    - from:
        - podSelector:
            matchLabels:
              app: api-gateway
      ports:
        - protocol: TCP
          port: 8080
    # Allow Prometheus scraping
    - from:
        - namespaceSelector:
            matchLabels:
              name: monitoring
        - podSelector:
            matchLabels:
              app: prometheus
      ports:
        - protocol: TCP
          port: 8080
  egress:
    # Allow DNS
    - to:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
    # Allow PostgreSQL
    - to:
        - podSelector:
            matchLabels:
              app: postgresql
      ports:
        - protocol: TCP
          port: 5432
    # Allow Redis
    - to:
        - podSelector:
            matchLabels:
              app: redis
      ports:
        - protocol: TCP
          port: 6379
    # Allow external HTTPS
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - protocol: TCP
          port: 443
```

### Junior → FAANG: Network Policies as Micro-Segmentation Fundamentals

Without network policies, every pod in a Kubernetes cluster can communicate with every other pod by default. This flat network model is operationally simple but is a security risk: a compromised pod can attempt to reach any other service in the cluster, including services it has no business reason to access.

Network policies implement micro-segmentation: each policy specifies which pods can communicate with which other pods on which ports. The default-deny pattern (apply a policy that denies all ingress and egress, then apply specific allow policies for required communication paths) is the production baseline for any service that handles sensitive data.

First-job habit: when you draw the dependency graph of your service (which services does it call, which services call it), translate each edge in the graph into a network policy rule. The dependency graph is the specification for the network policy set. If you cannot draw the dependency graph, you do not have enough information to write correct network policies.

### Senior @ FAANG: Network Policy at Scale and CNI Constraints

At staff level, network policy management is a scale problem. A cluster with 200 namespaces and 1,000 services, each with correct default-deny policies and specific allow rules, has thousands of NetworkPolicy objects. Managing them manually is error-prone and unsustainable. The platform solution is automated policy generation from a service dependency declaration and automated audit of the live policies against the declared dependencies.

The CNI constraint is important: not all CNI plugins enforce NetworkPolicy. Flannel does not support NetworkPolicy at all. Calico, Cilium, and Weave support it. The CNI choice is a cluster-level decision made at cluster creation time and is expensive to change later. The platform ADR for CNI choice must include explicit coverage of NetworkPolicy support requirements.

Cilium extends NetworkPolicy significantly with CiliumNetworkPolicy (Layer 7 policies that can filter by HTTP method, path, and headers, or by Kafka topic) and uses eBPF for enforcement rather than iptables rules. At large pod counts, iptables-based policy enforcement scales poorly (O(n) rule evaluation per packet, where n is the number of policies). eBPF-based enforcement is O(1) and is a meaningful performance advantage at cluster scale. The staff engineer evaluating CNI options should include a quantitative assessment of the expected policy count and the per-packet latency overhead of each enforcement approach.

---
