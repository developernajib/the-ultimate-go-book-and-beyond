## Common Mistakes

### Mistake 1: Not Optimizing Kanban Board Queries

Loading all tasks for a board with separate queries per column creates an N+1 problem that worsens as projects grow. The fix is to load the entire board in a single query with JOINs and PostgreSQL's `json_agg` to group tasks by column server-side.

```go
// ❌ Bad: N+1 query problem loading board
func (h *Handler) GetBoard(w http.ResponseWriter, r *http.Request) {
    projectID := chi.URLParam(r, "id")

    // Get columns
    columns, _ := h.repo.GetColumns(r.Context(), projectID)

    for i, col := range columns {
        // N+1: Query for each column
        tasks, _ := h.repo.GetTasksByColumn(r.Context(), col.ID)

        for j, task := range tasks {
            // N+N+1: Query for each task's assignee
            assignee, _ := h.repo.GetUser(r.Context(), task.AssigneeID)
            tasks[j].Assignee = assignee

            // N+N+N+1: Query for each task's labels
            labels, _ := h.repo.GetTaskLabels(r.Context(), task.ID)
            tasks[j].Labels = labels
        }

        columns[i].Tasks = tasks
    }

    json.NewEncoder(w).Encode(columns)
}

// ✅ Good: Single optimized query with JOIN
func (h *Handler) GetBoard(w http.ResponseWriter, r *http.Request) {
    projectID := chi.URLParam(r, "id")

    board, err := h.repo.GetBoardWithTasks(r.Context(), projectID)
    if err != nil {
        respondError(w, err)
        return
    }

    json.NewEncoder(w).Encode(board)
}

// Repository with optimized query
func (r *BoardRepository) GetBoardWithTasks(ctx context.Context, projectID string) (*Board, error) {
    // Single query with JOINs and JSON aggregation
    query := `
        SELECT
            c.id, c.name, c.position,
            COALESCE(
                json_agg(
                    json_build_object(
                        'id', t.id,
                        'title', t.title,
                        'description', t.description,
                        'position', t.position,
                        'assignee', json_build_object(
                            'id', u.id,
                            'name', u.name,
                            'avatar_url', u.avatar_url
                        ),
                        'labels', (
                            SELECT COALESCE(json_agg(
                                json_build_object('id', l.id, 'name', l.name, 'color', l.color)
                            ), '[]')
                            FROM task_labels tl
                            JOIN labels l ON tl.label_id = l.id
                            WHERE tl.task_id = t.id
                        )
                    ) ORDER BY t.position
                ) FILTER (WHERE t.id IS NOT NULL),
                '[]'
            ) as tasks
        FROM columns c
        LEFT JOIN tasks t ON t.column_id = c.id
        LEFT JOIN users u ON t.assignee_id = u.id
        WHERE c.project_id = $1
        GROUP BY c.id
        ORDER BY c.position
    `

    rows, err := r.db.QueryContext(ctx, query, projectID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var columns []Column
    for rows.Next() {
        var col Column
        var tasksJSON []byte
        rows.Scan(&col.ID, &col.Name, &col.Position, &tasksJSON)
        json.Unmarshal(tasksJSON, &col.Tasks)
        columns = append(columns, col)
    }

    return &Board{Columns: columns}, nil
}
```

### Mistake 2: Race Conditions in Real-Time Updates

Updating a task's column and position without checking whether another user moved it first leads to lost updates or duplicate positions. The fix is optimistic locking: the client sends its expected version number, and the server rejects the write if the version has changed. On conflict, the server returns the current state so the client can reconcile.

```go
// ❌ Bad: Race condition when moving tasks
func (h *Handler) MoveTask(w http.ResponseWriter, r *http.Request) {
    var req MoveTaskRequest
    json.NewDecoder(r.Body).Decode(&req)

    // Get task
    task, _ := h.repo.GetTask(r.Context(), req.TaskID)

    // Update column
    task.ColumnID = req.NewColumnID
    task.Position = req.NewPosition

    // Save - but another user might have moved it already!
    h.repo.UpdateTask(r.Context(), task)

    // Broadcast - clients will show inconsistent state
    h.hub.Broadcast(task.ProjectID, "task.moved", task)
}

// ✅ Good: Optimistic locking with version check
func (h *Handler) MoveTask(w http.ResponseWriter, r *http.Request) {
    var req MoveTaskRequest
    json.NewDecoder(r.Body).Decode(&req)

    // Try to move with version check
    task, err := h.service.MoveTask(r.Context(), MoveTaskParams{
        TaskID:          req.TaskID,
        NewColumnID:     req.NewColumnID,
        NewPosition:     req.NewPosition,
        ExpectedVersion: req.Version, // Client sends current version
    })

    if err != nil {
        if errors.Is(err, ErrVersionConflict) {
            // Return current state so client can reconcile
            current, _ := h.repo.GetTask(r.Context(), req.TaskID)
            w.WriteHeader(http.StatusConflict)
            json.NewEncoder(w).Encode(map[string]any{
                "error":   "version_conflict",
                "current": current,
            })
            return
        }
        respondError(w, err)
        return
    }

    // Broadcast with version
    h.hub.Broadcast(task.ProjectID, "task.moved", TaskMovedEvent{
        Task:    task,
        Version: task.Version,
        MovedBy: getUserID(r.Context()),
    })

    json.NewEncoder(w).Encode(task)
}

// Service with proper locking
func (s *TaskService) MoveTask(ctx context.Context, params MoveTaskParams) (*Task, error) {
    tx, err := s.db.BeginTx(ctx, nil)
    if err != nil {
        return nil, err
    }
    defer tx.Rollback()

    // Lock task row and check version
    var currentVersion int
    err = tx.QueryRowContext(ctx, `
        SELECT version FROM tasks WHERE id = $1 FOR UPDATE
    `, params.TaskID).Scan(&currentVersion)
    if err != nil {
        return nil, err
    }

    if currentVersion != params.ExpectedVersion {
        return nil, ErrVersionConflict
    }

    // Reorder other tasks
    _, err = tx.ExecContext(ctx, `
        UPDATE tasks
        SET position = position + 1
        WHERE column_id = $1 AND position >= $2
    `, params.NewColumnID, params.NewPosition)
    if err != nil {
        return nil, err
    }

    // Update task with new version
    newVersion := currentVersion + 1
    _, err = tx.ExecContext(ctx, `
        UPDATE tasks
        SET column_id = $1, position = $2, version = $3, updated_at = NOW()
        WHERE id = $4
    `, params.NewColumnID, params.NewPosition, newVersion, params.TaskID)
    if err != nil {
        return nil, err
    }

    if err := tx.Commit(); err != nil {
        return nil, err
    }

    return &Task{
        ID:       params.TaskID,
        ColumnID: params.NewColumnID,
        Position: params.NewPosition,
        Version:  newVersion,
    }, nil
}
```

### Mistake 3: WebSocket Reconnection Not Restoring State

When a WebSocket reconnects after a network drop, the client has missed events and its local state is stale. The fix is to track the last received event ID and request missed events from the server on reconnect, replaying them before re-subscribing to the live stream.

```go
// ❌ Bad: Losing updates during reconnection
// Client side (TypeScript)
/*
const ws = new WebSocket(url);
ws.onclose = () => {
    // Simply reconnect without restoring state
    setTimeout(() => connect(), 1000);
};
*/

// ✅ Good: Track last event and request missed updates
// Server: Support event ID for resumption
type WSHub struct {
    clients   map[*Client]bool
    events    *EventLog // Ring buffer of recent events
    mu        sync.RWMutex
}

type EventLog struct {
    events    []*Event
    size      int
    nextIndex int
}

func (h *WSHub) Broadcast(projectID, eventType string, data any) {
    event := &Event{
        ID:        generateEventID(),
        ProjectID: projectID,
        Type:      eventType,
        Data:      data,
        Timestamp: time.Now(),
    }

    // Store in event log
    h.events.Add(event)

    // Broadcast to clients
    h.mu.RLock()
    defer h.mu.RUnlock()

    for client := range h.clients {
        if client.ProjectID == projectID {
            client.Send <- event
        }
    }
}

// Resume from last event
func (h *WSHub) Resume(client *Client, lastEventID string) error {
    events := h.events.GetSince(lastEventID)

    for _, event := range events {
        if event.ProjectID == client.ProjectID {
            client.Send <- event
        }
    }

    return nil
}

// Client handler with resumption
func (h *WSHub) HandleConnection(w http.ResponseWriter, r *http.Request) {
    lastEventID := r.URL.Query().Get("last_event_id")

    conn, _ := upgrader.Upgrade(w, r, nil)
    client := &Client{
        Conn:      conn,
        ProjectID: r.URL.Query().Get("project_id"),
        Send:      make(chan *Event, 256),
    }

    h.register <- client

    // Send missed events
    if lastEventID != "" {
        h.Resume(client, lastEventID)
    }

    go client.writePump()
    client.readPump()
}
```

### Mistake 4: Not Debouncing Task Updates

Persisting every intermediate drag position or text keystroke generates excessive write requests. Debouncing writes (sending only the final state after the user pauses) reduces write volume while keeping the UI responsive to local changes. The batcher below queues updates per entity and flushes them in a single batch request after the debounce interval.

```go
// ❌ Bad: Saving on every keystroke
// Frontend sends update on each change
/*
onChange={(e) => {
    updateTask({ id: task.id, title: e.target.value });
}}
*/

// ✅ Good: Debounce updates with optimistic UI

// Server: Accept batch updates
func (h *Handler) BatchUpdateTasks(w http.ResponseWriter, r *http.Request) {
    var req BatchUpdateRequest
    json.NewDecoder(r.Body).Decode(&req)

    results := make([]UpdateResult, len(req.Updates))

    tx, _ := h.db.BeginTx(r.Context(), nil)
    defer tx.Rollback()

    for i, update := range req.Updates {
        err := h.updateTask(r.Context(), tx, update)
        results[i] = UpdateResult{
            TaskID:  update.TaskID,
            Success: err == nil,
            Error:   errorString(err),
        }
    }

    tx.Commit()

    json.NewEncoder(w).Encode(results)
}

// Client: Debounce and batch
type UpdateBatcher struct {
    pending   map[string]*TaskUpdate
    debounce  time.Duration
    batchSize int
    flush     chan struct{}
    mu        sync.Mutex
}

func (b *UpdateBatcher) QueueUpdate(update *TaskUpdate) {
    b.mu.Lock()
    b.pending[update.TaskID] = update
    b.mu.Unlock()

    // Debounce
    go func() {
        time.Sleep(b.debounce)
        b.TryFlush()
    }()
}

func (b *UpdateBatcher) TryFlush() {
    b.mu.Lock()
    if len(b.pending) == 0 {
        b.mu.Unlock()
        return
    }

    updates := make([]*TaskUpdate, 0, len(b.pending))
    for _, u := range b.pending {
        updates = append(updates, u)
    }
    b.pending = make(map[string]*TaskUpdate)
    b.mu.Unlock()

    // Send batch
    b.sendBatch(updates)
}
```

### Mistake 5: Not Handling Drag-and-Drop Edge Cases

Drag-and-drop involves edge cases that are easy to overlook: dropping onto the source column, concurrent drags from two users, and network failure mid-drag. The `DragDropService` below tracks active drag sessions server-side so that two users cannot drag the same task simultaneously. Sessions auto-expire after 30 seconds to prevent deadlocks from abandoned drags.

```go
// ❌ Bad: Not handling concurrent drag operations
func (h *Handler) DropTask(w http.ResponseWriter, r *http.Request) {
    var req DropTaskRequest
    json.NewDecoder(r.Body).Decode(&req)

    // Simply update positions without checking state
    h.repo.UpdateTaskPosition(r.Context(), req.TaskID, req.Position)
}

// ✅ Good: Handle drag state and validate drop
type DragDropService struct {
    activeDrags map[string]*DragSession // taskID -> session
    mu          sync.RWMutex
}

type DragSession struct {
    TaskID       string
    UserID       string
    SourceColumn string
    StartedAt    time.Time
    ExpiresAt    time.Time
}

func (s *DragDropService) StartDrag(ctx context.Context, taskID, userID string) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    // Check if task is already being dragged
    if session, exists := s.activeDrags[taskID]; exists {
        if session.UserID != userID && time.Now().Before(session.ExpiresAt) {
            return ErrTaskBeingDragged
        }
    }

    // Get current position
    task, _ := s.taskRepo.GetTask(ctx, taskID)

    s.activeDrags[taskID] = &DragSession{
        TaskID:       taskID,
        UserID:       userID,
        SourceColumn: task.ColumnID,
        StartedAt:    time.Now(),
        ExpiresAt:    time.Now().Add(30 * time.Second), // Auto-release
    }

    // Broadcast drag start
    s.hub.Broadcast(task.ProjectID, "task.drag_start", map[string]any{
        "task_id": taskID,
        "user_id": userID,
    })

    return nil
}

func (s *DragDropService) Drop(ctx context.Context, req DropRequest) error {
    s.mu.Lock()
    session, exists := s.activeDrags[req.TaskID]
    if !exists || session.UserID != req.UserID {
        s.mu.Unlock()
        return ErrInvalidDragSession
    }
    delete(s.activeDrags, req.TaskID)
    s.mu.Unlock()

    // Validate drop target
    if err := s.validateDrop(ctx, req); err != nil {
        // Broadcast drag cancel
        s.hub.Broadcast(req.ProjectID, "task.drag_cancel", map[string]any{
            "task_id": req.TaskID,
        })
        return err
    }

    // Execute drop
    task, err := s.executeMove(ctx, req)
    if err != nil {
        return err
    }

    // Broadcast successful move
    s.hub.Broadcast(req.ProjectID, "task.moved", task)

    return nil
}

func (s *DragDropService) CancelDrag(ctx context.Context, taskID, userID string) {
    s.mu.Lock()
    if session, exists := s.activeDrags[taskID]; exists && session.UserID == userID {
        delete(s.activeDrags, taskID)
    }
    s.mu.Unlock()

    task, _ := s.taskRepo.GetTask(ctx, taskID)
    s.hub.Broadcast(task.ProjectID, "task.drag_cancel", map[string]any{
        "task_id": taskID,
    })
}
```

### Junior -> FAANG: Using Common Mistakes as Interview Preparation

Each mistake in this file corresponds to a question interviewers ask to differentiate candidates who have shipped production systems from candidates who have only built tutorials. "What query optimization did you apply to the board load?" is a proxy for Mistake 1. "How did you handle concurrent edits?" is Mistake 2. "Did you encounter any WebSocket scaling issues?" is Mistake 3.

Before your interview, write down one concrete example from your own experience for each mistake. If you have not encountered these in production, build them deliberately: implement the N+1 version, measure the query count, implement the fix, and measure again. The numbers you remember from measurement are more credible than generic descriptions.

The debouncing mistake (Mistake 4) is frequently tested in frontend system design. Know the difference between debounce (emit after a quiet period) and throttle (emit at most once per interval). For drag-and-drop position updates, you want debounce: only send the final position after the drag ends, not on every pixel of movement.

### Senior @ FAANG: Systemic Root Causes Behind the Five Mistakes

These five mistakes are not random errors. They share a systemic root cause: the original design did not reason about concurrency, scale, or failure modes.

**Mistake 1 (N+1 queries)** originates from a design that treats the repository layer as a row-level accessor rather than a query boundary. The correct senior-level design principle: a single user-facing action should cross the database boundary at most once per aggregate. A board load is one action, one query (or a small fixed number with JOINs). If the repository design requires callers to loop and fetch, the repository API is wrong.

**Mistake 2 (concurrent edit collision)** originates from the absence of a concurrency model in the original design. Before writing the first service method, a senior engineer asks: "What is our concurrency model? Optimistic locking, pessimistic locking, or CRDT?" The answer is in the ADR, not discovered after users report lost data.

**Mistake 3 (update storm)** originates from designing the WebSocket protocol as a notification channel without modeling the fan-out cost. At design time, the question is: "If 200 users are watching this board and a bulk update touches 100 tasks, what is the total message volume?" 200 * 100 = 20,000 messages. That calculation should happen before code is written. The batching solution (emit one `entities_changed` message instead of 100 per-task messages) is a protocol design decision, not a code optimization.

**Mistake 4 (no debouncing)** originates from ignoring the integration contract between the frontend and backend. The backend has no rate limiting per-entity. The frontend has no write coalescing. Both sides assumed the other would handle it. The fix requires coordination: either the backend rate-limits at the API gateway and returns 429, or the frontend debounces. Debouncing in the frontend is correct because it preserves intent (the last value the user set), while backend rate limiting loses intermediate states.

**Mistake 5 (search kills database)** originates from not testing at representative data volumes. A `LIKE '%term%'` query on a 500-row development database returns in 2ms. The same query on a 500,000-row production database blocks the query planner for 30 seconds. The senior engineering practice is to define the expected data scale at design time, run the query plan against a production-sized dataset in staging (using `EXPLAIN ANALYZE`), and add the GIN index before the feature is shipped, not after the incident.

---
