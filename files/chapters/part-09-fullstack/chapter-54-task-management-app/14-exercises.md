## Exercises

1. **Add Labels Management**: Implement CRUD endpoints for project-level labels with a name and hex color. Add a many-to-many `task_labels` join table and update the task list query to include labels in the response. On the frontend, render colored label chips on each task card.

2. **Implement Task Search**: Add a PostgreSQL `tsvector` column to the tasks table with a GIN index. Create a `/api/v1/projects/{id}/tasks/search?q=` endpoint that uses `plainto_tsquery` and returns paginated results ranked by relevance. Wire it to a search input in the frontend header.

3. **Add Due Date Reminders**: Write a background goroutine that runs every hour, queries for tasks due within 24 hours that have not yet been notified, and broadcasts a reminder via WebSocket to the assigned user. Store a `reminder_sent_at` timestamp to avoid duplicate notifications.

4. **Implement Activity Log**: Create an `activity_events` table that records every task mutation (created, updated, moved, commented, deleted) with the acting user ID and a JSON diff of changed fields. Add a timeline view on the task detail modal that displays these events in reverse chronological order.

5. **Add File Attachments**: Integrate an S3-compatible object store (MinIO for local development). Add upload and download endpoints that stream files through the Go backend rather than exposing pre-signed URLs. Store file metadata (name, size, content type, S3 key) in an `attachments` table linked to the task.

6. **Implement User Mentions**: Parse `@username` patterns in comment content on the backend. Resolve each mention to a user ID, store the mention associations, and send a WebSocket notification to the mentioned user. On the frontend, render mentions as clickable links to the user's profile.

7. **Add Board Views**: Implement a list view that renders tasks as table rows sortable by any column (title, priority, due date, assignee), and a calendar view that places tasks on their due dates using a month grid. Share the same RTK Query cache across all three views so switching is instant.

8. **Add Export/Import**: Add a `/api/v1/projects/{id}/export` endpoint that streams project data as a JSON file using `json.NewEncoder` writing directly to the response body. For CSV export, use the `encoding/csv` package. Implement a corresponding import endpoint that validates the schema before inserting rows in a transaction.

### Junior -> FAANG: Exercises as Portfolio Work

These eight exercises are not academic. Each one maps to a real feature that ships in production task management tools. Building exercise 2 (full-text search) and exercise 4 (activity log) together gives you the two features FAANG system design interviewers most frequently use to probe data modeling depth: search index design and audit logging.

For each exercise you complete, write a brief technical note: what the data model change was, what the query looks like, and what you would do differently if the system needed to handle 10 times the data. That note is the basis for your interview answer about that feature.

Exercise 3 (due date reminders) is a concurrency exercise disguised as a feature. The background goroutine must be idempotent (the `reminder_sent_at` timestamp prevents duplicates), it must handle database errors without crashing the server, and it must exit cleanly when the server receives SIGTERM. Write a test that verifies the goroutine does not send a duplicate reminder if it runs twice for the same task.

### Senior @ FAANG: Prioritizing the Exercises for Platform Readiness

From a platform maturity perspective, these exercises are not equal in priority or complexity.

Exercise 4 (activity log) is the highest-value exercise for a production system. An audit trail of every task mutation is the foundation for compliance (SOC 2, HIPAA, GDPR audit logs), for user-visible history ("who changed this task's status?"), and for debugging production incidents ("what was the exact sequence of operations that led to this state?"). Implement it using the transactional outbox pattern: write the activity event in the same database transaction as the task mutation, so the audit log cannot diverge from the task state. A separate worker reads the outbox and writes to the activity log table, and optionally to an external audit service.

Exercise 5 (file attachments) is the highest-risk exercise from a security perspective. File upload endpoints are common attack vectors: path traversal, MIME type spoofing, malicious file content, and oversized uploads. Before implementing: enforce a maximum file size at the router level (`MaxBytesReader`), validate MIME type by reading the first 512 bytes and calling `http.DetectContentType` rather than trusting the `Content-Type` header, store files under a UUID key with no connection to the original filename, and never serve user-uploaded files from the same origin as the application (use a separate subdomain with `Content-Disposition: attachment`).

Exercise 7 (board views: list, calendar) is a frontend architecture exercise about shared state. All three views (Kanban, list, calendar) must read from the same RTK Query cache without duplicating data. This tests whether you understand RTK Query tag sharing: the `getTasks` query provides the `Task` tag, and all three views consume it. Switching views does not trigger a refetch unless the cache entry has expired or been invalidated. Implementing this correctly requires understanding `keepUnusedDataFor`, which controls how long RTK Query holds data in the cache after the last subscriber unmounts.

Exercise 8 (export/import) is a good test of streaming, transactions, and schema validation, but it is low leverage for FAANG interviews unless you are interviewing for a data platform role. Prioritize 4, 2, and 5 first.
