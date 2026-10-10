## 114.4 Feature Store Implementation

A feature store is a centralized system for storing, discovering, and serving ML features. It bridges the gap between model training (offline) and model serving (online).

### Feature Store Architecture

A feature store separates online storage (Redis/Cassandra for low-latency serving at inference time) from offline storage (S3/Parquet for batch training jobs), with a sync process keeping them consistent. The feature registry tracks metadata, schemas, and data lineage so models always consume the same feature definitions in training and serving, preventing training-serving skew.

```
┌──────────────────────────────────────────────────────────────────┐
│                        Feature Store                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────┐              ┌────────────────────┐      │
│  │  Offline Storage   │              │  Online Storage    │      │
│  │   (S3/Parquet)     │             │  (Redis/Cassandra) │       │
│  │                    │              │                    │      │
│  │  • Historical      │              │  • Latest values   │      │
│  │    features        │              │  • Low latency     │      │
│  │  • Training data   │◄────sync────│  • High throughput │       │
│  │  • Batch access    │              │  • Point queries   │      │
│  └────────┬───────────┘              └─────────┬──────────┘      │
│           │                                     │                │
│           │                                     │                │
│           ▼                                     ▼                │
│  ┌────────────────────┐              ┌────────────────────┐      │
│  │  Training Jobs     │              │ Serving Services   │      │
│  │  • Batch features  │              │ • Real-time lookup │      │
│  │  • Point-in-time   │              │ • Feature vectors  │      │
│  │    correct joins   │              │ • Low latency      │      │
│  └────────────────────┘              └────────────────────┘      │
│                                                                  │
│                    ┌────────────────────┐                        │
│                    │  Feature Registry  │                        │
│                    │  • Metadata        │                        │
│                    │  • Schemas         │                        │
│                    │  • Lineage         │                        │
│                    └────────────────────┘                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Feature Store Implementation

The core feature store type manages an in-memory feature registry alongside an online store for serving and an offline store for training exports. The two paths stay deliberately separate: `GetOnline` and `WriteOnline` talk to the low-latency store, `GetHistorical` and `WriteOffline` talk to the batch store, and the registry validates that every requested feature is one somebody actually declared.

Notice what this design does *not* do, because the omissions are the interesting part. There is no fallback from online to offline on a miss: the offline store's latency belongs to a batch job, and putting it in the request path would turn a cache miss into a multi-second stall on the checkout page. There is no atomic write across both stores either. Those are two different systems with no shared transaction, so a dual write can leave them disagreeing, and pretending otherwise is how you end up debugging a skew you have been told cannot happen. Production feature stores resolve this by making one path the source of truth and materializing to the other, accepting a bounded, measured window of inconsistency rather than an imaginary guarantee.

```go
// pkg/featurestore/types.go
package featurestore

import (
    "context"
    "fmt"
    "sync"
    "time"
)

// Feature represents a single feature
type Feature struct {
    Name        string
    Type        FeatureType
    Description string
    Version     int
    Created     time.Time
    Updated     time.Time
}

type FeatureType string

const (
    FeatureTypeInt     FeatureType = "int"
    FeatureTypeFloat   FeatureType = "float"
    FeatureTypeString  FeatureType = "string"
    FeatureTypeBool    FeatureType = "bool"
    FeatureTypeVector  FeatureType = "vector"
)

// FeatureValue represents a feature value for an entity
type FeatureValue struct {
    EntityID  string
    Feature   string
    Value     any
    Timestamp time.Time
}

// FeatureVector represents a collection of features for an entity
type FeatureVector struct {
    EntityID  string
    Features  map[string]any
    Timestamp time.Time
}

// FeatureGroup groups related features
type FeatureGroup struct {
    Name        string
    Features    []string
    EntityType  string
    Description string
}

// OnlineStore handles real-time feature serving
type OnlineStore interface {
    Get(ctx context.Context, entityID string, features []string) (*FeatureVector, error)
    Set(ctx context.Context, fv *FeatureVector) error
    Delete(ctx context.Context, entityID string) error
}

// OfflineStore handles batch feature access
type OfflineStore interface {
    GetHistorical(ctx context.Context, entityIDs []string, features []string,
        startTime, endTime time.Time) ([]*FeatureVector, error)
    Write(ctx context.Context, vectors []*FeatureVector) error
}

// FeatureStore provides unified feature access
type FeatureStore struct {
    online   OnlineStore
    offline  OfflineStore
    registry *FeatureRegistry
    mu       sync.RWMutex
}

// FeatureRegistry manages feature metadata
type FeatureRegistry struct {
    features map[string]*Feature
    groups   map[string]*FeatureGroup
    mu       sync.RWMutex
}

func NewFeatureRegistry() *FeatureRegistry {
    return &FeatureRegistry{
        features: make(map[string]*Feature),
        groups:   make(map[string]*FeatureGroup),
    }
}

func (r *FeatureRegistry) RegisterFeature(feature *Feature) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    feature.Created = time.Now()
    feature.Updated = time.Now()
    r.features[feature.Name] = feature
    return nil
}

func (r *FeatureRegistry) GetFeature(name string) (*Feature, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    feature, exists := r.features[name]
    if !exists {
        return nil, fmt.Errorf("feature %s not found", name)
    }

    return feature, nil
}

func (r *FeatureRegistry) RegisterGroup(group *FeatureGroup) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    // Validate all features exist
    for _, featureName := range group.Features {
        if _, exists := r.features[featureName]; !exists {
            return fmt.Errorf("feature %s not found in registry", featureName)
        }
    }

    r.groups[group.Name] = group
    return nil
}

func (r *FeatureRegistry) GetGroup(name string) (*FeatureGroup, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()

    group, exists := r.groups[name]
    if !exists {
        return nil, fmt.Errorf("feature group %s not found", name)
    }

    return group, nil
}

func NewFeatureStore(online OnlineStore, offline OfflineStore) *FeatureStore {
    return &FeatureStore{
        online:   online,
        offline:  offline,
        registry: NewFeatureRegistry(),
    }
}

// GetOnline retrieves features from the online store
func (fs *FeatureStore) GetOnline(ctx context.Context, entityID string,
    features []string) (*FeatureVector, error) {

    // Validate features exist
    for _, feature := range features {
        if _, err := fs.registry.GetFeature(feature); err != nil {
            return nil, err
        }
    }

    return fs.online.Get(ctx, entityID, features)
}

// GetOnlineByGroup retrieves feature group from online store
func (fs *FeatureStore) GetOnlineByGroup(ctx context.Context, entityID string,
    groupName string) (*FeatureVector, error) {

    group, err := fs.registry.GetGroup(groupName)
    if err != nil {
        return nil, err
    }

    return fs.online.Get(ctx, entityID, group.Features)
}

// WriteOnline writes features to the online store
func (fs *FeatureStore) WriteOnline(ctx context.Context, fv *FeatureVector) error {
    return fs.online.Set(ctx, fv)
}

// GetHistorical retrieves historical features for training
func (fs *FeatureStore) GetHistorical(ctx context.Context, entityIDs []string,
    features []string, startTime, endTime time.Time) ([]*FeatureVector, error) {

    return fs.offline.GetHistorical(ctx, entityIDs, features, startTime, endTime)
}

// WriteOffline writes features to offline storage
func (fs *FeatureStore) WriteOffline(ctx context.Context, vectors []*FeatureVector) error {
    return fs.offline.Write(ctx, vectors)
}

// RegisterFeature registers a feature in the registry
func (fs *FeatureStore) RegisterFeature(feature *Feature) error {
    return fs.registry.RegisterFeature(feature)
}

// RegisterGroup registers a feature group
func (fs *FeatureStore) RegisterGroup(group *FeatureGroup) error {
    return fs.registry.RegisterGroup(group)
}
```

### Redis Online Store Implementation

Redis serves as the low-latency online feature store in ML serving pipelines, providing sub-millisecond feature retrieval at inference request time. The following implementation demonstrates feature key design, serialization format selection, and TTL management for keeping online features fresh.

```go
// pkg/featurestore/redis.go
package featurestore

import (
    "context"
    "encoding/json"
    "errors"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// RedisOnlineStore implements OnlineStore using Redis
type RedisOnlineStore struct {
    client *redis.Client
    ttl    time.Duration
}

func NewRedisOnlineStore(addr string, ttl time.Duration) *RedisOnlineStore {
    client := redis.NewClient(&redis.Options{
        Addr:         addr,
        DB:           0,
        DialTimeout:  5 * time.Second,
        ReadTimeout:  3 * time.Second,
        WriteTimeout: 3 * time.Second,
        PoolSize:     10,
    })

    return &RedisOnlineStore{
        client: client,
        ttl:    ttl,
    }
}

func (r *RedisOnlineStore) Get(ctx context.Context, entityID string,
    features []string) (*FeatureVector, error) {

    // Use Redis hash to store all features for an entity
    key := fmt.Sprintf("features:%s", entityID)

    values, err := r.client.HMGet(ctx, key, features...).Result()
    if err != nil {
        return nil, fmt.Errorf("redis HMGet failed: %w", err)
    }

    fv := &FeatureVector{
        EntityID:  entityID,
        Features:  make(map[string]any),
        Timestamp: time.Now(),
    }

    // HMGet returns a nil entry for any field that is absent, and returns no
    // error when the key itself does not exist. A miss is therefore silent:
    // the loop below simply leaves the feature out of the map.
    //
    // That silence is dangerous in a feature store. The caller receives a
    // FeatureVector that looks valid, the model sees a missing feature, and
    // whatever the serving code does next (substitute a zero, use Go's zero
    // value, skip the feature) is a decision nobody made deliberately. Track
    // which features were actually found and let the caller decide.
    var missing []string
    for i, feature := range features {
        if values[i] == nil {
            missing = append(missing, feature)
            continue
        }

        // Deserialize JSON value
        var value any
        if str, ok := values[i].(string); ok {
            if err := json.Unmarshal([]byte(str), &value); err != nil {
                return nil, fmt.Errorf("failed to unmarshal feature %s: %w",
                    feature, err)
            }
            fv.Features[feature] = value
        }
    }

    if len(missing) > 0 {
        return fv, fmt.Errorf("%w: entity %s missing features %v",
            ErrFeaturesMissing, entityID, missing)
    }

    return fv, nil
}

// ErrFeaturesMissing signals a partial online-store hit. It is a sentinel so
// callers can decide per model whether a partial vector is usable, imputable,
// or grounds for failing the request. Returning the vector alongside the error
// lets them inspect what did arrive.
var ErrFeaturesMissing = errors.New("features missing from online store")

func (r *RedisOnlineStore) Set(ctx context.Context, fv *FeatureVector) error {
    key := fmt.Sprintf("features:%s", fv.EntityID)

    // Serialize features to JSON
    fields := make(map[string]any)
    for feature, value := range fv.Features {
        jsonValue, err := json.Marshal(value)
        if err != nil {
            return fmt.Errorf("failed to marshal feature %s: %w", feature, err)
        }
        fields[feature] = string(jsonValue)
    }

    // Write the fields and refresh the TTL together.
    //
    // HSet, not HMSet: Redis deprecated HMSET once HSET learned to take
    // multiple field/value pairs, and go-redis keeps HMSet only for
    // compatibility.
    //
    // A pipeline is not a transaction. It batches these two commands into one
    // round trip, which is the point, but it does not make them atomic: use
    // TxPipeline if you need the MULTI/EXEC guarantee that nothing observes
    // the hash between the write and the Expire.
    pipe := r.client.Pipeline()
    pipe.HSet(ctx, key, fields)
    if r.ttl > 0 {
        pipe.Expire(ctx, key, r.ttl)
    }

    _, err := pipe.Exec(ctx)
    if err != nil {
        return fmt.Errorf("redis pipeline failed: %w", err)
    }

    return nil
}

func (r *RedisOnlineStore) Delete(ctx context.Context, entityID string) error {
    key := fmt.Sprintf("features:%s", entityID)
    return r.client.Del(ctx, key).Err()
}

func (r *RedisOnlineStore) Close() error {
    return r.client.Close()
}
```

### S3 Offline Store Implementation

S3-compatible object storage serves as the high-capacity offline feature store for batch training jobs that process historical feature data. `Write` lays objects out under a `date=` partition, which is the layout every warehouse query engine expects.

`GetHistorical` below is the naive read, and it is worth studying as a counterexample before you copy it. It lists every object under the prefix regardless of the requested time range, downloads all of them, and decodes each fully into memory to throw most of the rows away. The partitioning that `Write` carefully created is ignored on the read side, so the scan cost grows with total history rather than with the window you asked for. Three fixes turn this into something you could run: push the date range into the `Prefix` so S3 only lists the partitions in scope, stream the decode rather than materializing whole arrays, and store Parquet instead of JSON so the reader can skip column chunks and row groups it does not need. The JSON here keeps the example readable, and it is the first thing to go.

```go
// pkg/featurestore/s3.go
package featurestore

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3OfflineStore implements OfflineStore using S3
type S3OfflineStore struct {
    client     *s3.Client
    bucket     string
    pathPrefix string
}

func NewS3OfflineStore(client *s3.Client, bucket, pathPrefix string) *S3OfflineStore {
    return &S3OfflineStore{
        client:     client,
        bucket:     bucket,
        pathPrefix: pathPrefix,
    }
}

func (s *S3OfflineStore) GetHistorical(ctx context.Context, entityIDs []string,
    features []string, startTime, endTime time.Time) ([]*FeatureVector, error) {

    // In production, this would read Parquet files efficiently
    // For this example, we'll use JSON

    var results []*FeatureVector

    // List objects in time range
    prefix := fmt.Sprintf("%s/features/", s.pathPrefix)

    listOutput, err := s.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
        Bucket: aws.String(s.bucket),
        Prefix: aws.String(prefix),
    })
    if err != nil {
        return nil, fmt.Errorf("failed to list S3 objects: %w", err)
    }

    // Download and filter feature vectors
    for _, obj := range listOutput.Contents {
        // Parse timestamp from key
        // In production, use partitioning by date

        getOutput, err := s.client.GetObject(ctx, &s3.GetObjectInput{
            Bucket: aws.String(s.bucket),
            Key:    obj.Key,
        })
        if err != nil {
            continue
        }

        var vectors []*FeatureVector
        if err := json.NewDecoder(getOutput.Body).Decode(&vectors); err != nil {
            getOutput.Body.Close()
            continue
        }
        getOutput.Body.Close()

        // Filter by entity IDs and time range
        entityMap := make(map[string]bool)
        for _, id := range entityIDs {
            entityMap[id] = true
        }

        for _, fv := range vectors {
            if entityMap[fv.EntityID] &&
               fv.Timestamp.After(startTime) &&
               fv.Timestamp.Before(endTime) {

                // Filter to requested features
                filtered := &FeatureVector{
                    EntityID:  fv.EntityID,
                    Features:  make(map[string]any),
                    Timestamp: fv.Timestamp,
                }

                for _, feature := range features {
                    if value, exists := fv.Features[feature]; exists {
                        filtered.Features[feature] = value
                    }
                }

                results = append(results, filtered)
            }
        }
    }

    return results, nil
}

func (s *S3OfflineStore) Write(ctx context.Context, vectors []*FeatureVector) error {
    if len(vectors) == 0 {
        return nil
    }

    // Partition by date for efficient querying
    date := vectors[0].Timestamp.Format("2006-01-02")
    key := fmt.Sprintf("%s/features/date=%s/%d.json",
        s.pathPrefix, date, time.Now().UnixNano())

    // Serialize to JSON (in production, use Parquet)
    data, err := json.Marshal(vectors)
    if err != nil {
        return fmt.Errorf("failed to marshal vectors: %w", err)
    }

    _, err = s.client.PutObject(ctx, &s3.PutObjectInput{
        Bucket: aws.String(s.bucket),
        Key:    aws.String(key),
        Body:   bytes.NewReader(data),
    })
    if err != nil {
        return fmt.Errorf("failed to write to S3: %w", err)
    }

    return nil
}
```

### Feature Store Example

This end-to-end example registers feature definitions, writes a computed feature vector for one user, and reads it back both by group and by explicit feature list. It shows the write-once-read-many shape that online serving depends on: features are computed ahead of time, written to the online store, and fetched by point lookup during inference rather than recomputed per request.

```go
// examples/feature-store/main.go
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    "yourmodule/pkg/featurestore"
)

func main() {
    // Initialize stores
    onlineStore := featurestore.NewRedisOnlineStore("localhost:6379", 24*time.Hour)
    defer onlineStore.Close()

    // Create feature store
    fs := featurestore.NewFeatureStore(onlineStore, nil)

    // Register features
    features := []*featurestore.Feature{
        {
            Name:        "user_age",
            Type:        featurestore.FeatureTypeInt,
            Description: "User age in years",
            Version:     1,
        },
        {
            Name:        "user_lifetime_value",
            Type:        featurestore.FeatureTypeFloat,
            Description: "Total revenue from user",
            Version:     1,
        },
        {
            Name:        "user_country",
            Type:        featurestore.FeatureTypeString,
            Description: "User country code",
            Version:     1,
        },
        {
            Name:        "user_is_premium",
            Type:        featurestore.FeatureTypeBool,
            Description: "Whether user has premium subscription",
            Version:     1,
        },
    }

    for _, feature := range features {
        if err := fs.RegisterFeature(feature); err != nil {
            log.Fatal(err)
        }
    }

    // Register feature group
    group := &featurestore.FeatureGroup{
        Name:        "user_profile",
        EntityType:  "user",
        Features:    []string{"user_age", "user_lifetime_value", "user_country", "user_is_premium"},
        Description: "User profile features",
    }

    if err := fs.RegisterGroup(group); err != nil {
        log.Fatal(err)
    }

    // Write features to online store
    ctx := context.Background()

    userFeatures := &featurestore.FeatureVector{
        EntityID: "user_12345",
        Features: map[string]any{
            "user_age":             28,
            "user_lifetime_value":  1250.50,
            "user_country":         "US",
            "user_is_premium":      true,
        },
        Timestamp: time.Now(),
    }

    if err := fs.WriteOnline(ctx, userFeatures); err != nil {
        log.Fatal("Failed to write features:", err)
    }

    fmt.Println("Features written successfully")

    // Read features from online store
    retrievedFeatures, err := fs.GetOnlineByGroup(ctx, "user_12345", "user_profile")
    if err != nil {
        log.Fatal("Failed to get features:", err)
    }

    fmt.Printf("\nRetrieved features for user_12345:\n")
    for feature, value := range retrievedFeatures.Features {
        fmt.Printf("  %s: %v\n", feature, value)
    }

    // Example: Get specific features
    specificFeatures, err := fs.GetOnline(ctx, "user_12345",
        []string{"user_age", "user_is_premium"})
    if err != nil {
        log.Fatal(err)
    }

    fmt.Printf("\nSpecific features:\n")
    fmt.Printf("  Age: %v\n", specificFeatures.Features["user_age"])
    fmt.Printf("  Premium: %v\n", specificFeatures.Features["user_is_premium"])
}
```

Two details in this example are load-bearing. The store is constructed with a nil offline store, which is fine only because nothing here calls `GetHistorical`: a real deployment wires both. And note that `user_age` round-trips through JSON, so the `28` written as an `int` comes back as a `float64`. That is JSON's only number type, not a bug in the store, but it is exactly the kind of quiet type drift that makes an online feature disagree with its offline twin. Decide on the wire types deliberately and assert them on read.

### Junior → FAANG: Feature Stores as the Solution to Training-Serving Skew

The feature store is the component that prevents training-serving skew by construction. Without a feature store, the data scientist computes features in a Python notebook using one set of transformation rules, and the serving engineer computes the same features in Go using a separately written implementation. Subtle differences accumulate: a slightly different missing value strategy, a different normalization denominator, a different categorical encoding for rare values. The model was validated against the Python features but serves against the Go features, and the divergence is invisible until it causes a production incident.

With a feature store, the transformation logic is defined once in a shared specification and executed identically in both the offline (Python, batch) and online (Go, real-time) contexts. The feature store becomes the contract that guarantees consistency. Understanding this architecture and being able to explain it in an interview is a significant differentiator for ML infrastructure candidates.

For interview prep, be able to describe the two modes of the feature store: offline serving (loading historical feature snapshots for model training) and online serving (retrieving current feature values for real-time inference). The offline path reads from a data warehouse or object storage. The online path reads from a low-latency key-value store like Redis or DynamoDB. The same feature definitions drive both paths. A candidate who can draw this dual-path architecture and explain the consistency guarantees is demonstrating FAANG-level understanding of feature store design.

### Senior @ FAANG: Feature Store as Platform Infrastructure

At FAANG scale, a feature store is a multi-team platform that must satisfy conflicting requirements simultaneously. Model teams need the ability to define new features quickly without platform team involvement. The platform team needs the ability to enforce data quality standards, manage storage costs, and ensure low-latency serving without being blocked by individual model team requests. The solution is a self-service feature registration API with automated validation: model teams define features in a schema, the platform validates the schema against quality standards, and the platform provisions the storage and computation resources automatically.

Feature freshness SLOs are a senior-level design decision. Different features have different freshness requirements: a user's account balance might need to be fresh within 5 seconds for fraud detection, while a user's 30-day purchase history might be acceptable with 4-hour staleness. The feature store must enforce freshness guarantees and expose freshness metadata so that models and monitoring systems can detect when a feature is stale. Designing the staleness detection and alert system for a feature store with hundreds of features across dozens of staleness SLOs requires careful data modeling and alerting architecture.

Feature discovery and documentation are underinvested in most organizations and are a significant source of engineering waste. When a model team needs to understand whether a specific feature already exists, they should be able to search a feature catalog rather than asking across Slack channels. The feature catalog should record: the feature definition, the transformation logic, the upstream data sources, the current staleness, the models that use it, and the owner team. Building and maintaining this catalog is a platform team responsibility that pays dividends across every model team.

At L6, feature store governance includes the policy for feature deprecation. Features that are no longer used by any model should be deprecated and eventually deleted to reduce storage costs and computation overhead. But deprecation requires coordinating with every model team that might have used the feature in the past for reproducibility purposes (to reproduce a training run from six months ago, you might need features that are no longer actively served). Designing a retention policy that balances cost savings with reproducibility requirements, and driving adoption of that policy across model teams, is a staff-level organizational challenge.

Privacy and compliance requirements add another dimension to feature store governance. Features derived from user behavior data may be subject to GDPR right-to-erasure requirements, meaning that when a user requests deletion, their feature values must be purged from the online store, the offline store, and any training datasets that used those features. Designing the feature store to support efficient per-user deletion across all storage tiers, and auditing the compliance of existing feature pipelines, is a work stream that senior engineers must plan and execute in coordination with the privacy and legal teams.
