export default `## 7B.10 Build Tags and Conditional Compilation

Build tags control which files are included in a build. When the Go toolchain compiles a package, it evaluates the \`//go:build\` constraint at the top of each file and skips any file whose constraint does not match the current \`GOOS\`, \`GOARCH\`, or user-specified tags. This is how Go handles platform-specific code without a preprocessor. Each variant lives in its own file with an appropriate build constraint.

\`\`\`go
// file: feature_linux.go
//go:build linux

package platform

func OSName() string { return "linux" }

// file: feature_darwin.go
//go:build darwin

package platform

func OSName() string { return "darwin" }

// file: feature_windows.go
//go:build windows

package platform

func OSName() string { return "windows" }
\`\`\`

### Complex Build Constraints

Build constraints can be combined using boolean logic: \`||\` means "or," \`&&\` means "and," and \`!\` means "not." This lets you target very specific platform and configuration combinations. For example, you can write code that only compiles on 64-bit Linux or macOS when CGo is disabled. Go 1.17 introduced the \`//go:build\` syntax which uses standard boolean expressions, replacing the older \`// +build\` comment syntax that used spaces for OR and separate lines for AND.

\`\`\`go
//go:build (linux || darwin) && amd64 && !cgo

// Equivalent to old format (pre-Go 1.17):
// +build linux darwin
// +build amd64
// +build !cgo

package main

// Environment-based tags
//go:build integration

// Custom tags
//go:build myfeature
\`\`\`

\`\`\`bash
# Build with custom tag
go build -tags="integration myfeature" ./...

# Run tests with tag
go test -tags="integration" ./...

# Build for specific OS/arch
GOOS=linux GOARCH=arm64 go build ./...
\`\`\`

### Feature Flags via Build Tags

Build tags can serve as compile-time feature flags. By defining a constant in two separate files with complementary build constraints, you can toggle behavior at build time without any runtime cost. When you build normally, the default file is included. When you pass \`-tags=experimental\`, the alternative file is used instead. This pattern is cleaner than runtime feature flags for features that should be entirely compiled out in production.

\`\`\`go
// internal/features/flags.go
//go:build !experimental

package features

const ExperimentalEnabled = false

// internal/features/flags_experimental.go
//go:build experimental

package features

const ExperimentalEnabled = true

// Usage:
// go build -tags=experimental ./...
\`\`\`

### init() Ordering and Build Tags

Combining \`init()\` functions with build tags is a powerful pattern for environment-specific initialization. Each file with a build tag can define its own \`init()\` function, and only the one matching the active build constraints will be compiled and executed. This is commonly used to configure logging levels, enable debug instrumentation, or set up different backends for development versus production without cluttering your code with \`if\` statements.

\`\`\`go
// file: init_debug.go
//go:build debug

package main

import "log"

func init() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile | log.Lmicroseconds)
	log.Println("debug mode enabled")
}

// file: init_prod.go
//go:build !debug

package main

import (
	"log"
	"io"
)

func init() {
	log.SetOutput(io.Discard) // silence in production
}
\`\`\`

### Build Tag Anti-Patterns

Build tags are powerful and easy to misuse. Three patterns to flag:

1. **Build tags as runtime feature flags.** If the flag needs to change at runtime (A/B test, canary rollout), build tags are wrong. Use a real feature flag.
2. **Build tags for tests.** Occasionally legitimate (skip expensive tests by default), often a sign of test suite fragmentation. Prefer \`testing.Short()\`.
3. **OS-specific code without a build-tag-free fallback.** A file with \`//go:build linux\` and no Windows equivalent will not compile on Windows. Either add the fallback or document the platform requirement.

---
`;
