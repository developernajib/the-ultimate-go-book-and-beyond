## 37D.6 Multi-Document Transactions

### When Transactions Are (and Are Not) Available

Multi-document transactions landed in MongoDB 4.0 (replica sets) and 4.2 (sharded clusters). A few non-negotiable preconditions:

- **Replica set or sharded cluster required.** A standalone `mongod` does not expose a session oplog, so transactions cannot start. This is the single most common "transaction unavailable" error in development - run your local MongoDB as a single-node replica set (`mongod --replSet rs0` + `rs.initiate()`).
- **Default 60-second transaction lifetime** (`transactionLifetimeLimitSeconds`). Long transactions are aborted by the server to protect oplog reclamation. Design transactions to be *short and targeted*: read what you need, write what you must, commit. Do not hold a transaction open across network I/O, user input, or external API calls.
- **No DDL inside a transaction.** Creating collections, creating indexes, and modifying validators cannot run inside a transaction (except in recent releases and even then with caveats). Run schema setup outside transactions at application boot.
- **Distinct performance cost.** Transactions hold locks, write to the oplog twice (prepare + commit in sharded clusters), and require majority acknowledgment. Single-document atomic operations (`FindOneAndUpdate`, `$inc`) remain the preferred tool when they suffice.

### ACID Transactions with Retry Logic

Multi-document ACID transactions in MongoDB require a session and careful error handling to retry on transient failures such as write conflicts. The implementation below wraps business logic in a callback-style transaction that automatically retries on `TransientTransactionError` and commits with majority write concern.

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
	"go.mongodb.org/mongo-driver/v2/mongo/readconcern"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
	"go.mongodb.org/mongo-driver/v2/mongo/writeconcern"
)

// TransactionFunc is a function that runs within a transaction
type TransactionFunc func(ctx context.Context, session mongo.Session) error

// WithTransaction executes a function in a multi-document transaction with retry
func WithTransaction(ctx context.Context, client *mongo.Client, fn TransactionFunc) error {
	// Transaction options: majority read and write concern
	txnOpts := options.Transaction().
		SetReadConcern(readconcern.Snapshot()).
		SetWriteConcern(writeconcern.Majority()).
		SetReadPreference(readpref.Primary())

	// Session options
	sessOpts := options.Session().
		SetDefaultTransactionOptions(txnOpts)

	session, err := client.StartSession(sessOpts)
	if err != nil {
		return fmt.Errorf("start session: %w", err)
	}
	defer session.EndSession(ctx)

	// WithTransaction handles transient errors and commit retries automatically
	_, err = session.WithTransaction(ctx, func(sessCtx context.Context) (any, error) {
		return nil, fn(sessCtx, session)
	}, txnOpts)

	return err
}

// OrderService demonstrates transaction usage
type OrderService struct {
	client     *mongo.Client
	orders     *mongo.Collection
	inventory  *mongo.Collection
	accounts   *mongo.Collection
}

// PlaceOrder atomically: deduct inventory + create order + debit account
func (s *OrderService) PlaceOrder(ctx context.Context, req PlaceOrderRequest) (*Order, error) {
	var createdOrder *Order

	err := WithTransaction(ctx, s.client, func(ctx context.Context, _ mongo.Session) error {
		// Step 1: Check and decrement inventory
		for _, item := range req.Items {
			result := s.inventory.FindOneAndUpdate(ctx,
				bson.D{
					{Key: "_id", Value: item.ProductID},
					{Key: "quantity", Value: bson.D{{Key: "$gte", Value: item.Quantity}}}, // optimistic check
				},
				bson.D{{Key: "$inc", Value: bson.D{{Key: "quantity", Value: -item.Quantity}}}},
				options.FindOneAndUpdate().SetReturnDocument(options.After),
			)
			if result.Err() != nil {
				if errors.Is(result.Err(), mongo.ErrNoDocuments) {
					return fmt.Errorf("insufficient inventory for product %s", item.ProductID.Hex())
				}
				return fmt.Errorf("inventory update: %w", result.Err())
			}
		}

		// Step 2: Calculate total cents
		var totalCents int64
		for _, item := range req.Items {
			totalCents += item.PriceCents * int64(item.Quantity)
		}

		// Step 3: Debit account
		result := s.accounts.FindOneAndUpdate(ctx,
			bson.D{
				{Key: "_id", Value: req.AccountID},
				{Key: "balance_cents", Value: bson.D{{Key: "$gte", Value: totalCents}}},
			},
			bson.D{
				{Key: "$inc", Value: bson.D{{Key: "balance_cents", Value: -totalCents}}},
				{Key: "$push", Value: bson.D{
					{Key: "transactions", Value: bson.D{
						{Key: "amount_cents", Value: -totalCents},
						{Key: "type", Value: "debit"},
						{Key: "ts", Value: time.Now().UTC()},
					}},
				}},
			},
			options.FindOneAndUpdate().SetReturnDocument(options.After),
		)
		if result.Err() != nil {
			if errors.Is(result.Err(), mongo.ErrNoDocuments) {
				return errors.New("insufficient account balance")
			}
			return fmt.Errorf("account debit: %w", result.Err())
		}

		// Step 4: Create order
		order := &Order{
			BaseDocument: BaseDocument{ID: bson.NewObjectID()},
			UserID:       req.UserID,
			Items:        req.Items,
			TotalCents:   totalCents,
			Status:       "confirmed",
		}
		order.SetTimestamps(time.Now().UTC(), time.Now().UTC())

		_, err := s.orders.InsertOne(ctx, order)
		if err != nil {
			return fmt.Errorf("create order: %w", err)
		}

		createdOrder = order
		return nil
	})

	if err != nil {
		return nil, err
	}
	return createdOrder, nil
}

type PlaceOrderRequest struct {
	UserID    bson.ObjectID
	AccountID bson.ObjectID
	Items     []OrderItem
}
```

### Junior to FAANG: Prerequisite Gaps and First-Job Context

If you are new to MongoDB transactions, the first conceptual hurdle is that MongoDB is not Postgres. In a relational database you almost always wrap multi-statement work in `BEGIN` and `COMMIT`. In MongoDB the default unit of atomicity is the single document, and a huge fraction of use cases are already atomic because the document models a whole aggregate. Before reaching for `WithTransaction` ask yourself whether one `FindOneAndUpdate` with `$inc`, `$push`, or a filter expression could do the same job. It usually can.

A worked example makes this concrete. Suppose a junior engineer writes a transaction to increment a counter and append to an audit log stored in the same document. That transaction is wasted work. The equivalent single-document update below is atomic, cheaper, and cannot deadlock:

```go
_, err := col.UpdateOne(ctx,
    bson.D{{Key: "_id", Value: id}},
    bson.D{
        {Key: "$inc", Value: bson.D{{Key: "count", Value: 1}}},
        {Key: "$push", Value: bson.D{{Key: "audit", Value: entry}}},
    },
)
```

A first-job context for transactions looks different. You have two collections that cannot be merged because they have different lifecycles, such as `orders` and `inventory`, and you need a consistent decrement-plus-insert. That is the canonical use case for `session.WithTransaction`. Interviewers at the entry level often ask: "why does MongoDB need a replica set for transactions" and "what is the difference between `w:1` and `w:majority`". The short answers are that the oplog drives the snapshot read concern transactions depend on, and `w:majority` waits for acknowledgment from a majority of voting nodes before returning, which is what makes the write durable across failover. Know those two sentences cold and you will pass the MongoDB transactions screen at most FAANG-adjacent shops.

### Senior at FAANG: Staff and Principal Material

At staff level, the conversation shifts from "can I use a transaction" to "what is the blast radius of this transaction under partition, failover, and shard migration". A few things every senior engineer should internalize:

**Transaction size limits.** In MongoDB 4.0 a transaction had to fit in a single 16 MB oplog entry. Since 4.2 a large transaction splits across multiple oplog entries, so total transaction size is no longer hard-capped at 16 MB (each individual oplog entry is still bounded by the 16 MB BSON document limit). The binding constraint on modern clusters is the WiredTiger cache: a transaction too large to ever fit in cache aborts with `TransactionTooLargeForCache` (6.2+). A bulk import of tens of thousands of documents inside one transaction can hit this. The correct pattern is to batch, commit, batch, commit, and use idempotent operations keyed on a client-generated `_id` so retries are safe.

**Cross-shard transactions since 4.2 are distributed two-phase commit.** MongoDB coordinates prepare across shards, persists a coordinator document, then sends commit or abort. Each participating shard blocks its portion of the key range during prepare. A badly designed cross-shard transaction on a hot key can stall the balancer, starve other writers, and trigger `StaleShardVersion` retries that compound latency. The senior heuristic is to make the shard key the same as the transaction scope whenever possible so transactions are effectively single-shard, which the coordinator optimizes into a fast path.

**retryWrites and idempotency.** `retryWrites=true` is the default in modern drivers and applies only to retryable single-statement writes, not to transactions. Inside a transaction the driver relies on the server returning `TransientTransactionError` or `UnknownTransactionCommitResult`, and `WithTransaction` loops until either it commits or the context deadline fires. You must assume the commit can be retried after partial visibility. Every side effect outside the transaction, such as publishing to Kafka or calling a payment API, must be deferred until after commit and must itself be idempotent. The transactional outbox pattern (write the event to an `outbox` collection inside the transaction, have a change-stream consumer publish it) is the standard answer at review time.

**Write concern cost.** `w:majority` with `j:true` on a three-node replica set means every transaction pays two fsyncs on two nodes plus network round trips to the majority. On a five-node set with two geographic replicas, commit latency is bounded by the slowest of the three closest voting members. A staff engineer sizing a region layout should know `writeConcernMajorityJournalDefault`, the role of `electionTimeoutMillis`, and how `priority: 0` and `hidden: true` members interact with the write-concern math.

**When not to use a transaction.** Prefer single-document atomicity, optimistic concurrency with a `version` field and `$expr`, or the outbox pattern. Reserve transactions for cross-aggregate invariants such as transferring a balance between two accounts or reserving inventory while creating an order. At principal level you should be able to whiteboard a `reservations` collection that uses TTL-expired holds instead of a long transaction, and explain why it scales better under contention on popular SKUs during a flash sale.

---
