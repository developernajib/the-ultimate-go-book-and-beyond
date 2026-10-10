## 102G.3 Distroless & Minimal Images

### Multi-Stage Distroless Build

Distroless images contain only your application binary and its runtime dependencies. No shell, no package manager, no debugging tools. This minimizes the attack surface dramatically: a distroless Go image has essentially zero exploitable OS-level CVEs because there are no OS binaries to exploit. Multi-stage builds achieve this by compiling the Go binary in a full `golang` builder image, then copying only the binary into a `gcr.io/distroless/static-debian12` base that has no shell and a minimal filesystem.

```dockerfile
# Stage 1: Build
FROM golang:1.27.1-alpine AS builder

# Install CA certificates for HTTPS calls in the final image
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /build

# Download dependencies first (layer caching)
COPY go.mod go.sum ./
RUN go mod download

# Build with security flags
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build \
    -ldflags="-w -s -extldflags '-static'" \
    -trimpath \
    -o /build/server \
    ./cmd/server

# Run security scan on binary
RUN go install golang.org/x/vuln/cmd/govulncheck@latest && \
    govulncheck ./...

# Stage 2: Minimal runtime (distroless)
# nonroot: runs as UID 65532, no shell, no package manager
FROM gcr.io/distroless/static-debian12:nonroot

# Copy timezone data and certificates from builder
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy binary
COPY --from=builder /build/server /server

# Distroless nonroot already has USER 65532 set
EXPOSE 8080

ENTRYPOINT ["/server"]
```

### Scratch-Based Image (Even Smaller)

A `FROM scratch` image is the most extreme minimization possible: the resulting image contains literally nothing except the files you explicitly copy into it. Because there is no libc, no shell, and no init system, Go's `CGO_ENABLED=0` static compilation flag is mandatory. The binary must be fully self-contained with no shared library dependencies. The trade-off compared to distroless is that scratch images omit even the minimal user/group database that distroless provides, so you must manually supply `/etc/passwd` or use a numeric UID in the `USER` instruction to satisfy Kubernetes `runAsNonRoot` enforcement.

```dockerfile
FROM golang:1.27.1-alpine AS builder
RUN apk add --no-cache ca-certificates
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o server ./cmd/server

# FROM scratch: literally empty - no shell, no OS, just your binary
FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /build/server /server
USER 65534:65534  # nobody:nobody
ENTRYPOINT ["/server"]
```

**Size comparison**:
```
ubuntu:22.04    77 MB
alpine:3.19      7 MB
distroless       2 MB
scratch          0 MB (just binary + certs ~12MB total)
```

---

### Junior → FAANG: Why Image Minimization Matters for Security Interviews

The size comparison table at the end of this section is a useful anchor for interviews, but the security rationale behind it is what interviewers are testing. A smaller image is not just faster to pull. It has fewer binaries that an attacker can use if they gain code execution.

The critical insight: in a traditional ubuntu-based image, an attacker who achieves RCE has access to `bash`, `curl`, `wget`, `python3`, `netcat`, and dozens of other tools they can use to download additional payloads, exfiltrate data, or pivot to other services. In a distroless image, they have none of those tools. The exploit does not go away, but the blast radius shrinks dramatically.

Prerequisite gap: `CGO_ENABLED=0` is easy to add to a build command but juniors often do not know why it is required for scratch images. CGO links against the host's libc at compile time. A scratch image has no libc, so a CGO-enabled binary will fail at runtime with a "no such file or directory" error on `/lib/x86_64-linux-gnu/libc.so.6`. This is a common first-day surprise when switching from alpine to scratch.

First-job habit: always add `govulncheck` to your build stage as shown above. It checks your Go module's call graph against the Go vulnerability database and reports only vulnerabilities in code paths your application actually executes, not every vulnerability in every transitive dependency.

### Senior @ FAANG: Base Image Governance and the Golden Image Program

At the platform level, the question is not "should we use distroless" but "how do we ensure every team uses an approved base image, and how do we update all 200 services when the distroless base is updated."

The pattern that scales is a golden image program. The platform team maintains a small set of pre-built, pre-scanned base images (Go distroless, Python distroless, JVM distroless) stored in the organization's internal registry. Those base images are rebuilt weekly, scanned with Trivy, signed with Cosign, and pinned by digest in a managed catalog. Product teams reference the catalog entry, not the upstream image directly.

The governance mechanism: OPA/Gatekeeper admission control enforces that every pod's image must be pulled from the internal registry. `FROM ubuntu:22.04` in a Dockerfile is blocked at deploy time, not just discouraged in a wiki. This is the only pattern that reliably prevents teams from inadvertently using a compromised upstream image.

The update propagation problem: when a new CVE is published in a distroless base image and you need to update all 200 services, you cannot ask 200 teams to update their Dockerfiles manually. The platform solution is Renovate or Dependabot configured to automatically open PRs updating the base image digest in every repository. The PR includes the Trivy scan diff (showing the CVE is resolved), and CI must pass before merge. This turns a manual emergency response into a standard automated update flow.

ADR consideration: distroless vs. scratch has an operational trade-off beyond size. Distroless includes a minimal `/etc/passwd` and `/etc/group`, which means tools that rely on user name lookups (some logging libraries, some certificate libraries) work correctly. Scratch requires you to explicitly provide these files. For a platform serving many teams, distroless is the safer default because it avoids subtle runtime failures that juniors diagnose incorrectly as application bugs.

Bar-raiser depth: the `COPY --from=builder /usr/share/zoneinfo` line in the Dockerfile is easy to miss but critical for services that process timestamps. A distroless image without timezone data will fail on any `time.LoadLocation` call that references a named timezone. A staff engineer reviewing Dockerfiles should recognize this as a common omission that causes timezone-related bugs in production, typically manifesting only when the service first handles a request from a user in a non-UTC timezone.
