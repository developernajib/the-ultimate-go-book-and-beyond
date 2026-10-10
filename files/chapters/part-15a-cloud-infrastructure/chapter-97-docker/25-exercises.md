## Exercises

1. **Multi-Stage Go Docker Build**: Create a Dockerfile using multi-stage builds that compiles a Go HTTP server in a `golang:1.27.1-alpine` builder stage and copies only the final binary into a `scratch` base image. Verify the resulting image is under 15 MB and that the binary runs correctly with `docker run`.

2. **Non-Root User Security Hardening**: Take an existing Go application Dockerfile and harden it by creating a dedicated non-root user and group (`appuser:appgroup`), setting file ownership on the binary, and switching to that user with `USER`. Confirm with `docker inspect` that the container no longer runs as root, and document any capability drops (`--cap-drop=ALL`) needed.

3. **Docker Layer Caching Optimization**: Restructure a Go Dockerfile so that `go mod download` runs in its own layer before copying application source code. Measure build times with a warm cache vs. a cold cache using `docker build --no-cache`. Achieve at least a 60% reduction in rebuild time when only application code changes.

4. **Health Check Implementation**: Add a `HEALTHCHECK` instruction to a Go web server Dockerfile that calls the `/healthz` endpoint every 15 seconds with a 5-second timeout and 3 retries before marking the container unhealthy. Verify the health status transitions with `docker inspect --format='{{.State.Health.Status}}'` after deliberately breaking the endpoint.

5. **Docker Compose for Local Dev with Hot Reload**: Write a `docker-compose.yml` that runs a Go service with [Air](https://github.com/air-verse/air) for hot reload, mounts the source directory as a volume, and wires up a PostgreSQL service with a health check dependency. Confirm that saving a `.go` file triggers an automatic recompile and restart within the container without rebuilding the image.

6. **Distroless Image with Debug Variant**: Build the same Go binary into both `gcr.io/distroless/static-debian12` (production) and `gcr.io/distroless/static-debian12:debug` (debug) using a build argument (`ARG VARIANT=static-debian12`). Show that the production image has no shell while the debug image allows `docker run --entrypoint /busybox/sh` inspection. Compare final image sizes and document the security trade-offs.

### Junior → FAANG: Getting the Most From These Exercises

These exercises are scoped tightly to produce concrete, verifiable results. Each one has a specific success condition (image under 15 MB, health status transitions, recompile triggers). Aim to hit those conditions exactly, then extend the exercise: what happens if you break the health endpoint intentionally? What does `docker events` output during a container lifecycle?

The distroless debug variant exercise is particularly valuable because it makes the production/debugging tradeoff tangible. Running the same binary in two different base images and experiencing the difference in debug capability versus attack surface is more memorable than reading about it. Take notes on the specific commands that work in the debug image and fail in the production image. Those notes are the basis for a runbook.

### Senior @ FAANG: Extending Exercises Into Platform Work

At senior level, these exercises are not individual learning activities. They are prototypes for platform standards. Exercise 1 (multi-stage build under 15 MB) becomes the standard image size gate in CI. Exercise 4 (health check implementation) becomes the required health check specification in the service deployment template. Exercise 5 (Docker Compose with hot reload) becomes the standard local development environment for all Go services.

The senior extension for each exercise is: how would this be enforced across all services? Who owns the enforcement mechanism? What is the exception process? What is the monitoring that tells you when a service violates the standard? Thinking through these questions for each exercise produces a concrete platform design document that maps directly to real work.

---

*Next: [Chapter 98: Kubernetes for Go Applications](../chapter-98-kubernetes/00-introduction.md)*

