## Build Tags

Build tags (also called build constraints) let you control which files are included in a build based on the operating system, architecture, or custom tags you define. Place the `//go:build` directive at the very top of a Go file, before the package declaration. This is commonly used to write platform-specific code, separate integration tests from unit tests, or toggle features between development and production builds. You can also rely on file naming conventions (e.g., `file_linux.go`) as an alternative to explicit build tags.

```go
// At top of file

// Single tag
//go:build linux

// Multiple tags (AND)
//go:build linux && amd64

// Multiple tags (OR)
//go:build linux || darwin

// Negation
//go:build !windows

// Complex expression
//go:build (linux && amd64) || (darwin && arm64)

// Common tags
//go:build linux
//go:build darwin
//go:build windows
//go:build amd64
//go:build arm64
//go:build integration
//go:build !race

// Old format (deprecated but still supported)
// +build linux

// Build with tag
// go build -tags=integration
// go test -tags="integration,postgres"

// File naming convention
// file_linux.go       // Only on Linux
// file_windows.go     // Only on Windows
// file_amd64.go       // Only on amd64
// file_linux_amd64.go // Only on Linux amd64

// Example: integration tests
//go:build integration

package mypackage_test

// Run with: go test -tags=integration
```

---
