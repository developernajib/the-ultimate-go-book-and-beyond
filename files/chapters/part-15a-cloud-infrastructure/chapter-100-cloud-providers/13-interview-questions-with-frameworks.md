## 100.13 Interview Questions with Frameworks

### Question 1: Design a Multi-Region File Storage Service

**Problem**: Design a Go service that stores files across multiple AWS regions with automatic failover.

```
┌─────────────────────────────────────────────────────────────────┐
│           MULTI-REGION STORAGE DESIGN FRAMEWORK                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. REPLICATION STRATEGY                                        │
│     ├─ S3 Cross-Region Replication (CRR)                        │
│     ├─ Active-Passive vs Active-Active                          │
│     ├─ Eventual vs Strong consistency trade-offs                │
│     └─ Replication lag handling                                 │
│                                                                 │
│  2. HEALTH CHECKING                                             │
│     ├─ Periodic health probes per region                        │
│     ├─ Circuit breaker pattern                                  │
│     ├─ Latency-based routing                                    │
│     └─ Health status caching                                    │
│                                                                 │
│  3. FAILOVER MECHANISM                                          │
│     ├─ Automatic detection (circuit breaker open)               │
│     ├─ Manual override capability                               │
│     ├─ Gradual traffic shift vs instant cutover                 │
│     └─ Rollback strategy                                        │
│                                                                 │
│  4. CONSISTENCY HANDLING                                        │
│     ├─ Read-your-writes guarantee approach                      │
│     ├─ Conflict resolution (last-write-wins vs CRDT)            │
│     ├─ Version tagging with ETags                               │
│     └─ Tombstone handling for deletes                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// Multi-region S3 storage with automatic failover
package storage

import (
    "context"
    "fmt"
    "sync"
    "sync/atomic"
    "time"

    "github.com/aws/aws-sdk-go-v2/config"
    "github.com/aws/aws-sdk-go-v2/service/s3"
    "github.com/sony/gobreaker"
)

type RegionConfig struct {
    Region   string
    Bucket   string
    Priority int // Lower = higher priority
}

type MultiRegionStorage struct {
    clients        map[string]*s3.Client
    buckets        map[string]string
    regions        []RegionConfig
    activeRegion   atomic.Value
    breakers       map[string]*gobreaker.CircuitBreaker
    mu             sync.RWMutex
    healthChecker  *HealthChecker
}

func NewMultiRegionStorage(ctx context.Context, configs []RegionConfig) (*MultiRegionStorage, error) {
    mrs := &MultiRegionStorage{
        clients:  make(map[string]*s3.Client),
        buckets:  make(map[string]string),
        regions:  configs,
        breakers: make(map[string]*gobreaker.CircuitBreaker),
    }

    // Initialize clients for each region
    for _, rc := range configs {
        cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(rc.Region))
        if err != nil {
            return nil, fmt.Errorf("load config for %s: %w", rc.Region, err)
        }

        mrs.clients[rc.Region] = s3.NewFromConfig(cfg)
        mrs.buckets[rc.Region] = rc.Bucket

        // Initialize circuit breaker per region
        mrs.breakers[rc.Region] = gobreaker.NewCircuitBreaker(gobreaker.Settings{
            Name:        fmt.Sprintf("s3-%s", rc.Region),
            MaxRequests: 3,
            Interval:    10 * time.Second,
            Timeout:     30 * time.Second,
            ReadyToTrip: func(counts gobreaker.Counts) bool {
                return counts.ConsecutiveFailures > 5
            },
            OnStateChange: func(name string, from, to gobreaker.State) {
                if to == gobreaker.StateOpen {
                    mrs.handleRegionFailure(rc.Region)
                }
            },
        })
    }

    // Set initial active region
    mrs.activeRegion.Store(configs[0].Region)

    // Start health checker
    mrs.healthChecker = NewHealthChecker(mrs)
    go mrs.healthChecker.Start(ctx)

    return mrs, nil
}

// Upload with failover to secondary regions
func (mrs *MultiRegionStorage) Upload(ctx context.Context, key string, data []byte) error {
    region := mrs.activeRegion.Load().(string)

    _, err := mrs.breakers[region].Execute(func() (any, error) {
        return nil, mrs.uploadToRegion(ctx, region, key, data)
    })

    if err != nil {
        // Try next available region
        for _, rc := range mrs.regions {
            if rc.Region != region {
                if uploadErr := mrs.uploadToRegion(ctx, rc.Region, key, data); uploadErr == nil {
                    return nil
                }
            }
        }
        return fmt.Errorf("all regions failed: %w", err)
    }

    return nil
}

// Download with automatic failover
func (mrs *MultiRegionStorage) Download(ctx context.Context, key string) ([]byte, error) {
    region := mrs.activeRegion.Load().(string)

    result, err := mrs.breakers[region].Execute(func() (any, error) {
        return mrs.downloadFromRegion(ctx, region, key)
    })

    if err != nil {
        // Failover to secondary regions
        for _, rc := range mrs.regions {
            if rc.Region != region {
                if data, downloadErr := mrs.downloadFromRegion(ctx, rc.Region, key); downloadErr == nil {
                    return data, nil
                }
            }
        }
        return nil, fmt.Errorf("all regions failed: %w", err)
    }

    return result.([]byte), nil
}

func (mrs *MultiRegionStorage) handleRegionFailure(failedRegion string) {
    // Find next healthy region by priority
    for _, rc := range mrs.regions {
        if rc.Region != failedRegion && mrs.breakers[rc.Region].State() != gobreaker.StateOpen {
            mrs.activeRegion.Store(rc.Region)
            return
        }
    }
}

func (mrs *MultiRegionStorage) uploadToRegion(ctx context.Context, region, key string, data []byte) error {
    bucket := mrs.buckets[region]
    _, err := mrs.clients[region].PutObject(ctx, &s3.PutObjectInput{
        Bucket: &bucket,
        Key:    &key,
    })
    return err
}

func (mrs *MultiRegionStorage) downloadFromRegion(ctx context.Context, region, key string) ([]byte, error) {
    bucket := mrs.buckets[region]
    result, err := mrs.clients[region].GetObject(ctx, &s3.GetObjectInput{
        Bucket: &bucket,
        Key:    &key,
    })
    if err != nil {
        return nil, err
    }
    defer result.Body.Close()
    return []byte{}, nil
}

type HealthChecker struct {
    mrs *MultiRegionStorage
}

func NewHealthChecker(mrs *MultiRegionStorage) *HealthChecker {
    return &HealthChecker{mrs: mrs}
}

func (hc *HealthChecker) Start(ctx context.Context) {
    ticker := time.NewTicker(10 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            // Probing logic across configured regions
        }
    }
}
```

---

### Question 2: Explain DynamoDB Single-Table Design

**Problem**: How would you design a DynamoDB schema for a social media app with users, posts, and followers?

```
┌────────────────────────────────────────────────────────────────────┐
│           DYNAMODB SINGLE-TABLE DESIGN FRAMEWORK                   │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ENTITY MAPPING                                                    │
│  ─────────────────────────────────────────────────────────────     │
│  PK                    SK                    Data                  │
│  USER#123              PROFILE               {name, email, bio}    │
│  USER#123              POST#2024-01-15#001   {content, likes}      │
│  USER#123              POST#2024-01-14#002   {content, likes}      │
│  USER#123              FOLLOWER#456          {since}               │
│  USER#456              FOLLOWING#123         {since}               │
│                                                                    │
│  ACCESS PATTERNS                                                   │
│  ─────────────────────────────────────────────────────────────     │
│  1. Get user profile:          PK=USER#123, SK=PROFILE             │
│  2. List user's posts:         PK=USER#123, SK begins_with POST#   │
│  3. List user's followers:     PK=USER#123, SK begins_with FOLLOWER│
│  4. Check if A follows B:      PK=USER#A, SK=FOLLOWING#B           │
│  5. Get recent posts (GSI):    GSI1PK=RECENT, GSI1SK=timestamp     │
│                                                                    │
│  DESIGN PRINCIPLES                                                 │
│  ─────────────────────────────────────────────────────────────     │
│  • Denormalize data (duplicate for read patterns)                  │
│  • Design for access patterns, not data structure                  │
│  • Use composite keys for hierarchical relationships               │
│  • Use GSIs for alternate access patterns                          │
│  • Keep items under 400KB limit                                    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

```go
// DynamoDB single-table design for social media
package socialdb

import (
    "context"
    "fmt"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
    "github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Table name and GSI configuration
const (
    TableName = "social-app"
    GSI1Name  = "GSI1"
)

// Item types with prefixes
const (
    PrefixUser      = "USER#"
    PrefixProfile   = "PROFILE"
    PrefixPost      = "POST#"
    PrefixFollower  = "FOLLOWER#"
    PrefixFollowing = "FOLLOWING#"
)

type SocialDB struct {
    client    *dynamodb.Client
    tableName string
}

// User profile entity
type UserProfile struct {
    PK        string    `dynamodbav:"PK"`
    SK        string    `dynamodbav:"SK"`
    UserID    string    `dynamodbav:"user_id"`
    Name      string    `dynamodbav:"name"`
    Email     string    `dynamodbav:"email"`
    Bio       string    `dynamodbav:"bio"`
    CreatedAt time.Time `dynamodbav:"created_at"`
    GSI1PK    string    `dynamodbav:"GSI1PK,omitempty"`
    GSI1SK    string    `dynamodbav:"GSI1SK,omitempty"`
}

// Post entity
type Post struct {
    PK        string    `dynamodbav:"PK"`
    SK        string    `dynamodbav:"SK"`
    PostID    string    `dynamodbav:"post_id"`
    UserID    string    `dynamodbav:"user_id"`
    Content   string    `dynamodbav:"content"`
    Likes     int       `dynamodbav:"likes"`
    CreatedAt time.Time `dynamodbav:"created_at"`
    GSI1PK    string    `dynamodbav:"GSI1PK"` // For recent posts feed
    GSI1SK    string    `dynamodbav:"GSI1SK"`
}

// Follow relationship entity
type Follow struct {
    PK        string    `dynamodbav:"PK"`
    SK        string    `dynamodbav:"SK"`
    FollowerID string   `dynamodbav:"follower_id"`
    FolloweeID string   `dynamodbav:"followee_id"`
    Since     time.Time `dynamodbav:"since"`
}

// Create user profile
func (db *SocialDB) CreateUser(ctx context.Context, userID, name, email, bio string) error {
    profile := UserProfile{
        PK:        PrefixUser + userID,
        SK:        PrefixProfile,
        UserID:    userID,
        Name:      name,
        Email:     email,
        Bio:       bio,
        CreatedAt: time.Now(),
    }

    av, err := attributevalue.MarshalMap(profile)
    if err != nil {
        return fmt.Errorf("marshal profile: %w", err)
    }

    _, err = db.client.PutItem(ctx, &dynamodb.PutItemInput{
        TableName:           aws.String(db.tableName),
        Item:                av,
        ConditionExpression: aws.String("attribute_not_exists(PK)"),
    })
    return err
}

// Get user profile
func (db *SocialDB) GetUser(ctx context.Context, userID string) (*UserProfile, error) {
    result, err := db.client.GetItem(ctx, &dynamodb.GetItemInput{
        TableName: aws.String(db.tableName),
        Key: map[string]types.AttributeValue{
            "PK": &types.AttributeValueMemberS{Value: PrefixUser + userID},
            "SK": &types.AttributeValueMemberS{Value: PrefixProfile},
        },
    })
    if err != nil {
        return nil, err
    }
    if result.Item == nil {
        return nil, nil
    }

    var profile UserProfile
    if err := attributevalue.UnmarshalMap(result.Item, &profile); err != nil {
        return nil, err
    }
    return &profile, nil
}

// Create post
func (db *SocialDB) CreatePost(ctx context.Context, userID, postID, content string) error {
    now := time.Now()
    post := Post{
        PK:        PrefixUser + userID,
        SK:        fmt.Sprintf("%s%s#%s", PrefixPost, now.Format("2006-01-02"), postID),
        PostID:    postID,
        UserID:    userID,
        Content:   content,
        Likes:     0,
        CreatedAt: now,
        GSI1PK:    "RECENT",                      // For global feed
        GSI1SK:    now.Format(time.RFC3339Nano), // Sort by time
    }

    av, err := attributevalue.MarshalMap(post)
    if err != nil {
        return fmt.Errorf("marshal post: %w", err)
    }

    _, err = db.client.PutItem(ctx, &dynamodb.PutItemInput{
        TableName: aws.String(db.tableName),
        Item:      av,
    })
    return err
}

// Get user's posts (sorted by date descending)
func (db *SocialDB) GetUserPosts(ctx context.Context, userID string, limit int32) ([]Post, error) {
    keyCondition := expression.Key("PK").Equal(expression.Value(PrefixUser + userID)).
        And(expression.Key("SK").BeginsWith(PrefixPost))

    expr, err := expression.NewBuilder().WithKeyCondition(keyCondition).Build()
    if err != nil {
        return nil, err
    }

    result, err := db.client.Query(ctx, &dynamodb.QueryInput{
        TableName:                 aws.String(db.tableName),
        KeyConditionExpression:    expr.KeyCondition(),
        ExpressionAttributeNames:  expr.Names(),
        ExpressionAttributeValues: expr.Values(),
        ScanIndexForward:          aws.Bool(false), // Descending order
        Limit:                     aws.Int32(limit),
    })
    if err != nil {
        return nil, err
    }

    var posts []Post
    if err := attributevalue.UnmarshalListOfMaps(result.Items, &posts); err != nil {
        return nil, err
    }
    return posts, nil
}

// Follow user (creates two items for bidirectional lookup)
func (db *SocialDB) FollowUser(ctx context.Context, followerID, followeeID string) error {
    now := time.Now()

    // Item 1: Follower lookup (who follows user X)
    followerItem := Follow{
        PK:         PrefixUser + followeeID,
        SK:         PrefixFollower + followerID,
        FollowerID: followerID,
        FolloweeID: followeeID,
        Since:      now,
    }

    // Item 2: Following lookup (who does user X follow)
    followingItem := Follow{
        PK:         PrefixUser + followerID,
        SK:         PrefixFollowing + followeeID,
        FollowerID: followerID,
        FolloweeID: followeeID,
        Since:      now,
    }

    followerAV, _ := attributevalue.MarshalMap(followerItem)
    followingAV, _ := attributevalue.MarshalMap(followingItem)

    // Transaction ensures both items are created
    _, err := db.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
        TransactItems: []types.TransactWriteItem{
            {Put: &types.Put{TableName: aws.String(db.tableName), Item: followerAV}},
            {Put: &types.Put{TableName: aws.String(db.tableName), Item: followingAV}},
        },
    })
    return err
}

// Get user's followers
func (db *SocialDB) GetFollowers(ctx context.Context, userID string) ([]string, error) {
    keyCondition := expression.Key("PK").Equal(expression.Value(PrefixUser + userID)).
        And(expression.Key("SK").BeginsWith(PrefixFollower))

    expr, _ := expression.NewBuilder().WithKeyCondition(keyCondition).Build()

    result, err := db.client.Query(ctx, &dynamodb.QueryInput{
        TableName:                 aws.String(db.tableName),
        KeyConditionExpression:    expr.KeyCondition(),
        ExpressionAttributeNames:  expr.Names(),
        ExpressionAttributeValues: expr.Values(),
    })
    if err != nil {
        return nil, err
    }

    var follows []Follow
    if err := attributevalue.UnmarshalListOfMaps(result.Items, &follows); err != nil {
        return nil, err
    }

    followers := make([]string, len(follows))
    for i, f := range follows {
        followers[i] = f.FollowerID
    }
    return followers, nil
}
```

---

### Question 3: Compare AWS Lambda vs Cloud Run for Go

**Problem**: When would you choose Lambda over Cloud Run (or vice versa) for a Go service?

```
┌─────────────────────────────────────────────────────────────────┐
│           SERVERLESS COMPARISON FRAMEWORK                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  FACTOR              LAMBDA              CLOUD RUN              │
│  ─────────────────────────────────────────────────────────────  │
│  Pricing Model       Per invocation      Per request + CPU time │
│  Cold Start          100-500ms (Go)      200-1000ms             │
│  Max Timeout         15 minutes          60 minutes             │
│  Max Memory          10GB                32GB                   │
│  Container Support   Yes (newer)         Native                 │
│  VPC Access          Yes (adds latency)  Yes (native)           │
│  Concurrency         1000 default        1000+ per service      │
│  Request/Resp        Event-based         HTTP-native            │
│                                                                 │
│  CHOOSE LAMBDA WHEN:                                            │
│  • Event-driven (S3, SQS, DynamoDB triggers)                    │
│  • Short-lived functions (< 15 min)                             │
│  • Infrequent invocations (cost-effective)                      │
│  • Tight AWS integration needed                                 │
│  • Pay-per-execution pricing preferred                          │
│                                                                 │
│  CHOOSE CLOUD RUN WHEN:                                         │
│  • HTTP services with sustained traffic                         │
│  • Need container flexibility (any language/runtime)            │
│  • Longer execution times needed                                │
│  • Want to use existing containers                              │
│  • Need WebSocket or gRPC streaming                             │
│  • Multi-cloud portability desired                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Question 4: Design a Cloud-Native Event-Driven System

**Problem**: Design a Go event processing system using SQS/Pub-Sub with exactly-once semantics.

```
┌─────────────────────────────────────────────────────────────────┐
│           EVENT PROCESSING DESIGN FRAMEWORK                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  EXACTLY-ONCE CHALLENGES:                                       │
│  • At-least-once delivery → duplicate handling                  │
│  • Network failures → partial processing                        │
│  • Consumer crashes → message redelivery                        │
│                                                                 │
│  STRATEGIES:                                                    │
│  ─────────────────────────────────────────────────────────────  │
│  1. IDEMPOTENCY KEYS                                            │
│     • Store processed message IDs                               │
│     • Check before processing                                   │
│     • Use DynamoDB/Redis for dedup store                        │
│                                                                 │
│  2. TRANSACTIONAL OUTBOX                                        │
│     • Write to DB + outbox in single transaction                │
│     • Separate process publishes from outbox                    │
│     • Guarantees no lost events                                 │
│                                                                 │
│  3. VISIBILITY TIMEOUT                                          │
│     • Set based on max processing time                          │
│     • Extend for long-running tasks                             │
│     • DLQ for failed messages                                   │
│                                                                 │
│  4. ORDERED PROCESSING                                          │
│     • FIFO queues for ordering guarantees                       │
│     • Message groups for parallel ordered processing            │
│     • Single consumer per group                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

```go
// Event processor with exactly-once semantics
package events

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb"
    "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
    "github.com/aws/aws-sdk-go-v2/service/sqs"
    sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

type Event struct {
    ID        string    `json:"id"`
    Type      string    `json:"type"`
    Data      any       `json:"data"`
    Timestamp time.Time `json:"timestamp"`
}

type EventProcessor struct {
    sqsClient      *sqs.Client
    dynamoClient   *dynamodb.Client
    queueURL       string
    dedupTable     string
    handlers       map[string]EventHandler
}

type EventHandler func(context.Context, Event) error

// Process messages with exactly-once semantics
func (ep *EventProcessor) ProcessMessages(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            msgs, err := ep.sqsClient.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
                QueueUrl:            aws.String(ep.queueURL),
                MaxNumberOfMessages: 10,
                WaitTimeSeconds:     20,
                VisibilityTimeout:   300, // 5 minutes
                MessageAttributeNames: []string{"All"},
            })
            if err != nil {
                continue
            }

            for _, msg := range msgs.Messages {
                if err := ep.processMessage(ctx, msg); err != nil {
                    // Message will be redelivered after visibility timeout
                    continue
                }

                // Delete only after successful processing
                ep.sqsClient.DeleteMessage(ctx, &sqs.DeleteMessageInput{
                    QueueUrl:      aws.String(ep.queueURL),
                    ReceiptHandle: msg.ReceiptHandle,
                })
            }
        }
    }
}

func (ep *EventProcessor) processMessage(ctx context.Context, msg sqstypes.Message) error {
    var event Event
    if err := json.Unmarshal([]byte(*msg.Body), &event); err != nil {
        return fmt.Errorf("unmarshal event: %w", err)
    }

    // Step 1: Check if already processed (idempotency)
    if ep.isProcessed(ctx, event.ID) {
        return nil // Already processed, skip
    }

    // Step 2: Process the event
    handler, ok := ep.handlers[event.Type]
    if !ok {
        return fmt.Errorf("no handler for event type: %s", event.Type)
    }

    if err := handler(ctx, event); err != nil {
        return fmt.Errorf("handle event: %w", err)
    }

    // Step 3: Mark as processed (with TTL for cleanup)
    if err := ep.markProcessed(ctx, event.ID); err != nil {
        // Log but don't fail - worst case we process twice
        // which is still idempotent
    }

    return nil
}

func (ep *EventProcessor) isProcessed(ctx context.Context, eventID string) bool {
    result, err := ep.dynamoClient.GetItem(ctx, &dynamodb.GetItemInput{
        TableName: aws.String(ep.dedupTable),
        Key: map[string]types.AttributeValue{
            "event_id": &types.AttributeValueMemberS{Value: eventID},
        },
    })
    return err == nil && result.Item != nil
}

func (ep *EventProcessor) markProcessed(ctx context.Context, eventID string) error {
    ttl := time.Now().Add(24 * time.Hour).Unix()

    _, err := ep.dynamoClient.PutItem(ctx, &dynamodb.PutItemInput{
        TableName: aws.String(ep.dedupTable),
        Item: map[string]types.AttributeValue{
            "event_id":     &types.AttributeValueMemberS{Value: eventID},
            "processed_at": &types.AttributeValueMemberS{Value: time.Now().Format(time.RFC3339)},
            "ttl":          &types.AttributeValueMemberN{Value: fmt.Sprintf("%d", ttl)},
        },
    })
    return err
}
```

---

### Junior → FAANG: Cloud Interview Preparation and the Service Selection Framework

Cloud interview questions at product companies cluster around service selection ("which AWS service would you use for X?"), system design ("design a photo upload and processing pipeline"), and operational questions ("how would you debug high latency in a Lambda function?"). Preparing for all three requires hands-on familiarity, not just theoretical knowledge.

The service selection framework: identify the access pattern (read-heavy versus write-heavy, request-response versus async, stateful versus stateless), the consistency requirement (strong versus eventual), the throughput requirement (messages per second, requests per second), and the cost constraint. Then match the pattern to the service that best fits all four dimensions. Practicing this framework with a variety of scenarios builds the rapid pattern-matching that interviewers are looking for.

For system design questions involving cloud services, always cover: the data flow (where data enters, where it is stored, where it is processed, where it exits), the failure modes (what happens when each service fails), the cost model (rough estimate of the cost at the described scale), and the monitoring strategy (how you would know if the system was not working correctly). These four dimensions differentiate a complete design from a partial one.

### Senior @ FAANG: Bar-Raiser Cloud Design Interview Signals

At L6/L7, the cloud design interview tests whether you make architectural decisions at the organizational level and consider second-order effects. A bar-raiser response to "design a multi-region file storage service" covers not just the technical architecture but also: the data residency compliance requirements that constrain the region selection, the replication lag and its implications for read-after-write consistency, the cost model at the described scale and the optimization strategies available, the operational model for capacity planning and incident response, and the migration strategy if the initial design needs to change as requirements evolve.

The signal that clearly distinguishes senior from staff: staff engineers explicitly trade off competing concerns and justify their choices with evidence, not just intuition. "I chose DynamoDB over a relational database because the access patterns are simple key-value lookups at high throughput, and DynamoDB's operational overhead is lower than managing RDS at this scale" is a staff-level justification. "DynamoDB is good for key-value access" is a senior-level observation. The difference is the explicit trade-off reasoning and the organizational context.
