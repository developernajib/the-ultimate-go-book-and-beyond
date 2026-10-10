package git

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/rs/zerolog/log"
)

// CloneOptions contains options for cloning a repository
type CloneOptions struct {
	URL         string
	Ref         string // Branch, tag, or commit
	Destination string
	Depth       int    // Shallow clone depth (0 = full clone)
	Token       string // Access token for private repos
	Username    string // Username for authentication
}

// Cloner handles Git operations
type Cloner struct {
	gitBinary string
}

// NewCloner creates a new Git cloner
func NewCloner() (*Cloner, error) {
	// Find git binary
	gitPath, err := exec.LookPath("git")
	if err != nil {
		return nil, fmt.Errorf("git not found in PATH: %w", err)
	}

	return &Cloner{gitBinary: gitPath}, nil
}

// Clone clones a Git repository
func (c *Cloner) Clone(ctx context.Context, opts *CloneOptions) error {
	// Create destination directory
	if err := os.MkdirAll(opts.Destination, 0755); err != nil {
		return fmt.Errorf("create destination directory: %w", err)
	}

	// Build clone URL with auth if provided
	cloneURL := opts.URL
	if opts.Token != "" {
		cloneURL = c.injectToken(opts.URL, opts.Token, opts.Username)
	}

	// Build git clone command
	args := []string{"clone"}

	// Shallow clone if depth specified
	if opts.Depth > 0 {
		args = append(args, "--depth", fmt.Sprintf("%d", opts.Depth))
	}

	// Single branch optimization
	if opts.Ref != "" {
		args = append(args, "--branch", opts.Ref, "--single-branch")
	}

	args = append(args, cloneURL, opts.Destination)

	// Execute git clone
	cmd := exec.CommandContext(ctx, c.gitBinary, args...)
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0", // Disable interactive prompts
		"GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=no",
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		// Sanitize output (remove tokens)
		sanitizedOutput := c.sanitizeOutput(string(output), opts.Token)
		return fmt.Errorf("git clone failed: %s: %w", sanitizedOutput, err)
	}

	log.Info().
		Str("url", opts.URL).
		Str("ref", opts.Ref).
		Str("destination", opts.Destination).
		Msg("Repository cloned successfully")

	return nil
}

// Checkout checks out a specific commit, branch, or tag
func (c *Cloner) Checkout(ctx context.Context, repoPath, ref string) error {
	cmd := exec.CommandContext(ctx, c.gitBinary, "checkout", ref)
	cmd.Dir = repoPath

	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git checkout failed: %s: %w", string(output), err)
	}

	return nil
}

// GetCommitInfo retrieves information about a commit
func (c *Cloner) GetCommitInfo(ctx context.Context, repoPath, ref string) (*CommitInfo, error) {
	// Get commit SHA
	shaCmd := exec.CommandContext(ctx, c.gitBinary, "rev-parse", ref)
	shaCmd.Dir = repoPath
	shaOutput, err := shaCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("get commit sha: %w", err)
	}
	sha := strings.TrimSpace(string(shaOutput))

	// Get commit message
	msgCmd := exec.CommandContext(ctx, c.gitBinary, "log", "-1", "--pretty=%B", sha)
	msgCmd.Dir = repoPath
	msgOutput, err := msgCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("get commit message: %w", err)
	}
	message := strings.TrimSpace(string(msgOutput))

	// Get author info
	authorCmd := exec.CommandContext(ctx, c.gitBinary, "log", "-1", "--pretty=%an", sha)
	authorCmd.Dir = repoPath
	authorOutput, err := authorCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("get author: %w", err)
	}
	author := strings.TrimSpace(string(authorOutput))

	// Get author email
	emailCmd := exec.CommandContext(ctx, c.gitBinary, "log", "-1", "--pretty=%ae", sha)
	emailCmd.Dir = repoPath
	emailOutput, err := emailCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("get author email: %w", err)
	}
	email := strings.TrimSpace(string(emailOutput))

	return &CommitInfo{
		SHA:     sha,
		Message: message,
		Author:  author,
		Email:   email,
	}, nil
}

// GetPipelineFile reads the pipeline YAML file from the repository
func (c *Cloner) GetPipelineFile(repoPath string) ([]byte, error) {
	pipelineFile := filepath.Join(repoPath, ".pipeline.yaml")

	// Try alternate names if not found
	if _, err := os.Stat(pipelineFile); os.IsNotExist(err) {
		pipelineFile = filepath.Join(repoPath, ".pipeline.yml")
	}

	if _, err := os.Stat(pipelineFile); os.IsNotExist(err) {
		pipelineFile = filepath.Join(repoPath, "pipeline.yaml")
	}

	data, err := os.ReadFile(pipelineFile)
	if err != nil {
		return nil, fmt.Errorf("read pipeline file: %w", err)
	}

	return data, nil
}

// injectToken injects an access token into a Git URL
func (c *Cloner) injectToken(url, token, username string) string {
	// For HTTPS URLs, inject token
	if strings.HasPrefix(url, "https://") {
		if username == "" {
			username = "oauth2"
		}
		// https://github.com/user/repo.git -> https://oauth2:token@github.com/user/repo.git
		return strings.Replace(url, "https://", fmt.Sprintf("https://%s:%s@", username, token), 1)
	}

	return url
}

// sanitizeOutput removes sensitive information from output
func (c *Cloner) sanitizeOutput(output, token string) string {
	if token == "" {
		return output
	}
	return strings.ReplaceAll(output, token, "***")
}

// CommitInfo contains information about a commit
type CommitInfo struct {
	SHA     string
	Message string
	Author  string
	Email   string
}
