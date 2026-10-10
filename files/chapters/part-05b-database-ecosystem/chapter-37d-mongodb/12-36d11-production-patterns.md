## 37D.11 Production Patterns

### FindOneAndUpdate with Optimistic Locking

`FindOneAndUpdate` with a version field implements optimistic locking: the filter matches only when the document's version equals the client's expected version, and `$inc` atomically bumps it on success. If the version has advanced since the client last read the document, the update returns `ErrNoDocuments` rather than silently overwriting a concurrent write.

```go
package mongodb

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// VersionedDocument supports optimistic locking via version field
type VersionedDocument struct {
	BaseDocument `bson:",inline"`
	Version      int64 `bson:"version"`
}

// OptimisticUpdate performs update only if version matches
func OptimisticUpdate(ctx context.Context, coll *mongo.Collection, id bson.ObjectID, version int64, update bson.D) error {
	filter := bson.D{
		{Key: "_id", Value: id},
		{Key: "version", Value: version}, // optimistic lock check
	}

	fullUpdate := bson.D{
		{Key: "$set", Value: update},
		{Key: "$inc", Value: bson.D{{Key: "version", Value: 1}}},
		{Key: "$currentDate", Value: bson.D{{Key: "updated_at", Value: true}}},
	}

	result, err := coll.UpdateOne(ctx, filter, fullUpdate)
	if err != nil {
		return fmt.Errorf("optimistic update: %w", err)
	}
	if result.MatchedCount == 0 {
		return ErrConcurrentModification
	}
	return nil
}

var ErrConcurrentModification = errors.New("document modified by another process")

// FindOneAndModify pattern for atomic operations
func AtomicDequeue(ctx context.Context, coll *mongo.Collection, workerID string) (*Task, error) {
	filter := bson.D{
		{Key: "status", Value: "pending"},
		{Key: "scheduled_at", Value: bson.D{{Key: "$lte", Value: time.Now().UTC()}}},
	}
	update := bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "status", Value: "processing"},
			{Key: "worker_id", Value: workerID},
			{Key: "started_at", Value: time.Now().UTC()},
		}},
	}
	opts := options.FindOneAndUpdate().
		SetSort(bson.D{{Key: "priority", Value: -1}, {Key: "scheduled_at", Value: 1}}).
		SetReturnDocument(options.After)

	var task Task
	err := coll.FindOneAndUpdate(ctx, filter, update, opts).Decode(&task)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil // no tasks available
	}
	if err != nil {
		return nil, fmt.Errorf("dequeue: %w", err)
	}
	return &task, nil
}

type Task struct {
	BaseDocument `bson:",inline"`
	Type         string    `bson:"type"`
	Payload      bson.Raw  `bson:"payload"`
	Status       string    `bson:"status"`
	Priority     int       `bson:"priority"`
	ScheduledAt  time.Time `bson:"scheduled_at"`
	WorkerID     string    `bson:"worker_id,omitempty"`
	StartedAt    time.Time `bson:"started_at,omitempty"`
}

// Cursor streaming for large result sets
func StreamDocuments[T any](ctx context.Context, coll *mongo.Collection, filter bson.D, process func(T) error) error {
	opts := options.Find().
		SetBatchSize(1000).           // fetch 1000 docs per round-trip
		SetNoCursorTimeout(false)     // cursor expires after 10 minutes of inactivity

	cursor, err := coll.Find(ctx, filter, opts)
	if err != nil {
		return fmt.Errorf("find for stream: %w", err)
	}
	defer cursor.Close(ctx)

	for cursor.Next(ctx) {
		var doc T
		if err := cursor.Decode(&doc); err != nil {
			return fmt.Errorf("decode: %w", err)
		}
		if err := process(doc); err != nil {
			return err
		}
	}
	return cursor.Err()
}
```

### Junior to FAANG: Prerequisite Gaps and First-Job Context

Production patterns are where junior engineers are expected to stop copying code snippets and start reasoning about concurrency, failure, and security. The prerequisite is to internalise three realities. First, two requests can read the same document at the same time and both write back, and the last writer wins unless you prevent it. Second, a process can crash mid-operation and you must be able to resume without duplicating work. Third, a malicious user can craft input that your code will evaluate as a query filter if you do not validate it.

A first-job worked example for optimistic locking: a support-tool form lets agents edit a customer record. Two agents open the same record, agent A saves a note, then agent B saves a different note five seconds later. Without optimistic locking, agent B's write overwrites agent A's. With a `version` field and the filter `{_id, version}`, agent B's update matches zero documents, the server returns `ErrConcurrentModification`, and your UI tells agent B "the record changed, reload". Interviewers phrase this as "how do you prevent lost updates without a transaction". The answer is a version field plus a conditional update.

A second first-job pattern is the atomic dequeue. A queue collection has `{status: "pending"}` tasks. Many workers poll at the same time. Without `FindOneAndUpdate` with sort plus status flip, two workers pull the same task. With the atomic pattern in the code above, exactly one worker transitions the document from `pending` to `processing` and the others see `ErrNoDocuments`. Know this cold. It is the canonical MongoDB interview answer for "how do you build a job queue".

### Senior at FAANG: Staff and Principal Material

**RBAC at the database layer.** MongoDB supports built-in roles (`read`, `readWrite`, `dbAdmin`, `clusterAdmin`) and custom roles with `privileges` scoped to collections and actions. The principle of least privilege applies: the application user should have `readWrite` on the application database only, never on `admin` or `config`. Ops users for index creation and schema change should be separate principals with `dbAdmin`, used only during migrations. In Atlas, database-user roles integrate with workspace roles, and you can bind x509 certificates or AWS IAM principals to MongoDB users for certificateless auth from EKS and ECS.

**Field-Level Encryption: CSFLE and Queryable Encryption.** Client-Side Field-Level Encryption (CSFLE) encrypts sensitive fields with a Data Encryption Key (DEK) on the client before the document hits the wire. The server stores ciphertext and cannot read it. Equality queries work because the ciphertext is deterministic for a given DEK (this is the trade-off: deterministic encryption leaks equality). Queryable Encryption, generally available in 2024 and matured through 8.0 in 2026, uses structured encryption to support equality, range, and prefix queries over encrypted data with forward-privacy guarantees. The cost is larger ciphertext (roughly 3x) and per-query metadata overhead. The senior decision is which fields justify QE (PII, PHI, payment data) versus which can rely on at-rest encryption plus TLS.

**KMS integration.** CSFLE and QE both require a KMS provider for the Customer Master Key that wraps DEKs. Supported providers include AWS KMS, Azure Key Vault, GCP KMS, and local KMS for development. Rotate CMKs on a schedule, version DEKs, and record rotations in an ADR. Never embed a CMK in application configuration.

**Query shape safety.** Accepting user-supplied JSON and passing it as a filter is a MongoDB injection vulnerability. A user who submits `{"$ne": null}` as a password field bypasses authentication in naive code. Always construct filters field-by-field from typed inputs, or use a schema-validated DTO as the boundary. Atlas Query Analyzer flags queries whose shape includes operators originating from user input.

**Read-your-own-writes under secondary reads.** A client that writes with `w:majority` and immediately reads with `readPreference=secondary` may not see its own write because the secondary has not yet applied the oplog entry. The fix is to use `readConcern: "majority"` plus causal consistency via sessions. A session carries a `lsid` and the driver attaches `afterClusterTime` to subsequent reads, so the secondary waits until it has applied past that timestamp. Use causal sessions for user-facing flows where the same user writes then reads.

**Cursor timeouts and the ten-minute rule.** An idle cursor is reaped after ten minutes. `SetNoCursorTimeout(true)` disables this, but it also leaks server resources on client crashes. The senior pattern is: keep batches small enough that processing stays under ten minutes, or design the scan to be resumable by sort key (`{_id: 1}` or a timestamp) rather than relying on cursor persistence.

**Observability.** Emit structured logs with `operation`, `collection`, `duration_ms`, `n_matched`, `n_modified`, and `writeConcern` fields. Integrate the driver's Command Monitoring (`SetMonitor` on client options) to capture every command start, succeeded, and failed event with `requestId` for distributed tracing. Export pool metrics (`checkedOutConnections`, `availableConnections`, `pendingConnections`) and server-selection metrics. Alert on `WriteConflict` rate, not just error rate, because write conflicts signal hot documents under optimistic update contention.

**Migration and backfill discipline.** Never run a backfill in a single `UpdateMany`. Batch with `_id` ranges, log the last processed ID, and checkpoint. Design backfills to be idempotent and resumable after a crash. For schema migrations that add a required field, use the expand-migrate-contract pattern: deploy code that writes the new field, backfill existing documents, then deploy code that reads only the new field. Schema validators (`$jsonSchema`) should lag the code rollout so in-flight deploys do not reject writes.

---
