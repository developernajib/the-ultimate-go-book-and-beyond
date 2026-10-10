## 17.8 Build and Deployment

### Makefile

A well-structured Makefile serves as the project's command directory. It encodes the approved way to build, test, and deploy the application, so every developer and every CI pipeline uses identical flags. Injecting version metadata via `-ldflags -X` embeds it directly into the binary with no separate configuration file to keep in sync.

```makefile
.PHONY: build test lint run

# Variables
BINARY_NAME=myapp
VERSION=$(shell git describe --tags --always --dirty)
# Derive the stamp from the commit, NOT from `date`. See the note below.
SOURCE_DATE_EPOCH=$(shell git log -1 --pretty=%ct)
BUILD_TIME=$(shell date -u -d "@${SOURCE_DATE_EPOCH}" '+%Y-%m-%dT%H:%M:%SZ')
LDFLAGS=-ldflags "-X main.version=${VERSION} -X main.buildTime=${BUILD_TIME}"

# Build
build:
	go build -trimpath ${LDFLAGS} -o bin/${BINARY_NAME} ./cmd/api

build-all:
	GOOS=linux GOARCH=amd64 go build ${LDFLAGS} -o bin/${BINARY_NAME}-linux-amd64 ./cmd/api
	GOOS=darwin GOARCH=amd64 go build ${LDFLAGS} -o bin/${BINARY_NAME}-darwin-amd64 ./cmd/api
	GOOS=windows GOARCH=amd64 go build ${LDFLAGS} -o bin/${BINARY_NAME}-windows-amd64.exe ./cmd/api

# Test
test:
	go test -race -cover ./...

test-integration:
	go test -race -tags=integration ./test/integration/...

# Lint
lint:
	golangci-lint run ./...

# Run
run:
	go run ./cmd/api

# Docker
docker-build:
	docker build -t ${BINARY_NAME}:${VERSION} .

docker-push:
	docker push ${BINARY_NAME}:${VERSION}

# Clean
clean:
	rm -rf bin/
```

**Why `BUILD_TIME` comes from the commit and not from `date`.** The obvious version of that line is `BUILD_TIME=$(shell date -u ...)`, and it quietly destroys reproducibility. The timestamp changes on every invocation, so it gets linked into the binary as a different string every time, and the same commit produces a different artifact on every build:

```
build 1 sha: 148fc49c4d6b0bb7
build 2 sha: d8ae99d91e7697da   # identical source, different binary
```

Deriving the stamp from the commit date (the `SOURCE_DATE_EPOCH` convention, which is shared across the wider reproducible-builds effort) makes rebuilds byte-identical:

```
build 3 sha: f23dbbbcefaf22a4
build 4 sha: f23dbbbcefaf22a4   # reproducible
```

That matters for more than tidiness. If you cannot rebuild a commit and get the artifact you shipped, you cannot prove the binary in production came from the source you think it did, which is the whole foundation of supply-chain attestation and a nasty gap during an incident.

### Dockerfile

A multi-stage Dockerfile separates the build environment from the runtime image: the `builder` stage uses the full Go toolchain to produce a statically linked binary with `CGO_ENABLED=0`, which is then copied into a minimal Alpine image that contains no compiler, no source code, and a significantly smaller attack surface.

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /app/bin/api ./cmd/api

# Final stage
FROM alpine:3.19

RUN apk --no-cache add ca-certificates

WORKDIR /app

COPY --from=builder /app/bin/api .
COPY --from=builder /app/configs ./configs

EXPOSE 8080

ENTRYPOINT ["./api"]
```

### Distroless and Scratch Images

For smaller, more secure images, use `gcr.io/distroless/static` (no shell, minimal attack surface) or `scratch` (nothing but the binary).

Be precise about the linking, because this is where scratch images usually go wrong. `CGO_ENABLED` defaults to **1**, not 0, and a default build that touches `net` or `os/user` links against the system libc:

```
$ CGO_ENABLED=1 go build -o bin-cgo .   # the default
$ file bin-cgo
ELF 64-bit LSB executable, x86-64, dynamically linked, interpreter /lib64/...

$ CGO_ENABLED=0 go build -o bin-nocgo .
$ file bin-nocgo
ELF 64-bit LSB executable, x86-64, statically linked
```

A dynamically linked binary copied into `scratch` fails at startup with a "no such file or directory" error that is really the missing dynamic loader, one of the more confusing messages in Docker. `CGO_ENABLED=0` is what makes the binary self-contained, so it is a requirement for scratch, not a nicety:

```dockerfile
FROM scratch
COPY --from=builder /app/bin/api /api
COPY --from=builder /app/configs /configs
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
ENTRYPOINT ["/api"]
```

Keep the size expectations honest: for a Go service the binary dominates the image, and the base layer is the only thing you are trading away. Alpine adds roughly 8 MB on top of your binary, `distroless/static` a couple of MB, and `scratch` nothing at all. Going from alpine to scratch saves single-digit megabytes, not the bulk of the image. The real argument for distroless and scratch is the attack surface: no shell, no package manager, no busybox, so an attacker who achieves RCE has no tools to pivot with. Optimize for that, and treat the megabytes as a bonus.

Note the two files the scratch build still has to copy in. CA certificates are needed for any outbound TLS, and without them every HTTPS call fails with a certificate-verification error. If your service formats times in a named location, you need zoneinfo too, either copied from the builder or embedded with `import _ "time/tzdata"`. Scratch also has no `/etc/passwd`, so the container runs as root unless you add a numeric `USER 65534` and set file ownership in the `COPY`.

### Build Flags for Production

```bash
go build -trimpath -ldflags="-s -w -X main.version=$(git rev-parse --short HEAD)" ./cmd/api
```

- `-trimpath`: removes build-machine paths from the binary (security).
- `-ldflags="-s -w"`: strips debug info, reduces binary size.
- `-X main.version`: embeds the git commit into the binary.

Tag the binary version. On-call engineers thank you when they can `./api version` to see exactly what is running.

### Staff Lens: Build Reproducibility

A production build must be reproducible: the same source at the same commit produces the same binary. This requires `GOFLAGS=-trimpath`, pinned Go versions, deterministic dependencies (`go.sum` verified), and deterministic timestamps. Without reproducibility, supply-chain security and incident diagnosis are harder than they need to be.

---
