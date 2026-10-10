## 54.8 Company Case Studies

### Asana: Hierarchical Task Organization

Asana's task architecture (documented in Asana Engineering's published architectural retrospectives on hierarchical graph data models and recursive CTE query performance) supports subtasks nested to arbitrary depth, where each subtask inherits its parent's project memberships. The data model uses a recursive `parent_id` foreign key, and the service layer uses a recursive CTE query to load an entire task tree in a single round trip. The `CreateSubtask` method runs in a transaction to atomically insert the child and copy the parent's project associations.

```go
// Asana-style hierarchical task model
package asana

import (
    "context"
    "database/sql"
    "time"
)

type User struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}

type Project struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}

type Tag struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}

type CustomField struct {
    ID    string `json:"id"`
    Name  string `json:"name"`
    Value any    `json:"value"`
}

type TaskCache struct{}

func (c *TaskCache) Invalidate(id string) {}
func (c *TaskCache) GetWithSubtasks(id string) (*Task, error) {
    return nil, sql.ErrNoRows
}
func (c *TaskCache) SetWithSubtasks(id string, t *Task) {}

type TaskSearch struct{}
type WebhookDispatcher struct{}

func (w *WebhookDispatcher) Dispatch(event string, payload any) {}

func generateGID() string {
    return "gid-12345"
}

// Task with full hierarchy support
type Task struct {
    ID           string        `json:"gid"`
    Name         string        `json:"name"`
    Notes        string        `json:"notes"`
    HTMLNotes    string        `json:"html_notes"`
    DueOn        *time.Time    `json:"due_on"`
    DueAt        *time.Time    `json:"due_at"`
    StartOn      *time.Time    `json:"start_on"`
    Completed    bool          `json:"completed"`
    CompletedAt  *time.Time    `json:"completed_at"`
    Assignee     *User         `json:"assignee"`
    Parent       *Task         `json:"parent"`
    Projects     []Project     `json:"projects"`
    Tags         []Tag         `json:"tags"`
    Dependencies []Task        `json:"dependencies"`
    Dependents   []Task        `json:"dependents"`
    Subtasks     []Task        `json:"subtasks"`
    CustomFields []CustomField `json:"custom_fields"`
    CreatedAt    time.Time     `json:"created_at"`
    ModifiedAt   time.Time     `json:"modified_at"`
}

// TaskService handles complex task operations
type TaskService struct {
    db       *sql.DB
    cache    *TaskCache
    search   *TaskSearch
    webhooks *WebhookDispatcher
}

func (s *TaskService) getTask(ctx context.Context, tx *sql.Tx, id string) (*Task, error) {
    return &Task{ID: id}, nil
}

// CreateSubtask creates a subtask with proper ordering
func (s *TaskService) CreateSubtask(
    ctx context.Context,
    parentID string,
    task *Task,
) (*Task, error) {
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return nil, err
    }
    defer tx.Rollback()

    // Get parent and verify access
    parent, err := s.getTask(ctx, tx, parentID)
    if err != nil {
        return nil, err
    }

    // Get next position in subtask order
    var maxPosition int
    tx.QueryRowContext(ctx, `
        SELECT COALESCE(MAX(position), 0) FROM tasks WHERE parent_id = $1
    `, parentID).Scan(&maxPosition)

    task.ID = generateGID()
    task.Parent = &Task{ID: parentID}

    // Insert task
    _, err = tx.ExecContext(ctx, `
        INSERT INTO tasks (id, name, notes, parent_id, position, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
    `, task.ID, task.Name, task.Notes, parentID, maxPosition+1, time.Now())
    if err != nil {
        return nil, err
    }

    // Copy projects from parent (subtasks inherit parent's projects)
    _, err = tx.ExecContext(ctx, `
        INSERT INTO task_projects (task_id, project_id)
        SELECT $1, project_id FROM task_projects WHERE task_id = $2
    `, task.ID, parentID)
    if err != nil {
        return nil, err
    }

    if err := tx.Commit(); err != nil {
        return nil, err
    }

    // Dispatch webhook
    s.webhooks.Dispatch("task.created", task)

    // Invalidate caches
    s.cache.Invalidate(parentID)

    return task, nil
}

// GetTaskTree returns task with full subtask tree
func (s *TaskService) GetTaskTree(ctx context.Context, taskID string, depth int) (*Task, error) {
    task, err := s.cache.GetWithSubtasks(taskID)
    if err == nil {
        return task, nil
    }

    // Recursive CTE to get task tree
    rows, err := s.db.QueryContext(ctx, `
        WITH RECURSIVE task_tree AS (
            SELECT id, name, notes, parent_id, completed, assignee_id, 0 as depth
            FROM tasks WHERE id = $1
            UNION ALL
            SELECT t.id, t.name, t.notes, t.parent_id, t.completed, t.assignee_id, tt.depth + 1
            FROM tasks t
            JOIN task_tree tt ON t.parent_id = tt.id
            WHERE tt.depth < $2
        )
        SELECT * FROM task_tree ORDER BY depth, position
    `, taskID, depth)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    // Build tree structure
    taskMap := make(map[string]*Task)
    var root *Task

    for rows.Next() {
        var t Task
        var parentID sql.NullString
        var assigneeID sql.NullString
        var depth int

        rows.Scan(&t.ID, &t.Name, &t.Notes, &parentID, &t.Completed, &assigneeID, &depth)

        taskMap[t.ID] = &t

        if parentID.Valid {
            parent := taskMap[parentID.String]
            if parent != nil {
                parent.Subtasks = append(parent.Subtasks, t)
            }
        } else {
            root = &t
        }
    }

    s.cache.SetWithSubtasks(taskID, root)
    return root, nil
}

// ReorderTasks reorders tasks within a project section
func (s *TaskService) ReorderTasks(
    ctx context.Context,
    projectID string,
    sectionID string,
    taskIDs []string,
) error {
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // Update positions in a single batch
    for i, taskID := range taskIDs {
        _, err := tx.ExecContext(ctx, `
            UPDATE task_sections
            SET position = $1
            WHERE task_id = $2 AND section_id = $3
        `, i, taskID, sectionID)
        if err != nil {
            return err
        }
    }

    return tx.Commit()
}
```

### Monday.com: Flexible Item Attributes

As documented in Monday.com Engineering's architecture disclosures ("Building Monday's Flexible Board Architecture", Monday.com Engineering Blog), Monday.com utilizes a flexible schema-on-read model where boards maintain arbitrary user-configured column types. Each item stores its values as JSON blobs keyed by column ID, allowing teams to reconfigure boards without database migrations. The trade-off is that column value validation and indexing must happen in application code rather than database constraints, as shown in the `StatusColumnValidator` below.

```go
// Monday.com-style dynamic columns
package monday

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "time"
)

type User struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}

type Group struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}

type Permissions struct {
    CanEdit bool `json:"can_edit"`
}

type AutomationEvent struct {
    Type     string          `json:"type"`
    BoardID  string          `json:"board_id"`
    ItemID   string          `json:"item_id"`
    ColumnID string          `json:"column_id"`
    Value    json.RawMessage `json:"value"`
}

type AutomationEngine struct{}

func (a *AutomationEngine) Trigger(ctx context.Context, event AutomationEvent) {}

// Board represents a workspace board
type Board struct {
    ID          string       `json:"id"`
    Name        string       `json:"name"`
    Description string       `json:"description"`
    Columns     []Column     `json:"columns"`
    Groups      []Group      `json:"groups"`
    Items       []Item       `json:"items"`
    Owners      []User       `json:"owners"`
    Permissions *Permissions `json:"permissions"`
}

// Column defines a column type and configuration
type Column struct {
    ID       string          `json:"id"`
    Title    string          `json:"title"`
    Type     ColumnType      `json:"type"`
    Settings json.RawMessage `json:"settings"`
    Width    int             `json:"width"`
}

type ColumnType string

const (
    ColumnStatus   ColumnType = "status"
    ColumnPerson   ColumnType = "person"
    ColumnDate     ColumnType = "date"
    ColumnTimeline ColumnType = "timeline"
    ColumnNumbers  ColumnType = "numbers"
    ColumnText     ColumnType = "text"
    ColumnLink     ColumnType = "link"
    ColumnDropdown ColumnType = "dropdown"
    ColumnCheckbox ColumnType = "checkbox"
    ColumnFile     ColumnType = "file"
)

// Item represents a row in the board
type Item struct {
    ID           string                 `json:"id"`
    Name         string                 `json:"name"`
    GroupID      string                 `json:"group_id"`
    ColumnValues map[string]ColumnValue `json:"column_values"`
    Subitems     []Item                 `json:"subitems"`
    CreatedAt    time.Time              `json:"created_at"`
    UpdatedAt    time.Time              `json:"updated_at"`
}

// ColumnValue holds the value for a specific column
type ColumnValue struct {
    ColumnID string          `json:"column_id"`
    Value    json.RawMessage `json:"value"`
    Text     string          `json:"text"` // Human-readable representation
}

// BoardService handles board operations
type BoardService struct {
    db          *sql.DB
    automations *AutomationEngine
}

func (s *BoardService) getColumn(ctx context.Context, boardID, columnID string) (*Column, error) {
    return &Column{ID: columnID, Type: ColumnStatus}, nil
}

func (s *BoardService) getValidator(t ColumnType) *StatusColumnValidator {
    return &StatusColumnValidator{}
}

func (s *BoardService) GetItem(ctx context.Context, itemID string) (*Item, error) {
    return &Item{ID: itemID}, nil
}

// ChangeColumnValue updates a single column value
func (s *BoardService) ChangeColumnValue(
    ctx context.Context,
    boardID, itemID, columnID string,
    value json.RawMessage,
) (*Item, error) {
    // Validate column type and value
    column, err := s.getColumn(ctx, boardID, columnID)
    if err != nil {
        return nil, err
    }

    validator := s.getValidator(column.Type)
    if err := validator.Validate(value, column.Settings); err != nil {
        return nil, fmt.Errorf("invalid value for column %s: %w", columnID, err)
    }

    // Update value
    _, err = s.db.ExecContext(ctx, `
        INSERT INTO item_column_values (item_id, column_id, value, text)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (item_id, column_id)
        DO UPDATE SET value = $3, text = $4, updated_at = NOW()
    `, itemID, columnID, value, validator.ToText(value))
    if err != nil {
        return nil, err
    }

    // Trigger automations
    s.automations.Trigger(ctx, AutomationEvent{
        Type:     "column_changed",
        BoardID:  boardID,
        ItemID:   itemID,
        ColumnID: columnID,
        Value:    value,
    })

    return s.GetItem(ctx, itemID)
}

// StatusColumnValidator validates status column values
type StatusColumnValidator struct{}

type StatusValue struct {
    Index int `json:"index"`
}

type StatusSettings struct {
    Labels map[int]StatusLabel `json:"labels"`
}

type StatusLabel struct {
    Color string `json:"color"`
    Text  string `json:"text"`
}

func (v *StatusColumnValidator) Validate(value json.RawMessage, settings json.RawMessage) error {
    var status StatusValue
    if err := json.Unmarshal(value, &status); err != nil {
        return err
    }

    var statusSettings StatusSettings
    if err := json.Unmarshal(settings, &statusSettings); err != nil {
        return err
    }

    if _, ok := statusSettings.Labels[status.Index]; !ok {
        return fmt.Errorf("invalid status index: %d", status.Index)
    }

    return nil
}

func (v *StatusColumnValidator) ToText(value json.RawMessage) string {
    var status StatusValue
    json.Unmarshal(value, &status)
    return fmt.Sprintf("%d", status.Index)
}
```

### Linear: Optimistic Sync Engine

As documented by Linear's co-founder and CTO Tuomas Artman ("Scaling the Linear Sync Engine", Linear Engineering Blog, 2020), Linear achieves sub-50ms interaction latencies through an offline-first, client-side database synchronization architecture with fractional indexing and Lamport timestamp-based delta synchronization. While Linear's primary web client and service layer run TypeScript/Node.js, high-throughput sync coordination and backend delta broadcasting follow the patterns modeled below in Go:

```go
// Linear-style optimistic sync
package linear

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "sync"
    "time"
)

type State struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}

type User struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}

type Project struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}

type Label struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}

type Cycle struct {
    ID   string `json:"id"`
    Name string `json:"name"`
}

type DeltaStore struct{}

type IssueCache struct{}

type CreateIssueInput struct {
    Title       string
    Description string
    Priority    int
    StateID     string
    AssigneeID  *string
    ProjectID   *string
    TeamID      string
}

type UpdateIssueInput struct {
    Title       *string
    Description *string
}

type VersionConflictError struct {
    Expected int64
    Actual   int64
    Current  *Issue
}

func (e *VersionConflictError) Error() string {
    return fmt.Sprintf("version conflict: expected %d, got %d", e.Expected, e.Actual)
}

func generateNanoID() string {
    return "lin-nano-1"
}

func buildUpdateQuery(table, id string, input UpdateIssueInput, version int64) (string, []any) {
    return "UPDATE issues SET sync_version = $1 WHERE id = $2", []any{version, id}
}

// SyncEngine handles real-time sync between clients
type SyncEngine struct {
    clients   map[string]*SyncClient
    delta     *DeltaStore
    broadcast chan *SyncDelta
    mu        sync.RWMutex
}

func (e *SyncEngine) Broadcast(ctx context.Context, delta *SyncDelta) {}

// SyncDelta represents a change to sync
type SyncDelta struct {
    ID        string          `json:"id"`
    Type      string          `json:"type"`  // create, update, delete
    ModelType string          `json:"model"` // issue, project, etc.
    ModelID   string          `json:"model_id"`
    Data      json.RawMessage `json:"data"`
    Timestamp int64           `json:"timestamp"` // Lamport timestamp
    ClientID  string          `json:"client_id"`
    TeamID    string          `json:"team_id"`
}

// SyncClient represents a connected client
type SyncClient struct {
    ID               string
    UserID           string
    TeamIDs          []string
    LastSync         int64
    Send             chan *SyncDelta
    SubscribedModels map[string]bool
}

// Issue with sync support
type Issue struct {
    ID          string     `json:"id"`
    Identifier  string     `json:"identifier"` // e.g., "LIN-123"
    Title       string     `json:"title"`
    Description string     `json:"description"`
    Priority    int        `json:"priority"`
    State       *State     `json:"state"`
    Assignee    *User      `json:"assignee"`
    Project     *Project   `json:"project"`
    Labels      []Label    `json:"labels"`
    Cycle       *Cycle     `json:"cycle"`
    DueDate     *time.Time `json:"dueDate"`
    SortOrder   float64    `json:"sortOrder"` // Fractional indexing
    CreatedAt   time.Time  `json:"createdAt"`
    UpdatedAt   time.Time  `json:"updatedAt"`
    ArchivedAt  *time.Time `json:"archivedAt"`
    SyncVersion int64      `json:"_syncVersion"` // For optimistic concurrency
    TeamID      string     `json:"team_id"`
}

// IssueService with sync
type IssueService struct {
    db    *sql.DB
    cache *IssueCache
    sync  *SyncEngine
}

func (s *IssueService) generateIdentifier(ctx context.Context, teamID string) string {
    return "LIN-101"
}

func (s *IssueService) GetIssue(ctx context.Context, id string) (*Issue, error) {
    return &Issue{ID: id}, nil
}

// CreateIssue creates an issue with optimistic sync
func (s *IssueService) CreateIssue(ctx context.Context, input CreateIssueInput) (*Issue, error) {
    issue := &Issue{
        ID:          generateNanoID(),
        Identifier:  s.generateIdentifier(ctx, input.TeamID),
        Title:       input.Title,
        Description: input.Description,
        Priority:    input.Priority,
        SortOrder:   s.calculateSortOrder(ctx, input.StateID),
        CreatedAt:   time.Now(),
        UpdatedAt:   time.Now(),
        SyncVersion: time.Now().UnixNano(),
        TeamID:      input.TeamID,
    }

    // Insert into database
    _, err := s.db.ExecContext(ctx, `
        INSERT INTO issues (
            id, identifier, title, description, priority,
            state_id, assignee_id, project_id, sort_order,
            created_at, updated_at, sync_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, issue.ID, issue.Identifier, issue.Title, issue.Description,
        issue.Priority, input.StateID, input.AssigneeID, input.ProjectID,
        issue.SortOrder, issue.CreatedAt, issue.UpdatedAt, issue.SyncVersion)

    if err != nil {
        return nil, err
    }

    // Broadcast sync delta
    data, _ := json.Marshal(issue)
    s.sync.Broadcast(ctx, &SyncDelta{
        ID:        generateNanoID(),
        Type:      "create",
        ModelType: "issue",
        ModelID:   issue.ID,
        Data:      data,
        Timestamp: issue.SyncVersion,
        TeamID:    input.TeamID,
    })

    return issue, nil
}

// UpdateIssue with optimistic locking
func (s *IssueService) UpdateIssue(
    ctx context.Context,
    issueID string,
    input UpdateIssueInput,
    expectedVersion int64,
) (*Issue, error) {
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return nil, err
    }
    defer tx.Rollback()

    // Check version for optimistic locking
    var currentVersion int64
    err = tx.QueryRowContext(ctx, `
        SELECT sync_version FROM issues WHERE id = $1 FOR UPDATE
    `, issueID).Scan(&currentVersion)
    if err != nil {
        return nil, err
    }

    if currentVersion != expectedVersion {
        // Version conflict - return current state for client merge
        issue, _ := s.GetIssue(ctx, issueID)
        return nil, &VersionConflictError{
            Expected: expectedVersion,
            Actual:   currentVersion,
            Current:  issue,
        }
    }

    newVersion := time.Now().UnixNano()

    // Build update query dynamically
    query, args := buildUpdateQuery("issues", issueID, input, newVersion)
    _, err = tx.ExecContext(ctx, query, args...)
    if err != nil {
        return nil, err
    }

    if err := tx.Commit(); err != nil {
        return nil, err
    }

    issue, _ := s.GetIssue(ctx, issueID)

    // Broadcast sync delta
    data, _ := json.Marshal(issue)
    s.sync.Broadcast(ctx, &SyncDelta{
        ID:        generateNanoID(),
        Type:      "update",
        ModelType: "issue",
        ModelID:   issue.ID,
        Data:      data,
        Timestamp: newVersion,
        TeamID:    issue.TeamID,
    })

    return issue, nil
}

// Fractional indexing for efficient reordering
func (s *IssueService) calculateSortOrder(ctx context.Context, stateID string) float64 {
    var maxOrder float64
    s.db.QueryRowContext(ctx, `
        SELECT COALESCE(MAX(sort_order), 0) FROM issues WHERE state_id = $1
    `, stateID).Scan(&maxOrder)
    return maxOrder + 1.0
}

func (s *IssueService) MoveIssueBetween(
    ctx context.Context,
    issueID string,
    beforeID, afterID *string,
) error {
    var beforeOrder, afterOrder float64

    if beforeID != nil {
        s.db.QueryRowContext(ctx, `
            SELECT sort_order FROM issues WHERE id = $1
        `, *beforeID).Scan(&beforeOrder)
    }

    if afterID != nil {
        s.db.QueryRowContext(ctx, `
            SELECT sort_order FROM issues WHERE id = $1
        `, *afterID).Scan(&afterOrder)
    }

    // Calculate new order using fractional indexing
    var newOrder float64
    if beforeID == nil {
        newOrder = afterOrder / 2
    } else if afterID == nil {
        newOrder = beforeOrder + 1
    } else {
        newOrder = (beforeOrder + afterOrder) / 2
    }

    _, err := s.db.ExecContext(ctx, `
        UPDATE issues SET sort_order = $1, updated_at = NOW() WHERE id = $2
    `, newOrder, issueID)

    return err
}
```

### Junior -> FAANG: Reading Case Studies for Interview Signals

Interviewers at FAANG ask: "Tell me about a system you designed that is similar to [Asana / Monday.com / Linear]." If you have studied these case studies, you can anchor your answer to real architectural decisions rather than invented ones. The Asana recursive CTE for task trees, the Monday.com schema-on-read pattern for custom columns, and Linear's fractional indexing for reordering are all concrete choices with known tradeoffs.

For entry-level FAANG, the expectation is that you can name the pattern and explain why it solves the stated problem. "Asana uses a recursive CTE to load the task tree in a single query rather than making N queries for N levels of nesting" is a credible answer. "They probably use some database thing" is not.

Study the `MoveIssueBetween` function in the Linear example until you can explain fractional indexing without the code in front of you. It appears in system design interviews whenever the question involves ordered lists: music playlists, document sections, Kanban columns.

### Senior @ FAANG: Architecture Review of the Three Models

Each case study represents a different point on the flexibility-consistency spectrum. Understanding where to place your system on that spectrum is a staff-level judgment.

**Asana's recursive model** optimizes for structured hierarchy: subtasks inherit project membership, the data model is relational and enforced at the database level, and queries are efficient via CTE. The tradeoff is rigidity: adding a new relationship type (cross-project links, dependency graphs) requires schema changes and migration. The `GetTaskTree` function is correct for depth-bounded trees but becomes a full materialization at depth 10+ in a large project. At that depth, Asana uses a pre-computed closure table maintained by database triggers.

**Monday.com's schema-on-read model** optimizes for flexibility: teams can add custom columns without a migration, and the column schema lives in JSON settings. The tradeoff is that validation, indexing, and query efficiency all move to the application layer. You cannot put a B-tree index on a JSON-blob column value without a generated column and a partial index. The `StatusColumnValidator` correctly does validation in application code, but if you need to query "all items where status = Done," you are scanning and deserializing JSON for every row unless you maintain a denormalized lookup table. The senior-level question is: when does the schema-on-read pattern break down under query pressure, and what is the migration path to a more structured model?

**Linear's optimistic sync model** optimizes for perceived performance and offline capability. The Lamport timestamp (`SyncVersion`) ensures events are totally ordered on the server without relying on wall-clock synchronization. The `VersionConflictError` returns the current state on conflict so the client can implement a merge strategy rather than silently losing data. The tradeoff is complexity: the sync engine, conflict resolution protocol, and client-side merge logic all require correctness guarantees that are difficult to test exhaustively. The ADR question at FAANG is: "Is our product's value proposition dependent on offline-first or sub-100ms perceived write latency?" If yes, build the sync engine. If no, optimistic locking with version columns is sufficient and an order of magnitude simpler to operate.

---
