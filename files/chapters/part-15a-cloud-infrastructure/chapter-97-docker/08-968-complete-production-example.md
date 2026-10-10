## 97.8 Complete Production Example

### Project Structure

A well-organized Go project separates the application entry point (`cmd/`), internal business logic (`internal/`), and Docker-related files at the repository root. Having separate Dockerfiles for production and debugging, along with separate Compose files for development and production, keeps each concern isolated and makes it clear which configuration applies in which environment.

```
myapp/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── config/
│   ├── handlers/
│   └── services/
├── Dockerfile
├── Dockerfile.debug
├── docker-compose.yml
├── docker-compose.prod.yml
├── .dockerignore
├── go.mod
└── go.sum
```

### Production Docker Compose

A production Compose file differs from a development one in several important ways. It references pre-built images instead of building from source, sets resource limits (CPU and memory) to prevent any single service from starving others, enables a read-only filesystem, and configures health checks for automatic restart on failure. The `deploy.resources` section is especially important because without memory limits, a memory leak in your Go application could consume all available RAM on the host.

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  app:
    image: myapp:${VERSION:-latest}
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - LOG_LEVEL=info
    healthcheck:
      test: ["CMD", "/server", "-health-check"]
      interval: 30s
      timeout: 3s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 512M
        reservations:
          cpus: '0.25'
          memory: 128M
    read_only: true
    security_opt:
      - no-new-privileges:true
```

---

### Junior → FAANG: Reading a Production Dockerfile End to End

The value of a complete production example is that it makes the dependencies between decisions visible. Non-root user requires creating the user in the build stage and copying passwd entries to the final stage. Read-only root filesystem requires knowing which directories the application writes to at runtime and mounting them explicitly. Health checks require knowing which endpoint is cheap to call and has no side effects.

A practical exercise for building this intuition: take a production Dockerfile from an open-source Go project (the Go projects in the CNCF ecosystem are good references) and annotate every instruction with the reason behind it. What CVE or incident does this instruction prevent? What performance problem does it solve? Being able to answer that question for every line in a Dockerfile demonstrates genuine understanding, not just syntax familiarity.

First-job interview signal: when asked "how would you improve this Dockerfile?" the answer should not just be "add a multi-stage build." It should cover layer ordering, cache mounting, security controls, image scanning, and health checks, with a brief explanation of the value of each.

### Senior @ FAANG: Production Readiness as a Codified Standard

At senior level, a complete production example should be the template from which every new service starts, not an aspirational example in a book. This is a platform problem: how do you make the right thing the default thing for every new team?

The mechanism is a service template or project scaffold that generates the Dockerfile, the Kubernetes manifests, the CI pipeline, and the observability configuration from a single `service.yaml` manifest. Backstage (the CNCF developer portal project), internal CLIs, or cookiecutter-style template repositories are common implementations. The critical requirement is that the template is maintained and kept current: when the security standard changes (new base image, new required label, new admission policy), the template is updated and teams receive automated PRs to upgrade.

At L6/L7, the production example conversation becomes a discussion about standards governance. Who owns the template? How are breaking changes communicated? What is the migration path when the standard changes significantly? What is the exception process for teams with legitimate reasons to deviate? These are organizational and process questions, not technical ones, and answering them well is a bar-raiser signal.
