## 25.6 Cross-Compilation

### Target Platforms

Go's cross-compilation requires only setting two environment variables, `GOOS` for the target operating system and `GOARCH` for the target CPU architecture. No host-side cross-compiler toolchain is needed for pure Go code, making it trivial to build Linux binaries on macOS for container deployment. `go tool dist list` shows every supported `GOOS/GOARCH` combination.

```bash
# List supported platforms
go tool dist list

# Build for Linux
GOOS=linux GOARCH=amd64 go build -o app-linux-amd64
GOOS=linux GOARCH=arm64 go build -o app-linux-arm64

# Build for macOS
GOOS=darwin GOARCH=amd64 go build -o app-darwin-amd64
GOOS=darwin GOARCH=arm64 go build -o app-darwin-arm64

# Build for Windows
GOOS=windows GOARCH=amd64 go build -o app-windows-amd64.exe
```

### CGO Cross-Compilation

`CGO_ENABLED=0` produces a statically linked pure Go binary, the simplest and most portable approach. When CGO is required (e.g., for SQLite or system crypto libraries), cross-compilation demands a matching C cross-compiler for the target platform. Setting `CC` to the appropriate cross-compiler binary allows the Go toolchain to call it for the C portions of the build.

```bash
# Disable CGO for pure Go builds
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build

# Cross-compile with CGO (requires cross-compiler)
CGO_ENABLED=1 CC=x86_64-linux-gnu-gcc GOOS=linux GOARCH=amd64 go build
```

### Build Script

A release build script iterates over a matrix of target platforms, sets `GOOS` and `GOARCH` for each, and injects version metadata via `-ldflags`. Naming output files with the platform suffix, `myapp-linux-amd64`, `myapp-darwin-arm64`, produces a clean `dist/` directory that a CI pipeline can upload directly to a GitHub release or S3 bucket.

`-trimpath` earns its place in any script that produces artifacts you ship. Without it the compiler records absolute source paths, so the binary embeds whatever directory it was built in, and the same commit built in `/home/alice/src` and `/build/ci` produces different bytes. With it, the two are byte-identical. That is the difference between a release you can reproduce and audit and one you can only take on faith, and it costs nothing.

```bash
#!/bin/bash
set -e

VERSION=$(git describe --tags --always)
COMMIT=$(git rev-parse HEAD)
BUILD_TIME=$(date -u '+%Y-%m-%d_%H:%M:%S')

LDFLAGS="-s -w -X main.Version=$VERSION -X main.Commit=$COMMIT -X main.BuildTime=$BUILD_TIME"

PLATFORMS=("linux/amd64" "linux/arm64" "darwin/amd64" "darwin/arm64" "windows/amd64")

for platform in "${PLATFORMS[@]}"; do
    GOOS=${platform%/*}
    GOARCH=${platform#*/}
    output="dist/myapp-${GOOS}-${GOARCH}"

    if [ "$GOOS" = "windows" ]; then
        output+=".exe"
    fi

    echo "Building $output..."
    # -trimpath: strip absolute source paths so the artifact is reproducible
    # regardless of which directory (or CI runner) built it.
    CGO_ENABLED=0 GOOS=$GOOS GOARCH=$GOARCH \
        go build -trimpath -ldflags="$LDFLAGS" -o "$output" ./cmd/myapp
done

echo "Build complete!"
```

### Staff Lens: Cross-Compile on Dev Machines

Pure Go cross-compiles trivially. Developers should build production-arch binaries locally to test, not wait for CI. CGO complicates this. Avoid CGO when possible for this reason alone.

---
