## Build Automation and Operational Tooling

Production debugging toolkits require disciplined operational automation. Rather than relying on memorized terminal flags or error-prone ad-hoc commands, production systems standardize compilation, local reproduction, remote debugging, profiling capture, and artifact sanitization behind automated tooling targets.

---

### 1. Build and Compilation Targets

The following Makefile targets compile the debug server and the CLI tool. The `build-debug` target preserves full symbol information by disabling optimizations and inlining, which is necessary for Delve to inspect local variables, but should never be used for profiling, since the resulting binary does not reflect production performance characteristics.

```makefile
build: build-server build-ctl

build-server:
	@echo "Building debug server..."
	go build $(LDFLAGS) -o bin/debugserver ./cmd/debugserver

build-ctl:
	@echo "Building debug CLI..."
	go build $(LDFLAGS) -o bin/debugctl ./cmd/debugctl

build-debug:
	@echo "Building with debug symbols..."
	go build $(LDFLAGS) -gcflags="all=-N -l" -o bin/debugserver ./cmd/debugserver
```


---

### 2. Verification, Race Detection and Benchmarking

These targets run the test suite with the race detector enabled (`-race`) so that any concurrent access bugs in the debug toolkit itself are caught before deployment. The benchmark target measures the overhead of each collector and analyzer to verify they stay within acceptable bounds for production use.

```makefile
test:
	go test -v -race -cover ./...

test-coverage:
	go test -v -race -coverprofile=coverage.out ./...
	go tool cover -html=coverage.out -o coverage.html

bench:
	go test -bench=. -benchmem ./...
```


---

### 3. Local Runtime and Container Execution

The `run` target builds the debug server and starts it on loopback port 6060 with debug-level logging. The Docker variant brings up the server alongside any supporting infrastructure (Prometheus, Jaeger) defined in the compose file.

```makefile
run: build-server
	./bin/debugserver --addr 127.0.0.1:6060 --log-level debug

run-docker: docker-build
	docker compose up -d
```

Two details are deliberate. The address is `127.0.0.1:6060` rather than `:6060`, because a bare `:6060` binds every interface and publishes heap contents and argv to whatever network the machine is attached to. And it is `docker compose`, two words: the hyphenated `docker-compose` is the v1 Python tool, which is end-of-life and absent from current Docker installs.


---

### 4. Container Packaging and Metadata Injection

The Docker build injects version, commit SHA, and build timestamp as build arguments so the resulting image carries the same metadata exposed by the `/debug/info` endpoint. The push target tags and uploads to the configured container registry.

```makefile
docker-build:
	docker build \
		--build-arg VERSION=$(VERSION) \
		--build-arg COMMIT=$(COMMIT) \
		--build-arg BUILD_TIME=$(BUILD_TIME) \
		-t debug-toolkit:$(VERSION) .

docker-push: docker-build
	docker tag debug-toolkit:$(VERSION) $(REGISTRY)/debug-toolkit:$(VERSION)
	docker push $(REGISTRY)/debug-toolkit:$(VERSION)
```


---

### 5. Automated Telemetry and Profile Capture

These targets use the `debugctl` CLI to capture profiles from a running service and immediately open them in the `pprof` web UI. The CPU profile captures 30 seconds of execution by default. Heap and goroutine profiles are point-in-time snapshots that complete instantly.

```makefile
profile-cpu:
	./bin/debugctl profile cpu --duration 30s --output cpu.prof
	go tool pprof -http=:8081 cpu.prof

profile-heap:
	./bin/debugctl profile heap --output heap.prof
	go tool pprof -http=:8082 heap.prof

profile-goroutine:
	./bin/debugctl profile goroutine --output goroutine.prof
	go tool pprof goroutine.prof
```


---

### 6. Interactive and Headless Delve Debugging

The `debug-attach` target starts a headless Delve server attached to a running process, and `debug-connect` opens an interactive client session against it. Pass the target process ID via `make debug-attach PID=<pid>`.

```makefile
debug-attach:
	dlv attach $(PID) --headless --listen=127.0.0.1:2345 --api-version=2

debug-connect:
	dlv connect 127.0.0.1:2345
```

The listen address is `127.0.0.1:2345`, not `:2345`, and the difference is not stylistic. Delve's API has no authentication and no transport security, and it can set breakpoints, read and write memory, and call functions in the target. Anyone who can open a TCP connection to that port has arbitrary code execution as the debugged process. `--listen=:2345` offers exactly that to the whole network. To debug something on another host, bind loopback there and forward the port over SSH (`ssh -L 2345:127.0.0.1:2345 host`), which puts the session behind authentication you already trust.

Remember also what attaching does: `dlv attach` halts every goroutine in the target and holds it halted until you detach. On a service taking traffic, that stalls requests and fails health checks, and an orchestrator may restart the pod underneath you. Drain the replica first, or take a core and debug that instead.


---

### 7. Code Quality, Dependency Tidying, and Command Summary

Standard housekeeping targets for linting, formatting, dependency tidying, and cleanup. The `help` target prints a summary of all available commands, useful when onboarding new team members to the toolkit.

```makefile
lint:
	golangci-lint run ./...

fmt:
	go fmt ./...
	goimports -w .

tidy:
	go mod tidy

clean:
	rm -rf bin/
	rm -f coverage.out coverage.html
	rm -f *.prof

help:
	@echo "Debug Toolkit Makefile"
	@echo ""
	@echo "Build:"
	@echo " make build Build all binaries"
	@echo " make build-debug Build with debug symbols"
	@echo ""
	@echo "Test:"
	@echo " make test Run tests"
	@echo " make test-coverage Run tests with coverage"
	@echo " make bench Run benchmarks"
	@echo ""
	@echo "Run:"
	@echo " make run Run debug server locally"
	@echo " make run-docker Run in Docker"
	@echo ""
	@echo "Profile:"
	@echo " make profile-cpu Capture and view CPU profile"
	@echo " make profile-heap Capture and view heap profile"
	@echo ""
	@echo "Docker:"
	@echo " make docker-build Build Docker image"
	@echo " make docker-push Push to registry"
	@echo ""
	@echo "Debug:"
	@echo " make debug-attach PID=<pid> Attach Delve to process"
	@echo " make debug-connect Connect to Delve server"
```

---

