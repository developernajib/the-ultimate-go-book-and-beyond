package executor

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	imagetypes "github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/example/cicd-platform/internal/parser"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
)

// DockerExecutor executes jobs in Docker containers
type DockerExecutor struct {
	client     *client.Client
	workDir    string // Base directory for workspaces
	logDir     string // Base directory for logs
	containers sync.Map // Map of jobRunID -> containerID
}

// NewDockerExecutor creates a new Docker executor
func NewDockerExecutor(workDir, logDir string) (*DockerExecutor, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("create docker client: %w", err)
	}

	// Verify Docker is accessible
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := cli.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ping docker: %w", err)
	}

	// Create directories
	if err := os.MkdirAll(workDir, 0755); err != nil {
		return nil, fmt.Errorf("create work directory: %w", err)
	}

	if err := os.MkdirAll(logDir, 0755); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}

	return &DockerExecutor{
		client:  cli,
		workDir: workDir,
		logDir:  logDir,
	}, nil
}

// Execute runs a job in a Docker container
func (e *DockerExecutor) Execute(ctx context.Context, execCtx *ExecutionContext) (*ExecutionResult, error) {
	startTime := time.Now()
	result := &ExecutionResult{}

	// Create job workspace
	jobWorkDir := filepath.Join(e.workDir, execCtx.JobRunID.String())
	if err := os.MkdirAll(jobWorkDir, 0755); err != nil {
		return nil, fmt.Errorf("create job workspace: %w", err)
	}

	// Copy source code to workspace (assumed to be in execCtx.WorkDir)
	if execCtx.WorkDir != "" {
		if err := e.copyDirectory(execCtx.WorkDir, jobWorkDir); err != nil {
			return nil, fmt.Errorf("copy source to workspace: %w", err)
		}
	}

	// Pull Docker image
	if err := e.pullImage(ctx, execCtx.JobConfig.Image); err != nil {
		return nil, fmt.Errorf("pull image: %w", err)
	}

	// Prepare environment variables
	env := e.prepareEnv(execCtx.Env, execCtx.Secrets)

	// Create and start container
	containerID, err := e.createContainer(ctx, execCtx, jobWorkDir, env)
	if err != nil {
		return nil, fmt.Errorf("create container: %w", err)
	}

	// Store container ID for potential stop
	e.containers.Store(execCtx.JobRunID, containerID)
	defer e.containers.Delete(execCtx.JobRunID)

	// Start container
	if err := e.client.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		return nil, fmt.Errorf("start container: %w", err)
	}

	log.Info().
		Str("job_run_id", execCtx.JobRunID.String()).
		Str("container_id", containerID).
		Msg("Container started")

	// Stream logs
	logFile, err := e.createLogFile(execCtx.JobRunID)
	if err != nil {
		return nil, fmt.Errorf("create log file: %w", err)
	}
	defer logFile.Close()

	result.LogPath = logFile.Name()

	// Attach to container and stream logs
	if err := e.streamLogs(ctx, containerID, logFile, execCtx.LogWriter); err != nil {
		log.Warn().Err(err).Msg("Failed to stream logs")
	}

	// Wait for container to finish (with timeout)
	execTimeout := execCtx.Timeout
	if execTimeout == 0 {
		execTimeout = 30 * time.Minute // Default timeout
	}

	waitCtx, cancel := context.WithTimeout(ctx, execTimeout)
	defer cancel()

	statusCh, errCh := e.client.ContainerWait(waitCtx, containerID, container.WaitConditionNotRunning)

	var exitCode int64
	select {
	case err := <-errCh:
		if err != nil {
			return nil, fmt.Errorf("wait for container: %w", err)
		}
	case status := <-statusCh:
		exitCode = status.StatusCode
	case <-waitCtx.Done():
		// Timeout - kill container
		log.Warn().
			Str("job_run_id", execCtx.JobRunID.String()).
			Msg("Job timed out, killing container")

		killTimeoutSec := 10
		if err := e.client.ContainerStop(ctx, containerID, container.StopOptions{Timeout: &killTimeoutSec}); err != nil {
			log.Error().Err(err).Msg("Failed to stop container")
		}

		exitCode = 124 // Timeout exit code
	}

	result.ExitCode = int(exitCode)
	result.Duration = time.Since(startTime)

	// Collect artifacts if job succeeded
	if exitCode == 0 && execCtx.JobConfig.Artifacts != nil {
		artifacts, err := e.collectArtifacts(ctx, containerID, execCtx.JobConfig.Artifacts, jobWorkDir)
		if err != nil {
			log.Warn().Err(err).Msg("Failed to collect artifacts")
		} else {
			result.Artifacts = artifacts
		}
	}

	// Remove container
	removeOptions := container.RemoveOptions{
		Force:         true,
		RemoveVolumes: true,
	}
	if err := e.client.ContainerRemove(ctx, containerID, removeOptions); err != nil {
		log.Warn().Err(err).Msg("Failed to remove container")
	}

	return result, nil
}

// createContainer creates a Docker container for the job
func (e *DockerExecutor) createContainer(
	ctx context.Context,
	execCtx *ExecutionContext,
	workDir string,
	env []string,
) (string, error) {
	// Build command from steps
	var commands []string
	for _, step := range execCtx.JobConfig.Steps {
		commands = append(commands, step.Run)
	}

	// Combine commands with proper error handling
	script := strings.Join(commands, " && ")
	cmd := []string{"/bin/sh", "-c", script}

	// Container configuration
	config := &container.Config{
		Image:        execCtx.JobConfig.Image,
		Cmd:          cmd,
		Env:          env,
		WorkingDir:   "/workspace",
		AttachStdout: true,
		AttachStderr: true,
	}

	// Host configuration
	hostConfig := &container.HostConfig{
		Mounts: []mount.Mount{
			{
				Type:   mount.TypeBind,
				Source: workDir,
				Target: "/workspace",
			},
		},
		Resources: container.Resources{
			Memory:   2 * 1024 * 1024 * 1024, // 2GB
			NanoCPUs: 2 * 1000000000,         // 2 CPUs
		},
		AutoRemove: false,
	}

	// Network configuration
	networkConfig := &network.NetworkingConfig{}

	// Create container
	resp, err := e.client.ContainerCreate(
		ctx,
		config,
		hostConfig,
		networkConfig,
		nil,
		fmt.Sprintf("job-%s", execCtx.JobRunID.String()),
	)

	if err != nil {
		return "", fmt.Errorf("create container: %w", err)
	}

	return resp.ID, nil
}

// pullImage pulls a Docker image if not present
func (e *DockerExecutor) pullImage(ctx context.Context, image string) error {
	// Check if image exists locally
	_, _, err := e.client.ImageInspectWithRaw(ctx, image)
	if err == nil {
		return nil // Image already exists
	}

	log.Info().Str("image", image).Msg("Pulling Docker image")

	reader, err := e.client.ImagePull(ctx, image, imagetypes.PullOptions{})
	if err != nil {
		return fmt.Errorf("pull image: %w", err)
	}
	defer reader.Close()

	// Read pull output (required for pull to complete)
	_, err = io.Copy(io.Discard, reader)
	return err
}

// streamLogs streams container logs to multiple writers
func (e *DockerExecutor) streamLogs(
	ctx context.Context,
	containerID string,
	logFile io.Writer,
	liveWriter io.Writer,
) error {
	options := container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
		Timestamps: true,
	}

	reader, err := e.client.ContainerLogs(ctx, containerID, options)
	if err != nil {
		return fmt.Errorf("get container logs: %w", err)
	}
	defer reader.Close()

	// Use MultiWriter to write to both file and live stream
	writers := []io.Writer{logFile}
	if liveWriter != nil {
		writers = append(writers, liveWriter)
	}
	multiWriter := io.MultiWriter(writers...)

	// Copy logs (Docker multiplexes stdout/stderr, so we need to demux)
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := scanner.Text()
		if _, err := multiWriter.Write([]byte(line + "\n")); err != nil {
			return fmt.Errorf("write log: %w", err)
		}
	}

	return scanner.Err()
}

// collectArtifacts collects artifacts from the container
func (e *DockerExecutor) collectArtifacts(
	ctx context.Context,
	containerID string,
	artifactConfig *parser.ArtifactConfig,
	workDir string,
) ([]string, error) {
	var artifacts []string

	artifactDir := filepath.Join(workDir, "artifacts")
	if err := os.MkdirAll(artifactDir, 0755); err != nil {
		return nil, fmt.Errorf("create artifact directory: %w", err)
	}

	for _, pattern := range artifactConfig.Paths {
		// Copy files from container
		reader, _, err := e.client.CopyFromContainer(ctx, containerID, filepath.Join("/workspace", pattern))
		if err != nil {
			log.Warn().Err(err).Str("pattern", pattern).Msg("Failed to copy artifact")
			continue
		}
		defer reader.Close()

		// Extract tar archive
		artifactPath := filepath.Join(artifactDir, filepath.Base(pattern))
		file, err := os.Create(artifactPath)
		if err != nil {
			log.Warn().Err(err).Msg("Failed to create artifact file")
			continue
		}

		if _, err := io.Copy(file, reader); err != nil {
			file.Close()
			log.Warn().Err(err).Msg("Failed to write artifact")
			continue
		}
		file.Close()

		artifacts = append(artifacts, artifactPath)
	}

	return artifacts, nil
}

// prepareEnv prepares environment variables for the container
func (e *DockerExecutor) prepareEnv(env, secrets map[string]string) []string {
	var envVars []string

	for k, v := range env {
		envVars = append(envVars, fmt.Sprintf("%s=%s", k, v))
	}

	for k, v := range secrets {
		envVars = append(envVars, fmt.Sprintf("%s=%s", k, v))
	}

	return envVars
}

// createLogFile creates a log file for the job
func (e *DockerExecutor) createLogFile(jobRunID uuid.UUID) (*os.File, error) {
	logPath := filepath.Join(e.logDir, fmt.Sprintf("%s.log", jobRunID.String()))
	return os.Create(logPath)
}

// copyDirectory recursively copies a directory
func (e *DockerExecutor) copyDirectory(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Calculate relative path
		relPath, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}

		targetPath := filepath.Join(dst, relPath)

		if info.IsDir() {
			return os.MkdirAll(targetPath, info.Mode())
		}

		// Copy file
		return e.copyFile(path, targetPath)
	})
}

// copyFile copies a single file
func (e *DockerExecutor) copyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	destFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destFile.Close()

	_, err = io.Copy(destFile, sourceFile)
	return err
}

// Stop stops a running job
func (e *DockerExecutor) Stop(ctx context.Context, jobRunID uuid.UUID) error {
	containerIDValue, ok := e.containers.Load(jobRunID)
	if !ok {
		return fmt.Errorf("job not found or already completed")
	}

	containerID := containerIDValue.(string)

	timeoutSec := 10
	return e.client.ContainerStop(ctx, containerID, container.StopOptions{Timeout: &timeoutSec})
}

// GetLogs retrieves logs for a job (not implemented for Docker executor)
func (e *DockerExecutor) GetLogs(ctx context.Context, jobRunID uuid.UUID) (io.ReadCloser, error) {
	logPath := filepath.Join(e.logDir, fmt.Sprintf("%s.log", jobRunID.String()))
	return os.Open(logPath)
}

// Cleanup cleans up resources for a job
func (e *DockerExecutor) Cleanup(ctx context.Context, jobRunID uuid.UUID) error {
	// Remove workspace
	workDir := filepath.Join(e.workDir, jobRunID.String())
	if err := os.RemoveAll(workDir); err != nil {
		log.Warn().Err(err).Msg("Failed to remove workspace")
	}

	return nil
}

// Close closes the Docker client
func (e *DockerExecutor) Close() error {
	return e.client.Close()
}
