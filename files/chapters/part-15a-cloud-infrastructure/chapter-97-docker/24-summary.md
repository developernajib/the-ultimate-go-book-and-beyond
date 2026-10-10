## Summary

- **Multi-stage builds**: Separate build and runtime stages to produce minimal production images, dramatically reducing attack surface and image size.
- **Minimal base images**: Use `scratch` or `distroless` for Go binaries - no shell, no package manager, and far fewer CVEs than general-purpose base images.
- **Layer caching**: Order Dockerfile instructions from least to most frequently changed. Copy `go.mod`/`go.sum` and run `go mod download` before copying source code.
- **Non-root user**: Always run containers as a non-root user (`USER nonroot:nonroot`) to limit the blast radius of a container escape.
- **Docker Compose for local development**: Define multi-service environments with health checks, dependency ordering, and bind mounts to mirror production topology locally.
- **Image security scanning**: Integrate `trivy` or `docker scout` into CI to catch known CVEs before images are pushed to a registry.
- **GOMAXPROCS tuning**: Set `GOMAXPROCS` to match the container's CPU quota (via `automaxprocs` library) to prevent the Go scheduler from over-spinning goroutines.
- **Health checks**: Define both `HEALTHCHECK` in the Dockerfile and liveness/readiness probes in orchestration so traffic is only routed to healthy containers.
- **Registry management**: Tag images with both a semantic version and `latest`. Use image digest pinning in production manifests to guarantee immutability.
- **Graceful shutdown**: Handle `SIGTERM` in Go with a context-based shutdown sequence so in-flight requests complete before the container exits.

### Junior → FAANG: Using This Summary as a Pre-Interview Checklist

This summary is a dense reference for the decisions that distinguish a production-quality Go container setup from a tutorial example. Before any interview at a company that runs containers (which is nearly all product companies), walk through each bullet and make sure you can explain: what problem it solves, how to implement it, and what the consequence is of skipping it.

The highest-return items to know deeply for entry-level interviews: multi-stage builds (explain the layer structure and why the runtime image contains no compiler), `automaxprocs` and `GOMEMLIMIT` (explain the cgroup-awareness problem without them), and graceful shutdown (explain the SIGTERM handler and the context deadline). These come up repeatedly because they are Go-specific concerns that are not covered by generic Docker tutorials.

### Senior @ FAANG: Summary as a Platform Audit Checklist

At senior level, this summary maps directly to a platform audit. For each item, the question is not "do I know this" but "is this enforced consistently across all services, and do we have evidence of that enforcement."

The audit process: for each item in the summary, identify the enforcement mechanism (CI gate, admission controller, linter, template), verify that the mechanism is active and correctly configured, and spot-check a sample of services to confirm compliance. Items with no enforcement mechanism are gaps in the platform contract, and each gap is a risk that needs to be documented, prioritized, and assigned an owner.

At FAANG maturity, a container platform audit is a quarterly activity, the results are presented to engineering leadership, and trends over time (compliance rate improving or degrading, new gaps appearing as standards evolve) are tracked as platform health metrics. The staff engineer who owns the platform is accountable for these metrics and responsible for the roadmap of investments that moves them in the right direction.
