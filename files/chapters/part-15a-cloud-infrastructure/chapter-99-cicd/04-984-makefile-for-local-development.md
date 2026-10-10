## 99.4 Makefile for Local Development

A `Makefile` provides a single, self-documenting interface for every common development task, ensuring that the same commands work consistently for every contributor regardless of their local tooling setup. Using `.PHONY` declarations prevents `make` from confusing target names with real files, and grouping targets by concern, build, test, lint, security, Docker, mirrors the structure of the CI pipeline so local runs match what the pipeline will execute. The `check` target composes formatting, linting, testing, and security scanning into one pre-commit gate that catches issues before they reach the remote.

```makefile
# Makefile
.PHONY: all build test lint security run clean

GO := go
BINARY := bin/server
DOCKER_IMAGE := myapp

# Build
build:
	$(GO) build -o $(BINARY) ./cmd/server

build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GO) build -o $(BINARY) ./cmd/server

# Test
test:
	$(GO) test -v -race ./...

test-coverage:
	$(GO) test -v -race -coverprofile=coverage.out ./...
	$(GO) tool cover -html=coverage.out -o coverage.html

# Lint
lint:
	golangci-lint run

fmt:
	$(GO) fmt ./...
	goimports -w .

# Security
security:
	govulncheck ./...
	gosec ./...

# Docker
docker-build:
	docker build -t $(DOCKER_IMAGE):latest .

docker-push:
	docker push $(DOCKER_IMAGE):latest

# Run
run:
	$(GO) run ./cmd/server

# Clean
clean:
	rm -rf bin/
	rm -f coverage.out coverage.html

# All checks (run before commit)
check: fmt lint test security
	@echo "All checks passed!"
```

---

### Junior → FAANG: The Makefile as the Local CI Simulation

The Makefile's most important function is making the local development experience match the CI pipeline. When `make check` runs the same lint, test, and security checks that CI runs, CI failures become predictable and fixable locally before pushing. When the Makefile and CI diverge (different flags, different tool versions), CI failures become surprises that break the development flow.

The practical pattern: every CI step that is not hardware-specific or environment-specific should have a Makefile target. Before pushing a commit, `make check` (or whatever the equivalent is in your Makefile) should be green. This is not about compliance. It is about not wasting your own time and your reviewers' time on CI failures that a local run would have caught.

First-job habit: add a help target (`make help`) that documents what each target does. A Makefile that is self-documenting is significantly more valuable to a team than one that requires reading the targets' implementations to understand their purpose.

### Senior @ FAANG: Makefile as Developer Experience Infrastructure

At staff level, the Makefile is a developer experience (DX) product. Its quality directly affects how quickly engineers can onboard, how fast the feedback loop is for common tasks, and how consistent the build and test experience is across different machines and operating systems.

The DX concerns that do not appear in small teams: tool version management (does `make lint` use the same golangci-lint version as CI, and how is that enforced?), cross-platform compatibility (does the Makefile work on both Linux and macOS, and for engineers with Windows + WSL?), and dependency bootstrapping (can a new engineer run `make setup` and have everything they need, including the correct Go version, linters, and local infrastructure?).

Replacing a Makefile with a tool like Task (taskfile.dev) or Just (casey/just) is a legitimate improvement for teams that hit Makefile's limitations (portability, readability, dependency management). The ADR for this choice should document the specific limitations being addressed and the migration plan for existing contributors. The staff engineer's role is to evaluate the trade-offs and make a recommendation that the team buys into, not to unilaterally replace a tool that works adequately.
