## 99.16 Interview Questions: CI/CD for Go

### Fundamental Questions

**Q1: What are the essential stages of a CI/CD pipeline for Go projects?**

Answer:
```
ESSENTIAL CI/CD STAGES:

1. CODE QUALITY (Parallel)
   ├── go fmt / goimports - Formatting
   ├── go vet - Common mistakes
   ├── golangci-lint - Comprehensive linting
   └── staticcheck - Additional analysis

2. TESTING
   ├── Unit tests with -race flag
   ├── Integration tests
   ├── Coverage reporting (>80% target)
   └── Benchmark tests (optional)

3. SECURITY
   ├── govulncheck - Known vulnerabilities
   ├── gosec - Security issues in code
   ├── Secret scanning (trufflehog/gitleaks)
   └── Dependency scanning

4. BUILD
   ├── Multi-arch build (amd64, arm64)
   ├── Docker image creation
   ├── Image scanning
   └── Push to registry

5. DEPLOY
   ├── Staging deployment
   ├── Integration/smoke tests
   ├── Production canary
   └── Full rollout

KEY PRINCIPLES:
- Run parallel stages where possible
- Fail fast - security and lint first
- Cache dependencies aggressively
- Use environment-specific configs
```

**Q2: How do you handle secrets in CI/CD pipelines?**

Answer:
```
SECRET MANAGEMENT APPROACHES:

1. PLATFORM SECRETS (GitHub Actions)
   - Settings → Secrets → Actions
   - ${{ secrets.SECRET_NAME }}
   - Scoped to repository/organization

2. EXTERNAL SECRET MANAGERS
   - AWS Secrets Manager
   - HashiCorp Vault
   - GCP Secret Manager
   - Fetch at runtime

3. OIDC FEDERATION (Best for cloud)
   - No static credentials
   - Short-lived tokens
   - Example: GitHub → AWS

NEVER:
- Hardcode in workflow files
- Store in environment variables in code
- Commit to git (even in .gitignore)
- Log secret values

BEST PRACTICES:
- Rotate secrets regularly
- Use minimal permissions
- Audit secret access
- Scan for leaked secrets
```

### Intermediate Questions

**Q3: How would you implement a blue-green deployment in your CI/CD pipeline?**

Answer:
```yaml
# Blue-Green Deployment Strategy

# 1. Maintain two environments
blue-deployment:
  replicas: 3
  label: version=blue

green-deployment:
  replicas: 3
  label: version=green

# 2. CI/CD Pipeline
steps:
  - build: Create image
  - deploy: Deploy to inactive environment (green)
  - test: Run tests against green
  - switch: Update service selector to green
  - monitor: Watch metrics for 10 minutes
  - cleanup: Scale down blue (optional)

# Key Commands:
# Deploy to inactive
kubectl set image deployment/green app=myapp:new

# Switch traffic
kubectl patch service myapp -p '{"spec":{"selector":{"version":"green"}}}'

# Rollback (instant)
kubectl patch service myapp -p '{"spec":{"selector":{"version":"blue"}}}'

ADVANTAGES:
- Zero downtime
- Instant rollback
- Full testing before switch
- No user impact during deployment
```

**Q4: What caching strategies improve CI/CD performance for Go projects?**

Answer:
```yaml
CACHING STRATEGIES:

1. GO MODULE CACHE
   - Cache ~/go/pkg/mod
   - Key on go.sum hash
   - Shared across jobs

   - name: Cache Go modules
     uses: actions/cache@v4
     with:
       path: ~/go/pkg/mod
       key: go-mod-${{ hashFiles('**/go.sum') }}

2. BUILD CACHE
   - Cache ~/.cache/go-build
   - Speeds up compilation
   - Rebuild only changed packages

3. DOCKER LAYER CACHE
   - Use BuildKit with GHA cache
   - Cache FROM builder stage
   - Order Dockerfile for cache hits:
     1. COPY go.mod go.sum (rarely changes)
     2. RUN go mod download (cached)
     3. COPY . . (changes often)
     4. RUN go build (incremental)

4. TEST CACHE
   - Go caches test results
   - Clear with -count=1 if needed

IMPACT:
- Module cache: 30s → 5s download
- Build cache: 2min → 30s compile
- Docker cache: 5min → 1min build
```

### Advanced Questions

**Q5: Design a CI/CD pipeline for a microservices monorepo.**

Answer:
```
MONOREPO CI/CD DESIGN:

STRUCTURE:
/monorepo
├── services/
│   ├── api/
│   ├── auth/
│   └── payments/
├── libs/
│   ├── common/
│   └── database/
└── go.work

PIPELINE STAGES:

1. CHANGE DETECTION
   - Compare HEAD with base branch
   - Identify affected services
   - Include dependency graph
   - If libs/common changes → test all dependents

2. PARALLEL TESTING
   - Matrix build for affected services
   - Shared test infrastructure
   - Isolated test databases per service

3. SELECTIVE BUILD
   - Only build changed services
   - Tag with service name and SHA
   - Push to shared registry

4. COORDINATED DEPLOY
   - Deploy dependent services first
   - Respect service dependencies
   - Shared feature flags
   - Atomic deployment groups

EXAMPLE WORKFLOW:
detect-changes:
  outputs:
    services: ["api", "payments"]
    needs-integration: true

test:
  matrix:
    service: ${{ needs.detect-changes.outputs.services }}

deploy:
  strategy: rolling
  order:
    - common-services  # First
    - api, auth        # Then these
    - payments         # Finally
```

**Q6: How do you implement canary deployments with automatic rollback?**

Answer:
```yaml
# Canary Deployment with Auto-Rollback

stages:
  canary:
    # Deploy to 5% of traffic
    weight: 5
    duration: 10m
    success_criteria:
      error_rate: < 1%
      latency_p99: < 200ms
    on_failure: automatic_rollback

  progressive:
    steps:
      - weight: 25, duration: 5m
      - weight: 50, duration: 5m
      - weight: 75, duration: 5m
      - weight: 100

# Implementation with Argo Rollouts
apiVersion: argoproj.io/v1alpha1
kind: Rollout
spec:
  strategy:
    canary:
      steps:
        - setWeight: 5
        - pause: {duration: 10m}
        - analysis:
            templates:
              - templateName: success-rate
            args:
              - name: service-name
                value: myapp
        - setWeight: 25
        - pause: {duration: 5m}
        - setWeight: 50
        - pause: {duration: 5m}
        - setWeight: 100

---
# Analysis Template
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
spec:
  metrics:
    - name: success-rate
      interval: 1m
      successCondition: result[0] > 0.99
      provider:
        prometheus:
          address: http://prometheus:9090
          query: |
            sum(rate(http_requests_total{service="{{args.service-name}}",code=~"2.."}[5m]))
            /
            sum(rate(http_requests_total{service="{{args.service-name}}"}[5m]))
```

---

### Junior → FAANG: CI/CD Interview Preparation for Go Roles

CI/CD interview questions at product companies test two things: can you describe your current or previous team's pipeline, and can you design a pipeline for a new service from scratch. Both require concrete knowledge, not abstract familiarity.

For the "describe your pipeline" question: be specific. Know how many stages, how long each takes, what tools are used at each stage, and what the failure rate is. "We use GitHub Actions with about a 12-minute pipeline" is a starting point. "We have 5 stages: lint runs in 30 seconds with golangci-lint, test runs in 4 minutes with -race and coverage, security scan runs trivy and govulncheck, build produces a multi-stage Docker image and takes 3 minutes with BuildKit layer caching, and deploy uses Argo CD with a GitOps workflow" demonstrates genuine operational experience.

For the "design a pipeline" question: cover the pipeline stage ordering, the specific tools for Go, the caching strategy, the deployment strategy (staged rollout, feature flags, automatic rollback), and the notification strategy. Show that you are thinking about both correctness (does this catch the bugs we care about?) and efficiency (does this pipeline enable fast iteration?).

### Senior @ FAANG: Bar-Raiser CI/CD Signals at L6/L7

At staff level, CI/CD bar-raiser questions test whether you think about delivery infrastructure at the organizational level. "How would you improve the CI/CD system for 500 engineers" is not a question about tool selection. It is a question about organizational leverage, investment prioritization, and systems thinking.

The bar-raiser signal is a structured answer that covers: the current state assessment (DORA metrics, specific pain points), the investment priorities (ranked by impact and feasibility), the ownership model (who builds and maintains each component), the success metrics (how will you know the investment paid off), and the organizational change management required (how do you get 500 engineers to adopt new tools and processes). Each of these components is a real engineering and organizational problem, and the ability to address all of them demonstrates L6/L7 scope.

The signal that most clearly distinguishes senior from staff in CI/CD interviews: staff engineers talk about the organizational process and governance model for the pipeline, not just the technical implementation. "The pipeline needs a flaky test quarantine process with weekly review and SLA for resolution" is a staff-level concern. "The pipeline should cache Go modules" is a senior-level concern. Both are correct. Only one demonstrates the scope of organizational impact that characterizes L6/L7.
