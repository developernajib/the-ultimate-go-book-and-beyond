# Part XVB: DevOps & Platform Engineering

*The future of ops is platform engineering, making it easy for developers to do the right thing.*

---

In 2026, knowing Terraform, ArgoCD, and Helm is as fundamental to a senior backend engineer as knowing Git. Over 80% of large engineering organizations now have dedicated platform engineering teams building Internal Developer Platforms, and the engineers who build and operate these platforms command some of the highest salaries in the industry. At FAANG companies, senior engineers are expected to provision infrastructure, set up deployment pipelines, manage Kubernetes clusters, and define the golden paths that make their entire team productive - not just write application code.

Platform engineering represents the evolution of DevOps into a product-oriented discipline. Instead of every team building their own deployment pipeline and Kubernetes configurations from scratch, platform teams provide self-service infrastructure that abstracts away complexity while preserving flexibility. This is how Netflix enables thousands of deployments per day, how Google manages millions of containers across its fleet, and how Spotify empowers autonomous squads to ship independently. The platform is the product, and the developers are the customers.

Go is the dominant language in this space. Kubernetes, Terraform providers, ArgoCD, Helm, Prometheus, and Backstage plugins are all built with or deeply integrated into the Go ecosystem. When you build platform tooling in Go, you are working in the same language as the infrastructure itself, giving you the ability to extend, customize, and debug at every layer of the stack.

**What this part covers:**
- Chapter 102C: Terraform & IaC Deep Dive - HCL mastery, module design, state management, Pulumi with Go, and infrastructure testing
- Chapter 102D: GitOps & Deployment Strategies - ArgoCD, FluxCD, canary deployments, blue/green rollouts, and automated rollback
- Chapter 102E: Helm & Kubernetes Advanced - chart development, Custom Resource Definitions, HPA/VPA/KEDA autoscaling, and network policies
- Chapter 102F: Platform Engineering - Internal Developer Platforms, Backstage integration, golden paths, and self-service infrastructure
- Chapter 102G: Container Security & Service Discovery - image scanning, rootless containers, OPA policy enforcement, Consul, and service mesh patterns
- Chapter 102O: Monorepo & Build Systems - monorepo strategies, Bazel, build caching, and dependency management at scale

**How to use this part:**
Start with chapter 102C on Terraform and infrastructure as code, as it provides the foundational IaC concepts that all subsequent chapters build upon. Chapter 102D on GitOps naturally follows, connecting IaC to automated deployment workflows. Chapter 102E deepens your Kubernetes expertise, which chapters 102F and 102G then build on for platform engineering and security topics. The monorepo chapter is independent and can be read at any point.

**FAANG relevance:**
Platform engineering skills are explicitly tested in FAANG infrastructure and SRE interviews, and increasingly in general backend interviews at L5+. You will be asked to design deployment pipelines, explain rollback strategies, and architect self-service infrastructure platforms. On the job, senior engineers are expected to define Terraform modules, configure ArgoCD applications, write Helm charts, and contribute to the internal platform that accelerates their entire organization. These are the skills that distinguish infrastructure-literate engineers from those who only know application code.

---
