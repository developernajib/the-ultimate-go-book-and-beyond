## Interview Questions

### Question 1: How would you implement task dependencies in a project management tool?

**What FAANG expects:** Model dependencies as a directed graph, prevent cycles on insert (DFS or transitive-closure check), cascade "unblocked" events to dependents on completion, and know the four dependency types from PMBOK (Finish-to-Start is 90% of real use). Bonus for noting that `LTREE`/recursive CTEs scale the cascade query to thousands of nodes without N+1 lookups.

**Answer:**

Task dependencies require careful handling to prevent cycles and manage cascading updates:

```go
// Dependency management with cycle detection
type DependencyService struct {
    db     *sql.DB
    cache  *DependencyCache
    notify *NotificationService
}

type Dependency struct {
    ID           string         `json:"id"`
    TaskID       string         `json:"task_id"`       // Dependent task
    DependsOnID  string         `json:"depends_on_id"` // Blocking task
    Type         DependencyType `json:"type"`
    CreatedAt    time.Time      `json:"created_at"`
}

type DependencyType string

const (
    FinishToStart  DependencyType = "finish_to_start"  // Default
    StartToStart   DependencyType = "start_to_start"
    FinishToFinish DependencyType = "finish_to_finish"
    StartToFinish  DependencyType = "start_to_finish"
)

// AddDependency creates a dependency with cycle detection
func (s *DependencyService) AddDependency(
    ctx context.Context,
    taskID, dependsOnID string,
    depType DependencyType,
) error {
    // Check for cycles using DFS
    if s.wouldCreateCycle(ctx, taskID, dependsOnID) {
        return ErrCyclicDependency
    }

    // Check same project
    task, _ := s.getTask(ctx, taskID)
    dependsOn, _ := s.getTask(ctx, dependsOnID)
    if task.ProjectID != dependsOn.ProjectID {
        return ErrCrossProjectDependency
    }

    _, err := s.db.ExecContext(ctx, `
        INSERT INTO task_dependencies (id, task_id, depends_on_id, type, created_at)
        VALUES ($1, $2, $3, $4, $5)
    `, generateID(), taskID, dependsOnID, depType, time.Now())

    if err != nil {
        return err
    }

    // Update task status if blocked
    s.updateBlockedStatus(ctx, taskID)

    return nil
}

func (s *DependencyService) wouldCreateCycle(ctx context.Context, taskID, dependsOnID string) bool {
    visited := make(map[string]bool)
    return s.hasCycle(ctx, dependsOnID, taskID, visited)
}

func (s *DependencyService) hasCycle(ctx context.Context, current, target string, visited map[string]bool) bool {
    if current == target {
        return true
    }
    if visited[current] {
        return false
    }
    visited[current] = true

    // Get dependencies of current task
    deps, _ := s.getDependencies(ctx, current)
    for _, dep := range deps {
        if s.hasCycle(ctx, dep.DependsOnID, target, visited) {
            return true
        }
    }

    return false
}

// CompleteTask updates dependent tasks when a blocking task is completed
func (s *DependencyService) CompleteTask(ctx context.Context, taskID string) error {
    tx, _ := s.db.BeginTx(ctx, nil)
    defer tx.Rollback()

    // Mark task complete
    _, err := tx.ExecContext(ctx, `
        UPDATE tasks SET status = 'completed', completed_at = NOW() WHERE id = $1
    `, taskID)
    if err != nil {
        return err
    }

    // Find unblocked tasks
    unblockedTasks, err := s.findUnblockedTasks(ctx, tx, taskID)
    if err != nil {
        return err
    }

    // Update blocked status
    for _, unblockedID := range unblockedTasks {
        _, err = tx.ExecContext(ctx, `
            UPDATE tasks SET is_blocked = false WHERE id = $1
        `, unblockedID)
        if err != nil {
            return err
        }

        // Notify assignee
        task, _ := s.getTask(ctx, unblockedID)
        s.notify.Send(task.AssigneeID, Notification{
            Type:    "task_unblocked",
            TaskID:  unblockedID,
            Message: fmt.Sprintf("Task '%s' is now unblocked", task.Title),
        })
    }

    return tx.Commit()
}
```

**Follow-ups:**
- *Why recursive DFS instead of a cached transitive-closure table?* DFS is simpler and fine for the typical per-project dependency graph (hundreds of tasks, not millions). At Jira/Asana scale, maintain a materialized closure in Postgres and check membership in O(1).
- *What happens when the cycle check passes but a concurrent insert creates a cycle anyway?* Wrap the insert + re-check in a serializable transaction, or add a deferred trigger that validates after commit. Pure application-level DFS has a classic TOCTOU race.
- *How do you handle cross-project dependencies?* Most teams reject them (the sample does) because a blocking change in project A silently stalls project B. When you must allow them, require explicit opt-in and visual edges that survive filters.

---

### Question 2: How do you handle real-time collaboration without conflicts?

**What FAANG expects:** Three tools for three shapes: OT (Google Docs) for rich text with a central server, CRDTs (Yjs, Automerge) for local-first/offline, and optimistic locking (version column) for structured records. Explain why you *shouldn't* build OT yourself (the invariants are subtle, `transform()` correctness is proof-level). Bonus for naming Yjs + y-protocols as the 2026 default for collaborative editors, and for recognizing that task objects are usually fine with version+merge, not CRDTs.

**Answer:**

Use Operational Transformation (OT) or CRDTs for text, and optimistic locking for structured data:

```go
// Collaborative editing with operational transformation
type CollaborativeEditor struct {
    docs     map[string]*Document
    sessions map[string]*EditSession
    hub      *WSHub
}

type Document struct {
    ID        string
    Content   string
    Version   int
    Operations []Operation
    mu        sync.RWMutex
}

type Operation struct {
    Type     OpType // insert, delete, retain
    Position int
    Text     string
    Length   int
    UserID   string
    Version  int
}

type OpType string

const (
    OpInsert OpType = "insert"
    OpDelete OpType = "delete"
    OpRetain OpType = "retain"
)

// ApplyOperation applies an operation with transformation
func (d *Document) ApplyOperation(op Operation) (*Operation, error) {
    d.mu.Lock()
    defer d.mu.Unlock()

    // Transform operation against concurrent operations
    if op.Version < d.Version {
        // Operation is based on old version, transform it
        for i := op.Version; i < d.Version; i++ {
            op = transform(op, d.Operations[i])
        }
    }

    // Apply the transformed operation
    switch op.Type {
    case OpInsert:
        d.Content = d.Content[:op.Position] + op.Text + d.Content[op.Position:]
    case OpDelete:
        d.Content = d.Content[:op.Position] + d.Content[op.Position+op.Length:]
    }

    op.Version = d.Version
    d.Operations = append(d.Operations, op)
    d.Version++

    return &op, nil
}

// Transform transforms op1 against op2
func transform(op1, op2 Operation) Operation {
    if op2.Type == OpInsert {
        if op2.Position <= op1.Position {
            op1.Position += len(op2.Text)
        }
    } else if op2.Type == OpDelete {
        if op2.Position < op1.Position {
            if op2.Position + op2.Length <= op1.Position {
                op1.Position -= op2.Length
            } else {
                op1.Position = op2.Position
            }
        }
    }
    return op1
}

// For structured data like tasks, use version-based locking
type CollaborativeTaskService struct {
    db  *sql.DB
    hub *WSHub
}

func (s *CollaborativeTaskService) UpdateTask(
    ctx context.Context,
    taskID string,
    update TaskUpdate,
    clientVersion int,
) (*Task, error) {
    tx, _ := s.db.BeginTx(ctx, nil)
    defer tx.Rollback()

    // Check version
    var serverVersion int
    tx.QueryRowContext(ctx, `
        SELECT version FROM tasks WHERE id = $1 FOR UPDATE
    `, taskID).Scan(&serverVersion)

    if clientVersion != serverVersion {
        // Conflict - fetch current and let client merge
        task, _ := s.getTask(ctx, taskID)
        return nil, &ConflictError{
            Current:       task,
            ClientVersion: clientVersion,
            ServerVersion: serverVersion,
        }
    }

    // Apply update
    newVersion := serverVersion + 1
    _, err := tx.ExecContext(ctx, `
        UPDATE tasks SET title = $1, description = $2, version = $3
        WHERE id = $4
    `, update.Title, update.Description, newVersion, taskID)

    if err != nil {
        return nil, err
    }

    if err := tx.Commit(); err != nil {
        return nil, err
    }

    task, _ := s.getTask(ctx, taskID)

    // Broadcast to other clients
    s.hub.BroadcastExcept(task.ProjectID, update.UserID, "task.updated", task)

    return task, nil
}
```

**Follow-ups:**
- *Why is rolling your own OT a bad idea?* The correctness proof for the `transform` function is non-trivial and well-known to miss edge cases (tombstones, composite operations). Use `ot.js`, ShareDB, or switch to Yjs.
- *When would you choose CRDTs over OT?* When clients need to work offline and merge later. CRDTs give eventual convergence without a central authority. Cost: metadata overhead and garbage-collection complexity.
- *How do you communicate conflicts to the user?* Return the server's current version in the 409 response so the UI can diff. Automerge "last-write-wins" silently loses data. "prompt to merge" is the correct UX for task/record edits.

---

### Question 3: How would you implement task filtering and search?

**What FAANG expects:** Full-text search in Postgres via `tsvector` + GIN index, parameterized filter builder with placeholders (never string-concat user input into SQL), keyset pagination over offset at depth, and a faceted-count strategy. Bonus for mentioning `pg_trgm` for fuzzy matching, `paradedb` (BM25 in Postgres) as the 2025+ alternative to shipping to Elasticsearch, and deferred `COUNT(*) OVER()` vs separate count query trade-offs.

**Answer:**

Combine PostgreSQL's built-in full-text search for keyword queries with dynamic SQL filter construction for structured filters (assignee, priority, due date). The `TaskFilter` struct below captures every filterable dimension, and the service builds the WHERE clause incrementally using parameterized placeholders to prevent SQL injection. For keyword searches, a `tsvector` column with a GIN index avoids the full table scan that `ILIKE '%term%'` would require.

```go
// Advanced task filtering with full-text search
type TaskSearchService struct {
    db    *sql.DB
    index *search.Index // Elasticsearch or similar
}

type TaskFilter struct {
    ProjectID    string   `json:"project_id"`
    ColumnIDs    []string `json:"column_ids"`
    AssigneeIDs  []string `json:"assignee_ids"`
    LabelIDs     []string `json:"label_ids"`
    Priority     []int    `json:"priority"`
    DueDateFrom  *time.Time `json:"due_date_from"`
    DueDateTo    *time.Time `json:"due_date_to"`
    IsOverdue    *bool    `json:"is_overdue"`
    IsBlocked    *bool    `json:"is_blocked"`
    HasSubtasks  *bool    `json:"has_subtasks"`
    Query        string   `json:"query"` // Full-text search
    Sort         string   `json:"sort"`
    SortDir      string   `json:"sort_dir"`
    Page         int      `json:"page"`
    PageSize     int      `json:"page_size"`
}

func (s *TaskSearchService) SearchTasks(ctx context.Context, filter TaskFilter) (*TaskSearchResult, error) {
    // Use full-text search for query
    if filter.Query != "" {
        return s.fullTextSearch(ctx, filter)
    }

    // Build SQL query dynamically
    query := `
        SELECT t.*,
               u.name as assignee_name,
               array_agg(DISTINCT l.id) as label_ids
        FROM tasks t
        LEFT JOIN users u ON t.assignee_id = u.id
        LEFT JOIN task_labels tl ON t.id = tl.task_id
        LEFT JOIN labels l ON tl.label_id = l.id
        WHERE t.project_id = $1
    `

    args := []any{filter.ProjectID}
    argNum := 2

    // Add filters
    if len(filter.ColumnIDs) > 0 {
        query += fmt.Sprintf(" AND t.column_id = ANY($%d)", argNum)
        args = append(args, pq.Array(filter.ColumnIDs))
        argNum++
    }

    if len(filter.AssigneeIDs) > 0 {
        query += fmt.Sprintf(" AND t.assignee_id = ANY($%d)", argNum)
        args = append(args, pq.Array(filter.AssigneeIDs))
        argNum++
    }

    if len(filter.LabelIDs) > 0 {
        query += fmt.Sprintf(` AND EXISTS (
            SELECT 1 FROM task_labels WHERE task_id = t.id AND label_id = ANY($%d)
        )`, argNum)
        args = append(args, pq.Array(filter.LabelIDs))
        argNum++
    }

    if filter.DueDateFrom != nil {
        query += fmt.Sprintf(" AND t.due_date >= $%d", argNum)
        args = append(args, filter.DueDateFrom)
        argNum++
    }

    if filter.DueDateTo != nil {
        query += fmt.Sprintf(" AND t.due_date <= $%d", argNum)
        args = append(args, filter.DueDateTo)
        argNum++
    }

    if filter.IsOverdue != nil && *filter.IsOverdue {
        query += " AND t.due_date < NOW() AND t.status != 'completed'"
    }

    if filter.IsBlocked != nil {
        query += fmt.Sprintf(" AND t.is_blocked = $%d", argNum)
        args = append(args, *filter.IsBlocked)
        argNum++
    }

    // Group by
    query += " GROUP BY t.id, u.id"

    // Sorting
    sortColumn := "t.created_at"
    switch filter.Sort {
    case "due_date":
        sortColumn = "t.due_date"
    case "priority":
        sortColumn = "t.priority"
    case "title":
        sortColumn = "t.title"
    case "position":
        sortColumn = "t.position"
    }

    sortDir := "DESC"
    if filter.SortDir == "asc" {
        sortDir = "ASC"
    }
    query += fmt.Sprintf(" ORDER BY %s %s NULLS LAST", sortColumn, sortDir)

    // Pagination
    if filter.PageSize == 0 {
        filter.PageSize = 50
    }
    offset := filter.Page * filter.PageSize
    query += fmt.Sprintf(" LIMIT %d OFFSET %d", filter.PageSize, offset)

    rows, err := s.db.QueryContext(ctx, query, args...)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var tasks []Task
    for rows.Next() {
        var t Task
        rows.Scan(&t.ID, &t.Title, /* ... */)
        tasks = append(tasks, t)
    }

    // Get total count
    countQuery := strings.Replace(query, "SELECT t.*", "SELECT COUNT(*)", 1)
    countQuery = strings.Split(countQuery, "ORDER BY")[0]
    var total int
    s.db.QueryRowContext(ctx, countQuery, args...).Scan(&total)

    return &TaskSearchResult{
        Tasks:    tasks,
        Total:    total,
        Page:     filter.Page,
        PageSize: filter.PageSize,
    }, nil
}
```

**Follow-ups:**
- *Why is deep offset pagination slow?* Postgres scans and discards `OFFSET` rows. At page 1000 of size 50, that is 50k rows thrown away per request. Use keyset pagination (`WHERE (sort_key, id) > (?, ?)`) for deep scrolling.
- *When do you move search off Postgres?* When relevance ranking, typo tolerance, and multi-field weighting stop fitting `ts_rank`. OpenSearch (AGPL fork of Elasticsearch) or Meilisearch/Typesense for self-hosted, Algolia for hosted.
- *How do you keep the search index and the primary DB consistent?* Transactional outbox or Debezium CDC. Polling `updated_at` works for low volume. For real-time search, stream changes through Kafka/NATS into the index.

### Junior -> FAANG: How to Use These Questions in Preparation

FAANG behavioral and technical interviews for software engineering roles frequently combine both dimensions: "Tell me about a time you designed a system for [X]" and "How would you design [X]?" These three questions probe dependency management, conflict resolution, and search, all of which appear in system design rounds.

For each question, practice the two-minute version: state your approach, name the core data structure or algorithm, and describe one tradeoff. For the dependency question: DAG representation, DFS cycle check, transactional consistency. For the conflict resolution question: OT for free text, optimistic locking for structured records, CRDT for offline-first. For the search question: `tsvector` GIN index for Postgres, keyset pagination for deep scrolling.

The follow-up questions listed after each answer are the ones interviewers use to escalate difficulty. If you can answer the follow-ups, you are demonstrating above-bar depth. If you cannot, you are at bar. Prepare the follow-ups as thoroughly as the main questions.

### Senior @ FAANG: Bar-Raiser Calibration for These Questions

A bar-raiser uses these questions to distinguish L5 from L6 and L6 from L7.

**On dependency graphs:** An L5 answers with the DFS cycle check and mentions serializable transactions. An L6 answers that as well and describes the TOCTOU race in the DFS check, names the closure table as the production-scale solution, and articulates when cross-project dependencies should be rejected at the product level rather than solved technically. An L7 asks back: "What is the business justification for allowing cross-project dependencies, and does the added complexity compound into other areas of the system like permission enforcement and audit logging?" That question reframes a data-model problem as an organizational boundary problem, which is the L7 cognitive jump.

**On collaboration without conflicts:** An L5 describes optimistic locking. An L6 correctly distinguishes text-field collaboration (OT or CRDT) from record-level collaboration (optimistic locking), names Yjs as the 2025+ default for collaborative editors, and explains why rolling your own OT transform function is a correctness trap. An L7 goes further: "What is the user experience when a conflict is detected? Is the diff shown, or does the user re-type? What is the support cost of silent last-write-wins vs. explicit conflict resolution UI? What is the product-level decision about acceptable data loss?" The L7 treats correctness as a product requirement, not only an engineering requirement.

**On task filtering and search:** An L5 writes parameterized SQL with a `tsvector`. An L6 adds keyset pagination, faceted counts, and a CDC-based index sync strategy. An L7 frames the search capability as a platform feature: "Who else in the organization needs search over task data? What is the query pattern for analytics (aggregation over millions of rows) vs. user search (ranked results with typo tolerance)? Should these be the same system or should OLAP queries go to a separate columnar store (Redshift, BigQuery, ClickHouse) while user search goes to Typesense?" That question demonstrates that L7 engineers design for the system that will exist in three years, not only the one being built today.

---
