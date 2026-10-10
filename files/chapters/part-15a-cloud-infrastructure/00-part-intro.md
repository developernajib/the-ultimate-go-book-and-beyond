# Part XV: Cloud & Infrastructure

*The cloud is not just someone else's computer, it's an operating system for the internet.*

---

Every Go application you build will eventually run in the cloud. Whether it is a containerized microservice on Kubernetes, a serverless function on AWS Lambda, or a globally distributed system spanning multiple cloud regions, understanding cloud infrastructure is no longer optional for backend engineers. At FAANG companies, engineers are expected to containerize their own services, define Kubernetes manifests, configure CI/CD pipelines, and provision cloud resources - the days of throwing code over the wall to an operations team are long gone.

Go has a special relationship with cloud infrastructure. Docker, Kubernetes, Terraform, Prometheus, Istio, and etcd are all written in Go. When you build cloud-native applications in Go, you are working with the same language that powers the platform itself. This gives you a unique advantage: you can read the source code of your infrastructure tools, build Kubernetes operators that extend the platform, and write infrastructure-as-code using Go-native tools like Pulumi. Understanding this ecosystem deeply is what separates a Go developer from a Go cloud engineer.

This part takes you from containerizing your first Go application to building custom Kubernetes operators and provisioning infrastructure as code. You will learn not just the mechanics of each tool, but the architectural decisions behind them - why multi-stage Docker builds matter for Go binaries, how Kubernetes scheduling affects your application's performance, and when to choose one cloud provider's service over another.

**What this part covers:**
- Chapter 97: Docker for Go Applications - containers, multi-stage builds, minimal images, and Docker Compose workflows
- Chapter 98: Kubernetes for Go Applications - deployments, services, ConfigMaps, secrets, and production configurations
- Chapter 99: CI/CD for Go Applications - pipelines with GitHub Actions, testing automation, and deployment strategies
- Chapter 100: Cloud Providers - AWS, GCP, and Azure for Go applications including compute, storage, and managed databases
- Chapter 101: Kubernetes Operators - building custom controllers that extend Kubernetes with domain-specific logic
- Chapter 102: Infrastructure as Code - Terraform and Pulumi for provisioning and managing cloud resources programmatically
- Chapter 102B: Networking Deep Dive - cloud networking, VPCs, load balancers, DNS, and service discovery
- Chapter 102N: FinOps Deep Dive - cloud cost optimization, resource right-sizing, and financial operations for engineering teams
- Chapter 102Q: Edge Computing, Serverless, and WebAssembly - edge deployment patterns and running Go at the network edge

**How to use this part:**
Start with chapters 97 through 99 in order, as Docker is a prerequisite for Kubernetes, and CI/CD ties them together into a deployment workflow. Chapter 100 provides cloud provider context that chapters 101 and 102 build upon. The remaining chapters on networking, edge computing, and FinOps can be read in any order based on your immediate needs.

**FAANG relevance:**
Cloud infrastructure knowledge is tested in every FAANG system design interview - you are expected to specify deployment topology, container orchestration strategy, and cloud service choices. On the job, you will own your service end-to-end, from Dockerfile to production Kubernetes cluster. Building operators and writing infrastructure as code are skills that distinguish L5+ engineers and are frequently listed in senior role requirements at Google, Amazon, and Meta.

---
