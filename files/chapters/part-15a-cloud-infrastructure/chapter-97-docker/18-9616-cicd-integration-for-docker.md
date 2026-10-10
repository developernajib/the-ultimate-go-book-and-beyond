## 97.18 CI/CD Integration for Docker

### GitHub Actions Complete Workflow

A complete CI/CD pipeline for a Dockerized Go application has three stages: test the code, build and push the Docker image, and scan the image for security vulnerabilities. GitHub Actions integrates tightly with GitHub Container Registry (GHCR), and the `docker/build-push-action` handles multi-architecture builds, caching, and automatic tagging based on git branches and tags. The workflow below runs tests first, then builds and pushes the image on merges to main, and finally runs Trivy to check for known vulnerabilities in the final image.

```yaml
# .github/workflows/docker.yml
name: Docker Build and Push

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'
          cache: true

      - name: Run tests
        run: go test -v -race -coverprofile=coverage.out ./...

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: ./coverage.out

  build:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to Container Registry
        if: github.event_name != 'pull_request'
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
            type=semver,pattern={{major}}.{{minor}}
            type=sha

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            VERSION=${{ github.ref_name }}
            COMMIT=${{ github.sha }}
            BUILD_TIME=${{ github.event.head_commit.timestamp }}

  security-scan:
    needs: build
    runs-on: ubuntu-latest
    if: github.event_name != 'pull_request'
    steps:
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: '${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:sha-${{ github.sha }}'
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH'

      - name: Upload Trivy scan results
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: 'trivy-results.sarif'
```

### Makefile for Docker Operations

A Makefile provides a consistent, easy-to-remember interface for all Docker operations. Instead of remembering long `docker build` commands with multiple `--build-arg` flags, you type `make build`. This is especially valuable on a team where multiple engineers need to build, test, scan, and deploy images using the same standardized commands. The Makefile automatically extracts version information from git tags and commit hashes.

```makefile
# Makefile for Docker operations
.PHONY: build push test lint scan clean

# Variables
IMAGE_NAME ?= myapp
REGISTRY ?= ghcr.io/myorg
VERSION ?= $(shell git describe --tags --always --dirty)
COMMIT ?= $(shell git rev-parse --short HEAD)
BUILD_TIME ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
PLATFORMS ?= linux/amd64,linux/arm64

# Build image
build:
	docker build \
		--build-arg VERSION=$(VERSION) \
		--build-arg COMMIT=$(COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		-t $(IMAGE_NAME):$(VERSION) \
		-t $(IMAGE_NAME):latest \
		.

# Build multi-arch image
build-multi:
	docker buildx build \
		--platform $(PLATFORMS) \
		--build-arg VERSION=$(VERSION) \
		--build-arg COMMIT=$(COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		-t $(REGISTRY)/$(IMAGE_NAME):$(VERSION) \
		-t $(REGISTRY)/$(IMAGE_NAME):latest \
		--push \
		.

# Run tests in container
test:
	docker build --target tester -t $(IMAGE_NAME):test .
	docker run --rm $(IMAGE_NAME):test

# Lint Dockerfile
lint:
	docker run --rm -i hadolint/hadolint < Dockerfile

# Security scan
scan:
	docker scout cves $(IMAGE_NAME):latest
	trivy image $(IMAGE_NAME):latest

# Push to registry
push:
	docker tag $(IMAGE_NAME):latest $(REGISTRY)/$(IMAGE_NAME):$(VERSION)
	docker tag $(IMAGE_NAME):latest $(REGISTRY)/$(IMAGE_NAME):latest
	docker push $(REGISTRY)/$(IMAGE_NAME):$(VERSION)
	docker push $(REGISTRY)/$(IMAGE_NAME):latest

# Run locally
run:
	docker compose up --build

# Run in development mode with hot reload
dev:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# Clean up
clean:
	docker compose down -v
	docker rmi $(IMAGE_NAME):latest $(IMAGE_NAME):$(VERSION) || true
	docker system prune -f

# Show image details
inspect:
	docker inspect $(IMAGE_NAME):latest | jq '.[0].Config'
	docker history $(IMAGE_NAME):latest

### Junior → FAANG: CI/CD for Docker as the Deployment Heartbeat

The CI/CD pipeline that builds, tests, scans, and pushes a Docker image is the heartbeat of a Go service's deployment lifecycle. For junior engineers, the key insight is that CI is not just automation of what you would do manually: it is the authoritative, reproducible, auditable record of how every version of your service was built.

The practical habits to develop: always tag images with the commit SHA, not just `latest`. A tag like `myapp:abc1234` is immutable and traceable; `myapp:latest` is a moving target that makes it impossible to know which version is deployed. Always run tests before building the production image, and fail the pipeline on test failures so that a broken image is never pushed to the registry.

Understanding the pipeline stages is important for interviews at product companies: lint and vet, test, build image, scan image, push to registry, deploy to staging, smoke test, promote to production. Being able to describe what happens at each stage, why the order matters, and what failure at each stage means for the deployment is a strong signal.

### Senior @ FAANG: CI/CD Pipeline as a Platform Product

At staff level, the CI/CD pipeline is a platform product with internal customers. Its SLOs are: median build-to-deploy time for a trivial change, maximum build-to-deploy time for any change, and availability (percentage of time the pipeline is operational). Treating these as real SLOs with alerting and incident response is an L6/L7 pattern.

The architectural concerns that do not appear at small scale: artifact promotion (the same image that passed staging tests is promoted to production, not rebuilt), pipeline as code with versioning and rollback capability, progressive delivery integration (canary deployments, blue-green, feature flags to control rollout blast radius), and automatic rollback triggered by SLO violations post-deployment.

Image signing and provenance attestation is the supply-chain security layer that belongs in CI. Every image pushed to the registry should be signed with a key managed by the organization (cosign with KMS-backed keys), and the signature should be verified by the admission controller before the image is allowed to run in production. The attestation should include: the source commit hash, the CI job that built it, and the test results. This creates a verifiable chain of custody from source code to running container, which is the foundation of a software supply chain security program at FAANG maturity level.
```

---
