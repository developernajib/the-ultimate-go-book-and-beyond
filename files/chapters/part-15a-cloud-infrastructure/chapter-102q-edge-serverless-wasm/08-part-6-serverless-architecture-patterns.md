## 102Q.6 Serverless Architecture Patterns

Serverless functions execute in ephemeral containers and must therefore be composed using asynchronous messaging patterns rather than direct inter-service calls. This section covers three foundational patterns, fan-out, saga orchestration, and event sourcing, that are especially natural in serverless environments because each step is independently invocable and can be retried without re-running the entire workflow. Understanding these patterns helps you design systems where individual Lambda functions remain small and focused while the overall workflow handles partial failures gracefully.

### Fan-Out Pattern

The fan-out pattern distributes a single incoming event to multiple downstream consumers simultaneously, enabling parallel processing without a central coordinator blocking on each recipient. In AWS, this is typically achieved by publishing to an SNS topic (which fans out to SQS queues) or by a Lambda function explicitly sending to multiple SQS queues concurrently. Controlling concurrency with a semaphore, as shown below, prevents the function from exhausting the SQS API rate limit when the number of target queues is large.

```go
package fanout

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// Event represents an event payload to be fanned out
type Event struct {
	ID      string `json:"id"`
	Payload string `json:"payload"`
}

// FanOutProcessor distributes work across multiple downstream queues
type FanOutProcessor struct {
	sqsClient  *sqs.Client
	queues     []string
	maxWorkers int
}

func (p *FanOutProcessor) Process(ctx context.Context, events []Event) error {
	sem := make(chan struct{}, p.maxWorkers)
	var wg sync.WaitGroup
	var errCount atomic.Int64

	for _, event := range events {
		for _, queue := range p.queues {
			wg.Add(1)
			sem <- struct{}{}

			go func(event Event, queue string) {
				defer wg.Done()
				defer func() { <-sem }()

				if err := p.sendToQueue(ctx, queue, event); err != nil {
					errCount.Add(1)
					fmt.Printf("failed to send to %s: %v\n", queue, err)
				}
			}(event, queue)
		}
	}

	wg.Wait()
	if n := errCount.Load(); n > 0 {
		return fmt.Errorf("%d messages failed to send", n)
	}
	return nil
}

func (p *FanOutProcessor) sendToQueue(ctx context.Context, queueURL string, event Event) error {
	body, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}

	_, err = p.sqsClient.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    &queueURL,
		MessageBody: aws.String(string(body)),
	})
	return err
}
```

### Saga Pattern for Serverless

The saga pattern manages distributed transactions across multiple services or Lambda functions by replacing a single ACID transaction with a sequence of local transactions, each paired with a compensating action that undoes its effect if a later step fails. In a serverless context each step can be a separate Lambda invocation, making the saga naturally resumable after partial failures. The orchestrator implementation below executes steps in order and automatically rolls back completed steps in reverse order when an error occurs, ensuring the overall system reaches a consistent state even when individual steps fail.

```go
package saga

import (
	"context"
	"fmt"
)

// Step represents one step in a saga with its compensating transaction
type Step struct {
	Name       string
	Execute    func(ctx context.Context, state *SagaState) error
	Compensate func(ctx context.Context, state *SagaState) error
}

// SagaState holds data shared between saga steps
type SagaState struct {
	OrderID       string
	CustomerID    string
	AmountCents   int64
	ReservationID string
	PaymentID     string
}

type InventoryService interface {
	Reserve(ctx context.Context, orderID string) (string, error)
	Release(ctx context.Context, reservationID string) error
}

type PaymentService interface {
	Charge(ctx context.Context, customerID string, amountCents int64) (string, error)
	Refund(ctx context.Context, paymentID string) error
}

type EmailService interface {
	SendConfirmation(ctx context.Context, customerID, orderID string) error
	SendCancellation(ctx context.Context, customerID, orderID string) error
}

// SagaOrchestrator executes steps with automatic rollback on failure
type SagaOrchestrator struct {
	steps []Step
}

func NewOrderSaga(inventory InventoryService, payment PaymentService, email EmailService) *SagaOrchestrator {
	return &SagaOrchestrator{
		steps: []Step{
			{
				Name: "reserve-inventory",
				Execute: func(ctx context.Context, s *SagaState) error {
					id, err := inventory.Reserve(ctx, s.OrderID)
					if err != nil {
						return fmt.Errorf("reserve inventory: %w", err)
					}
					s.ReservationID = id
					return nil
				},
				Compensate: func(ctx context.Context, s *SagaState) error {
					return inventory.Release(ctx, s.ReservationID)
				},
			},
			{
				Name: "charge-payment",
				Execute: func(ctx context.Context, s *SagaState) error {
					id, err := payment.Charge(ctx, s.CustomerID, s.AmountCents)
					if err != nil {
						return fmt.Errorf("charge payment: %w", err)
					}
					s.PaymentID = id
					return nil
				},
				Compensate: func(ctx context.Context, s *SagaState) error {
					return payment.Refund(ctx, s.PaymentID)
				},
			},
			{
				Name: "send-confirmation",
				Execute: func(ctx context.Context, s *SagaState) error {
					return email.SendConfirmation(ctx, s.CustomerID, s.OrderID)
				},
				Compensate: func(ctx context.Context, s *SagaState) error {
					return email.SendCancellation(ctx, s.CustomerID, s.OrderID)
				},
			},
		},
	}
}

func (o *SagaOrchestrator) Execute(ctx context.Context, state *SagaState) error {
	var completed []int

	for i, step := range o.steps {
		if err := step.Execute(ctx, state); err != nil {
			// Compensate in reverse order
			for j := len(completed) - 1; j >= 0; j-- {
				idx := completed[j]
				if compErr := o.steps[idx].Compensate(ctx, state); compErr != nil {
					fmt.Printf("compensation failed for step %s: %v\n",
						o.steps[idx].Name, compErr)
				}
			}
			return fmt.Errorf("saga failed at step %s: %w", step.Name, err)
		}
		completed = append(completed, i)
	}

	return nil
}
```

### Idempotent Lambda Handler

SQS and SNS deliver messages at least once, which means a Lambda function can receive the same event multiple times, especially during retries after a throttle or transient error. An idempotency layer intercepts each invocation, writes a conditional record to DynamoDB using a content-derived key, and returns the cached result if the key already exists, guaranteeing that the business logic runs exactly once per unique event. The DynamoDB conditional `PutItem` with `attribute_not_exists` acts as a distributed lock, and setting a TTL on the record prevents the table from growing without bound for long-lived deployments.

```go
package idempotent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// IdempotencyStore tracks processed event IDs
type IdempotencyStore struct {
	db        *dynamodb.Client
	tableName string
	ttl       time.Duration
}

type idempotencyRecord struct {
	Key       string `json:"key"`
	Status    string `json:"status"` // "processing" | "completed"
	Result    string `json:"result"`
	ExpiresAt int64  `json:"expires_at"`
}

// Ensure ensures an event is processed exactly once
func (s *IdempotencyStore) Ensure(ctx context.Context, key string, handler func() (any, error)) (any, error) {
	// Try to claim the record (conditional put)
	now := time.Now()
	record := idempotencyRecord{
		Key:       key,
		Status:    "processing",
		ExpiresAt: now.Add(s.ttl).Unix(),
	}

	recordJSON, _ := json.Marshal(record)

	_, err := s.db.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &s.tableName,
		Item: map[string]types.AttributeValue{
			"key":        &types.AttributeValueMemberS{Value: key},
			"status":     &types.AttributeValueMemberS{Value: "processing"},
			"expires_at": &types.AttributeValueMemberN{Value: fmt.Sprintf("%d", record.ExpiresAt)},
		},
		ConditionExpression: aws.String("attribute_not_exists(#k) OR #status = :expired"),
		ExpressionAttributeNames: map[string]string{
			"#k":      "key",
			"#status": "status",
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":expired": &types.AttributeValueMemberS{Value: "expired"},
		},
	})

	if err != nil {
		// Check if it's a conditional check failure (duplicate)
		var condErr *types.ConditionalCheckFailedException
		if errors.As(err, &condErr) {
			// Fetch existing result
			return s.getResult(ctx, key)
		}
		return nil, fmt.Errorf("idempotency check: %w", err)
	}

	_ = recordJSON // used if you store in different format

	// Execute handler
	result, handlerErr := handler()

	// Update record with result
	status := "completed"
	resultJSON := ""
	if handlerErr != nil {
		status = "failed"
		resultJSON = handlerErr.Error()
	} else if result != nil {
		b, _ := json.Marshal(result)
		resultJSON = string(b)
	}

	_, _ = s.db.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: &s.tableName,
		Key: map[string]types.AttributeValue{
			"key": &types.AttributeValueMemberS{Value: key},
		},
		UpdateExpression: aws.String("SET #status = :status, #result = :result"),
		ExpressionAttributeNames: map[string]string{
			"#status": "status",
			"#result": "result",
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":status": &types.AttributeValueMemberS{Value: status},
			":result": &types.AttributeValueMemberS{Value: resultJSON},
		},
	})

	return result, handlerErr
}

func (s *IdempotencyStore) getResult(ctx context.Context, key string) (any, error) {
	out, err := s.db.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &s.tableName,
		Key: map[string]types.AttributeValue{
			"key": &types.AttributeValueMemberS{Value: key},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("get idempotency record: %w", err)
	}
	if len(out.Item) == 0 {
		return nil, fmt.Errorf("idempotency record not found")
	}

	resultAttr, ok := out.Item["result"]
	if !ok {
		return nil, nil
	}

	var result any
	if err := json.Unmarshal([]byte(resultAttr.(*types.AttributeValueMemberS).Value), &result); err != nil {
		return nil, fmt.Errorf("unmarshal result: %w", err)
	}
	return result, nil
}

// EventKey generates a stable key from an event
func EventKey(event any) string {
	b, _ := json.Marshal(event)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
```

---

### Junior → FAANG: Idempotency as the Non-Negotiable Requirement for All Serverless Patterns

The fan-out, saga, and event sourcing patterns all share one non-negotiable property: every Lambda function in the workflow must be idempotent. SQS delivers messages at-least-once, Step Functions can retry failed states, and EventBridge can deliver events to multiple targets concurrently. Any of these retry or parallel execution scenarios can invoke your function twice with the same input. If your function is not idempotent, the duplicate invocation produces incorrect results: double charges, duplicate records, or inconsistent state.

The idempotency implementation pattern: generate a unique idempotency key from the event (SQS message ID, EventBridge event ID, or a hash of the event payload), store the key with a TTL in DynamoDB before processing, and check for an existing key before executing the business logic. If the key exists, return the cached result or a no-op response. If it does not exist, process the event and store the key. This pattern adds one DynamoDB read and one write per invocation, which is the cost of correctness in an at-least-once delivery system.

### Senior @ FAANG: Saga Orchestration vs. Choreography as a Platform Architecture Decision

At staff level, the choice between saga orchestration (Step Functions) and choreography (event-driven with EventBridge) is an architecture decision with significant organizational implications. Orchestration makes the workflow visible: the Step Functions console shows the current state of every running workflow, including which step failed and the error detail. This observability is operationally valuable. Choreography distributes the workflow logic across services, making the overall workflow invisible without distributed tracing infrastructure.

The organizational default should be orchestration for multi-step workflows that span more than two services, have compensation logic (rollback steps), or have SLOs on overall completion time. Choreography is appropriate for fan-out patterns where downstream processing is fire-and-forget and does not need to be correlated. The platform team should document this decision boundary and provide the infrastructure for both patterns: a standard Step Functions IAM execution role and state machine scaffolding for orchestration, and a standard EventBridge event bus with schema registry and DLQ configuration for choreography.

The event sourcing pattern in this section scales to an organizational capability: if the platform owns a standard event store (DynamoDB Streams into Kinesis), teams can implement event sourcing without building the infrastructure. The platform investment is in the event store, the replay tooling, and the snapshot management. The team investment is in the aggregate logic. This split enables event sourcing adoption across multiple teams without each team independently solving the infrastructure problems.
