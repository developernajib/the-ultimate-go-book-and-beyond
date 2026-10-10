## 99.2 GitHub Actions

### Complete Pipeline

The workflow below translates the five pipeline stages into concrete GitHub Actions jobs with explicit dependency ordering via `needs`. The `lint`, `test`, and `security` jobs run in parallel because they are independent, while `build` gates on all three passing, preventing an insecure or broken image from ever reaching the registry. Docker layer caching via `type=gha` dramatically cuts image build times on repeated pushes, and the two-environment deployment chain (`staging` → `production`) uses GitHub Environments to enforce required reviewers and protection rules before production traffic is affected.

```yaml
# .github/workflows/ci.yaml
name: CI/CD Pipeline

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  GO_VERSION: '1.22'
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: ${{ env.GO_VERSION }}

      - name: golangci-lint
        uses: golangci/golangci-lint-action@v4
        with:
          version: latest

  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_PASSWORD: testpass
          POSTGRES_DB: testdb
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: ${{ env.GO_VERSION }}

      - name: Run tests
        env:
          DATABASE_URL: postgres://postgres:testpass@localhost:5432/testdb
        run: |
          go test -v -race -coverprofile=coverage.out ./...
          go tool cover -func=coverage.out

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          file: coverage.out

  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: ${{ env.GO_VERSION }}

      - name: Run govulncheck
        run: |
          go install golang.org/x/vuln/cmd/govulncheck@latest
          govulncheck ./...

      - name: Run gosec
        uses: securego/gosec@master
        with:
          args: ./...

  build:
    needs: [lint, test, security]
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    outputs:
      image-tag: ${{ steps.meta.outputs.tags }}

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Registry
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
            type=sha,prefix=
            type=ref,event=branch

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            VERSION=${{ github.sha }}
            COMMIT=${{ github.sha }}

  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    environment: staging

    steps:
      - uses: actions/checkout@v4

      - name: Deploy to staging
        uses: azure/k8s-deploy@v4
        with:
          namespace: staging
          manifests: k8s/overlays/staging
          images: ${{ needs.build.outputs.image-tag }}

  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment: production

    steps:
      - uses: actions/checkout@v4

      - name: Deploy to production
        uses: azure/k8s-deploy@v4
        with:
          namespace: production
          manifests: k8s/overlays/production
          images: ${{ needs.build.outputs.image-tag }}
```

---

### Junior → FAANG: GitHub Actions Fundamentals and Go-Specific Patterns

GitHub Actions is event-driven: workflows are triggered by events (push, pull_request, schedule, workflow_dispatch) and run jobs on runners. Understanding the event model is essential because it determines when pipelines run, what context is available (which branch, which ref, which actor), and what permissions are needed.

The Go-specific patterns to internalize: always pin the Go version with `actions/setup-go` and use a matrix if you need to test against multiple versions. Always cache the Go module and build caches with `actions/cache` to avoid re-downloading dependencies on every run. Use `go test -race -coverprofile=coverage.out ./...` to run all tests with race detection in a single command.

First-job habit: never use `latest` as the version for an action (`uses: actions/checkout@latest`). Pin to a specific version tag (`uses: actions/checkout@v4.1.7`) or to a commit SHA for maximum security. Actions are code that runs in your pipeline with access to your secrets. Untrusted or unpinned actions are a supply-chain attack vector.

### Senior @ FAANG: GitHub Actions at Scale and Runner Architecture

At staff level, GitHub Actions is a platform infrastructure choice with cost, performance, and security implications. GitHub-hosted runners are convenient but have fixed resource configurations, shared infrastructure (performance can vary), and limited customization. Self-hosted runners give full control over hardware, caching, and network access, but require operational maintenance (OS updates, runner software updates, autoscaling the runner fleet).

The runner architecture decision at FAANG scale: a fleet of ephemeral self-hosted runners (provisioned by Actions Runner Controller on Kubernetes) provides predictable performance, access to internal network resources (private registries, internal services for integration tests), and cost control (right-size the runner instances for the actual workload). The operational overhead is owning the runner Kubernetes cluster, the ARC deployment, and the autoscaling configuration.

The security model for GitHub Actions requires careful design. Secrets stored in GitHub Secrets are available as environment variables, which are visible in process listings. For sensitive secrets (cloud provider credentials, signing keys), the pattern is OIDC-based short-lived credentials: the GitHub Actions workflow assumes an IAM role using a GitHub-issued OIDC token, gets short-lived AWS/GCP credentials, and uses them for the duration of the job. No long-lived credentials are stored. This eliminates an entire class of secret rotation problems and is the required pattern for any Go service that deploys to a cloud provider from GitHub Actions.
