## Git Integration

Git integration is what connects your CI/CD platform to the outside world. When a developer pushes code, the Git hosting provider sends a webhook to your platform, which then needs to clone the repository at the correct commit, branch, or tag. This section implements both sides of that interaction: the webhook handler that verifies signatures and triggers pipelines, and the clone service that efficiently fetches source code. Handling Git operations reliably is important because network failures, authentication issues, and large repositories can all cause problems.

### Git Clone and Webhook Handling
Create `internal/git/clone.go`:

```go
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
```

### Webhook Handler

Create `internal/git/webhook.go`:

```go
package git

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/rs/zerolog/log"
)

// WebhookHandler handles Git provider webhooks
type WebhookHandler struct {
	secret string
}

// NewWebhookHandler creates a new webhook handler
func NewWebhookHandler(secret string) *WebhookHandler {
	return &WebhookHandler{secret: secret}
}

// WebhookPayload contains parsed webhook data
type WebhookPayload struct {
	Provider      string // github, gitlab, bitbucket
	Event         string // push, pull_request, tag
	Repository    string // org/repo
	Ref           string // refs/heads/main
	Branch        string // main
	Commit        string // SHA
	CommitMessage string
	Author        string
	AuthorEmail   string
	CloneURL      string
	IsPR          bool
	PRNumber      int
}

// HandleGitHub handles GitHub webhooks
func (h *WebhookHandler) HandleGitHub(r *http.Request) (*WebhookPayload, error) {
	// Verify signature
	if err := h.verifyGitHubSignature(r); err != nil {
		return nil, fmt.Errorf("verify signature: %w", err)
	}

	// Read body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	// Parse event type
	event := r.Header.Get("X-GitHub-Event")

	switch event {
	case "push":
		return h.parseGitHubPush(body)
	case "pull_request":
		return h.parseGitHubPR(body)
	default:
		return nil, fmt.Errorf("unsupported event type: %s", event)
	}
}

// verifyGitHubSignature verifies GitHub webhook signature
func (h *WebhookHandler) verifyGitHubSignature(r *http.Request) error {
	signature := r.Header.Get("X-Hub-Signature-256")
	if signature == "" {
		return fmt.Errorf("missing signature header")
	}

	// Read body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}

	// Compute expected signature
	mac := hmac.New(sha256.New, []byte(h.secret))
	mac.Write(body)
	expectedMAC := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	// Compare signatures
	if !hmac.Equal([]byte(signature), []byte(expectedMAC)) {
		return fmt.Errorf("invalid signature")
	}

	return nil
}

// parseGitHubPush parses a GitHub push event
func (h *WebhookHandler) parseGitHubPush(body []byte) (*WebhookPayload, error) {
	var event struct {
		Ref        string `json:"ref"`
		After      string `json:"after"`
		Repository struct {
			FullName string `json:"full_name"`
			CloneURL string `json:"clone_url"`
		} `json:"repository"`
		HeadCommit struct {
			ID      string `json:"id"`
			Message string `json:"message"`
			Author  struct {
				Name  string `json:"name"`
				Email string `json:"email"`
			} `json:"author"`
		} `json:"head_commit"`
	}

	if err := json.Unmarshal(body, &event); err != nil {
		return nil, fmt.Errorf("parse json: %w", err)
	}

	// Extract branch from ref (refs/heads/main -> main)
	branch := strings.TrimPrefix(event.Ref, "refs/heads/")

	return &WebhookPayload{
		Provider:      "github",
		Event:         "push",
		Repository:    event.Repository.FullName,
		Ref:           event.Ref,
		Branch:        branch,
		Commit:        event.After,
		CommitMessage: event.HeadCommit.Message,
		Author:        event.HeadCommit.Author.Name,
		AuthorEmail:   event.HeadCommit.Author.Email,
		CloneURL:      event.Repository.CloneURL,
	}, nil
}

// parseGitHubPR parses a GitHub pull request event
func (h *WebhookHandler) parseGitHubPR(body []byte) (*WebhookPayload, error) {
	var event struct {
		Action      string `json:"action"`
		Number      int    `json:"number"`
		PullRequest struct {
			Head struct {
				Ref string `json:"ref"`
				SHA string `json:"sha"`
			} `json:"head"`
			User struct {
				Login string `json:"login"`
			} `json:"user"`
			Title string `json:"title"`
		} `json:"pull_request"`
		Repository struct {
			FullName string `json:"full_name"`
			CloneURL string `json:"clone_url"`
		} `json:"repository"`
	}

	if err := json.Unmarshal(body, &event); err != nil {
		return nil, fmt.Errorf("parse json: %w", err)
	}

	// Only process opened, synchronize, and reopened actions
	if event.Action != "opened" && event.Action != "synchronize" && event.Action != "reopened" {
		return nil, fmt.Errorf("skipping PR action: %s", event.Action)
	}

	return &WebhookPayload{
		Provider:      "github",
		Event:         "pull_request",
		Repository:    event.Repository.FullName,
		Ref:           fmt.Sprintf("refs/pull/%d/head", event.Number),
		Branch:        event.PullRequest.Head.Ref,
		Commit:        event.PullRequest.Head.SHA,
		CommitMessage: event.PullRequest.Title,
		Author:        event.PullRequest.User.Login,
		CloneURL:      event.Repository.CloneURL,
		IsPR:          true,
		PRNumber:      event.Number,
	}, nil
}

// HandleGitLab handles GitLab webhooks
func (h *WebhookHandler) HandleGitLab(r *http.Request) (*WebhookPayload, error) {
	// Verify token
	token := r.Header.Get("X-Gitlab-Token")
	if token != h.secret {
		return nil, fmt.Errorf("invalid token")
	}

	// Read body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	// Parse event
	var event struct {
		ObjectKind string `json:"object_kind"`
		Ref        string `json:"ref"`
		After      string `json:"after"`
		Project    struct {
			PathWithNamespace string `json:"path_with_namespace"`
			GitHTTPURL        string `json:"git_http_url"`
		} `json:"project"`
		Commits []struct {
			ID      string `json:"id"`
			Message string `json:"message"`
			Author  struct {
				Name  string `json:"name"`
				Email string `json:"email"`
			} `json:"author"`
		} `json:"commits"`
	}

	if err := json.Unmarshal(body, &event); err != nil {
		return nil, fmt.Errorf("parse json: %w", err)
	}

	if event.ObjectKind != "push" {
		return nil, fmt.Errorf("unsupported object kind: %s", event.ObjectKind)
	}

	// Get last commit
	var commit, message, author, email string
	if len(event.Commits) > 0 {
		lastCommit := event.Commits[len(event.Commits)-1]
		commit = lastCommit.ID
		message = lastCommit.Message
		author = lastCommit.Author.Name
		email = lastCommit.Author.Email
	} else {
		commit = event.After
	}

	branch := strings.TrimPrefix(event.Ref, "refs/heads/")

	return &WebhookPayload{
		Provider:      "gitlab",
		Event:         "push",
		Repository:    event.Project.PathWithNamespace,
		Ref:           event.Ref,
		Branch:        branch,
		Commit:        commit,
		CommitMessage: message,
		Author:        author,
		AuthorEmail:   email,
		CloneURL:      event.Project.GitHTTPURL,
	}, nil
}
```

---
