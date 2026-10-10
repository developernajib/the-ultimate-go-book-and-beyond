## 110.6 Container Image Security

### Image Scanning with Trivy

Trivy scans container images for OS package and application dependency vulnerabilities, lints Dockerfiles for insecure configuration, and can emit an SBOM directly from an image. The commands below cover the invocations you need in local development and CI.

```bash
# Install Trivy
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin

# Scan container image
trivy image myapp:latest

# Scan with severity threshold
trivy image --severity HIGH,CRITICAL myapp:latest

# Scan and fail on vulnerabilities
trivy image --exit-code 1 --severity CRITICAL myapp:latest

# Scan Dockerfile
trivy config Dockerfile

# Generate SBOM from image
trivy image --format spdx-json -o sbom.spdx.json myapp:latest
```

### Multi-stage Dockerfile for Security

A multi-stage build keeps the toolchain, source code, and intermediate artifacts out of the shipped image. The Dockerfile below compiles in a full Go image, then copies only the static binary and CA certificates into a distroless runtime image that runs as a non-root user.

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

# Install build dependencies
RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /build

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download
RUN go mod verify

# Copy source code
COPY . .

# Build with security flags
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -o app \
    ./cmd/server

# Final stage: distroless for minimal attack surface
FROM gcr.io/distroless/static:nonroot

# Copy CA certificates
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy binary
COPY --from=builder /build/app /app

# Use non-root user (defined in distroless)
USER nonroot:nonroot

ENTRYPOINT ["/app"]
```

### Image Signing with Cosign

Cosign signs container images by creating a cryptographic signature of the image's content-addressable digest and storing it as a separate OCI artifact in the same registry, so signature verification requires only the registry URL and the signer's public key, with no separate signature distribution infrastructure. Signing in CI with a keyless workflow generates an ephemeral key pair locally and uses the OIDC token from the CI provider (GitHub Actions, Google, etc.) to obtain a short-lived certificate from Fulcio binding the key to that identity, recording the signature in the Rekor transparency log for auditability. Admission controllers like Connaisseur or Policy Controller can block deployment of unsigned or unverified images in Kubernetes clusters, enforcing the signing policy at the control plane rather than relying on developer discipline.

```bash
# Install cosign
go install github.com/sigstore/cosign/v2/cmd/cosign@latest

# Generate key pair
cosign generate-key-pair

# Sign image
cosign sign --key cosign.key myregistry/myapp:v1.0.0

# Verify signature
cosign verify --key cosign.pub myregistry/myapp:v1.0.0

# Keyless signing with OIDC
cosign sign myregistry/myapp:v1.0.0

# Attach SBOM to image
cosign attach sbom --sbom sbom.spdx.json myregistry/myapp:v1.0.0
```

### Junior → FAANG: Container Image Security Fundamentals

Container image security is a frequently tested topic at FAANG interviews because containerization is ubiquitous and image security is commonly neglected.

**Gap to close:** Know the three main container image security concerns: (1) base image vulnerabilities (using `ubuntu:latest` pulls in hundreds of OS packages with their vulnerabilities, use distroless or minimal base images), (2) running as root (containers that run as root have elevated privileges if the container escape succeeds), (3) secret exposure in layers (environment variables and files added in earlier layers are visible in the image even if they are removed in later layers, use multi-stage builds and never put secrets in the Dockerfile).

**First-job habit:** For every new Go service, use a two-stage Dockerfile: a build stage (`golang:1.27.1-alpine`) that compiles the binary, and a runtime stage (`scratch` or `gcr.io/distroless/static`) that copies only the binary. The runtime image has no shell, no package manager, and no OS utilities. This minimizes the attack surface from compromised runtime.

**Interview framing:** When asked about container security for a Go service, describe the distroless pattern: compile the binary in a Go builder image, copy the statically linked binary into a `gcr.io/distroless/static:nonroot` image, run as the nonroot user. Explain why: no shell means no shell injection, no OS packages means no OS package vulnerabilities, nonroot means no privilege escalation if the binary is compromised.

### Senior @ FAANG: Container Image Security as a Registry and Admission Policy

At senior level, container image security extends beyond the Dockerfile to registry configuration, admission control, and runtime enforcement.

**Image signing and admission control:** Use cosign to sign container images in the build pipeline and a Kubernetes admission controller (Sigstore Policy Controller or OPA Gatekeeper) to reject pods that attempt to run unsigned images. This creates a closed loop: only images that passed the approved build process and were signed can run in your cluster. Unsigned images (from developers' laptops, from external sources not subject to your build pipeline) are rejected at admission.

**Registry vulnerability scanning:** Configure your container registry (AWS ECR, Google Artifact Registry, Harbor) to scan images on push and block deployment of images with critical vulnerabilities. Set the threshold for blocking: critical vulnerabilities always block, high vulnerabilities block unless a documented exception exists. Monitor the exemption register: a growing list of exceptions signals that your update process is too slow.

**Base image governance:** Establish a policy for approved base images for Go services (distroless, Alpine with specific patch levels, scratch). Publish the list in your engineering standards. Configure a custom OPA rule or registry scanner that flags images using unapproved base images. Review the approved list quarterly and remove images that are no longer maintained or have accumulated vulnerabilities.

**Runtime security:** Even with secure images, runtime compromise is possible (for example, through application vulnerabilities that allow code execution). Use a runtime security tool (Falco, Tetragon) to detect anomalous container behavior: unexpected outbound network connections, privilege escalation attempts, unexpected file system writes. These detections are the last line of defense after the image is already running.

---
