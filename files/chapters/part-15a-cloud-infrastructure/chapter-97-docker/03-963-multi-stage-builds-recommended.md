## 97.3 Multi-Stage Builds (Recommended)

### Optimized Production Dockerfile

A multi-stage build uses two or more `FROM` instructions in a single Dockerfile. The first stage installs the Go toolchain and compiles your code, while the final stage starts from a tiny base image (like `scratch`) and copies only the compiled binary. This means your production image contains nothing except what your application actually needs to run, dramatically reducing both size and attack surface.

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

# Install certificates and timezone data
RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

# Copy go mod files first (layer caching)
COPY go.mod go.sum ./
RUN go mod download && go mod verify

# Copy source code
COPY . .

# Build with optimizations
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags='-w -s -extldflags "-static"' \
    -o /app/server ./cmd/server

# Final stage - minimal image
FROM scratch

# Copy certificates for HTTPS
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

# Copy binary
COPY --from=builder /app/server /server

# Non-root user (security)
USER 65534:65534

EXPOSE 8080

ENTRYPOINT ["/server"]
```

### Image Size Comparison

Choosing the right base image has a massive impact on your final container size. The full `golang` image includes the entire Go toolchain and weighs over a gigabyte, while `scratch` (an empty image with literally nothing in it) produces containers that are just the size of your binary plus any certificates you copy in. The table below shows how different base images compare so you can make an informed choice for your use case.

```
┌──────────────────────────────────────────────────────────────────┐
│                    IMAGE SIZE COMPARISON                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Base Image              │ Final Size │ Use Case                 │
│  ─────────────────────────────────────────────────────────────   │
│  golang:1.27.1           │ ~1.1 GB    │ Development only         │
│  golang:1.27.1-alpine    │ ~300 MB    │ Build stage              │
│  alpine:3.19             │ ~15 MB     │ Need shell/debugging     │
│  gcr.io/distroless/base  │ ~20 MB     │ Minimal with glibc       │
│  scratch                 │ ~5-15 MB   │ Absolute minimum         │
│                                                                  │
│  Your Go binary: ~10-20 MB typically                             │
│  Final scratch image: Binary size + certificates (~12-25 MB)     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

### Junior → FAANG: Multi-Stage Builds as the Default, Not the Advanced Topic

Many engineers treat multi-stage builds as something to add later, once the basic Dockerfile is working. That is backwards. For Go, the multi-stage build is the baseline. A single-stage build that ships the compiler into production is a mistake from the first commit, not a technical debt to fix someday.

The key mental model to internalize: stages are named with `AS`, and you reference them with `COPY --from=<stage-name>`. Each stage is disposable. The final image contains only what you explicitly copy into it. Walk through the pattern manually at least once: build stage produces a binary, runtime stage starts fresh, you copy just the binary. Understanding why the final image has no shell, no package manager, and no compiler is more important than memorizing the syntax.

Practical first-job habit: after every multi-stage build, run `docker image inspect <image> --format='{{.Size}}'` and compare against the go base image size. Being able to explain a 50x size reduction in a code review is a strong signal.

### Senior @ FAANG: Multi-Stage Build Architecture at Scale

At staff level, multi-stage builds become a build graph problem. Complex services may need: a protobuf generation stage, a frontend asset compilation stage, a Go compilation stage, and a runtime stage. The order and caching properties of each stage affect CI build times across the entire organization.

The architectural decision that matters is where caching lives. Local layer cache on a single CI runner is useless if jobs are distributed across a fleet of ephemeral agents. The right answer is a remote BuildKit cache backend (registry-based or S3-based) configured at the organization level. This is a platform decision with real cost and performance implications: a well-configured remote cache can cut median CI build time by 60-80% for mature Go services.

The second senior concern is reproducibility. Given the same source commit, does the image build produce a byte-identical result? Go's build system supports this via `GOFLAGS=-trimpath` and careful handling of build metadata (timestamps, commit hashes). Reproducible builds matter for supply-chain security: they enable independent verification that the image in the registry corresponds to the source in the repository. Tools like `reprotest` and Sigstore's provenance attestations make this machine-verifiable. At L6/L7, you should be able to describe the threat model that reproducible builds address and the organizational process for maintaining that guarantee over time.
