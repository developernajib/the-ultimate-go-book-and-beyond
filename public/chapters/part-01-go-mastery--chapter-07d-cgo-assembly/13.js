export default `## 7D.12 Cross-Compilation with CGO

Cross-compiling Go code that uses CGO requires the **target architecture's C compiler** - not just Go's cross-compiler.

### Strategy 1: Docker with Target's Toolchain

Cross-compiling CGO code requires a C cross-compiler targeting the destination architecture. Docker with a pre-built cross-toolchain is the most reliable approach for reproducible cross-compilation.

\`\`\`dockerfile
# Dockerfile.cross-amd64
FROM golang:1.26 AS builder
# Install cross-compilation toolchain for ARM64
RUN apt-get update && apt-get install -y gcc-aarch64-linux-gnu

WORKDIR /app
COPY . .

# Cross-compile for ARM64
ENV CGO_ENABLED=1
ENV GOOS=linux
ENV GOARCH=arm64
ENV CC=aarch64-linux-gnu-gcc
RUN go build -o myapp-arm64 ./cmd/server
\`\`\`

Build the cross-compiled binary and extract it from the container:

\`\`\`bash
docker build -f Dockerfile.cross-amd64 -o . .
\`\`\`

### Strategy 2: zig cc as Universal C Compiler

Zig ships with a complete C compiler and standard library for all targets, no need to install cross-toolchains:

\`\`\`bash
# Install zig: https://ziglang.org/download/
# Use zig cc as the C compiler for any target:

# Cross-compile for ARM64 Linux from macOS/Linux x86-64
CGO_ENABLED=1 \\
GOOS=linux \\
GOARCH=arm64 \\
CC="zig cc -target aarch64-linux-musl" \\
CXX="zig c++ -target aarch64-linux-musl" \\
go build -o myapp-arm64 ./...

# Cross-compile for Windows x86-64 from Linux
CGO_ENABLED=1 \\
GOOS=windows \\
GOARCH=amd64 \\
CC="zig cc -target x86_64-windows-gnu" \\
go build -o myapp.exe ./...

# Cross-compile for macOS ARM64 (Apple Silicon) from Linux
# Note: Apple frameworks require macOS SDK - only works for non-Apple APIs
CGO_ENABLED=1 \\
GOOS=darwin \\
GOARCH=arm64 \\
CC="zig cc -target aarch64-macos" \\
go build ./...
\`\`\`

### Strategy 3: muslcc for Static Musl Builds

Building against musl libc produces fully static binaries that run on any Linux distribution without glibc version dependencies. The \`muslcc\` cross-compiler enables this from a standard Linux or macOS host.

\`\`\`bash
# Static build using musl libc (fully self-contained binary, no external deps)
CGO_ENABLED=1 \\
GOOS=linux \\
GOARCH=amd64 \\
CC=x86_64-linux-musl-gcc \\
go build -ldflags="-linkmode=external -extldflags=-static" -o myapp-static ./...

# Verify no dynamic dependencies
ldd ./myapp-static
# not a dynamic executable
\`\`\`

### Build Tag Strategy for Cross-Platform CGO

When a package uses CGO for performance on supported platforms but needs to build everywhere, build tags conditionally select between the CGO implementation and a pure-Go fallback.

\`\`\`go
// file: native.go - compiled when CGO is available
//go:build cgo && (linux || darwin || windows)

package mylib

// NativeAccelerate uses platform-native acceleration
func NativeAccelerate(data []byte) []byte {
    // CGO implementation
    return cgoAccelerate(data)
}
\`\`\`

The fallback file uses the negated build constraint, so it compiles when CGO is disabled or on unsupported platforms:

\`\`\`go
// file: fallback.go - compiled when CGO is disabled OR unsupported platform
//go:build !cgo || !(linux || darwin || windows)

package mylib

// NativeAccelerate falls back to pure Go
func NativeAccelerate(data []byte) []byte {
    return pureGoAccelerate(data)
}
\`\`\`

### The Cross-Compile Tax

For a senior engineer evaluating CGO in a multi-platform service, the cross-compile tax is the cost you pay for every platform:

1. **A C toolchain.** Install, keep current, debug version skew.
2. **Per-platform testing.** Each platform needs its own CI runner or emulator.
3. **Deployment image size.** Statically linked C libraries balloon container images.
4. **Vulnerability management.** Each C library is a CVE source.

The pure-Go alternative (\`CGO_ENABLED=0\`) sidesteps all of this. For services that deploy to multiple platforms, the simplicity of pure Go is a significant operational win.

---
`;
