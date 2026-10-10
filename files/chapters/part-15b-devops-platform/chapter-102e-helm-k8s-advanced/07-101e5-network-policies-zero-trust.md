## 102E.5 Network Policies (Zero Trust)

Kubernetes Network Policies implement zero-trust networking at the pod level, replacing the default allow-all model with explicit allow rules for specific port and label combinations. The recommended starting point is a default-deny policy for all ingress and egress in a namespace, followed by targeted allow policies for each legitimate traffic flow. Without a CNI plugin that enforces Network Policies (such as Calico, Cilium, or Weave) the policies are accepted by the API server but not enforced, so validate CNI enforcement in your cluster before relying on them for security.

```yaml
# Default: deny all ingress and egress in namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: shopapp-production
spec:
  podSelector: {}  # selects all pods
  policyTypes:
    - Ingress
    - Egress
---
# Allow: shopapp-api can receive from ingress controller
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-to-api
  namespace: shopapp-production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: shopapp-api
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
          podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
      ports:
        - protocol: TCP
          port: 8080
---
# Allow: shopapp-api can connect to PostgreSQL
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-to-postgres
  namespace: shopapp-production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: shopapp-api
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: postgresql
      ports:
        - protocol: TCP
          port: 5432
    # Allow DNS resolution (required for all pods!)
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
---
# Allow: shopapp-api can connect to external Kafka
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-api-to-kafka
  namespace: shopapp-production
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: shopapp-api
  policyTypes:
    - Egress
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: messaging
          podSelector:
            matchLabels:
              app: kafka
      ports:
        - protocol: TCP
          port: 9092
```

### Junior → FAANG: Zero-Trust Networking as a First-Job Security Concept

The prerequisite gap that most junior engineers hit here: thinking that Kubernetes networking is "just like Docker networking" or assuming pods cannot talk to each other by default. The opposite is true. Without NetworkPolicy, every pod in the cluster can reach every other pod on any port. A compromised pod can probe your database, your secrets service, and your internal APIs without any barrier.

The first-job habit to build: apply a default-deny policy to every namespace you create, then add explicit allow rules only for the traffic your application actually needs. The DNS exception (port 53 UDP and TCP) is the detail that trips up most beginners. Forgetting it means your application silently cannot resolve any hostname, which shows up as mysterious connection failures rather than an obvious policy denial.

For interview preparation, be able to explain the difference between `podSelector` and `namespaceSelector`, and know that combining both in the same `from` rule creates an AND condition (the pod must match AND be in the matching namespace), while putting them in separate list items creates an OR condition. This distinction is a classic interview question because it is easy to misread the YAML.

### Senior @ FAANG: Network Policy as a Platform Security Primitive

At staff level, NetworkPolicy is not something each application team manages independently. It is a platform capability with organizational policy baked in. The questions are: who defines the base policy for each namespace tier (production vs staging vs dev), how are policies tested before they reach production, and how do you handle the operational burden of policy updates as service topologies change.

The CNI enforcement gap is a critical operational concern. NetworkPolicy objects are stored by the API server regardless of whether the CNI plugin enforces them. If the cluster is running a CNI plugin that does not enforce NetworkPolicy (such as the default `kubenet` in some managed Kubernetes offerings), every policy you apply is silently ignored. Verifying enforcement is not a one-time check. When CNI plugins are upgraded or replaced, enforcement behavior can change. Automated policy validation tests that probe denied connections and assert they fail, run in CI, are the production-grade approach.

For clusters at scale, Cilium's L7 policy capabilities extend NetworkPolicy to the application layer. Rather than allowing all traffic on port 443 from service A to service B, Cilium can enforce that only specific HTTP methods and paths are allowed. This is meaningfully stronger than port-level policy because a compromised service A cannot exfiltrate data by calling unexpected endpoints on service B. The trade-off is complexity: L7 policies require Cilium and require maintaining policy alongside application routing logic.

The audit and visibility gap is a staff-level concern that is easy to overlook. NetworkPolicy denials are not logged by the API server. Cilium provides a Hubble observability layer that records every allowed and denied connection with source, destination, and reason. Without something equivalent, a misconfigured policy that silently denies legitimate traffic becomes extremely difficult to diagnose. Building policy observability into the platform from the start, not as an afterthought, is a mark of L6/L7 platform thinking.

---
