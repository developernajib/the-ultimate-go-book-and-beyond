## Exercises (Continued)

### Exercise 9: Build a Delta-Sync Endpoint for a Todo App

**Objective**: Implement a production-ready delta-sync endpoint that a mobile todo app can call to synchronize its local SQLite database with the server.

**Requirements**:
1. `POST /api/v1/todos/sync` accepts a `SyncRequest` body containing `last_sync_at` and an array of client-side `changes` (creates, updates, deletes).
2. Server applies client changes using last-write-wins conflict resolution: compare client `updated_at` against server `updated_at`. Retain the newer version.
3. Response includes all server-side todos modified after `last_sync_at`, deleted todo IDs (tombstones), and a `server_time` field the client must store.
4. Soft-delete todos by setting `deleted_at`. Physically purge rows older than 90 days.
5. Clock skew guard: reject `last_sync_at` values more than 5 minutes in the future.
6. Write a Go integration test that simulates: (a) client syncs fresh, (b) client goes offline and modifies todo A, (c) server modifies todo A differently, (d) client reconnects and syncs - verify server version wins and the conflict is reported.

**Schema**:
```sql
CREATE TABLE todos (
    id          UUID PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id),
    title       TEXT NOT NULL,
    done        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_todos_user_updated ON todos(user_id, updated_at);
CREATE INDEX idx_todos_user_deleted ON todos(user_id, deleted_at) WHERE deleted_at IS NOT NULL;
```

**Stretch goals**: add cursor-based pagination to the sync response for users with thousands of todos. Implement gzip compression on the sync response.

### Exercise 10: Implement a Push Notification Routing Service

**Objective**: Build a notification microservice that accepts a platform-agnostic message and routes it to FCM or APNs based on the registered device platform.

**Requirements**:
1. `POST /internal/notify` accepts `{"user_id": "...", "title": "...", "body": "...", "category": "social", "data": {...}}`.
2. Fetch all device tokens for `user_id` from a PostgreSQL `device_tokens` table.
3. Route iOS tokens to APNs (token-based JWT auth, not certificate), Android tokens to FCM.
4. Fan out concurrently using goroutines with a semaphore limiting concurrency to 50.
5. On APNs `Unregistered` or FCM `NotRegistered` response, delete the token from the database.
6. Respect a `notification_preferences` table: skip sending if the user has opted out of the given category (never suppress `security` category).
7. Log each send attempt to a `notification_log` table: `(id, user_id, device_token_prefix, platform, category, status, error_msg, sent_at)`.
8. Write unit tests mocking the APNs and FCM clients. Write an integration test against a real PostgreSQL instance using testcontainers-go.

**Stretch goals**: add a `/internal/notify/batch` endpoint that accepts up to 1000 user IDs and uses `BatchNotify` with a configurable chunk size. Expose a Prometheus counter `notifications_sent_total{platform,status}`.

### Junior → FAANG: How To Get Full Credit On These Exercises

The exercises look like feature work. They are. They are also rubrics against which a senior reviewer can grade your production readiness. Getting the basic endpoint working is a passing grade. Getting full credit requires that you ship the exercise the way a senior engineer would ship it on a real team. That means: a structured commit history with small reviewable PRs, a test matrix that covers happy path plus at least three failure modes per endpoint, observability hooks (at minimum, a log line per request with `user_id`, `device_id`, and a request ID), and a README section documenting the operational concerns you did not fully solve (where you accepted scope, what the next iteration would add).

Worked approach for Exercise 9. Start with the schema and a migration file (a real migration, not an inline `CREATE TABLE` in the test). Then write the repository layer with explicit interfaces, so the handler can be tested without a database. Then write the handler, driven by tests. Then write the integration test using testcontainers-go against real Postgres. Finally, add the clock-skew guard, the tombstone purge (as a separate job, not inline in the handler), and the response-time metric. The order matters: schema first means the data model is stable, tests before implementation means you catch the bugs at the interface, and operational concerns last means you do not prematurely optimize.

Worked approach for Exercise 10. The routing service is a mini push platform. Treat it as such. Separate the concerns: the HTTP handler validates the request and enqueues, the fan-out worker reads from the queue and dispatches, the provider clients are dependency-injected (APNs and FCM should have interfaces, not concrete types), and the observability is wired to Prometheus and a log aggregator. The tests should be three layers: unit tests with mocked provider clients (fast, run on every commit), integration tests with Postgres via testcontainers-go (slower, run on PR), and a smoke test with real provider sandboxes (manual, run before a release). Documenting this test strategy is part of the exercise.

Interview framing. If an interviewer asks about these exercises or similar take-home projects, the signal they want is your process, not just your output. Walk through how you decomposed the problem, where you paused to ask clarifying questions in your head, what you built first and why, what you left for a stretch goal and why, and what you would do in the second iteration. That narrative is the staff-track signal.

### Senior @ FAANG: These Exercises Extended To Production Scale

At staff level the exercises above are starter-kit scope. The senior-track extensions are where the interesting engineering lives. Two extensions per exercise that a staff engineer would expect to own end to end.

Exercise 9 at scale. First, the sync endpoint must handle cursors, not just `last_sync_at`. Replace the single timestamp with an opaque cursor token that the server can evolve without breaking clients. The cursor encodes a monotonic sequence number, a version byte, and an expiration. Clients store it as a blob. The server changes the encoding in a future version without notification. Second, the sync engine must handle the migration from LWW to CRDT for a record type that becomes collaborative. Design the dual-write period where both policies are applied, the reconciliation job that compares merge results, and the cutover criterion (divergence rate below a threshold for a sustained window). Each of these is a staff-level quarter of work.

Exercise 10 at scale. First, the routing service must handle provider redundancy. Add an FCM bridge path for iOS so that when APNs is degraded, iOS traffic can fail over to FCM's APNs bridge. The failover decision is driven by an error-rate circuit breaker at the provider level. Add the dashboard and alerting. Second, the routing service must handle push storms. Add a rate limiter at the send-worker layer that smooths the dispatch over a configurable window. Add a configurable drain rate for recovery from a queue backlog. Add a kill-switch that can halt dispatch to a specific client version if a bad release is causing crashes on push receipt. Each of these is a staff-level runbook item that the exercise does not yet cover.

A third extension that touches both exercises: the observability story. At staff level the observability is not metrics and logs. It is a coherent story from "user taps button on mobile" through "server accepts event" through "server dispatches push" through "device receives push" through "user sees notification," with a correlation ID that ties the entire journey together. Building that story end to end requires: a trace-id generated at the client, propagated through the BFF via `traceparent`, preserved through the queue, propagated to the provider call, returned in the provider response, stored with the send log, joined with the client-reported receipt event, and visualized in a single dashboard. That is the story. A mobile backend that can produce that trace in minutes for any notification in the system is operating at the senior bar. A mobile backend that cannot is still in the growth curve.

A fourth extension that is not on the exercise list but should be: a feature-flag system that syncs to offline clients. When a flag is flipped, the change must propagate to installed clients in a bounded time (commonly 24 hours for background sync, minutes for foreground sync) and must be honored even when the client is offline by using the last-synced flag state. The design includes: the flag registry, the propagation mechanism (silent push plus client-side polling fallback), the client-side storage (encrypted at rest, forward-compatible schema), the default-value contract (every flag has a hardcoded default that ships with the client, used when no sync has occurred or sync is stale), and the kill-switch path (a flag that disables a code path entirely, used for emergency rollback of a buggy client feature). Feature-flag infrastructure is a multi-quarter staff-level project and is one of the most valuable investments a mobile backend team can make.

Each of these extensions is a portfolio of decisions that a staff engineer navigates. The exercises as written are the entry point. The extensions are where the actual scope of a senior mobile backend role is measured.
