package executor

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
	"github.com/example/cicd-platform/internal/parser"
)

// ExecutionContext provides context for job execution
type ExecutionContext struct {
	JobRunID      uuid.UUID
	PipelineRunID uuid.UUID
	JobConfig     *parser.JobConfig
	WorkDir       string            // Working directory on host
	Env           map[string]string // Environment variables
	Secrets       map[string]string // Decrypted secrets
	Timeout       time.Duration
	LogWriter     io.Writer // Stream logs here
}

// ExecutionResult contains the result of job execution
type ExecutionResult struct {
	ExitCode  int
	Duration  time.Duration
	LogPath   string   // Path to stored logs
	Artifacts []string // Paths to collected artifacts
	Error     error    // Execution error, if any
}

// Executor defines the interface for job execution
type Executor interface {
	// Execute runs a job and returns the result
	Execute(ctx context.Context, execCtx *ExecutionContext) (*ExecutionResult, error)

	// Stop stops a running job
	Stop(ctx context.Context, jobRunID uuid.UUID) error

	// GetLogs retrieves logs for a job
	GetLogs(ctx context.Context, jobRunID uuid.UUID) (io.ReadCloser, error)

	// Cleanup cleans up resources for a job
	Cleanup(ctx context.Context, jobRunID uuid.UUID) error
}

// LogEntry represents a single log line
type LogEntry struct {
	Timestamp time.Time `json:"timestamp"`
	Level     string    `json:"level"` // stdout, stderr, system
	Message   string    `json:"message"`
	JobRunID  uuid.UUID `json:"job_run_id"`
}

// LogCollector collects and streams logs
type LogCollector struct {
	writer io.Writer
}

// NewLogCollector creates a new log collector
func NewLogCollector(w io.Writer) *LogCollector {
	return &LogCollector{writer: w}
}

// Write implements io.Writer
func (lc *LogCollector) Write(p []byte) (n int, err error) {
	return lc.writer.Write(p)
}

// WriteEntry writes a structured log entry
func (lc *LogCollector) WriteEntry(entry *LogEntry) error {
	timestamp := entry.Timestamp.Format(time.RFC3339)
	logLine := fmt.Sprintf("[%s] %s: %s\n", timestamp, entry.Level, entry.Message)
	_, err := lc.writer.Write([]byte(logLine))
	return err
}
