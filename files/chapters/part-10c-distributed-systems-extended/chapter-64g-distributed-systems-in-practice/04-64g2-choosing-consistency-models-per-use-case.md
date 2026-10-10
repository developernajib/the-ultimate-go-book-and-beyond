## 64G.2 Choosing Consistency Models Per Use Case

### Consistency Levels Map to Business Requirements

Choosing a consistency model is ultimately a business decision: strong consistency buys correctness at the cost of availability and latency, while eventual consistency maximizes performance but requires the application to handle temporary staleness. The following mapping from business operation types to appropriate consistency levels provides a practical decision framework.

```go
package consistency

// Not all data requires the same consistency level
// Applying the wrong level either wastes performance or risks correctness

type ConsistencyRequirement struct {
    DataType    string
    WriteLevel  string
    ReadLevel   string
    Rationale   string
}

var consistencyMatrix = []ConsistencyRequirement{
    {
        DataType:   "Bank account balance",
        WriteLevel: "Serializable (highest)",
        ReadLevel:  "Linearizable",
        Rationale:  "Double-spend prevention - incorrect answer is worse than unavailability",
    },
    {
        DataType:   "User session / auth token",
        WriteLevel: "Strong consistency",
        ReadLevel:  "Strong consistency",
        Rationale:  "Stale session data allows use of revoked tokens",
    },
    {
        DataType:   "Inventory count (e-commerce)",
        WriteLevel: "Strong consistency for last N items",
        ReadLevel:  "Strong or strong for checkout, eventual for display",
        Rationale:  "Overselling is costly; showing slightly stale count is acceptable",
    },
    {
        DataType:   "Post view counter",
        WriteLevel: "Eventual (CRDT counter)",
        ReadLevel:  "Eventual",
        Rationale:  "Exact count irrelevant; approximate is fine; availability matters",
    },
    {
        DataType:   "User profile (name, bio)",
        WriteLevel: "Strong",
        ReadLevel:  "Eventual (with cache TTL)",
        Rationale:  "Profile changes are infrequent; slightly stale display is acceptable",
    },
    {
        DataType:   "Analytics/metrics",
        WriteLevel: "Eventual (batch)",
        ReadLevel:  "Eventual",
        Rationale:  "Approximate analytics acceptable; throughput > correctness",
    },
    {
        DataType:   "Distributed lock / leader election",
        WriteLevel: "Linearizable (via CAS)",
        ReadLevel:  "Linearizable",
        Rationale:  "Two leaders accepting writes = split-brain = data corruption",
    },
}
```

### Per-Operation Consistency in Practice

Many systems apply different consistency levels to different operations within the same service. Reads from a search index use eventual consistency while writes to the inventory service demand linearizability. The following Go middleware demonstrates how to encode per-operation consistency requirements as context values and route requests to the appropriate storage tier.

```go
package consistency

import (
    "context"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
    "github.com/gocql/gocql"
)

type Order struct {
    ID string
}

type DynamoRepository struct {
    client *dynamodb.Client
}

type CassandraRepository struct {
    session *gocql.Session
}

func marshalKey(id string) map[string]types.AttributeValue {
    return map[string]types.AttributeValue{
        "id": &types.AttributeValueMemberS{Value: id},
    }
}

func unmarshalOrder(item map[string]types.AttributeValue) (*Order, error) {
    return &Order{}, nil
}

// DynamoDB: per-operation consistency level
func (r *DynamoRepository) GetOrder(ctx context.Context, orderID string, consistent bool) (*Order, error) {
    input := &dynamodb.GetItemInput{
        TableName:      aws.String("orders"),
        Key:            marshalKey(orderID),
        ConsistentRead: aws.Bool(consistent),
        // true  → linearizable read (reads from leader, higher cost)
        // false → eventually consistent (reads from any replica, lower cost, possibly stale)
    }

    result, err := r.client.GetItem(ctx, input)
    if err != nil {
        return nil, err
    }

    return unmarshalOrder(result.Item)
}

// Use consistent reads for:
// - Checkout flow: need accurate inventory before charging
// - Balance display: user just made a payment, expects to see it
// - Permission checks: just granted/revoked, must take effect immediately

// Use eventually consistent reads for:
// - Product catalog browsing
// - User profile display (not auth)
// - Search result display
// - Historical order history

// Cassandra: LWT (Lightweight Transactions) for conditional writes
func (r *CassandraRepository) CreateUniqueEmail(ctx context.Context, userID, email string) (bool, error) {
    // Paxos-based conditional insert - prevents duplicate email registration
    // Slower than regular writes but prevents race condition
    applied, err := r.session.Query(
        "INSERT INTO users_by_email (email, user_id) VALUES (?, ?) IF NOT EXISTS",
        email, userID,
    ).WithContext(ctx).ScanCAS(nil)

    // applied = true  → insert succeeded, email was available
    // applied = false → email already exists
    return applied, err
}
```

### Junior → FAANG: Consistency Models as a Business-to-Technical Translation Skill

The most common junior mistake in system design interviews is applying the same consistency model to every piece of data in a system. Interviewers at FAANG explicitly test whether candidates can differentiate: "you said you'd use DynamoDB for the whole system, but what consistency level do you use for checkout vs for the product catalog?"

The consistency matrix in this section is a reference you should be able to reconstruct from first principles in an interview. For each data type, ask two questions: (1) what is the cost of serving a stale value to the user? (2) what is the cost of being unavailable? Financial data has catastrophic staleness cost (double-spend) and acceptable unavailability cost (user retries). View counters have negligible staleness cost and catastrophic unavailability cost (every page load blocks). That asymmetry determines the model.

For first-job engineers: when you encounter a new table in the codebase, ask "what consistency model is this implicitly using?" If the answer is "whatever the ORM defaults to," that is a documentation gap and a potential incident waiting to happen. Add a comment or ticket.

### Senior @ FAANG: Consistency Model Selection as a Formal Design Constraint

At senior level, per-operation consistency selection is a formal design constraint that should be encoded in the service's design document, reviewed at design time, and validated in integration tests.

**Consistency contracts between services.** When Service A reads data written by Service B, what consistency guarantee does A rely on? If B uses eventual consistency internally, A cannot assume it will see the latest write. This implicit dependency is invisible unless it is documented. Staff engineers introduce explicit consistency contracts: Service B's API documentation states "reads may reflect writes up to 500ms old. For consistent reads, use the `X-Consistent-Read: true` header." Contracts make the consistency guarantee explicit and testable.

**Lightweight transactions (LWT) cost modeling.** Cassandra's LWT (Paxos-based conditional writes) are correct but expensive: roughly 4x the latency of a regular write, and they reduce throughput significantly at high load. At FAANG scale, applying LWT to a high-throughput path without a capacity analysis first can cause a performance regression that looks like a distributed systems bug. The design review question is: does this operation require LWT, and if so, have we modeled the throughput impact at peak load? Alternative approaches (idempotency keys with optimistic concurrency, application-level deduplication) should be evaluated before accepting the LWT cost.

**Consistency model drift over time.** Services start with careful per-operation consistency selection and drift over time as engineers add new operations without referencing the original design document. The consistency matrix becomes stale. Staff engineers address this with two practices: (1) a mandatory "consistency model" field in the service's data dictionary, updated whenever a new data type is added, and (2) a quarterly review of the service's consistency claims against its actual storage configuration, ideally automated. Consistency drift is invisible until it causes a data correctness incident, at which point it is very visible and very expensive.

**Idempotency as a consistency mechanism.** Idempotency keys are not just a reliability pattern: they are a consistency mechanism. By making operations idempotent, you enable safe at-least-once delivery, which means you can use AP storage for write paths and still achieve correctness. The design pattern of "write idempotency key to strong-consistent store, then process in AP store" converts a strong consistency requirement into an eventual consistency requirement with a correctness guarantee. At FAANG, this pattern is standard for payment and order workflows.

---
