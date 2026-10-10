# Chapter 98: Kubernetes for Go Applications

> *"Kubernetes has become the Linux of the cloud - the substrate everything else runs on top of. Understanding it is no longer optional for a backend engineer."*

Kubernetes has fundamentally changed how production software is deployed, scaled, and operated. What began as Google's internal cluster management system - refined over a decade of running services at planetary scale - is now the de facto orchestration platform for containerized workloads worldwide. For Go engineers, Kubernetes is both an operational environment to target and a deeply programmable platform to extend. The Go client library for Kubernetes is the canonical way to interact with the API, and the entire Kubernetes ecosystem - from Helm to Argo to Prometheus - is written in Go and designed to be extended in Go.

Deploying a Go application to Kubernetes involves far more than writing a YAML manifest. You need to understand how Deployments manage rolling updates and rollback strategies, how Services abstract over ephemeral pod IPs to give stable network identities, and how Ingress or Gateway API objects route external traffic with TLS termination and host-based routing. ConfigMaps and Secrets decouple configuration from images. Horizontal Pod Autoscalers respond to CPU, memory, or custom metrics to scale your fleet dynamically as traffic grows. RBAC policies define exactly which service accounts can read, write, or delete which resources - critical for multi-tenant clusters. Network Policies govern which pods can communicate with which other pods, implementing a zero-trust network model inside the cluster.

Go's operational characteristics make it an excellent fit for Kubernetes: fast startup times satisfy liveness probe deadlines, low memory footprints allow high pod density per node, and graceful shutdown via `os.Signal` handling integrates cleanly with Kubernetes' SIGTERM-based termination lifecycle. This chapter covers everything from writing your first Deployment manifest to debugging a crashing pod in production using `kubectl exec`, `kubectl logs`, and ephemeral debug containers - giving you the full operational picture you need to run Go services reliably on Kubernetes.

**What you'll learn in this chapter:**

- How to write production-grade Deployment, Service, and Ingress manifests for Go applications, including rolling update strategies and pod disruption budgets
- How to implement liveness, readiness, and startup probes in Go that correctly signal pod health to the Kubernetes control plane
- How to manage application configuration and sensitive credentials using ConfigMaps and Secrets with proper volume mounts and env injection
- How to configure Horizontal Pod Autoscalers backed by CPU, memory, and custom Prometheus metrics for dynamic scaling
- How to define RBAC Roles and ClusterRoles that give your Go services least-privilege access to Kubernetes API resources
- How to enforce zero-trust networking with NetworkPolicy resources that restrict pod-to-pod traffic to explicitly declared paths
- How to debug crashing or misbehaving pods using `kubectl` commands, ephemeral debug containers, and Go's `pprof` endpoints
- How to implement graceful shutdown in Go that correctly handles Kubernetes SIGTERM signals and drains in-flight requests

**Why this matters at scale:**

Airbnb has documented running thousands of services on Kubernetes, and the pattern repeats across the industry: the orchestrator itself is Go, the controllers extending it are Go, and an ever-growing share of the workloads on it are Go. Teams that complete the migration consistently report the same shape of win - lower operational overhead and deployment frequency improving from weekly to multiple times per day. GitHub (now Microsoft-owned) runs its critical API services on Kubernetes with Go, handling over 100 million API requests daily. Pinterest uses Kubernetes HPA backed by custom metrics to handle 10x traffic spikes during viral events, a pattern made possible by Go's minimal startup overhead.

**Prerequisites:** Chapter 96 (Docker for Go), basic familiarity with YAML, and access to a Kubernetes cluster (minikube, kind, or a managed cloud cluster).

---

### Junior → FAANG: What Kubernetes Actually Solves

Many engineers approach Kubernetes as a more complex version of Docker Compose. That framing leads to unnecessary complexity and missed value. Kubernetes solves a different problem: running many containers across many machines with automated scheduling, self-healing, and declarative configuration management.

The key concepts to anchor first: Pods are the atomic unit (one or more containers that share a network and storage), Deployments manage rolling updates and replica sets, Services provide stable network endpoints despite pod IPs changing, and ConfigMaps and Secrets decouple configuration from the container image. Everything else builds on these four.

First-job habit: always use `kubectl explain <resource>` before searching the internet. It gives the authoritative documentation for the API version your cluster actually runs, including field descriptions and examples. Developing this habit early prevents the common mistake of copying YAML from a tutorial that targets a different API version.

### Senior @ FAANG: Kubernetes as Organizational Infrastructure

At staff level, Kubernetes is not a tool for individual teams. It is organizational infrastructure, and the decisions made in its configuration have org-wide consequences. The cluster configuration decisions that belong in ADRs: CNI plugin choice (Calico versus Cilium versus others, with implications for network policy support, eBPF capabilities, and operational complexity), admission controller stack (which policy frameworks are installed, what the default behavior is), storage class configuration (default class, retention policy, encryption), and node configuration (instance types, OS image, kernel parameters).

The governance question at L6/L7 is: who is allowed to do what in the cluster? RBAC at the organizational level means a namespace-per-team model with clearly scoped permissions, no team with cluster-admin rights except the platform team, and audit logging of all sensitive operations (secret reads, role bindings changes, privileged pod creation). Designing this access model and getting it adopted across the organization is a multi-quarter engineering effort with significant organizational change management required, which is squarely in the staff engineer responsibility space.
