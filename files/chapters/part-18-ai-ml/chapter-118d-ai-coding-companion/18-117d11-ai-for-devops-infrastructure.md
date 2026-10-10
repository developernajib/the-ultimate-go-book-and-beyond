## 118D.11 AI for DevOps & Infrastructure

### Using AI to Write Dockerfiles and Kubernetes Manifests

DevOps artifacts are among the most valuable targets for AI generation because they follow well-known patterns with project-specific details. AI produces excellent first drafts that you customize for your specific requirements.

**Template: Dockerfile Generation Prompt**

```
Generate a production-quality multi-stage Dockerfile for a Go
application with these requirements:

- Binary name: [your binary name]
- Go version: 1.27
- Needs: [CGO disabled / CGO enabled with specific libs]
- Exposes port: [port]
- Requires these runtime dependencies: [list any]
- Should run as non-root user
- Include health check
- Optimize for small image size
- Use distroless or alpine base for final stage

Additional context:
- The binary reads config from /etc/app/config.yaml
- It needs TLS certificates in /etc/ssl/certs
```

**AI-generated Dockerfile:**

```dockerfile
# Build stage: compile the Go binary.
FROM golang:1.27.1-alpine AS builder

# Install git for fetching dependencies and ca-certificates for HTTPS.
RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /build

# Cache dependency downloads.
COPY go.mod go.sum ./
RUN go mod download && go mod verify

# Copy source code.
COPY . .

# Build with optimizations: disable CGO, strip debug symbols, embed
# version information.
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-s -w -X main.version=${VERSION}" \
    -trimpath \
    -o /app/server \
    ./cmd/server

# Final stage: minimal runtime image.
FROM gcr.io/distroless/static-debian12:nonroot

# Copy timezone data and CA certificates from builder.
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy the binary.
COPY --from=builder /app/server /server

# Copy default configuration.
COPY config/default.yaml /etc/app/config.yaml

# Expose the application port.
EXPOSE 8080

# Health check: the app must implement a /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/server", "healthcheck"]

# Run as non-root user (65534 is the "nobody" user in distroless).
USER nonroot:nonroot

ENTRYPOINT ["/server"]
CMD ["--config=/etc/app/config.yaml"]
```

### CI/CD Pipeline Generation

**Template: GitHub Actions Pipeline Prompt**

```
Generate a GitHub Actions CI/CD pipeline for a Go microservice with:

- Go 1.27
- Run on: push to main, pull requests
- Steps: lint (golangci-lint), test (with race detector), build,
  security scan (gosec), Docker build and push to ECR
- Cache Go modules and build cache
- Run tests with coverage report
- Fail on coverage below 80%
- Deploy to staging on main push, production on tag
```

### Go Code: AI-Powered Deployment Assistant

The deployment assistant follows the same LLM client pattern shown throughout this chapter (see the `AnthropicClient` in Section 118D.2). The key design insight is gathering all cluster state *before* calling AI, so the model gets a complete picture in a single prompt.

```go
package deploy

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"time"
)

// DeploymentStatus represents the current state of a deployment.
type DeploymentStatus struct {
	Environment string    `json:"environment"`
	Version     string    `json:"version"`
	Status      string    `json:"status"` // "running", "failed", "rolling_back"
	StartedAt   time.Time `json:"started_at"`
	PodCount    int       `json:"pod_count"`
	ReadyCount  int       `json:"ready_count"`
}

// LLMClient abstracts the language model interface.
type LLMClient interface {
	Complete(ctx context.Context, prompt string) (string, error)
}

// DeployAssistant provides AI-powered deployment support.
// It wraps kubectl commands to gather cluster state, then sends
// the full context to an LLM for analysis.
type DeployAssistant struct {
	llm       LLMClient // Reuse the LLMClient interface from Section 118D.2.
	namespace string
}

// PreDeployCheck gathers cluster state and asks AI to identify potential
// issues before deploying a new version.
func (d *DeployAssistant) PreDeployCheck(ctx context.Context, deployment, newVersion string) (string, error) {
	// Gather all cluster state in parallel for a complete picture.
	status, _ := kubectlOutput(ctx, "get", "deployment", deployment,
		"-n", d.namespace, "-o", "json")
	events, _ := kubectlOutput(ctx, "get", "events",
		"-n", d.namespace, "--field-selector=involvedObject.name="+deployment)
	resources, _ := kubectlOutput(ctx, "top", "pods",
		"-n", d.namespace, "-l", "app="+deployment)

	prompt := fmt.Sprintf(`You are a Kubernetes deployment advisor.
Current deployment: %s (namespace: %s)
Deploying version: %s

Status: %s
Events: %s
Resources: %s

Analyze:
1. Is the deployment healthy enough to update?
2. Any warning signs in events?
3. Resource concerns (OOM/throttling risk)?
4. Recommended rollback strategy?
5. What to monitor during rollout?`, deployment, d.namespace, newVersion,
		status, events, resources)

	return d.llm.Complete(ctx, prompt)
}

// DiagnoseFailure analyzes a failed deployment and suggests fixes.
func (d *DeployAssistant) DiagnoseFailure(ctx context.Context, deployment string) (string, error) {
	podLogs, _ := kubectlOutput(ctx, "logs", "-n", d.namespace,
		"-l", "app="+deployment, "--tail=100", "--all-containers=true")
	events, _ := kubectlOutput(ctx, "get", "events",
		"-n", d.namespace, "--field-selector=involvedObject.name="+deployment)
	describe, _ := kubectlOutput(ctx, "describe", "deployment",
		deployment, "-n", d.namespace)

	prompt := fmt.Sprintf(`A Kubernetes deployment has failed. Diagnose the issue.
Deployment: %s (namespace: %s)

Pod Logs (last 100 lines): %s
Events: %s
Description: %s

Provide: root cause, immediate fix, further diagnosis commands,
and whether to rollback or fix forward.`, deployment, d.namespace,
		podLogs, events, describe)

	return d.llm.Complete(ctx, prompt)
}

func kubectlOutput(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "kubectl", args...)
	out, err := cmd.Output()
	if err != nil {
		slog.Warn("kubectl command failed", "args", args, "error", err)
		return fmt.Sprintf("(failed: %v)", err), err
	}
	return string(out), nil
}
```

> **What AI Gets Wrong**: AI-generated Kubernetes manifests and Terraform configs often use default resource limits that are inappropriate for your workload. Always review CPU/memory requests and limits, replica counts, and storage sizes against your actual traffic patterns. AI doesn't know your scale.

> **Pro Tip**: The most dangerous AI-generated DevOps artifact is a Terraform configuration. Unlike a bad Dockerfile (which just fails to build), a bad Terraform config can create expensive cloud resources or misconfigure security groups. Always `terraform plan` and review the plan output carefully before applying AI-generated infrastructure code.

---

### Junior → FAANG: DevOps AI Assistance as Infrastructure Engineering Entry Point

AI-assisted DevOps is an entry point for junior engineers to develop infrastructure engineering skills that would otherwise take years of trial-and-error experience to accumulate. AI can generate Kubernetes manifests, Helm charts, and Terraform configurations that follow production best practices (resource limits, readiness probes, network policies, security contexts) that junior engineers would not know to include without experience. The learning strategy is: generate with AI, study every configuration element to understand why it exists, apply the knowledge to future configurations without AI assistance.

The "terraform plan before applying" practice is the most important safety habit in infrastructure-as-code development. Unlike application code where a bug causes a test failure, a Terraform bug can create expensive cloud resources, misconfigure security groups, or delete production data. The plan step shows exactly what will be created, modified, or destroyed before any change is made. Review the plan output for: unexpected resource creation or deletion, security group changes that open unintended ports, and cost implications of new resources. This review discipline, applied to every AI-generated Terraform change, prevents the infrastructure accidents that are otherwise the most expensive learning experiences.

### Senior @ FAANG: AI-Generated Infrastructure as IaC Governance Challenge

At senior level, AI-generated infrastructure as code introduces a governance challenge: AI can generate syntactically correct Terraform or Kubernetes manifests that violate organizational security policies (security groups open to 0.0.0.0/0, containers running as root, missing network policies). Without policy-as-code enforcement (OPA Gatekeeper for Kubernetes, Sentinel for Terraform), these violations reach production regardless of the review process because reviewers may not notice every policy violation in a complex manifest.

The governance solution is automated policy enforcement: define organizational security policies as machine-readable rules, enforce them in CI as a blocking check, and provide clear error messages that help engineers correct the violations. AI-generated infrastructure code that violates these policies fails CI immediately, with a specific message about which policy was violated and how to fix it. This automated enforcement is the only governance mechanism that scales to AI-generation rates: human reviewers cannot review every AI-generated manifest line for every policy violation without becoming the bottleneck in the development process.
