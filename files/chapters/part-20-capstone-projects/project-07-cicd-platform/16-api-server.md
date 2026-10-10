## API Server

The API server is the main entry point for all external interactions with the CI/CD platform. It receives Git webhooks, serves the web dashboard, provides a REST API for pipeline management, and handles artifact uploads and downloads. We use the Chi router for its lightweight design and middleware support. The handlers follow a clean pattern where each endpoint validates input, delegates to the appropriate service layer, and returns a consistent JSON response.

### HTTP Handlers

Create `internal/api/handlers.go`:

```go
package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"github.com/yourusername/cicd-platform/internal/git"
	"github.com/yourusername/cicd-platform/internal/storage"
)

// Handler contains HTTP handlers
type Handler struct {
	db      *storage.DB
	webhook *git.WebhookHandler
}

// NewHandler creates a new handler
func NewHandler(db *storage.DB, webhookSecret string) *Handler {
	return &Handler{
		db:      db,
		webhook: git.NewWebhookHandler(webhookSecret),
	}
}

// HandleWebhook handles Git webhooks
func (h *Handler) HandleWebhook(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")

	var payload *git.WebhookPayload
	var err error

	switch provider {
	case "github":
		payload, err = h.webhook.HandleGitHub(r)
	case "gitlab":
		payload, err = h.webhook.HandleGitLab(r)
	default:
		respondError(w, http.StatusBadRequest, "unsupported provider")
		return
	}

	if err != nil {
		log.Error().Err(err).Str("provider", provider).Msg("Failed to parse webhook")
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	log.Info().
		Str("provider", payload.Provider).
		Str("repository", payload.Repository).
		Str("commit", payload.Commit).
		Msg("Webhook received")

	// TODO: Trigger pipeline execution

	respondJSON(w, http.StatusOK, map[string]string{
		"status": "accepted",
	})
}

// HandleListPipelineRuns lists pipeline runs
func (h *Handler) HandleListPipelineRuns(w http.ResponseWriter, r *http.Request) {
	pipelineIDStr := chi.URLParam(r, "pipelineId")
	pipelineID, err := uuid.Parse(pipelineIDStr)
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid pipeline ID")
		return
	}

	store := storage.NewPipelineRunStore(h.db)
	runs, err := store.ListByPipeline(r.Context(), pipelineID, 50, 0)
	if err != nil {
		log.Error().Err(err).Msg("Failed to list pipeline runs")
		respondError(w, http.StatusInternalServerError, "failed to list runs")
		return
	}

	respondJSON(w, http.StatusOK, runs)
}

// HandleGetPipelineRun gets a single pipeline run
func (h *Handler) HandleGetPipelineRun(w http.ResponseWriter, r *http.Request) {
	runIDStr := chi.URLParam(r, "runId")
	runID, err := uuid.Parse(runIDStr)
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid run ID")
		return
	}

	store := storage.NewPipelineRunStore(h.db)
	run, err := store.GetByID(r.Context(), runID)
	if err != nil {
		if err == storage.ErrNotFound {
			respondError(w, http.StatusNotFound, "run not found")
			return
		}
		log.Error().Err(err).Msg("Failed to get pipeline run")
		respondError(w, http.StatusInternalServerError, "failed to get run")
		return
	}

	respondJSON(w, http.StatusOK, run)
}

// HandleGetJobRunLogs streams job run logs
func (h *Handler) HandleGetJobRunLogs(w http.ResponseWriter, r *http.Request) {
	jobRunIDStr := chi.URLParam(r, "jobRunId")
	jobRunID, err := uuid.Parse(jobRunIDStr)
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid job run ID")
		return
	}

	// TODO: Stream logs from S3 or file system
	_ = jobRunID

	respondJSON(w, http.StatusOK, map[string]string{
		"logs": "Sample log output...",
	})
}

// respondJSON sends a JSON response
func respondJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// respondError sends an error response
func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{
		"error": message,
	})
}
```

### Router Configuration

Create `internal/api/routes.go`:

```go
package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
)

// NewRouter creates a new HTTP router
func NewRouter(handler *Handler) *chi.Mux {
	r := chi.NewRouter()

	// Middleware
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))

	// CORS
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"https://*", "http://*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: false,
		MaxAge:           300,
	}))

	// Health check
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// API routes
	r.Route("/api/v1", func(r chi.Router) {
		// Webhooks
		r.Post("/webhooks/{provider}", handler.HandleWebhook)

		// Pipeline runs
		r.Get("/pipelines/{pipelineId}/runs", handler.HandleListPipelineRuns)
		r.Get("/runs/{runId}", handler.HandleGetPipelineRun)

		// Job runs
		r.Get("/jobs/{jobRunId}/logs", handler.HandleGetJobRunLogs)
	})

	return r
}
```

---
