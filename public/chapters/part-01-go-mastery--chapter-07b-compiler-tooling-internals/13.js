export default `## 7B.11 The Go Linker and Binary Layout

### Linker Flags

The Go linker (\`cmd/link\`) accepts flags via \`-ldflags\` that control the final binary. The most commonly used flags are \`-s\` and \`-w\` to strip debug information and reduce binary size, and \`-X\` to inject version strings and build metadata at compile time without modifying source code. You can also produce fully static binaries by disabling CGo and passing static linker flags, which is essential for deploying to minimal container images like \`scratch\` or \`alpine\`.

\`\`\`bash
# Strip debug info (reduces binary size)
go build -ldflags="-s -w" ./...
# -s: omit symbol table
# -w: omit DWARF debug info

# Embed version info
go build -ldflags="-X main.Version=1.2.3 -X main.BuildTime=\$(date -u +%Y-%m-%dT%H:%M:%SZ)" ./...

# Static binary
CGO_ENABLED=0 go build -ldflags="-extldflags '-static'" ./...

# Combined
go build \\
  -ldflags="-s -w -X main.Version=\$(git describe --tags) -X main.Commit=\$(git rev-parse --short HEAD)" \\
  ./...
\`\`\`

### Version Embedding

Embedding version information into your binary is a standard practice for production Go applications. There are two approaches: the traditional method uses \`-ldflags -X\` to set package-level string variables at build time, and the newer method (Go 1.18+) uses \`runtime/debug.ReadBuildInfo()\` to read VCS revision, Go version, and module information that the toolchain automatically embeds. The \`ReadBuildInfo\` approach requires no build script changes, while \`-ldflags -X\` gives you full control over what gets embedded.

\`\`\`go
package main

import (
	"fmt"
	"runtime/debug"
)

// These are set by -ldflags at build time
var (
	Version   = "dev"
	Commit    = "unknown"
	BuildTime = "unknown"
)

// Or use Go 1.18+ build info
func GetBuildInfo() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return fmt.Sprintf("version=%s commit=%s built=%s", Version, Commit, BuildTime)
	}

	var goVersion = info.GoVersion
	var vcsRevision, vcsDirty string
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			vcsRevision = setting.Value[:8] // short hash
		case "vcs.modified":
			if setting.Value == "true" {
				vcsDirty = "-dirty"
			}
		}
	}

	return fmt.Sprintf("go=%s rev=%s%s", goVersion, vcsRevision, vcsDirty)
}
\`\`\`

### Binary Size Analysis

Understanding what contributes to your binary size helps you keep deployments lean. Go binaries include the runtime, garbage collector, and all transitively imported packages, so they tend to be larger than C binaries. The \`go tool nm\` command lists all symbols and their sizes, \`go tool objdump\` shows disassembly for specific functions, and third-party tools like \`bloaty\` provide detailed section-by-section breakdowns. This analysis is particularly important when targeting embedded systems or when binary size affects deployment times.

\`\`\`bash
# Analyze binary sections
go tool nm myapp | sort -k2 | tail -20

# Bloaty for detailed analysis (third-party)
bloaty myapp

# Show which packages contribute most to binary size
go build -v ./... 2>&1 | head -20

# Analyze with objdump
go tool objdump -s 'main\\.main' myapp | head -50
\`\`\`

### Binary Size Budget Discipline

For services with container-size constraints or deployment-speed concerns, track binary size over time:

1. **Wire binary size into CI.** \`ls -l \$(go list -f '{{.Target}}' .)\` emits the size. Track it per commit.
2. **Alert on size regressions.** A 20% growth on a single PR deserves review. Usually a new import added a large dependency.
3. **Use \`-ldflags="-s -w"\` in production.** Strips debug symbols. Saves 30% of the binary size typically.
4. **Consider \`go-mod-outdated\` or similar to find unused dependencies.** Old dependencies often bring in more than needed.

The senior-track discipline: binary size is part of the service's budget, same as memory and CPU.

---
`;
