## 102G.6 Service Discovery - Client-Side vs Server-Side

Service discovery solves the problem of finding healthy instances of a service in a dynamic environment where pod IPs change on every restart. Client-side discovery puts the load-balancing intelligence in the calling service: it queries a service registry, receives a list of live instances, and selects one according to its own load-balancing algorithm. Server-side discovery delegates that logic to a load balancer or service mesh: the caller sends traffic to a stable virtual IP and the infrastructure routes it to a healthy instance. Kubernetes uses the server-side model via kube-proxy and CoreDNS, while service meshes like Envoy extend it with L7-aware routing.

```
Client-Side Discovery:
  Service queries registry → gets list of instances → client load-balances

  Pros: client controls load balancing algorithm
  Cons: client needs registry client library per language
  Examples: Netflix Eureka (client-side), etcd (client-side)

  Client → ServiceRegistry.Lookup("payment-service")
         → [10.0.1.5:8080, 10.0.1.6:8080, 10.0.1.7:8080]
         → Client picks one → Direct connection

Server-Side Discovery:
  Request goes to load balancer/proxy → proxy queries registry → routes

  Pros: language-agnostic, client doesn't need registry logic
  Cons: extra hop, proxy is a single point of failure
  Examples: AWS ELB + Route53, Kubernetes Service + CoreDNS, Consul + Envoy

  Client → DNS lookup "payment-service.consul"
         → Consul DNS returns IP of healthy instance
         → Direct connection
```

---

### Junior → FAANG: Knowing Which Model You Are Using and Why

Interviewers at mid-level and above will ask you to describe the service discovery model in a system you have worked on. The gap most juniors have is that they use Kubernetes Services and CoreDNS without knowing that this is server-side discovery. Being able to name the model and articulate its trade-offs is the differentiator.

The worked example: your Go service calls `http://payment-service:8080`. That DNS name resolves via CoreDNS to a ClusterIP, which kube-proxy routes to a healthy pod. You never see the pod IP. You never implement load balancing. You never query a registry. That is server-side discovery. If instead your service called the Consul API at startup to get a list of payment service instances and implemented its own round-robin, that would be client-side discovery.

First-job habit: know the DNS name format in your cluster (`service.namespace.svc.cluster.local`) and understand what happens when a pod behind that name becomes unhealthy. The answer involves the readiness probe failing, kube-proxy updating its iptables rules, and the pod being removed from the Endpoints list. That sequence is the operational detail that separates knowing the feature from understanding how it works.

Entry-point framing: when designing a new service, the default answer is server-side discovery via Kubernetes Services. Client-side discovery is justified when you need sophisticated load-balancing logic (weighted routing, latency-aware selection) that kube-proxy does not provide, or when you are running outside Kubernetes where server-side infrastructure is not available.

### Senior @ FAANG: Selecting and Evolving Service Discovery at Platform Scale

At the staff level, the client-side vs. server-side decision is made once per platform, not per service. The platform team owns the service discovery infrastructure and product teams consume it through a stable interface. The governance question is: what is the migration path when the platform changes its service discovery model?

The migration scenario is real: organizations that started with Consul for service discovery often migrate to Kubernetes-native service discovery as they standardize on Kubernetes. The migration requires: a period of dual registration (services register in both Consul and Kubernetes), traffic shifting via weighted routing, and a rollback plan if Kubernetes DNS latency is higher than the Consul DNS latency in their specific network topology. A staff engineer managing this migration owns the observability (p99 latency comparison between the two discovery paths), the success criteria (Kubernetes DNS p99 within 10% of Consul DNS p99), and the rollback trigger.

The performance dimension is important at FAANG scale. DNS-based service discovery with the default Kubernetes DNS TTL (5 seconds) creates a lag between a pod becoming unhealthy and traffic stopping being routed to it. During that window, requests fail. At high traffic volume, 5 seconds of bad routing to one pod in a fleet of 100 pods is negligible. At lower traffic volume, it may cause noticeable error spikes. A staff engineer designing service discovery for a latency-sensitive service needs to reason about this TTL-to-error-rate trade-off.

The security dimension: client-side discovery with direct pod IP connections bypasses any service-level network policies. If a network policy allows traffic from service A to service B's ClusterIP but not directly to individual pod IPs, a client-side discovery implementation that connects directly to pod IPs may bypass the policy. This is a non-obvious security implication that requires careful policy design and is a bar-raiser question in security-focused design interviews.

ADR consideration: service mesh (Istio, Linkerd) represents a third model that is neither pure client-side nor pure server-side. The sidecar proxy (Envoy) performs client-side discovery on behalf of the application, but from the application's perspective it looks like server-side because the application always connects to localhost. The trade-off is operational complexity of the sidecar injection and control plane. A platform team choosing between Kubernetes Services, Consul, and a service mesh needs to reason about operational maturity, team size, and whether the additional capabilities of a service mesh (circuit breaking, retries, mTLS) justify the complexity for their specific organization.
