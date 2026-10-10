## 59.8 Idempotency

Idempotency ensures operations can be safely retried without unintended side effects. In distributed systems, a client that does not receive a response cannot distinguish between "the request was lost before reaching the server" and "the request succeeded but the response was lost on the way back." Without idempotency, retrying that request may execute the operation twice, charging a customer double or creating duplicate records. The Redis-backed implementation below uses a two-phase approach: first check for a cached result, then acquire a short-lived lock to prevent concurrent duplicate processing, execute the operation, and cache the result. The idempotency key is typically derived from the request's content hash or provided by the client.

```go
// idempotency/key.go
package idempotency

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "errors"
    "time"

    "github.com/redis/go-redis/v9"
)

var (
    ErrDuplicateRequest = errors.New("duplicate request")
    ErrRequestInProgress = errors.New("request in progress")
)

// IdempotencyKey generates unique keys for requests
type IdempotencyKey struct {
    client    *redis.Client
    prefix    string
    ttl       time.Duration
    lockTTL   time.Duration
}

// Result represents a cached operation result
type Result struct {
    StatusCode int             `json:"status_code"`
    Body       json.RawMessage `json:"body"`
    Headers    map[string]string `json:"headers"`
    Error      string          `json:"error,omitempty"`
}

// NewIdempotencyKey creates a new idempotency key manager
func NewIdempotencyKey(client *redis.Client, prefix string, ttl time.Duration) *IdempotencyKey {
    return &IdempotencyKey{
        client:  client,
        prefix:  prefix,
        ttl:     ttl,
        lockTTL: 30 * time.Second,
    }
}

// GenerateKey creates an idempotency key from request data
func GenerateKey(userID, method, path string, body []byte) string {
    h := sha256.New()
    h.Write([]byte(userID))
    h.Write([]byte(method))
    h.Write([]byte(path))
    h.Write(body)
    return hex.EncodeToString(h.Sum(nil))
}

// Execute runs an operation with idempotency
func (ik *IdempotencyKey) Execute(ctx context.Context, key string, fn func() (*Result, error)) (*Result, error) {
    resultKey := ik.prefix + ":result:" + key
    lockKey := ik.prefix + ":lock:" + key

    // Check for existing result
    cached, err := ik.client.Get(ctx, resultKey).Bytes()
    if err == nil {
        var result Result
        if err := json.Unmarshal(cached, &result); err == nil {
            return &result, nil
        }
    }

    // Try to acquire lock
    acquired, err := ik.client.SetNX(ctx, lockKey, "1", ik.lockTTL).Result()
    if err != nil {
        return nil, err
    }

    if !acquired {
        return nil, ErrRequestInProgress
    }

    // Ensure lock is released
    defer ik.client.Del(ctx, lockKey)

    // Double-check for result (might have been set while acquiring lock)
    cached, err = ik.client.Get(ctx, resultKey).Bytes()
    if err == nil {
        var result Result
        if err := json.Unmarshal(cached, &result); err == nil {
            return &result, nil
        }
    }

    // Execute the operation
    result, execErr := fn()
    if result == nil {
        result = &Result{}
    }
    if execErr != nil {
        result.Error = execErr.Error()
    }

    // Cache the result
    resultBytes, err := json.Marshal(result)
    if err == nil {
        ik.client.Set(ctx, resultKey, resultBytes, ik.ttl)
    }

    return result, execErr
}

// Check checks if a request has already been processed
func (ik *IdempotencyKey) Check(ctx context.Context, key string) (*Result, bool, error) {
    resultKey := ik.prefix + ":result:" + key

    cached, err := ik.client.Get(ctx, resultKey).Bytes()
    if err == redis.Nil {
        return nil, false, nil
    }
    if err != nil {
        return nil, false, err
    }

    var result Result
    if err := json.Unmarshal(cached, &result); err != nil {
        return nil, false, err
    }

    return &result, true, nil
}

// Invalidate removes a cached result
func (ik *IdempotencyKey) Invalidate(ctx context.Context, key string) error {
    resultKey := ik.prefix + ":result:" + key
    return ik.client.Del(ctx, resultKey).Err()
}
```

### Database Idempotency Pattern

Redis-backed idempotency is fast but volatile, a cache eviction or restart can cause a previously completed operation to execute a second time. For financial transactions or any mutation that must never be duplicated, the database itself becomes the authority. This implementation inserts a `pending` row inside a `SERIALIZABLE` transaction before executing the operation, so two concurrent requests with the same key race on a unique constraint rather than both proceeding. The status field distinguishes between in-flight, succeeded, and failed states, allowing callers to distinguish a duplicate of a successful request from a duplicate of a failed one.

```go
// idempotency/database.go
package idempotency

import (
    "context"
    "crypto/rand"
    "database/sql"
    "encoding/hex"
    "encoding/json"
    "errors"
    "time"
)

// DBIdempotency provides database-backed idempotency
type DBIdempotency struct {
    db  *sql.DB
    ttl time.Duration
}

// IdempotentRequest represents a stored request
type IdempotentRequest struct {
    ID           string
    Key          string
    Status       string // "pending", "completed", "failed"
    Result       json.RawMessage
    ErrorMessage string
    CreatedAt    time.Time
    CompletedAt  sql.NullTime
}

// NewDBIdempotency creates a database idempotency handler
func NewDBIdempotency(db *sql.DB, ttl time.Duration) *DBIdempotency {
    return &DBIdempotency{db: db, ttl: ttl}
}

// CreateTable creates the idempotency table
func (d *DBIdempotency) CreateTable(ctx context.Context) error {
    // The UNIQUE constraint on key already creates its index. Postgres
    // does not support MySQL-style inline INDEX clauses, so the
    // created_at index is a separate statement.
    query := `
        CREATE TABLE IF NOT EXISTS idempotent_requests (
            id VARCHAR(64) PRIMARY KEY,
            key VARCHAR(255) UNIQUE NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            result JSONB,
            error_message TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            completed_at TIMESTAMP WITH TIME ZONE
        );
        CREATE INDEX IF NOT EXISTS idx_idempotent_created
            ON idempotent_requests (created_at);
    `
    _, err := d.db.ExecContext(ctx, query)
    return err
}

// Execute runs an operation with database-backed idempotency
func (d *DBIdempotency) Execute(ctx context.Context, key string, fn func() (any, error)) (any, error) {
    // Try to insert a pending record
    tx, err := d.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
    if err != nil {
        return nil, err
    }
    defer tx.Rollback()

    // Check for existing request
    var existing IdempotentRequest
    err = tx.QueryRowContext(ctx, `
        SELECT id, key, status, result, error_message, created_at, completed_at
        FROM idempotent_requests
        WHERE key = $1 AND created_at > $2
        FOR UPDATE
    `, key, time.Now().Add(-d.ttl)).Scan(
        &existing.ID, &existing.Key, &existing.Status,
        &existing.Result, &existing.ErrorMessage,
        &existing.CreatedAt, &existing.CompletedAt,
    )

    if err == nil {
        // Found existing request
        switch existing.Status {
        case "completed":
            var result any
            if err := json.Unmarshal(existing.Result, &result); err != nil {
                return nil, err
            }
            return result, nil

        case "failed":
            return nil, errors.New(existing.ErrorMessage)

        case "pending":
            return nil, ErrRequestInProgress
        }
    } else if err != sql.ErrNoRows {
        return nil, err
    }

    // Insert new pending request
    requestID := generateUUID()
    _, err = tx.ExecContext(ctx, `
        INSERT INTO idempotent_requests (id, key, status)
        VALUES ($1, $2, 'pending')
    `, requestID, key)
    if err != nil {
        return nil, err
    }

    if err := tx.Commit(); err != nil {
        return nil, err
    }

    // Execute the operation
    result, execErr := fn()

    // Update the record
    if execErr != nil {
        d.db.ExecContext(ctx, `
            UPDATE idempotent_requests
            SET status = 'failed', error_message = $1, completed_at = NOW()
            WHERE id = $2
        `, execErr.Error(), requestID)
        return nil, execErr
    }

    resultBytes, _ := json.Marshal(result)
    d.db.ExecContext(ctx, `
        UPDATE idempotent_requests
        SET status = 'completed', result = $1, completed_at = NOW()
        WHERE id = $2
    `, resultBytes, requestID)

    return result, nil
}

// Cleanup removes expired idempotency records
func (d *DBIdempotency) Cleanup(ctx context.Context) error {
    _, err := d.db.ExecContext(ctx, `
        DELETE FROM idempotent_requests
        WHERE created_at < $1
    `, time.Now().Add(-d.ttl))
    return err
}

func generateUUID() string {
    // Idempotency IDs must be unpredictable, a clock-derived ID lets
    // an attacker enumerate or collide request records.
    b := make([]byte, 16)
    if _, err := rand.Read(b); err != nil {
        panic(err) // crypto/rand failure is unrecoverable
    }
    return hex.EncodeToString(b)
}
```

### Junior -> FAANG: Why Idempotency Keys Exist and How to Generate Them

The fundamental problem idempotency keys solve: a client sends a request, the server processes it successfully, and then the response is lost in transit. The client cannot distinguish "the request succeeded" from "the request was lost before reaching the server." Without idempotency, the safe choice is to not retry, but that means transient network errors cause permanent failures. With idempotency, the client can retry as many times as needed without fear of duplicate execution.

The key insight is that idempotency is a contract between client and server. The client generates a unique key for each logical operation and sends it with the request. The server caches the result under that key for a configurable window. Subsequent requests with the same key return the cached result rather than executing again. The client's job is to use the same key on all retries of the same logical operation, and to use a different key for genuinely new operations.

Key generation for interviews: idempotency keys should be globally unique, deterministic within a logical operation, and unpredictable to prevent enumeration. The hash-based approach (`sha256(userID + method + path + body)`) is deterministic but collision-resistant. A UUID per operation is non-deterministic (you must store it and re-use it across retries) but simpler to explain. Most payment APIs (Stripe, Braintree) use client-provided UUIDs and rely on clients to manage them.

First-job mistake to avoid: using request timestamps as idempotency keys. Two requests within the same millisecond from the same client will have the same timestamp but may be genuinely different operations. Use UUIDs or content hashes.

### Senior @ FAANG: Idempotency at Scale and the Outbox Pattern Alternative

Redis-backed idempotency is fast and operationally simple, but it has a correctness gap: Redis is volatile. If the Redis cluster loses data (after a failover with async replication, or after a crash before an AOF flush), a completed operation's result is gone. The next retry will re-execute the operation. For a cache-population operation, this is acceptable. For a financial transaction, it is not.

Database-backed idempotency (the second implementation) closes this gap by making the idempotency record durable and strongly consistent with the operation itself. The critical design decision is whether the idempotency record and the operation result are stored in the same transaction. If they are (as in the implementation above, using a `SERIALIZABLE` transaction), then either both are durable or neither is: there is no window where the operation completed but the idempotency record was not written. This is the correct design for any operation where duplicate execution causes financial or data integrity harm.

The outbox pattern is an alternative for event-driven systems. Instead of returning a result and caching it, the service writes both the operation result and an "outbox" event to the same database transaction. A background worker reads the outbox and publishes the event exactly once. The idempotency is guaranteed by the database transaction, not by a separate idempotency store. This is the preferred pattern for services that need both durability and event-driven integration (order services, payment services).

TTL governance is a subtle operational concern. Idempotency records must expire eventually to prevent unbounded storage growth. But if the TTL is too short, a client that retries 25 hours after the original request will get a new execution instead of the cached result. Stripe uses 24 hours as their standard idempotency window. Adjust based on your clients' typical retry windows and your storage cost tolerance.

Staff-level concern: idempotency keys work within a single service. Distributed sagas span multiple services, and each step must be idempotent independently. If a saga step fails after executing but before acknowledging, the orchestrator retries the step. The step must detect the duplicate and return the original result without executing again. This requires each saga step to implement its own idempotency, using the saga's correlation ID plus the step number as the idempotency key.

---
