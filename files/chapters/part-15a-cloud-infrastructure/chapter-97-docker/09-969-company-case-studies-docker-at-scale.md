## 97.9 Company Case Studies: Docker at Scale

### Google: Containerization Pioneer

Google was running containers long before Docker existed. Their internal system called Borg orchestrated billions of containers per week, and the lessons learned from Borg directly inspired the creation of Kubernetes, which Google open-sourced in 2014. Google's Go services use distroless base images and enforce strict security policies including non-root execution and binary authorization for all production workloads.

```
GOOGLE CONTAINER INFRASTRUCTURE:

┌──────────────────────────────────────────────────────────────────┐
│  GOOGLE'S CONTAINER HISTORY                                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  BEFORE DOCKER (2000s-2013):                                     │
│  ├── Borg: Google's internal container orchestrator              │
│  ├── Process containers (cgroups - contributed to Linux)         │
│  ├── Running billions of containers weekly                       │
│  └── Docker inspired by Google's container technology            │
│                                                                  │
│  KUBERNETES (2014-Present):                                      │
│  ├── Open-sourced Borg concepts as Kubernetes                    │
│  ├── Now standard for container orchestration                    │
│  ├── GKE: Managed Kubernetes on Google Cloud                     │
│  └── Autopilot: Fully managed K8s nodes                          │
│                                                                  │
│  GO SERVICES AT GOOGLE:                                          │
│  ├── Many internal services written in Go                        │
│  ├── Small container images (scratch + static Go binary)         │
│  ├── Fast startup times critical for autoscaling                 │
│  └── Distroless images for production security                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

GOOGLE DOCKER BEST PRACTICES:
- Use distroless base images (gcr.io/distroless/static)
- Non-root containers mandatory
- Image scanning in CI/CD pipeline
- Container image signing with Binary Authorization
```

### Uber: Microservices at Scale

Uber operates over 4,000 microservices, the majority written in Go, all running in containers. They enforce a standardized Dockerfile template across all Go services that mandates multi-stage builds, static binaries with `CGO_ENABLED=0`, and a maximum image size target of 50MB. This consistency across thousands of services makes their build pipeline predictable and their deployments fast.

```
UBER CONTAINERIZATION PATTERNS:

┌──────────────────────────────────────────────────────────────────┐
│  UBER'S GO + DOCKER STACK                                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  SCALE:                                                          │
│  ├── 4,000+ microservices                                        │
│  ├── Majority written in Go                                      │
│  ├── Millions of containers running                              │
│  └── Peakr: Internal container platform                          │
│                                                                  │
│  STANDARD GO DOCKERFILE AT UBER:                                 │
│  ├── Multi-stage builds mandatory                                │
│  ├── CGO_ENABLED=0 for static binaries                           │
│  ├── Scratch or distroless base                                  │
│  ├── Build-time version injection                                │
│  └── Standard healthcheck patterns                               │
│                                                                  │
│  OPTIMIZATION PATTERNS:                                          │
│  ├── BuildKit for faster builds                                  │
│  ├── Layer caching with dependency separation                    │
│  ├── Multi-arch builds for ARM support                           │
│  └── Image size < 50MB target for Go services                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

UBER DOCKERFILE TEMPLATE:
FROM golang:1.27.1-alpine AS builder
ARG VERSION
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w -X main.Version=${VERSION}" -o /app/service

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /app/service /service
USER nonroot:nonroot
ENTRYPOINT ["/service"]
```

### Netflix: Container Security Focus

Netflix takes a security-first approach to containerization, blocking deployments when critical CVEs are detected in image scans. Their internal container platform, Titus, manages thousands of applications running on AWS and uses Go services for its control plane. Netflix enforces non-root containers, read-only filesystems, and seccomp profiles as non-negotiable defaults for all production workloads.

```
NETFLIX DOCKER SECURITY:

┌──────────────────────────────────────────────────────────────────┐
│  NETFLIX CONTAINER PRACTICES                                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  SECURITY-FIRST APPROACH:                                        │
│  ├── Image scanning in CI pipeline                               │
│  ├── Runtime vulnerability detection                             │
│  ├── No root containers in production                            │
│  ├── Read-only filesystems default                               │
│  └── Seccomp profiles enforced                                   │
│                                                                  │
│  TITUS: CONTAINER PLATFORM                                       │
│  ├── Netflix's container management system                       │
│  ├── Runs on AWS                                                 │
│  ├── Supports thousands of applications                          │
│  └── Go services for control plane                               │
│                                                                  │
│  IMAGE STANDARDS:                                                │
│  ├── Base image version pinning required                         │
│  ├── Automated vulnerability scanning                            │
│  ├── Weekly base image updates                                   │
│  └── CVE threshold for deployment blocking                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

NETFLIX IMAGE SCANNING INTEGRATION:
# In CI pipeline
docker build -t myservice:${VERSION} .
docker scan myservice:${VERSION} --severity high
if [ $? -ne 0 ]; then
  echo "Critical vulnerabilities found, blocking deployment"
  exit 1
fi
```

### Stripe: Development Workflow

Stripe uses Docker Compose extensively to give every engineer a local development environment that mirrors production. Their setup includes volume mounts for hot reload (so code changes appear instantly without rebuilding), integrated Delve debugging, and all dependent services (databases, caches) running alongside the Go application. This approach means a new engineer can be productive within minutes of cloning the repository.

```
STRIPE DOCKER FOR DEVELOPMENT:

┌──────────────────────────────────────────────────────────────────┐
│  STRIPE'S DOCKER WORKFLOW                                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  DEVELOPMENT ENVIRONMENT:                                        │
│  ├── Docker Compose for local development                        │
│  ├── Production parity in containers                             │
│  ├── Hot reload with volume mounts                               │
│  └── Debugger integration (Delve)                                │
│                                                                  │
│  PRODUCTION PATTERNS:                                            │
│  ├── Multi-stage builds for all Go services                      │
│  ├── Minimal images (scratch preferred)                          │
│  ├── Build args for environment config                           │
│  └── Health checks for all services                              │
│                                                                  │
│  CI/CD INTEGRATION:                                              │
│  ├── GitHub Actions for builds                                   │
│  ├── Registry: AWS ECR                                           │
│  ├── Scanning: Trivy/Snyk integration                            │
│  └── Signed images for production                                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

STRIPE DEVELOPMENT COMPOSE:
version: '3.8'
services:
  api:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      - .:/app
      - go-modules:/go/pkg/mod
    ports:
      - "8080:8080"
      - "2345:2345"  # Debugger
    environment:
      - STRIPE_API_KEY=sk_test_xxx
      - DATABASE_URL=postgres://db:5432/stripe
    depends_on:
      - db
      - redis
```

### Amazon: ECS and ECR Patterns

Amazon Web Services provides a fully managed container ecosystem through ECR (Elastic Container Registry) for storing images and ECS (Elastic Container Service) for running them. ECS Fargate is a serverless compute engine that runs containers without requiring you to manage any servers. For Go microservices, Fargate is an excellent fit because Go's fast startup times and small memory footprint translate directly into lower costs when you pay per vCPU-second and per GB of memory.

```
AWS CONTAINER ECOSYSTEM:

┌──────────────────────────────────────────────────────────────────┐
│  AMAZON ECS FOR GO SERVICES                                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ECR (Elastic Container Registry):                               │
│  ├── Private container registry                                  │
│  ├── Image scanning built-in                                     │
│  ├── Cross-region replication                                    │
│  └── IAM-based authentication                                    │
│                                                                  │
│  ECS FARGATE:                                                    │
│  ├── Serverless containers                                       │
│  ├── No EC2 management                                           │
│  ├── Pay per vCPU and memory                                     │
│  └── Perfect for Go microservices                                │
│                                                                  │
│  GO OPTIMIZATIONS FOR AWS:                                       │
│  ├── Use AL2023-based images for Fargate                         │
│  ├── Configure memory limits matching Go runtime                 │
│  ├── Set GOMAXPROCS via env or container                         │
│  └── Enable container insights for observability                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

AWS ECR + ECS DEPLOYMENT:
# Build and push
aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_URL
docker build -t $ECR_URL/myservice:$VERSION .
docker push $ECR_URL/myservice:$VERSION

# ECS task definition (excerpt)
{
  "containerDefinitions": [{
    "name": "myservice",
    "image": "$ECR_URL/myservice:$VERSION",
    "memory": 512,
    "cpu": 256,
    "environment": [
      {"name": "GOMAXPROCS", "value": "1"}
    ],
    "healthCheck": {
      "command": ["CMD-SHELL", "curl -f http://localhost:8080/health"]
    }
  }]
}
```

---

### Junior → FAANG: Learning From Case Studies Without Cargo-Culting

Case studies from Google, Uber, and Netflix are useful for understanding why certain patterns exist, but they require careful reading. These companies operate at scales where 1% efficiency improvements translate to millions of dollars. The techniques they use are optimized for their specific constraints, and applying them blindly to a 10-person startup can add complexity with no benefit.

The right way to read a case study as a junior engineer: identify the specific problem they had (Uber's image sizes were causing push times that slowed deployments), the solution they applied (multi-stage builds, distroless), and the constraint that motivated it (hundreds of services deploying multiple times per day). Then ask: do I have that problem at my scale? If not, keep the technique in your mental model for when you do.

The interview value of case studies is knowing the vocabulary and the failure modes. Being able to say "Uber had this problem at scale and solved it by..." demonstrates awareness of the production reality of container deployments, which is a signal that you think beyond the happy path.

### Senior @ FAANG: Operating at the Scale Described in Case Studies

At staff level, you are not reading about these problems: you are the person being asked to solve them. The lesson from the major case studies is that containerization problems at scale are organizational as much as technical. Google's Borg evolved into Kubernetes because the resource scheduling problem required a shared platform, not individual teams managing their own VM allocations. Uber's multi-stage build adoption required a platform mandate, not optional guidance.

The pattern across all successful large-scale container adoptions is: centralized platform team with strong opinions, standardized golden paths that make the right thing easy, automated enforcement that makes the wrong thing fail fast, and a clear escalation process for legitimate exceptions. The platform team's job is to move problems from "each team solves this independently" to "the platform solves this once." The staff engineer's job is to identify which problems are worth moving to the platform layer and make the case for the investment.

Specific to Docker at scale: the case studies all point to the same set of platform investments: a private registry with replication, automated image scanning integrated into CI, a base image update pipeline, and image signing. These are not features. They are table stakes for operating a container platform at any meaningful scale. The L6/L7 contribution is designing these systems with the right extensibility, the right failure modes (fail open versus fail closed for scanning gates), and the right ownership model so they remain reliable as the organization grows.
