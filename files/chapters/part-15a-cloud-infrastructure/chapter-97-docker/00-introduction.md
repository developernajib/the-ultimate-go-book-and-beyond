# Chapter 97: Docker for Go Applications

> *"Shipping your application without Docker today is like shipping code without version control - technically possible, professionally indefensible."*

Go and Docker are a near-perfect pairing. Go's ability to compile into a single, statically-linked binary with no runtime dependencies makes it uniquely suited for container deployments. Where other languages require a full language runtime, standard library, and dependency tree inside the container, a Go binary can run inside an image that is just a few megabytes - sometimes just the binary itself in a scratch or distroless base image. This combination produces containers that are faster to start, cheaper to store, and dramatically smaller to pull across a network.

But small images are only one dimension of good containerization. Production-grade Docker usage for Go means mastering multi-stage builds that separate build-time tooling from the final runtime artifact, understanding how Docker's layer caching interacts with Go modules to make rebuild times near-instantaneous, and configuring health checks so orchestration platforms like Kubernetes know exactly when your application is ready to serve traffic. Security is equally important: running containers as non-root users, dropping Linux capabilities, using read-only filesystems, and scanning images for CVEs are table-stakes for any team operating at scale.

Beyond single containers, Docker Compose unlocks a reproducible local development environment that mirrors production - databases, caches, message brokers, and your Go service wired together with a single command. Understanding overlay networking, volume mounts, and environment-variable injection at the Compose level is what enables a new engineer to be productive in minutes rather than hours. This chapter walks you through every layer of Docker expertise a Go engineer needs, from your first `FROM golang:1.27.1` to a hardened, production-ready image pipeline.

**What you'll learn in this chapter:**

- How to write multi-stage Dockerfiles that produce minimal, production-ready Go images using `scratch` and distroless base images
- How Docker layer caching interacts with `go.mod` and `go.sum` to dramatically accelerate CI build times
- How to run Go containers as non-root users and apply least-privilege security hardening
- How to implement `HEALTHCHECK` instructions and integrate them with container orchestration readiness probes
- How to use build arguments, labels, and metadata to embed versioning information at build time
- How to configure Docker Compose for realistic multi-service local development environments
- How to profile and debug Go applications running inside containers using `dlv` and `pprof`
- How to scan Docker images for vulnerabilities using Trivy and integrate scanning into your CI pipeline

**Why this matters at scale:**

Google runs billions of containers per week across its internal infrastructure, with Go powering a significant portion of its core services. Teams routinely cut service image sizes by well over half after adopting multi-stage builds, directly lowering storage and network transfer costs across hundreds of microservices. Cloudflare uses distroless Go images to minimize its attack surface on edge nodes handling over 55 million HTTP requests per second. Netflix and Spotify both enforce non-root container execution as a hard requirement in their security policies, catching privilege-escalation vulnerabilities before they reach production.

**Prerequisites:** Familiarity with Go modules, basic Linux command line, and the concepts from Part 1 (Go fundamentals). Docker Desktop or Docker Engine installed locally.

---

### Junior → FAANG: Getting Docker Right From the Start

Many engineers joining their first Go team treat Docker as a black box: copy a Dockerfile from the internet, run `docker build`, and move on. That approach breaks down fast in a code review or an on-call incident. The foundational gaps to close are layer ordering (expensive steps last, stable steps first), understanding why multi-stage builds exist (keeping build tools out of the runtime image), and knowing what `CGO_ENABLED=0` means and when you need it.

A practical first-job habit: always run `docker image ls` after every build and watch the size. If your Go image is over 50 MB, something is wrong. If it is over 200 MB, you are almost certainly not using multi-stage builds. Pull that number down before the PR is merged.

For entry-level interviews at product companies, expect questions like: "Why is your Go Docker image 8 MB instead of 800 MB?" Being able to explain the scratch/distroless base, static linking, and multi-stage build pipeline end-to-end is a reliable signal of readiness for a production Go role.

### Senior @ FAANG: Container Strategy as Platform Infrastructure

At staff level and above, Docker is not an individual tool. It is a contract between every team and the platform. The questions shift from "how do I build an image" to "how do we enforce consistent image standards across 300 services without becoming a bottleneck."

The architectural decision that matters most is choosing a base image policy and enforcing it. Distroless versus Alpine versus scratch is not a taste preference: each choice has concrete implications for CVE surface area, debugging capability in production, and compatibility with security scanners. This decision belongs in an Architecture Decision Record (ADR), not a Slack thread, and it needs to be revisited on a cadence tied to your CVE SLA.

At FAANG scale, image build performance is a cost and developer-experience problem. A 10-minute image build multiplied across 500 engineers and 20 daily commits is a meaningful compute bill and a meaningful productivity tax. Staff engineers own the BuildKit layer cache strategy, the remote cache configuration, and the decision about whether to centralize image builds in CI or distribute them to developer machines.

The bar-raiser signal at L6/L7 is governance: can you describe the mechanism by which a new team's Dockerfile is validated before it reaches production? That means automated policy enforcement (conftest with OPA policies on Dockerfiles, Trivy gates in CI, image signing with cosign and Sigstore), not documentation that nobody reads. You should be able to name the tool, the failure mode when a policy is violated, and who owns the exception process.

Security posture is not optional. Non-root UID, read-only root filesystem, no-new-privileges, and capability dropping are requirements, not suggestions, in any regulated environment. The senior expectation is that these controls are enforced at the platform layer (admission controllers, OPA Gatekeeper) rather than left to each team to remember.
