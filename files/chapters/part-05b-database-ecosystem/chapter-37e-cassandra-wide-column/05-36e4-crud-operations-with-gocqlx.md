## 37E.4 CRUD Operations with gocqlx

### Repository Implementation

`gocqlx` wraps the low-level `gocql` driver with struct scanning and named-bind support, making repository code concise without sacrificing prepared statement reuse. Each write specifies the consistency level explicitly (`QUORUM` for financial records, `ONE` for high-throughput analytics writes) rather than accepting the session default.

```go
package cassandra

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/gocql/gocql"
	"github.com/scylladb/gocqlx/v3"
	"github.com/scylladb/gocqlx/v3/qb"
	"github.com/scylladb/gocqlx/v3/table"
)

var ErrNotFound = errors.New("not found")

// User domain model
type User struct {
	UserID    gocql.UUID        `db:"user_id"`
	Email     string            `db:"email"`
	Name      string            `db:"name"`
	CreatedAt time.Time         `db:"created_at"`
	Metadata  map[string]string `db:"metadata"`
	Tags      []string          `db:"tags"`
}

// UserRepository handles user persistence
type UserRepository struct {
	session *gocqlx.Session
	table   *table.Table
}

var userTableMetadata = table.Metadata{
	Name:    "users",
	Columns: []string{"user_id", "email", "name", "created_at", "metadata", "tags"},
	PartKey: []string{"user_id"},
	SortKey: []string{},
}

func NewUserRepository(session *gocqlx.Session) *UserRepository {
	return &UserRepository{
		session: session,
		table:   table.New(userTableMetadata),
	}
}

// Insert creates a new user
func (r *UserRepository) Insert(ctx context.Context, user *User) error {
	if user.UserID == (gocql.UUID{}) {
		user.UserID = gocql.TimeUUID()
	}
	user.CreatedAt = time.Now().UTC()

	return r.session.ContextQuery(ctx, r.table.Insert(), user).ExecRelease()
}

// InsertWithTTL creates a user that expires
func (r *UserRepository) InsertWithTTL(ctx context.Context, user *User, ttl time.Duration) error {
	user.CreatedAt = time.Now().UTC()
	stmt, names := r.table.Insert()
	return r.session.ContextQuery(ctx, stmt+" USING TTL ?", append(names, "ttl")...).
		BindStruct(user).
		Bind(int(ttl.Seconds())).
		ExecRelease()
}

// GetByID retrieves a user by primary key
func (r *UserRepository) GetByID(ctx context.Context, userID gocql.UUID) (*User, error) {
	var user User
	err := r.session.ContextQuery(ctx, r.table.Get(), &user).
		BindMap(qb.M{"user_id": userID}).
		GetRelease(&user)

	if err == gocql.ErrNotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}
	return &user, nil
}

// Update updates specific columns (in Cassandra: upsert semantics)
func (r *UserRepository) Update(ctx context.Context, userID gocql.UUID, name string, metadata map[string]string) error {
	stmt, names := qb.Update("users").
		Set("name", "metadata").
		Where(qb.Eq("user_id")).
		ToCql()

	return r.session.ContextQuery(ctx, stmt, names...).
		BindMap(qb.M{
			"user_id":  userID,
			"name":     name,
			"metadata": metadata,
		}).
		ExecRelease()
}

// Delete removes a user
func (r *UserRepository) Delete(ctx context.Context, userID gocql.UUID) error {
	stmt, names := r.table.Delete()
	return r.session.ContextQuery(ctx, stmt, names...).
		BindMap(qb.M{"user_id": userID}).
		ExecRelease()
}
```

### Order Repository with Clustering Columns

The `orders_by_user` table uses a composite primary key: `user_id` as the partition key and `(created_at, order_id)` as clustering columns. This layout co-locates all orders for a user on the same node while sorting them by creation time, making "get recent orders for user X" a single-partition range scan. The repository also writes to a second denormalized table (`orders_by_id`) for direct order lookup, using a logged batch to keep both views consistent.

```go
package cassandra

import (
	"context"
	"fmt"
	"time"

	"github.com/gocql/gocql"
	"github.com/scylladb/gocqlx/v3"
	"github.com/scylladb/gocqlx/v3/qb"
	"github.com/scylladb/gocqlx/v3/table"
)

// OrderItem is a frozen UDT
type OrderItem struct {
	ProductID  gocql.UUID `db:"product_id"`
	Name       string     `db:"name"`
	PriceCents int64      `db:"price_cents"`
	Quantity   int        `db:"quantity"`
}

// OrderByUser maps to orders_by_user table
type OrderByUser struct {
	UserID     gocql.UUID  `db:"user_id"`
	CreatedAt  time.Time   `db:"created_at"`
	OrderID    gocql.UUID  `db:"order_id"`
	Status     string      `db:"status"`
	TotalCents int64       `db:"total_cents"`
	Items      []OrderItem `db:"items"`
}

var orderByUserTable = table.Metadata{
	Name:    "orders_by_user",
	Columns: []string{"user_id", "created_at", "order_id", "status", "total_cents", "items"},
	PartKey: []string{"user_id"},
	SortKey: []string{"created_at", "order_id"},
}

// OrderRepository handles order persistence
type OrderRepository struct {
	session *gocqlx.Session
	byUser  *table.Table
	byID    *table.Table
}

func NewOrderRepository(session *gocqlx.Session) *OrderRepository {
	byIDMeta := table.Metadata{
		Name:    "orders_by_id",
		Columns: []string{"order_id", "user_id", "created_at", "status", "total_cents", "items"},
		PartKey: []string{"order_id"},
		SortKey: []string{},
	}
	return &OrderRepository{
		session: session,
		byUser:  table.New(orderByUserTable),
		byID:    table.New(byIDMeta),
	}
}

// Create inserts into both tables atomically using a batch
func (r *OrderRepository) Create(ctx context.Context, order OrderByUser) error {
	order.OrderID = gocql.TimeUUID()
	order.CreatedAt = time.Now().UTC()

	// Logged batch: atomic across partitions via the batchlog
	// (coordinator writes the batch to a system.batches table on two replicas
	// before executing, so on coordinator failure the statements are replayed).
	// Atomic != isolated: concurrent readers may see partial results mid-batch.
	// Same-partition logged batches skip the batchlog and are atomic + isolated.
	batch := r.session.Session.NewBatch(gocql.LoggedBatch).WithContext(ctx)

	// Insert into orders_by_user
	stmt1, _ := r.byUser.Insert()
	batch.Query(stmt1,
		order.UserID, order.CreatedAt, order.OrderID,
		order.Status, order.TotalCents, order.Items,
	)

	// Insert into orders_by_id (denormalized)
	stmt2, _ := r.byID.Insert()
	batch.Query(stmt2,
		order.OrderID, order.UserID, order.CreatedAt,
		order.Status, order.TotalCents, order.Items,
	)

	return r.session.Session.ExecuteBatch(batch)
}

// GetByUser retrieves paginated orders for a user
func (r *OrderRepository) GetByUser(ctx context.Context, userID gocql.UUID, limit int, pageState []byte) ([]OrderByUser, []byte, error) {
	stmt, names := qb.Select("orders_by_user").
		Columns("user_id", "created_at", "order_id", "status", "total_cents").
		Where(qb.Eq("user_id")).
		Limit(uint(limit)).
		ToCql()

	q := r.session.ContextQuery(ctx, stmt, names...).
		BindMap(qb.M{"user_id": userID}).
		PageSize(limit).
		PageState(pageState)

	iter := q.Iter()
	var orders []OrderByUser
	var o OrderByUser
	for iter.StructScan(&o) {
		orders = append(orders, o)
	}

	nextPageState := iter.PageState()
	if err := iter.Close(); err != nil {
		return nil, nil, fmt.Errorf("get orders by user: %w", err)
	}
	return orders, nextPageState, nil
}

// GetByIDRange retrieves orders in a time range (uses clustering key)
func (r *OrderRepository) GetByIDRange(ctx context.Context, userID gocql.UUID, from, to time.Time) ([]OrderByUser, error) {
	stmt, names := qb.Select("orders_by_user").
		Columns(orderByUserTable.Columns...).
		Where(
			qb.Eq("user_id"),
			qb.GtOrEq("created_at"),
			qb.LtOrEq("created_at"),
		).
		OrderBy("created_at", qb.DESC).
		ToCql()

	var orders []OrderByUser
	err := r.session.ContextQuery(ctx, stmt, names...).
		BindMap(qb.M{
			"user_id":        userID,
			"created_at[0]":  from,
			"created_at[1]":  to,
		}).
		SelectRelease(&orders)

	return orders, err
}

// UpdateStatus uses conditional update (LWT) for idempotent state machine
func (r *OrderRepository) UpdateStatus(ctx context.Context, orderID gocql.UUID, expectedStatus, newStatus string) (bool, error) {
	// LWT: UPDATE ... IF status = expectedStatus
	stmt := `UPDATE orders_by_id SET status = ? WHERE order_id = ? IF status = ?`

	applied, err := r.session.Session.Query(stmt, newStatus, orderID, expectedStatus).
		WithContext(ctx).
		ScanCAS(nil) // nil = don't need the current row back

	return applied, err
}
```

### Junior → FAANG: Prerequisite Gaps and Worked Entry Points

A junior reading the repository above should understand three idioms that are non obvious coming from SQL. First, every write in Cassandra is an upsert. `INSERT` and `UPDATE` have nearly identical semantics. `INSERT` writes the row whether or not it existed, and `UPDATE` does the same but with different CQL syntax. The only way to get real insert semantics is `INSERT ... IF NOT EXISTS`, which is a lightweight transaction (LWT) and pays a Paxos round trip cost. Second, deletes create tombstones that live for gc_grace_seconds (ten days by default) and are only reclaimed by compaction, which is why delete heavy workloads degrade read performance over time. Third, pagination is driven by an opaque `pageState` byte slice that the driver produces. You do not use LIMIT OFFSET because there is no stable offset in a wide column store. You pass the pageState from the previous page back on the next query. The Go pattern is `iter.PageState()` after exhausting the first page, then `PageState(prev)` on the next query.

The worked entry point is to run the `OrderRepository.Create` method and observe it in `cqlsh`. After insert, `SELECT * FROM orders_by_user WHERE user_id = ?` returns the row sorted newest first, and `SELECT * FROM orders_by_id WHERE order_id = ?` returns the same data under a different key. Confirm that if you kill the coordinator between the two inserts in a non logged version, the first insert persists and the second does not, and then repeat with `LoggedBatch` to see the atomicity guarantee kick in via the batchlog.

Interview entry point. Describe what `ScanCAS` does. It executes an LWT and returns `(applied bool, err error)` where applied is true if the conditional succeeded. Under the hood it runs a four phase Paxos round (prepare, promise, propose, commit), costs four network hops, and serializes through a per partition Paxos state. Use it for state machine transitions where you cannot tolerate a double apply, like marking an order as paid. Do not use it on hot paths because the throughput ceiling is roughly one thousand operations per second per partition.

### Senior @ FAANG: Staff and Principal Framing

Staff level review of the code above would flag several decisions. The `Create` method uses a LOGGED batch across two partitions (`orders_by_user` keyed by user_id and `orders_by_id` keyed by order_id), which is the correct use of LOGGED batches because you need atomicity across partitions for the denormalization to stay consistent. The batchlog write roughly halves the write throughput versus two parallel unlogged statements, and that cost is justified here. What is not justified is using LOGGED batch across many partitions (say, a fan out to one thousand follower timelines), because the batchlog is written to two replicas in the coordinator's DC and becomes a coordinator hot spot. For large fan outs the correct pattern is application level parallel async writes with idempotency guaranteed by the row's natural key (the post_id is deterministic), accepting eventual consistency and relying on a reconciliation job for the long tail.

UNLOGGED batches deserve a separate call out. UNLOGGED wins only when every statement in the batch targets the same partition, in which case the coordinator packages them into a single internal message and you save round trips. UNLOGGED across partitions gives you no atomicity (no batchlog) and more coordinator CPU (coordinator has to fan out) than equivalent parallel `session.Query(...).Exec()` calls. The common anti pattern is to use UNLOGGED batches as a write bulking technique across unrelated partitions, which is strictly worse than parallel async writes. COUNTER batches are a third kind and cannot be mixed with non counter statements. Counters themselves have weaker semantics (no idempotency, eventual consistency only) and should be avoided for anything that resembles a financial counter. Use them for view counts and similar imprecise metrics only.

The LWT implementation via `ScanCAS` has correctness subtleties. LWT requires SERIAL or LOCAL_SERIAL consistency for the Paxos round, which you set via `SerialConsistency` on the session or per query. LOCAL_SERIAL keeps Paxos within the local DC and is the right default for multi region deployments. A pure SERIAL LWT crosses regions for every conditional write, which at cross region RTT makes the operation prohibitively slow. The second subtlety is that LWT has a read path cost even when the condition fails, because Paxos proposes a value and the commit phase runs regardless. And the third is that LWT does not compose. You cannot wrap two LWTs in a batch and get multi row atomicity. For state machines that span multiple partitions, the senior level pattern is to persist an event in an append only events table keyed by aggregate id, apply the state transition by replaying events on read, and use LWT only at the events table write to enforce the expected version.

Paging deserves deeper treatment. The `PageState()` byte slice is opaque and internally encodes the current token and clustering position. It is stable across client reconnects, which means you can return it to a client as a cursor and the next request can pick up exactly where the last one left off, even if it lands on a different gocql process. But it is not stable across schema changes, because the internal encoding depends on the partitioner and clustering column types. Any migration that reorders clustering columns invalidates in flight page states. The production pattern is to treat pageState as short lived (a single user session, typically minutes) and to fall back to an application level cursor (last seen created_at + order_id) for long lived pagination like bookmarked search results.

gocqlx specific notes. `BindStruct` uses reflection cached at prepare time, so the reflection cost is amortized. `ContextQuery` threads the context through and respects cancellation, but the query is only canceled at the CQL protocol level if the driver has not yet sent the request. Once the request is in flight, server side cancellation requires the server to notice the connection close, which happens on the next response. Always set a context deadline, but do not rely on it to cancel already dispatched queries. The `table.Table` abstraction is convenient but produces a fixed column list, which means if you add a column you must update the metadata or risk selecting stale schema. For evolving schemas, explicit `qb.Select` with named columns is less magic and easier to audit.

Observability at staff level means every repository method is wrapped in an OpenTelemetry span, every query that exceeds the p99 SLO emits a metric tagged by statement fingerprint (not full text), and every `gocql.RequestErrWriteTimeout` is surfaced with enough context to decide whether to retry. The distinction between `ErrWriteTimeout` (the coordinator timed out waiting for replicas, but the write may have succeeded on some) and `ErrUnavailable` (not enough replicas up to attempt the write, so it definitely did not commit) is the foundation of safe retry logic. Surface both in logs with distinct codes, retry `ErrUnavailable` freely, retry `ErrWriteTimeout` only if the write is idempotent. That one discipline prevents the most common Cassandra corruption incident in production Go services.

---
