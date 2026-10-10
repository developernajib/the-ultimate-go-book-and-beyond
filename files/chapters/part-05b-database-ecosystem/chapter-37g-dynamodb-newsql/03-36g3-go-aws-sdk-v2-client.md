## 37G.3 Go AWS SDK v2 Client

### Production Setup

The AWS SDK for Go v2 (`github.com/aws/aws-sdk-go-v2/service/dynamodb`) is the only supported SDK as of 2026. The v1 SDK (`github.com/aws/aws-sdk-go`) entered maintenance mode in 2024 and received its final bug-fix release in mid 2025, so all new code should use v2. The v2 client uses `attributevalue.MarshalMap` to convert Go structs to DynamoDB's wire format and `attributevalue.UnmarshalMap` for the reverse. The `dynamodbav` struct tag controls field names. Configure the client with an HTTP transport that has `MaxIdleConnsPerHost` tuned to the expected request rate to prevent connection starvation under load, and prefer `aws.RetryModeAdaptive` (token-bucket-based) to the default standard mode for workloads that experience bursty throttling.

> **Senior track**: The single biggest latency gain on DynamoDB Go clients in production is reusing a single `*dynamodb.Client` across the process. It is goroutine-safe, pools connections, and amortises TLS handshakes. Creating a client per request turns a 3ms call into a 40ms call at p99.

```go
package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"go.opentelemetry.io/contrib/instrumentation/github.com/aws/aws-sdk-go-v2/otelaws"
)

// Common errors
var (
	ErrNotFound      = errors.New("item not found")
	ErrAlreadyExists = errors.New("item already exists")
)

// Client wraps DynamoDB with observability
type Client struct {
	ddb   *dynamodb.Client
	table string
	log   *slog.Logger
}

// NewClient creates a production DynamoDB client
func NewClient(ctx context.Context, region, tableName string, log *slog.Logger) (*Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(region),
		// Retry configuration: exponential backoff for throttling
		config.WithRetryMaxAttempts(5),
		config.WithRetryMode(aws.RetryModeAdaptive),
	)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}

	// Add OpenTelemetry instrumentation
	otelaws.AppendMiddlewares(&cfg.APIOptions)

	ddb := dynamodb.NewFromConfig(cfg,
		func(o *dynamodb.Options) {
			o.RetryMaxAttempts = 5
		},
	)

	return &Client{
		ddb:   ddb,
		table: tableName,
		log:   log,
	}, nil
}

// UserRepository implements user CRUD with DynamoDB
type UserRepository struct {
	client *Client
}

func NewUserRepository(client *Client) *UserRepository {
	return &UserRepository{client: client}
}

// PutUser creates or replaces a user
func (r *UserRepository) PutUser(ctx context.Context, user User) error {
	item := ToUserItem(user)

	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("marshal user: %w", err)
	}

	_, err = r.client.ddb.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(r.client.table),
		Item:      av,
		// Conditional: only create if user doesn't exist
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})

	if err != nil {
		var condErr *types.ConditionalCheckFailedException
		if errors.As(err, &condErr) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("put user: %w", err)
	}
	return nil
}

// GetUser retrieves a user by ID
func (r *UserRepository) GetUser(ctx context.Context, userID string) (*User, error) {
	result, err := r.client.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(r.client.table),
		Key: map[string]types.AttributeValue{
			"PK": &types.AttributeValueMemberS{Value: "USER#" + userID},
			"SK": &types.AttributeValueMemberS{Value: "PROFILE"},
		},
		ConsistentRead: aws.Bool(true), // strong consistency for profile reads
	})
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}
	if result.Item == nil {
		return nil, ErrNotFound
	}

	var item UserItem
	if err := attributevalue.UnmarshalMap(result.Item, &item); err != nil {
		return nil, fmt.Errorf("unmarshal user: %w", err)
	}

	return fromUserItem(item), nil
}

// GetUserByEmail looks up user by email using GSI1
func (r *UserRepository) GetUserByEmail(ctx context.Context, email string) (*User, error) {
	result, err := r.client.ddb.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(r.client.table),
		IndexName:              aws.String("GSI1"),
		KeyConditionExpression: aws.String("GSI1PK = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk": &types.AttributeValueMemberS{Value: "EMAIL#" + email},
		},
		Limit: aws.Int32(1),
	})
	if err != nil {
		return nil, fmt.Errorf("query email: %w", err)
	}
	if len(result.Items) == 0 {
		return nil, ErrNotFound
	}

	var item UserItem
	if err := attributevalue.UnmarshalMap(result.Items[0], &item); err != nil {
		return nil, err
	}
	return fromUserItem(item), nil
}

// UpdateUser updates specific user attributes
func (r *UserRepository) UpdateUser(ctx context.Context, userID string, updates map[string]any) error {
	// Build update expression dynamically
	expr, names, values := buildUpdateExpression(updates)
	values[":updated_at"] = &types.AttributeValueMemberS{
		Value: time.Now().UTC().Format(time.RFC3339),
	}
	expr += ", UpdatedAt = :updated_at"

	_, err := r.client.ddb.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(r.client.table),
		Key: map[string]types.AttributeValue{
			"PK": &types.AttributeValueMemberS{Value: "USER#" + userID},
			"SK": &types.AttributeValueMemberS{Value: "PROFILE"},
		},
		UpdateExpression:          aws.String("SET " + expr),
		ExpressionAttributeNames:  names,
		ExpressionAttributeValues: values,
		ConditionExpression:       aws.String("attribute_exists(PK)"),
	})
	if err != nil {
		var condErr *types.ConditionalCheckFailedException
		if errors.As(err, &condErr) {
			return ErrNotFound
		}
		return fmt.Errorf("update user: %w", err)
	}
	return nil
}

func buildUpdateExpression(updates map[string]any) (string, map[string]string, map[string]types.AttributeValue) {
	var parts []string
	names := make(map[string]string)
	values := make(map[string]types.AttributeValue)

	i := 0
	for k, v := range updates {
		nameKey := fmt.Sprintf("#f%d", i)
		valKey := fmt.Sprintf(":v%d", i)
		names[nameKey] = k
		parts = append(parts, fmt.Sprintf("%s = %s", nameKey, valKey))

		// Marshal value
		av, _ := attributevalue.Marshal(v)
		values[valKey] = av
		i++
	}
	return strings.Join(parts, ", "), names, values
}
```

### Junior to FAANG: the SDK v2 mental model and the mistakes that page you

The v2 SDK looks verbose because it is explicit. Every operation takes a typed input struct, returns a typed output struct, and uses `types.AttributeValue` interface implementations (`AttributeValueMemberS`, `AttributeValueMemberN`, and so on) to represent DynamoDB's union type system. Juniors who try to write DynamoDB calls without the `attributevalue` package end up hand-constructing these wrapper types and getting exhausted. The rule is simple: marshal from Go structs with `attributevalue.MarshalMap`, unmarshal to Go structs with `attributevalue.UnmarshalMap`, and use `dynamodbav` struct tags to control field naming. Only drop to manual `AttributeValue` construction when you need a single key for a `GetItem` or a key condition expression value.

Worked example. You need to fetch a user and handle not found. The three mistakes juniors make. First, calling `GetItem` and checking `err != nil` but forgetting that not found returns no error and an empty `result.Item`, so the code happily unmarshals an empty map into a zero-value struct and hands the caller a user with blank fields. Fix: always check `if result.Item == nil { return ErrNotFound }` before unmarshalling. Second, creating a new `dynamodb.Client` per HTTP handler. The client is goroutine-safe and holds a connection pool. Create it once at startup, inject it. Third, ignoring `ConsumedCapacity` in the response. Under provisioned mode, this is the metric that tells you when a pattern is about to start throttling. Log it with structured logging and alert when it rises.

First-job context and interview entry point. Expect questions like "how do you avoid hot partitions in your client code" (use jitter on retry, use adaptive retry mode, shard writes at the producer), "what does conditional write give you" (optimistic concurrency via `attribute_not_exists` or `attribute_exists` plus version number checks), and "how do you perform a transactional update across two items" (TransactWriteItems with up to 100 actions, each including its own condition expression, and the whole thing commits atomically or fails atomically). The BatchWriteItem and BatchGetItem limits (25 items per batch, 16MB response for Get) are also standard interview trivia and real production constraints.

Practical tip. Before shipping any DynamoDB call to production, wire `ReturnConsumedCapacity: types.ReturnConsumedCapacityTotal` into the request and log the consumed RCU/WCU. Tables that suddenly consume 10x their normal capacity because an application change added a filter expression that matches many more items, or a GSI projection that now includes a large attribute, are invisible without this logging.

### Senior at FAANG: SDK internals, middleware, expression builder, and the retry budget

The v2 SDK is middleware-first. Every call passes through a chain of middleware that handles serialization, retry, signing, and response deserialization. You inject observability here, not at the application layer. The canonical hook is `APIOptions []func(*middleware.Stack) error`, which lets you add custom steps. For DynamoDB, the staff-grade set of middleware includes: OpenTelemetry instrumentation (`otelaws.AppendMiddlewares`), a middleware that injects correlation IDs into `ClientRequestToken` for idempotent writes, a middleware that enforces a global QPS cap to prevent runaway lambdas from eating the table's entire capacity, and a middleware that tags every request with service and caller identity for cost allocation via `X-Amz-Target` plus custom headers. The ability to compose these without forking the SDK is the reason v2 won.

The `expression` package (`github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression`) is mandatory for any non-trivial query, update, or scan. The hand-rolled `buildUpdateExpression` function in the example is teachable but fragile: it does not escape reserved words, does not handle nested attributes, and trusts the caller's map keys. Production code uses `expression.NewBuilder().WithUpdate(...).WithCondition(...).Build()` which produces properly escaped expressions, handles reserved words, and returns the name/value maps as a single cohesive unit. The same pattern applies to key conditions, filters, and projections. Staff engineers enforce "all expressions built via expression package" in code review because every hand-rolled expression becomes a vulnerability the day someone adds a reserved word like `Name` or `Status` to the schema.

Attributevalue marshaling gotchas. Empty strings in v2 marshal to `AttributeValueMemberS{Value: ""}` and DynamoDB accepts them (v1 used to reject), but empty string sets and empty binary sets are still rejected. Time types marshal to RFC 3339 strings by default but are not sortable lexicographically across timezones, so canonicalise to UTC before storing. `time.Time` with zero value marshals to `0001-01-01T00:00:00Z`, which will sort before every real value and break range queries. Always guard with `omitempty` or a custom marshaler. For financial amounts use `*big.Float` or a fixed-point integer (cents) never `float64`, because floats accumulate rounding error across read-modify-write cycles and corrupt ledgers.

BatchWriteItem and BatchGetItem at scale. BatchWriteItem takes up to 25 items per call and up to 16MB total. The response includes `UnprocessedItems` which is a partial failure map: items that were throttled or rate-limited and must be retried. The v2 SDK does not retry these automatically. You must implement a loop that copies `UnprocessedItems` into the next request, with exponential backoff, until the map is empty or a max-attempt budget is exhausted. BatchGetItem has the same `UnprocessedKeys` pattern. Staff engineers wrap both in a reusable package that handles this loop, enforces a per-call deadline, and returns a first-class partial-result type so callers cannot forget to check. Failing to retry UnprocessedItems is the single most common cause of "silent data loss" complaints in DynamoDB pipelines.

TransactWriteItems limits and semantics. Up to 100 actions per transaction as of 2026 (increased from 25 in late 2022 and stable since). Each action is a Put, Update, Delete, or ConditionCheck, each with its own condition expression. The whole transaction commits atomically or rolls back atomically. Cost is 2x standard writes per action plus transaction overhead, so a 100-action transaction costs roughly 200 WCUs. Transactions cannot span tables in different regions or accounts. Idempotency is provided by `ClientRequestToken`: if you retry a transaction with the same token within 10 minutes, DynamoDB returns the original result rather than re-executing. Always set this token from an upstream correlation ID so that network retries do not double-write. Setting `ReturnValuesOnConditionCheckFailure: ALL_OLD` on `ConditionCheck` actions (available since 2022) dramatically improves observability when a transaction fails because you can see which condition rejected.

The DynamoDB Enhanced Client pattern. The v2 SDK ships a lower-level client. Some teams (especially those migrating from the Java SDK which has a first-class Enhanced Client) build a thin layer that provides typed repositories, automatic attribute mapping, and versioned optimistic locking. In Go, this layer is typically a generics-backed repository pattern (`Repo[T Entity]`) built on top of `attributevalue.MarshalMap` plus the expression package. The payoff is that every repository method is a five-line typed wrapper rather than 50 lines of SDK boilerplate. The cost is one more abstraction to maintain. At FAANG scale, the abstraction pays for itself within the first dozen entity types.

Retry, timeout, and circuit-breaker discipline. `aws.RetryModeAdaptive` uses a token bucket that drains on throttling and refills on success, which provides automatic backoff proportional to observed throttling. It is strictly better than `RetryModeStandard` for DynamoDB. Set `RetryMaxAttempts` to 5 for most workloads and 3 for latency-sensitive user paths. Set the context deadline to your SLO budget minus one retry interval, so a final retry can still complete within budget. Never set no deadline: a rebalancing partition can stall a request for tens of seconds, and an unbounded call occupies a goroutine and a connection slot the entire time. For hot paths, add a client-side circuit breaker that opens on a sustained throttle rate and fails fast to the fallback (cache, queue, or degraded response) rather than piling retry pressure on an already overloaded partition.

Observability, staff grade. Every DynamoDB call should emit: operation name, table, index if any, consumed RCU and WCU, response size, latency, and the outcome (success, conditional failure, throttle, transient). Correlation IDs from the caller request should flow into `ClientRequestToken` for idempotent operations and into trace spans via `otelaws`. Cost allocation tags on the client (`aws.ClientLogMode`, custom user-agent suffix) let finance attribute spend to team and service. The single metric that matters most on dashboards is `consumed_capacity_rate_per_pattern`, broken down by access pattern name (a custom tag the application adds), because it surfaces runaway patterns before they throttle.

Testing strategy. The v2 client has a `dynamodbiface`-style interface pattern via manual interface extraction, plus DynamoDB Local for integration tests and moto or testcontainers for CI. Unit tests mock the client interface. Integration tests hit DynamoDB Local via a testcontainers-managed container, which runs the real DynamoDB engine (in Java, in a sandbox) and supports all features including transactions, streams, and PITR. Staff engineers forbid mocks in integration tests for DynamoDB because the behavior around throttling, eventual consistency, and GSI propagation is not captured by hand-written mocks. Use DynamoDB Local, run the full access-pattern list, and assert both functional correctness and cost (ConsumedCapacity must not exceed documented budget).

---
