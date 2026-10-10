## 37E.10 Complete Event-Driven Order System

### Full Production Example

This order system maintains one denormalized table per query pattern (`orders_by_id`, `orders_by_user`, and `orders_by_status_date`), writing to all three in a logged batch so all views stay consistent under partial failures. The event log table captures every state transition with a time-series clustering key, giving a complete audit trail without relying on Cassandra's limited update semantics.

```go
package orders

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/gocql/gocql"
	"github.com/scylladb/gocqlx/v3"
)

// OrderStatus state machine
type OrderStatus string

const (
	StatusPending    OrderStatus = "pending"
	StatusProcessing OrderStatus = "processing"
	StatusShipped    OrderStatus = "shipped"
	StatusDelivered  OrderStatus = "delivered"
	StatusCanceled  OrderStatus = "canceled"
)

var validTransitions = map[OrderStatus][]OrderStatus{
	StatusPending:    {StatusProcessing, StatusCanceled},
	StatusProcessing: {StatusShipped, StatusCanceled},
	StatusShipped:    {StatusDelivered, StatusCanceled},
	StatusDelivered:  {},
	StatusCanceled:  {},
}

// OrderService manages order lifecycle
type OrderService struct {
	session *gocqlx.Session
	log     *slog.Logger
}

func NewOrderService(session *gocqlx.Session, log *slog.Logger) *OrderService {
	return &OrderService{session: session, log: log}
}

// PlaceOrder creates a new order with idempotency
func (s *OrderService) PlaceOrder(ctx context.Context, req PlaceOrderRequest) (*OrderByUser, error) {
	// Validate
	if len(req.Items) == 0 {
		return nil, fmt.Errorf("order must have at least one item")
	}

	var totalCents int64
	for _, item := range req.Items {
		if item.Quantity <= 0 {
			return nil, fmt.Errorf("item %s: invalid quantity", item.ProductID)
		}
		totalCents += item.PriceCents * int64(item.Quantity)
	}

	order := OrderByUser{
		UserID:     req.UserID,
		OrderID:    gocql.TimeUUID(), // time-ordered UUID
		CreatedAt:  time.Now().UTC(),
		Status:     string(StatusPending),
		TotalCents: totalCents,
		Items:      req.Items,
	}

	// Write to all required tables atomically
	batch := s.session.Session.NewBatch(gocql.LoggedBatch).WithContext(ctx)

	batch.Query(
		`INSERT INTO orders_by_user (user_id, created_at, order_id, status, total_cents, items) VALUES (?, ?, ?, ?, ?, ?)`,
		order.UserID, order.CreatedAt, order.OrderID, order.Status, order.TotalCents, order.Items,
	)
	batch.Query(
		`INSERT INTO orders_by_id (order_id, user_id, created_at, status, total_cents, items) VALUES (?, ?, ?, ?, ?, ?)`,
		order.OrderID, order.UserID, order.CreatedAt, order.Status, order.TotalCents, order.Items,
	)
	batch.Query(
		`INSERT INTO orders_by_status_date (status, date_bucket, created_at, order_id, user_id, total_cents) VALUES (?, ?, ?, ?, ?, ?)`,
		order.Status, toDateBucket(order.CreatedAt), order.CreatedAt, order.OrderID, order.UserID, order.TotalCents,
	)

	if err := s.session.Session.ExecuteBatch(batch); err != nil {
		return nil, fmt.Errorf("place order batch: %w", err)
	}

	s.log.Info("order placed",
		"order_id", order.OrderID,
		"user_id", order.UserID,
		"total_cents", order.TotalCents,
	)

	return &order, nil
}

// TransitionStatus atomically transitions order status using LWT
func (s *OrderService) TransitionStatus(ctx context.Context, orderID gocql.UUID, from, to OrderStatus) error {
	// Validate transition
	valid := false
	for _, allowed := range validTransitions[from] {
		if allowed == to {
			valid = true
			break
		}
	}
	if !valid {
		return fmt.Errorf("invalid transition: %s → %s", from, to)
	}

	// LWT conditional update
	applied, err := s.session.Session.Query(
		`UPDATE orders_by_id SET status = ? WHERE order_id = ? IF status = ?`,
		string(to), orderID, string(from),
	).WithContext(ctx).ScanCAS(nil)

	if err != nil {
		return fmt.Errorf("status transition: %w", err)
	}
	if !applied {
		return fmt.Errorf("transition failed: order not in expected state %s", from)
	}

	s.log.Info("order status transitioned",
		"order_id", orderID,
		"from", from,
		"to", to,
	)
	return nil
}

// GetOrdersForProcessing retrieves pending orders for a day using partition query
func (s *OrderService) GetOrdersForProcessing(ctx context.Context, day string, limit int) ([]OrderByUser, error) {
	var orders []OrderByUser

	iter := s.session.Session.Query(
		`SELECT order_id, user_id, created_at, total_cents, items FROM orders_by_status_date
         WHERE status = ? AND date_bucket = ?
         ORDER BY created_at ASC LIMIT ?`,
		string(StatusPending), day, limit,
	).WithContext(ctx).Iter()

	var o OrderByUser
	for iter.Scan(&o.OrderID, &o.UserID, &o.CreatedAt, &o.TotalCents, &o.Items) {
		o.Status = string(StatusPending)
		orders = append(orders, o)
	}

	return orders, iter.Close()
}

// OrderItem represents a line item in an order
type OrderItem struct {
	ProductID   string `cql:"product_id"`
	ProductName string `cql:"product_name"`
	Quantity    int    `cql:"quantity"`
	PriceCents  int64  `cql:"price_cents"`
}

// OrderByUser represents order state denormalized for user queries
type OrderByUser struct {
	UserID     gocql.UUID  `db:"user_id"`
	CreatedAt  time.Time   `db:"created_at"`
	OrderID    gocql.UUID  `db:"order_id"`
	Status     string      `db:"status"`
	TotalCents int64       `db:"total_cents"`
	Items      []OrderItem `db:"items"`
}

func toDateBucket(t time.Time) string {
	return t.UTC().Format("2006-01-02")
}

type PlaceOrderRequest struct {
	UserID gocql.UUID
	Items  []OrderItem
}
```

### Junior to FAANG: query-first modeling with denormalized tables

The single biggest adjustment coming from relational systems is that Cassandra models data by query, not by entity. There is no join, so every access pattern gets its own table. The code above keeps three tables for the same order: `orders_by_id` for point lookups, `orders_by_user` for a user's history, and `orders_by_status_date` for the pending-orders worker. You pay write amplification (3x in this case) so reads can be single-partition and fast. A worked first-job example: a product manager asks for a new screen listing orders by region. Your instinct from SQL is to add an index on `region`. The correct Cassandra instinct is to add a new table `orders_by_region_date` keyed by `((region, date_bucket), created_at, order_id)` and to include the write to that table in the existing LOGGED batch. The interview entry point is the trade-off summary: extra writes and extra storage in exchange for single-partition reads on every access pattern, plus a LOGGED batch to keep the views consistent.

### Senior at FAANG: outbox via CDC, writes-first design, and idempotency

The production-grade version of this order system does not try to be transactional across Cassandra and downstream services. It embraces writes-first design. Every state change is a write to Cassandra plus an event row in an outbox, and a CDC consumer translates the outbox into Kafka events for the rest of the company. The mechanical pattern in Cassandra 5.0 is to add an `order_events` table keyed by `(order_id, event_time)` (or `((order_id, day), event_time)` if you expect many events per order) and to include an insert into that table in the same LOGGED batch as the denormalized writes. Because the batch is atomic, the event row is durable whenever the order mutation is durable. A CDC consumer then tails the commit log via `cdc_raw` (or the Debezium Cassandra connector in a sidecar) and publishes a domain event to Kafka. Downstream services consume Kafka rather than Cassandra, which isolates Cassandra from read pressure and gives you replay semantics for free. Scylla 6.0 exposes CDC as a regular CQL table, which simplifies the consumer but shifts the retention responsibility to the consumer with a 24-hour default TTL on the CDC log.

Idempotency is the second staff-level topic. `PlaceOrder` as written generates a fresh `TimeUUID` on every call, which means a client retry after a timeout creates a duplicate order. The production fix is a client-supplied idempotency key. The client sends `Idempotency-Key: <uuid>` on the HTTP request, the service checks an `idempotency_keys` table keyed by that UUID with an LWT `INSERT ... IF NOT EXISTS` that stores the resulting `order_id`, and on a retry returns the stored `order_id` rather than creating a new order. The LWT cost is paid once per order, which is acceptable given the consequences of duplicate orders in a commerce system. The idempotency row carries a TTL (typically 24 hours) so the table does not grow unbounded. Pair this with exactly-once semantics on the outbox by including the idempotency key in the event payload, so downstream consumers can dedupe on replay.

LWT on the status transition is correct but deserves scrutiny. The transition runs on `orders_by_id` only, which means `orders_by_user` and `orders_by_status_date` go stale until a follow-up write propagates the new status. The production approach is one of three: (1) route all status reads through `orders_by_id` so the other tables are indexes, not caches, and accept that `orders_by_status_date` is best-effort for workers that tolerate reprocessing, (2) write a second LWT to each denormalized table guarded by the same precondition, which multiplies the Paxos cost by three and is rarely justified, or (3) use the event log as the source of truth and treat all denormalized tables as derived projections, rebuilt by replaying events. Option three is the CQRS pattern and is the dominant choice in event-driven order systems at scale because it removes all consistency coupling between tables. Document the choice in an ADR and be ready to defend it in review.

State machine enforcement belongs server-side, not only in the `validTransitions` map. The LWT predicate `IF status = ?` enforces the from-state at the storage layer, which is the load-bearing guarantee. But the map above is client code and lives in the order service binary. If a second service writes to Cassandra (for example a support tool that cancels stuck orders), it must share the same map or it will corrupt the state machine. The production pattern is either a single write service (all mutations go through one service, which owns the state machine) or a generated state machine definition shared as a library across services. Interview signal at staff level: diagram the order flow with the outbox, the CDC consumer, the Kafka topics, the downstream services (fulfillment, billing, notifications), and the read paths from each denormalized table. Identify where retries can create duplicates, where idempotency keys and LWT guards prevent them, and what happens during a DC failover (answer: the idempotency table and the outbox both replicate via LOCAL_QUORUM, so cross-DC failover rehydrates pending operations safely as long as the CDC consumer checkpoints its position in a replicated store rather than local disk).

---
