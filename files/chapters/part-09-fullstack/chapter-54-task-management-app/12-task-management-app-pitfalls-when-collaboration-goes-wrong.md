## Task Management App Pitfalls: When Collaboration Goes Wrong

### Pitfall 1: The Lost Drag-Drop Reordering

**Incident Report**: Users rearranged Kanban cards, but their changes reverted after page refresh. The frontend updated optimistically but the backend position update used the wrong column's count. Race condition between two users reordering caused cards to disappear.

```go
// WRONG: Non-atomic position updates
func (s *TaskService) MoveTask(ctx context.Context, taskID string, columnID string, position int) error {
    // Get current max position in target column
    var maxPos int
    s.db.QueryRowContext(ctx, `
        SELECT COALESCE(MAX(position), 0) FROM tasks WHERE column_id = $1
    `, columnID).Scan(&maxPos)

    // Race condition: another user might insert here
    newPos := position
    if position > maxPos {
        newPos = maxPos + 1
    }

    // Update task - positions might conflict
    _, err := s.db.ExecContext(ctx, `
        UPDATE tasks SET column_id = $1, position = $2 WHERE id = $3
    `, columnID, newPos, taskID)

    return err
}

// CORRECT: Atomic position updates with gap strategy
func (s *TaskService) MoveTask(ctx context.Context, taskID, columnID string, position int) error {
    tx, _ := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
    defer tx.Rollback()

    // Lock the column's tasks
    var tasks []struct {
        ID       string
        Position int
    }

    rows, _ := tx.QueryContext(ctx, `
        SELECT id, position FROM tasks
        WHERE column_id = $1
        ORDER BY position FOR UPDATE
    `, columnID)
    defer rows.Close()

    for rows.Next() {
        var t struct {
            ID       string
            Position int
        }
        rows.Scan(&t.ID, &t.Position)
        tasks = append(tasks, t)
    }

    // Use fractional indexing / gap strategy
    var newPosition float64
    if position <= 0 {
        // Insert at beginning
        if len(tasks) > 0 {
            newPosition = float64(tasks[0].Position) / 2
        } else {
            newPosition = 1000
        }
    } else if position >= len(tasks) {
        // Insert at end
        if len(tasks) > 0 {
            newPosition = float64(tasks[len(tasks)-1].Position) + 1000
        } else {
            newPosition = 1000
        }
    } else {
        // Insert between two tasks
        prevPos := float64(tasks[position-1].Position)
        nextPos := float64(tasks[position].Position)
        newPosition = (prevPos + nextPos) / 2
    }

    // Update task with new column and position
    _, err := tx.ExecContext(ctx, `
        UPDATE tasks SET column_id = $1, position = $2, updated_at = NOW()
        WHERE id = $3
    `, columnID, newPosition, taskID)
    if err != nil {
        return err
    }

    // Rebalance if positions get too close (< 0.001 gap)
    if needsRebalance(tasks, newPosition) {
        rebalancePositions(ctx, tx, columnID)
    }

    return tx.Commit()
}

func needsRebalance(tasks []struct{ ID string; Position int }, newPos float64) bool {
    for _, t := range tasks {
        if math.Abs(float64(t.Position)-newPos) < 0.001 {
            return true
        }
    }
    return false
}

func rebalancePositions(ctx context.Context, tx *sql.Tx, columnID string) error {
    // Assign fresh positions with large gaps
    _, err := tx.ExecContext(ctx, `
        WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY position) * 1000 as new_pos
            FROM tasks WHERE column_id = $1
        )
        UPDATE tasks t SET position = r.new_pos
        FROM ranked r WHERE t.id = r.id
    `, columnID)
    return err
}
```

### Pitfall 2: The Concurrent Edit Collision

**Incident Report**: Two users edited the same task description. Both saw their changes saved. User A's changes were silently overwritten when User B saved 2 seconds later. No conflict warning, data just lost.

```go
// WRONG: Last-write-wins with no conflict detection
func (s *TaskService) UpdateTask(ctx context.Context, taskID string, update TaskUpdate) (*Task, error) {
    _, err := s.db.ExecContext(ctx, `
        UPDATE tasks SET
            title = COALESCE($1, title),
            description = COALESCE($2, description),
            updated_at = NOW()
        WHERE id = $3
    `, update.Title, update.Description, taskID)

    // User A's changes gone if User B updates after
    return s.GetTask(ctx, taskID)
}

// CORRECT: Optimistic locking with version check
type Task struct {
    ID          string    `json:"id"`
    Title       string    `json:"title"`
    Description string    `json:"description"`
    Version     int       `json:"version"`  // For optimistic locking
    UpdatedAt   time.Time `json:"updated_at"`
}

type TaskUpdate struct {
    Title       *string `json:"title"`
    Description *string `json:"description"`
    Version     int     `json:"version"`  // Required for updates
}

func (s *TaskService) UpdateTask(ctx context.Context, taskID string, update TaskUpdate) (*Task, error) {
    result, err := s.db.ExecContext(ctx, `
        UPDATE tasks SET
            title = COALESCE($1, title),
            description = COALESCE($2, description),
            version = version + 1,
            updated_at = NOW()
        WHERE id = $3 AND version = $4
    `, update.Title, update.Description, taskID, update.Version)
    if err != nil {
        return nil, err
    }

    rows, _ := result.RowsAffected()
    if rows == 0 {
        // Version mismatch - someone else updated
        current, _ := s.GetTask(ctx, taskID)
        return nil, &ConflictError{
            Message:        "Task was modified by another user",
            CurrentVersion: current.Version,
            YourVersion:    update.Version,
            CurrentData:    current,
        }
    }

    return s.GetTask(ctx, taskID)
}

// Handler returns conflict with current state
func updateTaskHandler(w http.ResponseWriter, r *http.Request) {
    var update TaskUpdate
    json.NewDecoder(r.Body).Decode(&update)

    task, err := taskService.UpdateTask(r.Context(), taskID, update)
    if conflictErr, ok := err.(*ConflictError); ok {
        respondJSON(w, http.StatusConflict, APIResponse{
            Success: false,
            Error: &APIError{
                Code:    "CONFLICT",
                Message: conflictErr.Message,
            },
            Data: map[string]any{
                "current_version": conflictErr.CurrentVersion,
                "your_version":    conflictErr.YourVersion,
                "current_data":    conflictErr.CurrentData,
            },
        })
        return
    }
    // ...
}
```

### Pitfall 3: The Real-Time Update Storm

**Incident Report**: With 50 users viewing a project, each task update triggered 50 WebSocket broadcasts. Each broadcast contained full task data. When someone bulk-updated 100 tasks, the server sent 5,000 messages in seconds. Clients lagged and some disconnected.

```go
// WRONG: Broadcast full data on every change
func (h *Hub) BroadcastTaskUpdate(task *Task) {
    data, _ := json.Marshal(task)
    msg := Message{
        Type: "task_updated",
        Data: data,
    }

    for client := range h.clients {
        client.send <- msg  // Full task to everyone
    }
}

// Called for each task in bulk update - 100 tasks = 100 broadcasts
func (s *TaskService) BulkUpdateTasks(ctx context.Context, taskIDs []string, update TaskUpdate) error {
    for _, id := range taskIDs {
        task, _ := s.UpdateTask(ctx, id, update)
        h.BroadcastTaskUpdate(task)  // 100 separate broadcasts!
    }
    return nil
}

// CORRECT: Debounced, batched, minimal broadcasts
type Hub struct {
    clients        map[*Client]bool
    pendingUpdates map[string]*Update  // Debounce per-entity
    flushTicker    *time.Ticker
    mu             sync.Mutex
}

type Update struct {
    EntityType string
    EntityID   string
    Fields     []string  // Only changed fields
    Timestamp  time.Time
}

func (h *Hub) QueueUpdate(entityType, entityID string, fields []string) {
    h.mu.Lock()
    defer h.mu.Unlock()

    key := entityType + ":" + entityID
    existing, ok := h.pendingUpdates[key]

    if ok {
        // Merge with existing pending update
        existing.Fields = mergeFields(existing.Fields, fields)
        existing.Timestamp = time.Now()
    } else {
        h.pendingUpdates[key] = &Update{
            EntityType: entityType,
            EntityID:   entityID,
            Fields:     fields,
            Timestamp:  time.Now(),
        }
    }
}

func (h *Hub) FlushUpdates() {
    h.mu.Lock()
    updates := h.pendingUpdates
    h.pendingUpdates = make(map[string]*Update)
    h.mu.Unlock()

    if len(updates) == 0 {
        return
    }

    // Group by entity type
    grouped := make(map[string][]string)
    for key := range updates {
        parts := strings.SplitN(key, ":", 2)
        entityType := parts[0]
        entityID := parts[1]
        grouped[entityType] = append(grouped[entityType], entityID)
    }

    // Send batched update notification
    msg := Message{
        Type: "entities_changed",
        Data: grouped,  // {"tasks": ["id1", "id2"], "comments": ["id3"]}
    }

    for client := range h.clients {
        select {
        case client.send <- msg:
        default:
            // Client not keeping up
        }
    }
}

// Run flush every 100ms
func (h *Hub) Run(ctx context.Context) {
    h.flushTicker = time.NewTicker(100 * time.Millisecond)

    for {
        select {
        case <-ctx.Done():
            return
        case <-h.flushTicker.C:
            h.FlushUpdates()
        // ... other cases
        }
    }
}

// Client fetches changed entities on demand
// Frontend: on "entities_changed", fetch only what's visible
```

### Pitfall 4: The Notification Spam Avalanche

**Incident Report**: User assigned 50 tasks to a teammate in one action. The teammate received 50 separate email notifications in 30 seconds. Their inbox was flooded and they missed an actual urgent message buried in the spam.

```go
// WRONG: One notification per action
func (s *TaskService) AssignTask(ctx context.Context, taskID, assigneeID string) error {
    // Update task
    s.db.ExecContext(ctx, `UPDATE tasks SET assignee_id = $1 WHERE id = $2`, assigneeID, taskID)

    // Send notification immediately
    task, _ := s.GetTask(ctx, taskID)
    s.notificationService.SendEmail(assigneeID, "Task Assigned", task.Title)

    return nil
}

// Bulk assign = 50 emails
func (s *TaskService) BulkAssign(ctx context.Context, taskIDs []string, assigneeID string) error {
    for _, id := range taskIDs {
        s.AssignTask(ctx, id, assigneeID)  // 50 emails!
    }
    return nil
}

// CORRECT: Digest notifications with batching
type NotificationService struct {
    pending map[string][]Notification  // userID -> pending notifications
    mu      sync.Mutex
}

func (s *NotificationService) Queue(userID, notifType string, data any) {
    s.mu.Lock()
    defer s.mu.Unlock()

    s.pending[userID] = append(s.pending[userID], Notification{
        Type:      notifType,
        Data:      data,
        CreatedAt: time.Now(),
    })
}

func (s *NotificationService) FlushDigests(ctx context.Context) {
    s.mu.Lock()
    pending := s.pending
    s.pending = make(map[string][]Notification)
    s.mu.Unlock()

    for userID, notifications := range pending {
        if len(notifications) == 0 {
            continue
        }

        // Group by type
        grouped := make(map[string][]Notification)
        for _, n := range notifications {
            grouped[n.Type] = append(grouped[n.Type], n)
        }

        // Send single digest email
        s.sendDigest(ctx, userID, grouped)
    }
}

func (s *NotificationService) sendDigest(ctx context.Context, userID string, grouped map[string][]Notification) {
    user, _ := s.userService.GetUser(ctx, userID)

    // Build digest email
    var sections []string

    if tasks, ok := grouped["task_assigned"]; ok {
        if len(tasks) == 1 {
            sections = append(sections, fmt.Sprintf("1 task was assigned to you"))
        } else {
            sections = append(sections, fmt.Sprintf("%d tasks were assigned to you", len(tasks)))
        }
    }

    if comments, ok := grouped["comment_added"]; ok {
        sections = append(sections, fmt.Sprintf("%d new comments on your tasks", len(comments)))
    }

    // Single email with summary
    s.emailClient.Send(user.Email, "Project Update Digest", strings.Join(sections, "\n"))
}

// Flush every 5 minutes or on user preference
func (s *NotificationService) Run(ctx context.Context) {
    ticker := time.NewTicker(5 * time.Minute)
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            s.FlushDigests(ctx)
        }
    }
}
```

### Pitfall 5: The Search That Killed the Database

**Incident Report**: User searched "report" across all projects. Query scanned 500,000 tasks with LIKE '%report%'. Database CPU hit 100% for 30 seconds. Other users experienced timeouts. This happened during a demo to investors.

```go
// WRONG: LIKE search on large tables
func (s *TaskService) Search(ctx context.Context, query string) ([]Task, error) {
    rows, err := s.db.QueryContext(ctx, `
        SELECT * FROM tasks
        WHERE title ILIKE $1 OR description ILIKE $1
    `, "%"+query+"%")  // Full table scan!

    // No pagination, returns unlimited results
    var tasks []Task
    for rows.Next() {
        var t Task
        rows.Scan(...)
        tasks = append(tasks, t)
    }
    return tasks, nil
}

// CORRECT: Full-text search with proper limits
func (s *TaskService) Search(ctx context.Context, query string, opts SearchOptions) (*SearchResult, error) {
    // Validate and sanitize input
    if len(query) < 2 {
        return nil, errors.New("query too short")
    }
    if len(query) > 100 {
        query = query[:100]
    }

    // Use PostgreSQL full-text search
    rows, err := s.db.QueryContext(ctx, `
        SELECT id, title, description,
               ts_rank(search_vector, plainto_tsquery('english', $1)) as rank
        FROM tasks
        WHERE search_vector @@ plainto_tsquery('english', $1)
          AND project_id = ANY($2)  -- Scope to user's projects
        ORDER BY rank DESC
        LIMIT $3 OFFSET $4
    `, query, opts.ProjectIDs, opts.Limit, opts.Offset)
    if err != nil {
        return nil, err
    }

    // ... process results

    // Get total count (cached or estimated)
    var total int
    s.db.QueryRowContext(ctx, `
        SELECT COUNT(*) FROM tasks
        WHERE search_vector @@ plainto_tsquery('english', $1)
          AND project_id = ANY($2)
    `, query, opts.ProjectIDs).Scan(&total)

    return &SearchResult{
        Tasks:      tasks,
        Total:      total,
        Page:       opts.Page,
        HasMore:    len(tasks) == opts.Limit,
    }, nil
}

// Add search vector column and index
// ALTER TABLE tasks ADD COLUMN search_vector tsvector - // CREATE INDEX idx_tasks_search ON tasks USING gin(search_vector) - // CREATE TRIGGER tasks_search_update BEFORE INSERT OR UPDATE ON tasks
//   FOR EACH ROW EXECUTE FUNCTION
//   tsvector_update_trigger(search_vector, 'pg_catalog.english', title, description);
```

### Quick Reference: Task Management Pitfall Prevention

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Lost drag-drop ordering | Positions reset/conflict | Fractional indexing, atomic updates |
| Concurrent edit collision | Silent data loss | Optimistic locking with version |
| Real-time update storm | Client lag/disconnect | Debounce, batch, minimal payloads |
| Notification spam | Inbox flooded | Digest emails, batched notifications |
| Search kills database | Timeouts during search | Full-text search, pagination, scoping |

### Junior -> FAANG: Incident Reports as Interview Preparation Material

Each pitfall is written as an incident report. Interviewers ask behavioral questions in the form "Tell me about a time something went wrong in production." If you have not yet worked on a system at scale, these incident reports are proxies: study them until you can describe the root cause, the impact, and the fix as if you were the engineer who debugged it.

Practice the "five whys" for each incident. For the drag-drop reordering incident: Why did positions reset? Because the optimistic update reverted. Why did it revert? Because the backend position count was wrong. Why was the count wrong? Because another user had inserted between the read and the write. Why was there no locking? Because the original implementation did not account for concurrent users. Why not? Because it was designed and tested with a single user in mind.

The "five whys" chain is what FAANG behavioral interviews are looking for. They want to know whether you understand root causes or only symptoms.

### Senior @ FAANG: Detecting These Patterns Before They Become Incidents

A senior engineer's job is to read a design and name the pitfalls before the system ships. Here is the pre-shipping checklist that these five incidents imply.

**For any drag-and-drop ordering feature:** Does the position update use a transaction with row-level locking? Does the ordering scheme tolerate concurrent inserts (integer positions do not, fractional keys do)? Is there a rebalance mechanism and a trigger for it? Is the frontend's optimistic update bounded by a version or a drag-session lock on the server?

**For any collaborative editing feature:** What is the concurrency model (optimistic locking, OT, CRDT)? What does the 409 Conflict response body contain, and does the frontend show it to the user or silently retry? What is the maximum time two users can diverge before one of their edits is rejected? Is that timeout documented in the product spec?

**For any WebSocket broadcast feature:** What is the maximum fan-out (users per project times events per minute)? Does the system shed slow consumers (the `default:` branch in the hub's broadcast)? Is the event payload sized to the minimum needed (delta, not full snapshot)? Is there a batch window that coalesces events before sending?

**For any notification feature:** Is there a deduplication window? Is there a digest mode? Does the recipient have user-level preferences for notification frequency? Is there a maximum notifications-per-hour rate limit per recipient? These are product and engineering questions that must be answered in the design doc, not discovered after an inbox-flood incident.

**For any search feature:** What is the expected index size? What is the p99 query latency at that size with the proposed query? Is the query plan verified with `EXPLAIN ANALYZE` against a production-sized dataset in staging before the feature ships? Is there a query timeout configured on the database connection to prevent one slow search from starving other queries?

Each of these checklists is the material of a staff-level design review. Writing them down and presenting them before implementation is the observable behavior that distinguishes L6 from L5.

---
