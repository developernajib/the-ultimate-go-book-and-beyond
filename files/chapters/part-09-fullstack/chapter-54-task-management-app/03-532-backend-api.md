## 54.2 Backend API

### User Model and Service

The user model carries authentication state and profile data. The `SetPassword` and `CheckPassword` methods encapsulate bcrypt hashing on the model itself, keeping password logic out of handlers and services. The `json:"-"` tag on `PasswordHash` ensures the hash is never serialized into API responses.

```go
// backend/internal/user/model.go
package user

import (
	"time"

	"golang.org/x/crypto/bcrypt"
)

type User struct {
	ID           string    `json:"id" db:"id"`
	Email        string    `json:"email" db:"email"`
	PasswordHash string    `json:"-" db:"password_hash"`
	Name         string    `json:"name" db:"name"`
	AvatarURL    string    `json:"avatar_url,omitempty" db:"avatar_url"`
	CreatedAt    time.Time `json:"created_at" db:"created_at"`
	UpdatedAt    time.Time `json:"updated_at" db:"updated_at"`
}

func (u *User) SetPassword(password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	u.PasswordHash = string(hash)
	return nil
}

func (u *User) CheckPassword(password string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password))
	return err == nil
}
```

The repository layer handles persistence using parameterized queries and context propagation. Each method accepts a `context.Context` to support request-scoped cancellation and deadlines. The `GetByEmail` method returns `nil` without an error when no row matches, letting the caller distinguish "not found" from a database failure.

```go
// backend/internal/user/repository.go
package user

import (
	"context"
	"database/sql"
	"time"

	"github.com/google/uuid"
)

type Repository struct {
	db *sql.DB
}

func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

func (r *Repository) Create(ctx context.Context, user *User) error {
	user.ID = uuid.New().String()
	user.CreatedAt = time.Now().UTC()
	user.UpdatedAt = time.Now().UTC()

	query := `
		INSERT INTO users (id, email, password_hash, name, avatar_url, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`

	_, err := r.db.ExecContext(ctx, query,
		user.ID, user.Email, user.PasswordHash, user.Name, user.AvatarURL,
		user.CreatedAt, user.UpdatedAt,
	)

	return err
}

func (r *Repository) GetByID(ctx context.Context, id string) (*User, error) {
	var user User
	query := `SELECT id, email, password_hash, name, avatar_url, created_at, updated_at FROM users WHERE id = $1`

	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.AvatarURL,
		&user.CreatedAt, &user.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}

	return &user, err
}

func (r *Repository) GetByEmail(ctx context.Context, email string) (*User, error) {
	var user User
	query := `SELECT id, email, password_hash, name, avatar_url, created_at, updated_at FROM users WHERE email = $1`

	err := r.db.QueryRowContext(ctx, query, email).Scan(
		&user.ID, &user.Email, &user.PasswordHash, &user.Name, &user.AvatarURL,
		&user.CreatedAt, &user.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}

	return &user, err
}

func (r *Repository) Update(ctx context.Context, user *User) error {
	user.UpdatedAt = time.Now().UTC()

	query := `
		UPDATE users SET name = $1, avatar_url = $2, updated_at = $3 WHERE id = $4
	`

	_, err := r.db.ExecContext(ctx, query, user.Name, user.AvatarURL, user.UpdatedAt, user.ID)
	return err
}
```

### Task Model and Service

Tasks are the central aggregate of this application, carrying ownership, status, priority, and ordering metadata that drive the Kanban board. The model uses pointer types for optional fields (`*string`, `*time.Time`) so the JSON encoder omits them when unset, and the `UpdateTaskInput` uses pointers to distinguish "set to empty" from "leave unchanged" during partial updates.

```go
// backend/internal/task/model.go
package task

import (
	"time"
)

// Task status constants
const (
	StatusTodo       = "todo"
	StatusInProgress = "in_progress"
	StatusReview     = "review"
	StatusDone       = "done"
)

// Task priority constants
const (
	PriorityLow    = "low"
	PriorityMedium = "medium"
	PriorityHigh   = "high"
	PriorityUrgent = "urgent"
)

type Task struct {
	ID          string     `json:"id" db:"id"`
	ProjectID   string     `json:"project_id" db:"project_id"`
	Title       string     `json:"title" db:"title"`
	Description string     `json:"description,omitempty" db:"description"`
	Status      string     `json:"status" db:"status"`
	Priority    string     `json:"priority" db:"priority"`
	Position    int        `json:"position" db:"position"`
	AssigneeID  *string    `json:"assignee_id,omitempty" db:"assignee_id"`
	CreatorID   string     `json:"creator_id" db:"creator_id"`
	DueDate     *time.Time `json:"due_date,omitempty" db:"due_date"`
	Labels      []string   `json:"labels" db:"-"`
	CreatedAt   time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at" db:"updated_at"`

	// Joined fields
	Assignee *TaskUser `json:"assignee,omitempty" db:"-"`
	Creator  *TaskUser `json:"creator,omitempty" db:"-"`
}

type TaskUser struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url,omitempty"`
}

type Comment struct {
	ID        string    `json:"id" db:"id"`
	TaskID    string    `json:"task_id" db:"task_id"`
	UserID    string    `json:"user_id" db:"user_id"`
	Content   string    `json:"content" db:"content"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`

	// Joined fields
	User *TaskUser `json:"user,omitempty" db:"-"`
}

type CreateTaskInput struct {
	Title       string     `json:"title" validate:"required,max=255"`
	Description string     `json:"description" validate:"max=5000"`
	Priority    string     `json:"priority" validate:"omitempty,oneof=low medium high urgent"`
	AssigneeID  *string    `json:"assignee_id"`
	DueDate     *time.Time `json:"due_date"`
	Labels      []string   `json:"labels"`
}

type UpdateTaskInput struct {
	Title       *string    `json:"title" validate:"omitempty,max=255"`
	Description *string    `json:"description" validate:"omitempty,max=5000"`
	Priority    *string    `json:"priority" validate:"omitempty,oneof=low medium high urgent"`
	AssigneeID  *string    `json:"assignee_id"`
	DueDate     *time.Time `json:"due_date"`
	Labels      []string   `json:"labels"`
}

type UpdatePositionInput struct {
	Status   string `json:"status" validate:"required,oneof=todo in_progress review done"`
	Position int    `json:"position" validate:"gte=0"`
}
```

The task service coordinates between the repository and the WebSocket hub. Every mutation method follows the same pattern: validate input, persist the change, reload the full task with joined user data, then broadcast the event to the project room. This ordering ensures WebSocket subscribers always receive the complete, up-to-date task representation rather than a partial write.

```go
// backend/internal/task/service.go
package task

import (
	"context"
	"fmt"

	"taskmanager/internal/ws"
)

type Service struct {
	repo  *Repository
	wsHub *ws.Hub
}

func NewService(repo *Repository, wsHub *ws.Hub) *Service {
	return &Service{
		repo:  repo,
		wsHub: wsHub,
	}
}

func (s *Service) Create(ctx context.Context, projectID, creatorID string, input CreateTaskInput) (*Task, error) {
	task := &Task{
		ProjectID:   projectID,
		Title:       input.Title,
		Description: input.Description,
		Status:      StatusTodo,
		Priority:    input.Priority,
		AssigneeID:  input.AssigneeID,
		CreatorID:   creatorID,
		DueDate:     input.DueDate,
		Labels:      input.Labels,
	}

	if task.Priority == "" {
		task.Priority = PriorityMedium
	}

	// Get next position
	position, err := s.repo.GetNextPosition(ctx, projectID, StatusTodo)
	if err != nil {
		return nil, err
	}
	task.Position = position

	if err := s.repo.Create(ctx, task); err != nil {
		return nil, err
	}

	// Load full task with user info
	fullTask, err := s.repo.GetByID(ctx, task.ID)
	if err != nil {
		return task, nil
	}

	// Broadcast to project room
	s.wsHub.BroadcastToRoom(fmt.Sprintf("project:%s", projectID), ws.Message{
		Type:    "task_created",
		Payload: fullTask,
	})

	return fullTask, nil
}

func (s *Service) Update(ctx context.Context, taskID, userID string, input UpdateTaskInput) (*Task, error) {
	task, err := s.repo.GetByID(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if task == nil {
		return nil, ErrTaskNotFound
	}

	// Update fields
	if input.Title != nil {
		task.Title = *input.Title
	}
	if input.Description != nil {
		task.Description = *input.Description
	}
	if input.Priority != nil {
		task.Priority = *input.Priority
	}
	if input.AssigneeID != nil {
		task.AssigneeID = input.AssigneeID
	}
	if input.DueDate != nil {
		task.DueDate = input.DueDate
	}
	if input.Labels != nil {
		task.Labels = input.Labels
	}

	if err := s.repo.Update(ctx, task); err != nil {
		return nil, err
	}

	// Load updated task
	fullTask, _ := s.repo.GetByID(ctx, task.ID)

	// Broadcast update
	s.wsHub.BroadcastToRoom(fmt.Sprintf("project:%s", task.ProjectID), ws.Message{
		Type:    "task_updated",
		Payload: fullTask,
	})

	return fullTask, nil
}

func (s *Service) UpdateStatus(ctx context.Context, taskID, status string) (*Task, error) {
	task, err := s.repo.GetByID(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if task == nil {
		return nil, ErrTaskNotFound
	}

	oldStatus := task.Status
	task.Status = status

	// Get next position in new status column
	position, err := s.repo.GetNextPosition(ctx, task.ProjectID, status)
	if err != nil {
		return nil, err
	}
	task.Position = position

	if err := s.repo.UpdateStatus(ctx, task.ID, status, position); err != nil {
		return nil, err
	}

	// Load updated task
	fullTask, _ := s.repo.GetByID(ctx, task.ID)

	// Broadcast update
	s.wsHub.BroadcastToRoom(fmt.Sprintf("project:%s", task.ProjectID), ws.Message{
		Type: "task_moved",
		Payload: map[string]any{
			"task":       fullTask,
			"old_status": oldStatus,
			"new_status": status,
		},
	})

	return fullTask, nil
}

func (s *Service) UpdatePosition(ctx context.Context, taskID string, input UpdatePositionInput) (*Task, error) {
	task, err := s.repo.GetByID(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if task == nil {
		return nil, ErrTaskNotFound
	}

	oldStatus := task.Status
	oldPosition := task.Position

	// Reorder tasks in target status
	if err := s.repo.ReorderTasks(ctx, task.ProjectID, input.Status, taskID, input.Position); err != nil {
		return nil, err
	}

	// Update task status and position
	if err := s.repo.UpdateStatus(ctx, task.ID, input.Status, input.Position); err != nil {
		return nil, err
	}

	// Load updated task
	fullTask, _ := s.repo.GetByID(ctx, task.ID)

	// Broadcast update
	s.wsHub.BroadcastToRoom(fmt.Sprintf("project:%s", task.ProjectID), ws.Message{
		Type: "task_reordered",
		Payload: map[string]any{
			"task":         fullTask,
			"old_status":   oldStatus,
			"old_position": oldPosition,
			"new_status":   input.Status,
			"new_position": input.Position,
		},
	})

	return fullTask, nil
}

func (s *Service) Delete(ctx context.Context, taskID string) error {
	task, err := s.repo.GetByID(ctx, taskID)
	if err != nil {
		return err
	}
	if task == nil {
		return ErrTaskNotFound
	}

	if err := s.repo.Delete(ctx, taskID); err != nil {
		return err
	}

	// Broadcast deletion
	s.wsHub.BroadcastToRoom(fmt.Sprintf("project:%s", task.ProjectID), ws.Message{
		Type: "task_deleted",
		Payload: map[string]any{
			"task_id":    taskID,
			"project_id": task.ProjectID,
		},
	})

	return nil
}

func (s *Service) List(ctx context.Context, projectID string) (map[string][]*Task, error) {
	tasks, err := s.repo.ListByProject(ctx, projectID)
	if err != nil {
		return nil, err
	}

	// Group by status
	result := map[string][]*Task{
		StatusTodo:       {},
		StatusInProgress: {},
		StatusReview:     {},
		StatusDone:       {},
	}

	for _, task := range tasks {
		result[task.Status] = append(result[task.Status], task)
	}

	return result, nil
}

func (s *Service) GetByID(ctx context.Context, taskID string) (*Task, error) {
	return s.repo.GetByID(ctx, taskID)
}

func (s *Service) AddComment(ctx context.Context, taskID, userID, content string) (*Comment, error) {
	task, err := s.repo.GetByID(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if task == nil {
		return nil, ErrTaskNotFound
	}

	comment, err := s.repo.AddComment(ctx, taskID, userID, content)
	if err != nil {
		return nil, err
	}

	// Broadcast new comment
	s.wsHub.BroadcastToRoom(fmt.Sprintf("project:%s", task.ProjectID), ws.Message{
		Type: "comment_added",
		Payload: map[string]any{
			"task_id": taskID,
			"comment": comment,
		},
	})

	return comment, nil
}

func (s *Service) GetComments(ctx context.Context, taskID string) ([]*Comment, error) {
	return s.repo.GetComments(ctx, taskID)
}

var ErrTaskNotFound = fmt.Errorf("task not found")
```

### Task Handler

HTTP handlers parse the request, validate input with the `go-playground/validator` library, call the appropriate service method, and serialize the result. Each handler translates domain errors like `ErrTaskNotFound` into the appropriate HTTP status code (404), keeping error mapping out of the service layer. The `extractValidationErrors` helper converts validator failures into a field-keyed map for structured API error responses.

```go
// backend/internal/task/handler.go
package task

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"

	"taskmanager/internal/auth"
	"taskmanager/pkg/api"
)

type Handler struct {
	service   *Service
	validator *validator.Validate
}

func NewHandler(service *Service) *Handler {
	return &Handler{
		service:   service,
		validator: validator.New(),
	}
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectId")

	tasks, err := h.service.List(r.Context(), projectID)
	if err != nil {
		api.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to fetch tasks")
		return
	}

	api.JSON(w, http.StatusOK, tasks)
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectId")
	userID := auth.GetUserIDFromContext(r.Context())

	var input CreateTaskInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		api.Error(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return
	}

	if err := h.validator.Struct(input); err != nil {
		api.ValidationError(w, extractValidationErrors(err))
		return
	}

	task, err := h.service.Create(r.Context(), projectID, userID, input)
	if err != nil {
		api.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to create task")
		return
	}

	api.JSON(w, http.StatusCreated, task)
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")

	task, err := h.service.GetByID(r.Context(), taskID)
	if err != nil {
		api.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to fetch task")
		return
	}
	if task == nil {
		api.Error(w, http.StatusNotFound, "NOT_FOUND", "Task not found")
		return
	}

	api.JSON(w, http.StatusOK, task)
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")
	userID := auth.GetUserIDFromContext(r.Context())

	var input UpdateTaskInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		api.Error(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return
	}

	if err := h.validator.Struct(input); err != nil {
		api.ValidationError(w, extractValidationErrors(err))
		return
	}

	task, err := h.service.Update(r.Context(), taskID, userID, input)
	if err == ErrTaskNotFound {
		api.Error(w, http.StatusNotFound, "NOT_FOUND", "Task not found")
		return
	}
	if err != nil {
		api.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to update task")
		return
	}

	api.JSON(w, http.StatusOK, task)
}

func (h *Handler) UpdateStatus(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")

	var input struct {
		Status string `json:"status" validate:"required,oneof=todo in_progress review done"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		api.Error(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return
	}

	task, err := h.service.UpdateStatus(r.Context(), taskID, input.Status)
	if err == ErrTaskNotFound {
		api.Error(w, http.StatusNotFound, "NOT_FOUND", "Task not found")
		return
	}
	if err != nil {
		api.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to update task status")
		return
	}

	api.JSON(w, http.StatusOK, task)
}

func (h *Handler) UpdatePosition(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")

	var input UpdatePositionInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		api.Error(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return
	}

	if err := h.validator.Struct(input); err != nil {
		api.ValidationError(w, extractValidationErrors(err))
		return
	}

	task, err := h.service.UpdatePosition(r.Context(), taskID, input)
	if err == ErrTaskNotFound {
		api.Error(w, http.StatusNotFound, "NOT_FOUND", "Task not found")
		return
	}
	if err != nil {
		api.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to update task position")
		return
	}

	api.JSON(w, http.StatusOK, task)
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")

	err := h.service.Delete(r.Context(), taskID)
	if err == ErrTaskNotFound {
		api.Error(w, http.StatusNotFound, "NOT_FOUND", "Task not found")
		return
	}
	if err != nil {
		api.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to delete task")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) AddComment(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")
	userID := auth.GetUserIDFromContext(r.Context())

	var input struct {
		Content string `json:"content" validate:"required,max=5000"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		api.Error(w, http.StatusBadRequest, "BAD_REQUEST", "Invalid request body")
		return
	}

	comment, err := h.service.AddComment(r.Context(), taskID, userID, input.Content)
	if err == ErrTaskNotFound {
		api.Error(w, http.StatusNotFound, "NOT_FOUND", "Task not found")
		return
	}
	if err != nil {
		api.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to add comment")
		return
	}

	api.JSON(w, http.StatusCreated, comment)
}

func (h *Handler) GetComments(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "id")

	comments, err := h.service.GetComments(r.Context(), taskID)
	if err != nil {
		api.Error(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Failed to fetch comments")
		return
	}

	api.JSON(w, http.StatusOK, comments)
}

func extractValidationErrors(err error) map[string]string {
	errors := make(map[string]string)
	if validationErrs, ok := err.(validator.ValidationErrors); ok {
		for _, e := range validationErrs {
			errors[e.Field()] = e.Tag()
		}
	}
	return errors
}
```

### Junior -> FAANG: Repository Pattern and Why Interviewers Care

The repository pattern appears in FAANG system design questions because it tests whether you understand testability at the data layer. If your handler calls `sql.DB` directly, you cannot test business logic without a real database. If your handler calls a `Repository` interface, you can inject a mock that returns controlled responses.

Practice this specific interview question: "How would you test the task creation flow without a database?" The answer is: define a `TaskRepository` interface, have the service accept that interface (not the concrete struct), and inject an in-memory implementation in tests. If you have actually written this test, you can answer in 90 seconds. If you have only read about it, you will stumble on the interface definition syntax.

One first-job habit to start immediately: never put `json:"-"` on a field without writing a test that serializes the struct and asserts the field is absent. The tag is invisible in code review and easy to remove accidentally.

### Senior @ FAANG: Service Layer Contracts and the Domain Error Problem

The task service in this file mixes two concerns that senior engineers separate: domain errors (task not found, task access denied) and infrastructure errors (database connection failed, query timeout). Both surface as `error` in Go, but they have different callers, different log levels, and different HTTP responses.

The pattern to enforce at L6 is typed domain errors. Define `ErrTaskNotFound`, `ErrAccessDenied`, and `ErrVersionConflict` as sentinel values or typed structs. The handler uses `errors.Is` or `errors.As` to distinguish them, and everything else becomes a 500. This removes the string comparison smell (`if err.Error() == "not found"`) and makes the error contract part of the package's public API.

The `Update` method in the task service silently ignores the error from `GetByID` after the write: `fullTask, _ := s.repo.GetByID(ctx, task.ID)`. At FAANG code review, this is a hard block. A write succeeded but the reload failed, so the service returns nil and the handler serializes nothing or panics. The correct behavior is to log the reload failure, return the partially-constructed task from the write phase (sufficient for the WebSocket broadcast), and let the client's next poll retrieve the authoritative state. Silently dropping errors is the most common source of ghost bugs in production Go services.

The WebSocket broadcast happens after the repository write but before the HTTP response is sent. This is the wrong ordering in a distributed system. If the service crashes between broadcast and response, the WebSocket subscriber has already received "task created" but the HTTP caller receives no response and will retry, creating a duplicate. The correct pattern is: respond to the HTTP caller first (the write is committed and durable), then broadcast. For at-most-once semantics this is acceptable. For exactly-once, use a transactional outbox: write the event into the same transaction as the task row, and have a separate poller broadcast committed events.

---
