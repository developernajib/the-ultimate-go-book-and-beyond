# Chapter 101: Kubernetes Operators - Building Custom Controllers

> *"An operator is the encoding of operational knowledge into software. It's how you teach Kubernetes to run your application the way your best engineer would - consistently, tirelessly, at 3 AM."*

The Kubernetes operator pattern is one of the most powerful ideas in modern infrastructure engineering: encoding the operational knowledge of a domain expert - how to deploy, scale, backup, upgrade, and recover a specific piece of software - into a Kubernetes controller that runs that playbook automatically. Operators extend the Kubernetes API with Custom Resource Definitions (CRDs) that introduce new resource types tailored to your domain. A `PostgresCluster` resource, a `KafkaTopic` resource, a `TenantEnvironment` resource - these are domain-specific abstractions that make the Kubernetes API speak the language of your business, not just the language of pods and services.

Building operators in Go with `controller-runtime` and Kubebuilder is the canonical approach, and for good reason: the entire Kubernetes control plane is written in Go, the client-go library is the reference implementation for API interaction, and Go's goroutine model maps naturally onto the concurrent, event-driven architecture of a reconciler. The reconcile loop - the heart of every operator - is elegantly simple in principle: given the desired state declared in a Custom Resource, observe the actual state of the world, compute the diff, and take actions to converge them. In practice, implementing a production-grade reconciler requires understanding watch caches, optimistic concurrency with resource versions, exponential backoff on errors, finalizer-based cleanup, and status subresource updates.

Admission webhooks - validating and mutating - add another dimension: intercepting API requests before they are persisted to etcd, enforcing invariants, injecting defaults, and rejecting resources that violate policy. Operators with webhooks can enforce organization-wide standards (every Pod must have resource limits, every Deployment must have a PodDisruptionBudget) as compile-time-style checks at admission time, not runtime surprises. This chapter takes you from scaffolding your first operator project with Kubebuilder through implementing a fully functional, production-ready operator with CRDs, a reconcile loop, finalizers, status conditions, and admission webhooks.

**What you'll learn in this chapter:**

- How to scaffold a complete operator project using Kubebuilder, including CRD API types with proper validation markers and status subresources
- How to implement a reconcile loop in `controller-runtime` that correctly handles create, update, and delete events with idempotent convergence logic
- How to use controller-runtime's fake client and `envtest` to write unit and integration tests for reconcilers without a live Kubernetes cluster
- How to implement finalizers that block resource deletion until cleanup logic (database teardown, DNS deregistration, certificate revocation) completes safely
- How to write validating and mutating admission webhooks in Go that enforce policy at request time with structured, actionable error messages
- How to manage operator permissions using aggregated ClusterRoles and configure leader election for high-availability operator deployments
- How to emit Kubernetes Events and manage Status Conditions on Custom Resources to give operators and users clear visibility into reconciliation progress
- How to package and distribute operators using OLM (Operator Lifecycle Manager) and OperatorHub for enterprise deployment workflows

**Why this matters at scale:**

Red Hat's OpenShift platform is built almost entirely on Go operators - over 100 operators manage every component of the OpenShift cluster lifecycle, from etcd backups to machine provisioning. Zalando runs the Postgres Operator in production, managing hundreds of PostgreSQL clusters across Kubernetes with automated failover, backups, and rolling upgrades - all encoded in Go reconcilers. The Prometheus Operator, used by thousands of organizations to manage monitoring infrastructure, pioneered many of the patterns now formalized in controller-runtime. Elastic, Confluent, and MongoDB all distribute their flagship products as Kubernetes operators written in Go, replacing complex runbooks with declarative Custom Resources.

**Prerequisites:** Chapters 96-97 (Docker and Kubernetes), understanding of Go interfaces and goroutines from Parts 2-3, and a running Kubernetes cluster (kind recommended for local development).

---

### Junior → FAANG: What Operators Are and When to Consider Building One

Operators are an advanced topic. Before building one, you need solid foundational Kubernetes knowledge (Deployments, Services, ConfigMaps, health checks, RBAC), Go concurrency skills (goroutines, channels, context), and a clear understanding of the problem you are solving. Attempting to build an operator without these foundations produces code that is hard to test, hard to debug, and operationally fragile.

The prerequisite understanding: an operator is a Kubernetes controller plus a Custom Resource Definition. A controller is a reconcile loop: watch for resources, compare desired state to actual state, take corrective action. The `controller-runtime` framework handles the watch, queue, and loop plumbing. Your code provides the reconcile logic. This separation of concerns is what makes operators testable.

For first-job engineers, the most valuable operator interaction is using existing operators (cert-manager, External Secrets Operator, Argo CD application controller) and understanding what they do from a user perspective before attempting to write one.

### Senior @ FAANG: Operators as Infrastructure Automation Products

At staff level, writing an operator is a product decision. The question is not "can we build an operator for this" but "is an operator the right mechanism for automating this operational concern, and what is the long-term maintenance commitment?"

Operators have high implementation and maintenance costs: the controller logic, the CRD schema and versioning, the webhook validation, the RBAC configuration, the observability, the documentation, and the upgrade procedures all require ongoing engineering investment. This investment is justified when the operator automates a task that would otherwise require expert human judgment, is performed frequently, and benefits from the Kubernetes-native interface (kubectl, GitOps, resource event integration).

The bar-raiser question for any operator proposal: what is the lifecycle of this operator? Who owns it? How is it upgraded when the Kubernetes API changes? What is the runbook for operator failure? A proposal that cannot answer these questions is not ready for production, regardless of how elegant the reconcile logic is. Owning the process of answering these questions is a staff engineer's contribution to preventing infrastructure debt.
