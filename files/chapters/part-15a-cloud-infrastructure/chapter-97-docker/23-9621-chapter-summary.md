## 97.23 Core Concepts Recap

### Key Takeaways

1. **Use multi-stage builds** - Separate build and runtime environments
2. **Start from scratch** - Minimal base image for Go
3. **Optimize layer caching** - Copy go.mod/go.sum first
4. **Run as non-root** - Security best practice
5. **Include health checks** - Enable orchestrator monitoring
6. **Inject version info** - Build-time metadata
7. **Set GOMAXPROCS** - Match container CPU limits
8. **Configure GOMEMLIMIT** - Help GC work with container memory
9. **Use structured logging** - JSON format for log aggregation
10. **Implement graceful shutdown** - Handle SIGTERM properly

### Dockerfile Checklist

- [ ] Multi-stage build
- [ ] Minimal base image (scratch/distroless)
- [ ] Dependencies cached properly
- [ ] Non-root user
- [ ] Build arguments for versioning
- [ ] Health check configured
- [ ] .dockerignore present
- [ ] Security scanned
- [ ] GOMAXPROCS set correctly
- [ ] Resource limits defined
- [ ] Logging configured
- [ ] Secrets managed securely

### Quick Reference Commands

These commands cover the full container lifecycle from building versioned images to inspecting security posture at runtime. The `--build-arg VERSION` pattern stamps the binary at build time so every running container can report its exact release without relying on external metadata. Tools like `docker scout` and `trivy` perform CVE scanning against the final image layers, catching vulnerabilities introduced by the base image or transitive dependencies before the image reaches production.

```bash
# Build
docker build -t myapp:latest .
docker build --build-arg VERSION=1.0.0 -t myapp:1.0.0 .

# Run
docker run -d -p 8080:8080 myapp:latest
docker run --rm -it myapp:latest sh  # Debug (needs shell)

# Logs
docker logs -f container_name
docker compose logs -f

# Security
docker scout cves myapp:latest
trivy image myapp:latest
docker inspect --format='{{.Config.User}}' myapp:latest

# Resources
docker stats
docker top container_name

# Cleanup
docker system prune -a
docker volume prune
```

---

### Junior → FAANG: Consolidating Docker Knowledge Into a Working Mental Model

After a chapter this dense, the risk is knowing many individual facts without a coherent mental model that ties them together. The mental model to consolidate: a Docker image is a layered, immutable artifact that encodes a specific environment for running a specific binary. A container is that artifact running as a process with isolation and resource boundaries. The Dockerfile is the recipe that produces the image, and every choice in that recipe has security, performance, and operational consequences.

The three principles that unify this chapter: make the image as small as possible (multi-stage builds, distroless base, static linking), make it as secure as possible (non-root user, read-only filesystem, no secrets in layers, scanned for CVEs), and make it as observable as possible (structured logs, health checks, resource limits that reflect actual usage). Every Dockerfile decision can be evaluated against these three principles.

For interviews, the ability to discuss a realistic scenario end to end (build a Go HTTP service, containerize it, make it production-ready, explain every choice) is more valuable than knowledge of any individual feature.

### Senior @ FAANG: Container Platform Strategy as a Staff Engineering Deliverable

The full arc of this chapter represents a container platform strategy. At L6/L7, the deliverable is not "I know how to do these things." It is "I have designed and driven adoption of a container platform that makes these things the default for every team in the organization."

The strategy has four layers. The standards layer: documented, versioned requirements for what a production container must include (specific base image version, non-root user, health checks, resource limits, image signing). The enforcement layer: automated checks at every gate in the delivery pipeline that verify compliance with standards and fail the pipeline on violations. The enablement layer: templates, libraries, and documentation that make it easy for teams to comply with standards without being container experts themselves. The governance layer: a process for updating standards, handling exceptions, and tracking the organization's compliance posture over time.

A staff engineer who has built all four layers for a container platform can point to measurable outcomes: reduction in container-related incidents, reduction in mean-time-to-detect for security vulnerabilities, reduction in average image size and associated infrastructure cost, and improvement in deployment frequency and lead time (as pipeline reliability improves). These outcomes, expressed in concrete numbers with before-and-after comparison, are the evidence of L6/L7 impact on container infrastructure.
