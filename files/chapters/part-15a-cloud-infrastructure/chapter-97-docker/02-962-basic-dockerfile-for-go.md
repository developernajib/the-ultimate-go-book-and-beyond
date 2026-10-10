## 97.2 Basic Dockerfile for Go

### Simple Single-Stage Build

A Dockerfile is a text file that contains step-by-step instructions for building a Docker image. In a single-stage build, everything happens in one image: you install the Go toolchain, copy your source code, compile it, and run the resulting binary. This approach is the simplest way to get started, but it leaves the entire Go compiler and build tools inside your final image, which wastes space and creates security risks.

```dockerfile
# Simple but NOT recommended for production
FROM golang:1.27.1

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build
RUN go build -o main .

# Run
EXPOSE 8080
CMD ["./main"]
```

**Problems with this approach:**
- Image size: ~1GB (includes entire Go toolchain)
- Security risk: Build tools in production image
- Slow builds: No layer caching optimization

---

### Junior → FAANG: Understanding Why the Basic Dockerfile Is a Starting Point, Not a Destination

The single-stage Dockerfile is the right place to start learning, but it should never reach production. The two concrete problems are size and attack surface. A 1 GB image takes longer to pull in CI, costs more in registry storage, and gives an attacker more tools to work with if they gain code execution inside the container.

The habit to build early: always add a `.dockerignore` file to every Go project before you write the Dockerfile. Without it, `COPY . .` will drag in your `.git` directory, local test fixtures, secrets files, and anything else in the working directory. A minimal `.dockerignore` for Go should exclude at minimum: `.git`, `vendor` (if you manage that separately), `*_test.go` files in some setups, and any local `.env` files.

For first-job readiness, be able to explain what `EXPOSE` does (documents intent, does not actually publish the port) versus `-p` at runtime (actually binds the port). Interviewers frequently test this distinction because it reveals whether someone has actually run containers or just written Dockerfiles.

### Senior @ FAANG: Dockerfile as Policy Document

At senior level, a Dockerfile is not just a build script. It is a policy document that encodes security posture, dependency provenance, and operational behavior. Every instruction is a claim about the runtime environment, and those claims need to be verifiable.

The critical senior concern with basic Dockerfiles is supply-chain security. Using `FROM golang:1.27.1` pins to a tag, but tags are mutable. The same tag can point to a different digest next week after an upstream rebuild. Production Dockerfiles should pin to digest (`FROM golang:1.27.1@sha256:...`) and have an automated process (Renovate, Dependabot) to update that digest with a human-readable changelog. This is a supply-chain hygiene decision that needs to be made at the platform level and enforced via policy, not left to individual teams.

At L6/L7, the conversation about basic Dockerfiles often comes up in the context of standardization. When you have 300 services each with their own Dockerfile, drift is inevitable. The architectural answer is a set of curated base images owned by the platform team, updated on a cadence, with the update propagated automatically to all services. Service teams consume a pinned version of the platform base image, not `golang:latest` from Docker Hub. This reduces the number of CVEs that reach production and gives the platform team a single lever to pull when a critical vulnerability like a glibc exploit requires a fleet-wide rebuild.
