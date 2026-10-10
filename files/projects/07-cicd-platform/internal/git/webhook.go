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

	_ = log.Logger // suppress unused import

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
