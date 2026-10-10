## 99.17 Exercises with Solutions

### Exercise 1: Complete CI Pipeline

**Task**: Create a GitHub Actions workflow that:
1. Runs lint, test, and security in parallel
2. Builds multi-arch Docker images
3. Pushes to GHCR with proper tagging
4. Signs images with Cosign

**Solution**:

```yaml
# .github/workflows/complete-ci.yaml
name: Complete CI Pipeline

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

permissions:
  contents: read
  packages: write
  id-token: write
  security-events: write

jobs:
  # Parallel quality checks
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - uses: golangci/golangci-lint-action@v4
        with:
          version: latest

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
        options: --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: Run tests
        env:
          DATABASE_URL: postgres://postgres:test@localhost:5432/postgres
        run: go test -v -race -coverprofile=coverage.out ./...
      - uses: codecov/codecov-action@v4
        with:
          files: coverage.out

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - name: govulncheck
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@latest
          govulncheck ./...
      - name: gosec
        run: |
          go install github.com/securego/gosec/v2/cmd/gosec@latest
          gosec -fmt=sarif -out=results.sarif ./...
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: results.sarif

  # Build and sign (only after all checks pass)
  build:
    needs: [lint, test, security]
    runs-on: ubuntu-latest
    outputs:
      digest: ${{ steps.build.outputs.digest }}
    steps:
      - uses: actions/checkout@v4

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Install Cosign
        uses: sigstore/cosign-installer@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=sha

      - name: Build and push
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Sign image
        if: github.event_name != 'pull_request'
        run: |
          cosign sign --yes \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}
```

### Exercise 2: GitOps Deployment Setup

**Task**: Create ArgoCD Application and Kustomize overlays for staging and production.

**Solution**:

```yaml
# argocd/applications/go-service.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: go-service
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/myorg/go-service-config
    targetRevision: HEAD
    path: k8s/overlays/production
  destination:
    server: https://kubernetes.default.svc
    namespace: go-service
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

```yaml
# k8s/base/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-service
spec:
  selector:
    matchLabels:
      app: go-service
  template:
    metadata:
      labels:
        app: go-service
    spec:
      containers:
        - name: go-service
          image: go-service:latest
          ports:
            - containerPort: 8080
          envFrom:
            - configMapRef:
                name: go-service-config
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
```

```yaml
# k8s/overlays/staging/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: staging
resources:
  - ../../base
namePrefix: staging-
replicas:
  - name: go-service
    count: 2
images:
  - name: go-service
    newName: ghcr.io/myorg/go-service
    newTag: staging-latest
configMapGenerator:
  - name: go-service-config
    literals:
      - LOG_LEVEL=debug
      - ENVIRONMENT=staging
```

```yaml
# k8s/overlays/production/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: production
resources:
  - ../../base
namePrefix: prod-
replicas:
  - name: go-service
    count: 5
images:
  - name: go-service
    newName: ghcr.io/myorg/go-service
    newTag: v1.0.0  # Updated by CI
configMapGenerator:
  - name: go-service-config
    literals:
      - LOG_LEVEL=info
      - ENVIRONMENT=production
patchesStrategicMerge:
  - resources-patch.yaml
```

```yaml
# k8s/overlays/production/resources-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: go-service
spec:
  template:
    spec:
      containers:
        - name: go-service
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi
```

### Exercise 3: Canary Deployment Pipeline

**Task**: Implement a canary deployment with automatic rollback.

**Solution**:

```yaml
# .github/workflows/canary-deploy.yaml
name: Canary Deploy

on:
  push:
    branches: [main]

jobs:
  deploy-canary:
    runs-on: ubuntu-latest
    environment: production-canary
    steps:
      - uses: actions/checkout@v4

      - name: Setup kubectl
        uses: azure/setup-kubectl@v3

      - name: Configure kubeconfig
        run: |
          echo "${{ secrets.KUBECONFIG }}" | base64 -d > kubeconfig
          export KUBECONFIG=kubeconfig

      - name: Deploy canary (10%)
        run: |
          kubectl apply -f k8s/canary/deployment.yaml
          kubectl rollout status deployment/go-service-canary --timeout=5m

      - name: Run smoke tests
        run: |
          CANARY_URL=$(kubectl get svc go-service-canary -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
          ./scripts/smoke-test.sh $CANARY_URL

      - name: Monitor canary (5 minutes)
        run: |
          ./scripts/monitor.sh \
            --service go-service-canary \
            --duration 5m \
            --error-threshold 1 \
            --latency-p99 200

      - name: Promote canary
        run: |
          kubectl set image deployment/go-service go-service=$(kubectl get deployment go-service-canary -o jsonpath='{.spec.template.spec.containers[0].image}')
          kubectl rollout status deployment/go-service --timeout=5m

      - name: Cleanup canary
        run: |
          kubectl delete deployment go-service-canary

  rollback:
    needs: deploy-canary
    if: failure()
    runs-on: ubuntu-latest
    steps:
      - name: Rollback canary
        run: |
          kubectl delete deployment go-service-canary || true
          echo "Canary deployment failed and was rolled back"

      - name: Notify on failure
        uses: slackapi/slack-github-action@v1
        with:
          channel-id: 'alerts'
          payload: |
            {"text": "❌ Canary deployment failed and was rolled back"}
        env:
          SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
```

---

### Junior → FAANG: CI/CD Exercises as Pipeline Literacy

These exercises build the specific skills that distinguish engineers who can talk about CI/CD from engineers who can actually set it up, debug it, and improve it. The most important exercise for career development is Exercise 1 (complete CI pipeline): set up a working pipeline for a real Go service, including all stages, and verify that each stage actually catches the class of errors it is supposed to catch. Break a stage deliberately (introduce a race condition, push a vulnerable dependency, break a test) and confirm the pipeline fails appropriately.

The cache configuration exercise is the one that changes daily workflow most noticeably. A 10-minute pipeline that becomes a 3-minute pipeline after proper caching is configured is a concrete improvement that is immediately felt by every team member. Measuring the before and after time is important: the improvement justifies the configuration complexity.

### Senior @ FAANG: CI/CD Exercises as Platform Requirements Gathering

At staff level, working through these exercises with a critical eye reveals the gaps between what the exercises assume (a single repository, a simple deployment target, a small team) and the requirements of an organizational CI/CD platform.

Exercise 1 (complete pipeline) at scale requires: a shared pipeline template maintained by the platform team, runner infrastructure that can handle thousands of concurrent runs, a remote cache backend, and integration with the organization's identity and access management system. Each of these is a platform engineering project, and identifying them from first-principles experience with the exercise is more valuable than reading about them abstractly.

The security scanning exercise at scale requires: a centralized vulnerability tracking system, a process for handling scanner false positives without blocking deployments indefinitely, and integration with the organization's ticketing system so that vulnerability remediation is tracked alongside feature work. These organizational requirements are visible only when you have run the scanner in a real environment and experienced the operational friction of managing its output. That experience is what the exercise provides.
