## Testing Strategy

A CI/CD platform must be thoroughly tested because bugs in the platform can break every project that depends on it. The testing strategy covers multiple layers: unit tests for individual components like the parser and executor, integration tests that verify the database layer and Docker interactions work correctly, and end-to-end tests that simulate a full pipeline run from webhook to completion. We use table-driven tests throughout, which is the idiomatic Go approach for testing multiple scenarios with shared setup logic.

### Unit Tests

Create `internal/parser/parser_test.go`:

```go
package parser_test

import (
	"testing"

	"github.com/yourusername/cicd-platform/internal/parser"
)

func TestParser_Parse(t *testing.T) {
	tests := []struct {
		name    string
		yaml    string
		wantErr bool
	}{
		{
			name: "valid pipeline",
			yaml: `
name: Test Pipeline
on:
  push:
    branches: [main]
stages:
  - name: test
    jobs:
      - name: unit-tests
        image: golang:1.27.1
        steps:
          - run: go test ./...
`,
			wantErr: false,
		},
		{
			name: "missing name",
			yaml: `
stages:
  - name: test
    jobs:
      - name: unit-tests
        image: golang:1.27.1
        steps:
          - run: go test ./...
`,
			wantErr: true,
		},
		{
			name: "missing steps",
			yaml: `
name: Test Pipeline
stages:
  - name: test
    jobs:
      - name: unit-tests
        image: golang:1.27.1
`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := parser.NewParser(true)
			_, err := p.Parse([]byte(tt.yaml))

			if (err != nil) != tt.wantErr {
				t.Errorf("Parse() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
```

### Integration Tests

Create `internal/executor/docker_test.go`:

```go
//go:build integration
// +build integration

package executor_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/yourusername/cicd-platform/internal/executor"
	"github.com/yourusername/cicd-platform/internal/parser"
)

func TestDockerExecutor_Execute(t *testing.T) {
	// Skip if Docker not available
	if os.Getenv("DOCKER_HOST") == "" && !fileExists("/var/run/docker.sock") {
		t.Skip("Docker not available")
	}

	// Create temporary directories
	workDir := t.TempDir()
	logDir := t.TempDir()

	exec, err := executor.NewDockerExecutor(workDir, logDir)
	if err != nil {
		t.Fatalf("NewDockerExecutor() error = %v", err)
	}
	defer exec.Close()

	ctx := context.Background()

	// Create execution context
	execCtx := &executor.ExecutionContext{
		JobRunID: uuid.New(),
		PipelineRunID: uuid.New(),
		JobConfig: &parser.JobConfig{
			Name:  "test-job",
			Image: "alpine:latest",
			Steps: []parser.StepConfig{
				{Run: "echo 'Hello, World!'"},
				{Run: "ls -la"},
			},
		},
		Timeout: 5 * time.Minute,
	}

	// Execute job
	result, err := exec.Execute(ctx, execCtx)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}

	// Verify result
	if result.ExitCode != 0 {
		t.Errorf("Expected exit code 0, got %d", result.ExitCode)
	}

	if result.LogPath == "" {
		t.Error("Expected log path, got empty string")
	}

	// Verify log file exists
	if !fileExists(result.LogPath) {
		t.Errorf("Log file not found: %s", result.LogPath)
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
```

---
