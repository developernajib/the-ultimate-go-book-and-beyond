## 37G.5 DynamoDB Transactions

### ACID Transactions

DynamoDB supports ACID transactions through `TransactWriteItems` and `TransactGetItems`, which atomically operate on up to 100 items (or 4 MB of data, whichever comes first) across multiple tables in the same AWS region. Each item in the transaction can include a condition expression, and if any condition fails the entire transaction is canceled. The `ClientRequestToken` field provides idempotency for a 10-minute window, making it safe to retry a failed request without risking duplicate writes. Transactions consume twice the normal read/write capacity units, so reserve them for genuinely atomic multi-item operations such as order placement with inventory decrement, ledger entries, or saga compensations. For independent writes, prefer `BatchWriteItem` (up to 25 items, non-atomic) at half the cost.

> **Senior track**: `TransactionCanceledException` is the only exception that matters in DynamoDB transaction code. Always inspect `CancellationReasons` by index, not by error text. The index position maps one-to-one to your `TransactItems` slice, so you can surface a precise user-facing error ("insufficient stock for product X", not "transaction failed"). This is a FAANG bar-raiser question on DynamoDB interviews.

```go
package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// OrderTransactionService handles atomic order operations
type OrderTransactionService struct {
	client *Client
}

// NewOrder creates an Order domain model from PlaceOrderRequest
func NewOrder(req PlaceOrderRequest) Order {
	var totalCents int64
	for _, item := range req.Items {
		totalCents += item.PriceCents * int64(item.Quantity)
	}
	return Order{
		ID:         fmt.Sprintf("%d", time.Now().UnixNano()),
		UserID:     req.UserID,
		Status:     "PENDING",
		TotalCents: totalCents,
		Items:      req.Items,
		CreatedAt:  time.Now().UTC(),
	}
}

// PlaceOrder atomically creates order + decrements inventory
// Uses TransactWriteItems: up to 100 items across up to 10 tables
func (s *OrderTransactionService) PlaceOrder(ctx context.Context, req PlaceOrderRequest) (*Order, error) {
	order := NewOrder(req)

	// Marshal order item
	orderItem := ToOrderItem(order)
	orderAV, err := attributevalue.MarshalMap(orderItem)
	if err != nil {
		return nil, err
	}

	// Build transaction
	transactItems := []types.TransactWriteItem{
		// 1. Create order
		{
			Put: &types.Put{
				TableName:           aws.String(s.client.table),
				Item:                orderAV,
				ConditionExpression: aws.String("attribute_not_exists(PK)"), // idempotent
			},
		},
	}

	// 2. Decrement stock for each item (with check)
	for _, item := range req.Items {
		transactItems = append(transactItems, types.TransactWriteItem{
			Update: &types.Update{
				TableName: aws.String(s.client.table),
				Key: map[string]types.AttributeValue{
					"PK": &types.AttributeValueMemberS{Value: "PRODUCT#" + item.ProductID},
					"SK": &types.AttributeValueMemberS{Value: "INVENTORY"},
				},
				UpdateExpression:    aws.String("SET Stock = Stock - :qty"),
				ConditionExpression: aws.String("Stock >= :qty"), // prevent negative stock
				ExpressionAttributeValues: map[string]types.AttributeValue{
					":qty": &types.AttributeValueMemberN{Value: fmt.Sprintf("%d", item.Quantity)},
				},
			},
		})
	}

	// 3. Debit account balance
	transactItems = append(transactItems, types.TransactWriteItem{
		Update: &types.Update{
			TableName: aws.String(s.client.table),
			Key: map[string]types.AttributeValue{
				"PK": &types.AttributeValueMemberS{Value: "USER#" + req.UserID},
				"SK": &types.AttributeValueMemberS{Value: "ACCOUNT"},
			},
			UpdateExpression:    aws.String("SET BalanceCents = BalanceCents - :total"),
			ConditionExpression: aws.String("BalanceCents >= :total"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":total": &types.AttributeValueMemberN{Value: fmt.Sprintf("%d", order.TotalCents)},
			},
		},
	})

	// Execute transaction
	_, err = s.client.ddb.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: transactItems,
		// Client token for idempotency (retry-safe)
		ClientRequestToken: aws.String(order.ID),
	})

	if err != nil {
		var txnErr *types.TransactionCanceledException
		if errors.As(err, &txnErr) {
			// Parse which condition failed
			for i, reason := range txnErr.CancellationReasons {
				if reason.Code != nil && *reason.Code == "ConditionalCheckFailed" {
					switch i {
					case 0:
						return nil, fmt.Errorf("order already exists (duplicate)")
					case len(transactItems) - 1:
						return nil, fmt.Errorf("insufficient account balance")
					default:
						return nil, fmt.Errorf("insufficient stock for item %d", i-1)
					}
				}
			}
		}
		return nil, fmt.Errorf("transaction: %w", err)
	}

	return &order, nil
}

// TransactGetItems atomically reads multiple consistent items
func (s *OrderTransactionService) GetOrderDetails(ctx context.Context, orderID, userID string) (*OrderDetails, error) {
	result, err := s.client.ddb.TransactGetItems(ctx, &dynamodb.TransactGetItemsInput{
		TransactItems: []types.TransactGetItem{
			{
				Get: &types.Get{
					TableName: aws.String(s.client.table),
					Key: map[string]types.AttributeValue{
						"PK": &types.AttributeValueMemberS{Value: "USER#" + userID},
						"SK": &types.AttributeValueMemberS{Value: "ORDER#" + orderID},
					},
				},
			},
			{
				Get: &types.Get{
					TableName: aws.String(s.client.table),
					Key: map[string]types.AttributeValue{
						"PK": &types.AttributeValueMemberS{Value: "USER#" + userID},
						"SK": &types.AttributeValueMemberS{Value: "PROFILE"},
					},
				},
			},
		},
	})
	if err != nil {
		return nil, err
	}

	var order OrderItem
	var user UserItem
	attributevalue.UnmarshalMap(result.Responses[0].Item, &order)
	attributevalue.UnmarshalMap(result.Responses[1].Item, &user)

	return &OrderDetails{
		Order: fromOrderItem(order),
		User:  *fromUserItem(user),
	}, nil
}

type PlaceOrderRequest struct {
	UserID string
	Items  []LineItem
}

type OrderDetails struct {
	Order Order
	User  User
}
```

### Junior to FAANG: DynamoDB Transactions Entry Point

If you are new to DynamoDB, the first surprise is that transactions are not free. A `TransactWriteItems` call consumes 2x the write capacity units of the equivalent non-transactional writes, and you are capped at 100 items or 4 MB per call. Before you even write Go code, be sure you understand why. DynamoDB runs a two-phase protocol under the hood (prepare plus commit), and the doubled cost pays for that coordination across the storage nodes that own each key. The limit of 100 items is not arbitrary either. It bounds the worst-case blast radius if a partition is hot, so your p99 latency stays predictable.

A very common first-job scenario is the order placement flow. Junior engineers reach for a Lambda that does three sequential `UpdateItem` calls (create order, decrement stock, debit balance) and then learn the hard way that a crash between calls leaves the account debited with no order. The worked example above is the fix. Three observations to internalize as you read it:

1. The first `Put` uses `attribute_not_exists(PK)`. This is how you make the write idempotent against client retries. If the Lambda fires twice because API Gateway retried, the second attempt fails the condition and the whole transaction cancels cleanly.
2. `ClientRequestToken` is a different kind of idempotency. It deduplicates at the DynamoDB service layer for 10 minutes. Use the order ID as the token so a retry within that window is a no-op instead of a conflict.
3. `CancellationReasons` is an index-aligned slice. Position 0 corresponds to `transactItems[0]`. If you grow the transaction, your error mapping has to grow with it, which is why most production code builds a parallel slice of error descriptors instead of switching on magic integers.

Interview framing at entry level usually sounds like "design an order service on DynamoDB." The bar-raiser signal is not "I used a transaction." It is "I priced the transaction, I chose an idempotency strategy, and I mapped each condition failure to a specific user-visible error." Junior candidates who can articulate the 2x cost trade-off against a single-table design with an aggregate root get promoted into the senior loop quickly.

One more pragmatic note. `TransactGetItems` is strongly consistent across all items in the transaction, but it also costs 2x read capacity. For a read that merely needs per-item consistency, a plain `BatchGetItem` at 1x cost is almost always the right call. Reach for the transactional variant only when you must observe a point-in-time snapshot across items, such as a financial statement that must show order and balance as of the same instant.

### Senior at FAANG: Transaction Design, Idempotency, and Multi-Region Correctness

At staff and principal level, the conversation about DynamoDB transactions is rarely about the API surface. It is about contract design, failure semantics, and cost. A senior review of the worked example would flag several topics that the junior framing glosses over.

First, the two idempotency layers are doing different jobs and must be reasoned about independently. `ClientRequestToken` protects against duplicate submissions at the service boundary for a 10-minute window. The `attribute_not_exists(PK)` condition protects against duplicates forever, up to the lifetime of the primary key. If your client can retry after 10 minutes (for example, a queue consumer with visibility timeout longer than 10 minutes, or a manual replay), only the condition expression will save you. The two together give belt-and-suspenders semantics, and senior engineers write the ADR that explicitly says so, because a future engineer will otherwise delete one of them as "redundant."

Second, the 2x write cost compounds in ways that junior capacity models miss. A transaction that writes N items consumes 2N WCUs, and each conditional check that reads an item also consumes 2 RCUs (not 1, because the check is part of the transactional protocol). For a 100-item transaction you are looking at 200 WCUs plus up to 200 RCUs per invocation. On-demand billing hides this, but under provisioned capacity you need to size your table for the transactional peak or accept throttling. A common staff-level mitigation is to split a monolithic transaction into an outer saga with smaller atomic steps, each using an outbox pattern via DynamoDB Streams to drive the next step. You trade strict atomicity for bounded cost and better partition distribution.

Third, optimistic concurrency with `ConditionCheck` is the correct pattern for cross-aggregate invariants, but the version-attribute discipline has to be codified. Every aggregate root carries a monotonic `Version` number. Every update asserts `Version = :expected` and sets `Version = :expected + 1`. On `TransactionCanceledException` with a `ConditionalCheckFailed` on the version, you rebuild the aggregate from current state and retry with bounded backoff. Senior code makes this a generic `OptimisticUpdate[T]` function, not a per-call pattern, and wires in metrics for retry count so you can alert when contention hotspots emerge.

Fourth, and this is where the principal-level conversation lives, DynamoDB transactions do not span regions. Global Tables replicate asynchronously with last-writer-wins conflict resolution based on region timestamps. If your order service is active-active across us-east-1 and eu-west-1, a transaction in one region does not see uncommitted state in the other, and concurrent writes to the same key in two regions will converge by LWW, not by your condition expressions. The correct architectures are either (a) pin each user to a home region via consistent hashing and route writes there, with the other region as warm standby, or (b) accept eventual consistency and design idempotent, commutative operations (CRDTs in spirit, even if you do not call them that). Any senior review that sees `TransactWriteItems` paired with Global Tables and no pinning strategy should block the change.

Fifth, observability. `TransactionCanceledException` carries a `CancellationReasons` array where each entry has a `Code` and an `Item` snapshot. Senior code emits a structured log with the failing condition, the current and expected attribute values, the `ClientRequestToken`, and a correlation ID. This turns production incidents from "transactions are failing" into "condition X on item Y failed because field Z had value A, expected B," which a on-call engineer can act on without attaching a debugger. Pair this with a CloudWatch metric on cancellation reason codes so you can distinguish contention (retry) from business rule violation (do not retry).

Sixth, testing. A common anti-pattern is to test transactions against a local DynamoDB or against a mock. Local DynamoDB does not faithfully simulate partition-level contention or the exact cancellation reason ordering. The senior-track discipline is (a) contract tests against the real service in a dedicated integration account, (b) chaos tests that inject `ProvisionedThroughputExceededException` mid-transaction to verify your retry path, and (c) a property-based test that generates concurrent transactions against the same aggregate and asserts that the final state matches a sequential interleaving. The last one catches subtle bugs in your optimistic concurrency code that unit tests cannot reach.

Finally, know when not to use a transaction. If the operation is naturally idempotent and commutative (increment a counter, append to a log), single-item conditional writes are cheaper, scale better, and never cancel. If the operation spans more than 100 items, you need a saga. If the operation needs cross-region atomicity, DynamoDB is the wrong database and you should be looking at Spanner or CockroachDB (covered later in this chapter). The transaction API is a precision tool for a narrow band of problems, and senior engineers who articulate that boundary clearly are the ones trusted to own the data layer.

---
