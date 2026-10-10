## 100.3 Amazon DynamoDB

### DynamoDB Operations

DynamoDB is a key-value and document database built around a single-table design pattern where composite primary keys (`PK` + `SK`) encode entity relationships and enable access patterns without joins. The AWS SDK v2 `attributevalue` package marshals Go structs to DynamoDB's typed attribute format using struct tags (`dynamodbav`), and the `expression` builder constructs type-safe update and key-condition expressions. Conditional writes (`attribute_not_exists(PK)`) prevent duplicate inserts, while `TransactWriteItems` atomically commits up to 100 operations across multiple logical items in the same table.

```go
package database

import (
    "context"
    "fmt"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
    "github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

type User struct {
    PK        string `dynamodbav:"PK"`
    SK        string `dynamodbav:"SK"`
    ID        string `dynamodbav:"id"`
    Email     string `dynamodbav:"email"`
    Name      string `dynamodbav:"name"`
    CreatedAt int64  `dynamodbav:"created_at"`
}

type DynamoDBClient struct {
    client    *dynamodb.Client
    tableName string
}

func NewDynamoDBClient(client *dynamodb.Client, tableName string) *DynamoDBClient {
    return &DynamoDBClient{client: client, tableName: tableName}
}

// Create user
func (d *DynamoDBClient) CreateUser(ctx context.Context, user *User) error {
    user.PK = fmt.Sprintf("USER#%s", user.ID)
    user.SK = fmt.Sprintf("PROFILE#%s", user.ID)

    av, err := attributevalue.MarshalMap(user)
    if err != nil {
        return fmt.Errorf("marshal user: %w", err)
    }

    _, err = d.client.PutItem(ctx, &dynamodb.PutItemInput{
        TableName:           aws.String(d.tableName),
        Item:                av,
        ConditionExpression: aws.String("attribute_not_exists(PK)"),
    })
    if err != nil {
        return fmt.Errorf("put item: %w", err)
    }

    return nil
}

// Get user by ID
func (d *DynamoDBClient) GetUser(ctx context.Context, userID string) (*User, error) {
    pk := fmt.Sprintf("USER#%s", userID)
    sk := fmt.Sprintf("PROFILE#%s", userID)

    result, err := d.client.GetItem(ctx, &dynamodb.GetItemInput{
        TableName: aws.String(d.tableName),
        Key: map[string]types.AttributeValue{
            "PK": &types.AttributeValueMemberS{Value: pk},
            "SK": &types.AttributeValueMemberS{Value: sk},
        },
    })
    if err != nil {
        return nil, fmt.Errorf("get item: %w", err)
    }

    if result.Item == nil {
        return nil, nil // Not found
    }

    var user User
    if err := attributevalue.UnmarshalMap(result.Item, &user); err != nil {
        return nil, fmt.Errorf("unmarshal user: %w", err)
    }

    return &user, nil
}

// Update user
func (d *DynamoDBClient) UpdateUser(ctx context.Context, userID, name, email string) error {
    pk := fmt.Sprintf("USER#%s", userID)
    sk := fmt.Sprintf("PROFILE#%s", userID)

    update := expression.Set(
        expression.Name("name"), expression.Value(name),
    ).Set(
        expression.Name("email"), expression.Value(email),
    )

    expr, err := expression.NewBuilder().WithUpdate(update).Build()
    if err != nil {
        return fmt.Errorf("build expression: %w", err)
    }

    _, err = d.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
        TableName: aws.String(d.tableName),
        Key: map[string]types.AttributeValue{
            "PK": &types.AttributeValueMemberS{Value: pk},
            "SK": &types.AttributeValueMemberS{Value: sk},
        },
        UpdateExpression:          expr.Update(),
        ExpressionAttributeNames:  expr.Names(),
        ExpressionAttributeValues: expr.Values(),
    })
    if err != nil {
        return fmt.Errorf("update item: %w", err)
    }

    return nil
}

// Query users by prefix
func (d *DynamoDBClient) QueryUsers(ctx context.Context, limit int32) ([]User, error) {
    keyCondition := expression.Key("PK").BeginsWith("USER#")

    expr, err := expression.NewBuilder().WithKeyCondition(keyCondition).Build()
    if err != nil {
        return nil, fmt.Errorf("build expression: %w", err)
    }

    // Note: This requires a GSI with PK as partition key
    result, err := d.client.Query(ctx, &dynamodb.QueryInput{
        TableName:                 aws.String(d.tableName),
        KeyConditionExpression:    expr.KeyCondition(),
        ExpressionAttributeNames:  expr.Names(),
        ExpressionAttributeValues: expr.Values(),
        Limit:                     aws.Int32(limit),
    })
    if err != nil {
        return nil, fmt.Errorf("query: %w", err)
    }

    var users []User
    if err := attributevalue.UnmarshalListOfMaps(result.Items, &users); err != nil {
        return nil, fmt.Errorf("unmarshal users: %w", err)
    }

    return users, nil
}

// Batch write (up to 25 items)
func (d *DynamoDBClient) BatchCreateUsers(ctx context.Context, users []User) error {
    var writeRequests []types.WriteRequest

    for _, user := range users {
        user.PK = fmt.Sprintf("USER#%s", user.ID)
        user.SK = fmt.Sprintf("PROFILE#%s", user.ID)

        av, err := attributevalue.MarshalMap(user)
        if err != nil {
            return fmt.Errorf("marshal user: %w", err)
        }

        writeRequests = append(writeRequests, types.WriteRequest{
            PutRequest: &types.PutRequest{Item: av},
        })
    }

    _, err := d.client.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
        RequestItems: map[string][]types.WriteRequest{
            d.tableName: writeRequests,
        },
    })
    if err != nil {
        return fmt.Errorf("batch write: %w", err)
    }

    return nil
}

// Transaction write
func (d *DynamoDBClient) TransactCreateUser(ctx context.Context, user *User) error {
    user.PK = fmt.Sprintf("USER#%s", user.ID)
    user.SK = fmt.Sprintf("PROFILE#%s", user.ID)

    userAV, err := attributevalue.MarshalMap(user)
    if err != nil {
        return fmt.Errorf("marshal user: %w", err)
    }

    // Also create an email index entry
    emailIndex := map[string]types.AttributeValue{
        "PK":      &types.AttributeValueMemberS{Value: fmt.Sprintf("EMAIL#%s", user.Email)},
        "SK":      &types.AttributeValueMemberS{Value: fmt.Sprintf("USER#%s", user.ID)},
        "user_id": &types.AttributeValueMemberS{Value: user.ID},
    }

    _, err = d.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
        TransactItems: []types.TransactWriteItem{
            {
                Put: &types.Put{
                    TableName:           aws.String(d.tableName),
                    Item:                userAV,
                    ConditionExpression: aws.String("attribute_not_exists(PK)"),
                },
            },
            {
                Put: &types.Put{
                    TableName:           aws.String(d.tableName),
                    Item:                emailIndex,
                    ConditionExpression: aws.String("attribute_not_exists(PK)"),
                },
            },
        },
    })
    if err != nil {
        return fmt.Errorf("transact write: %w", err)
    }

    return nil
}
```

---

### Junior → FAANG: DynamoDB Data Modeling Fundamentals

DynamoDB's data model is not relational, and the biggest mistakes junior engineers make come from trying to use it like a relational database. In DynamoDB, queries are constrained to a single partition (defined by the partition key), and access patterns must be defined upfront during data modeling. Adding an access pattern after the table is in production is expensive (requires a full table scan and potentially a new Global Secondary Index with its own provisioned throughput).

The single-table design pattern (storing multiple entity types in one table with carefully chosen partition keys and sort keys) is the advanced pattern that enables efficient access to related data without joins. It requires upfront planning of all access patterns, which feels counterintuitive if you are accustomed to SQL's flexibility. Understanding when single-table design is appropriate (low-latency, high-volume access to well-defined access patterns) versus when a relational database is better (complex ad-hoc queries, reporting, frequent schema changes) is the foundational DynamoDB design decision.

First-job habit: before designing a DynamoDB table, write down every access pattern your application needs. Each access pattern must be directly supported by the table's key structure or by a Global Secondary Index. If you cannot list the access patterns upfront, you may be reaching for the wrong database.

### Senior @ FAANG: DynamoDB Architecture and Capacity Management at Scale

At staff level, DynamoDB is a foundational database service with specific failure modes and capacity constraints that need to be designed for explicitly. The hot partition problem is the most common cause of DynamoDB performance degradation at scale: if traffic is concentrated on a small number of partition keys, those partitions exhaust their allocated capacity and requests are throttled. The mitigation strategies are key distribution (using a composite partition key that spreads traffic), write sharding (adding a random suffix to the partition key for write-heavy partitions), and DAX (DynamoDB Accelerator) for read caching.

Capacity planning for DynamoDB requires understanding the relationship between item size, request units, and throughput. On-demand mode eliminates capacity planning but is expensive at high, consistent throughput. Provisioned mode with auto-scaling is more cost-efficient for predictable workloads but requires setting appropriate min/max capacity bounds and scaling cooldown periods. Getting these parameters wrong causes either over-provisioning (wasted cost) or under-provisioning (throttling during traffic spikes).

The operational concerns at FAANG scale: DynamoDB backups (on-demand backups for production, point-in-time recovery enabled for compliance), DynamoDB Streams for change data capture (enabling event-driven architectures where DynamoDB changes trigger Lambda or SQS processing), and cross-region replication with Global Tables (for multi-region active-active deployments where DynamoDB is the source of truth). Each of these is an architectural decision with cost and operational implications that needs to be evaluated and documented at the staff engineering level.
