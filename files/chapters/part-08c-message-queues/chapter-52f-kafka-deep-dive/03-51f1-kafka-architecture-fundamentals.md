## 52F.1 Kafka Architecture Fundamentals

Understanding Kafka's architecture is essential before writing a single line of producer or consumer code. Kafka is not a traditional message broker - it is a distributed, partitioned, replicated commit log service.

### Brokers, Topics, Partitions, and Segments

A **broker** is a single Kafka server process. A cluster typically runs 3 to hundreds of brokers depending on throughput requirements. Each broker is identified by a unique integer ID and can handle hundreds of thousands of reads and writes per second.

A **topic** is a named feed of messages - think of it as a category or table name. Topics are logical groupings. The physical storage unit is the **partition**.

A **partition** is an ordered, immutable sequence of records. Each record within a partition gets a monotonically increasing **offset** - a 64-bit integer that uniquely identifies that record within the partition. Partitions are the unit of parallelism in Kafka: more partitions means more consumers can read in parallel.

A **segment** is the physical file on disk that holds partition data. Each partition is split into segments (default 1 GB or 7 days). Old segments are eligible for deletion or compaction based on retention policies.

```
Topic "orders" with 3 partitions:

Partition 0:  [0] [1] [2] [3] [4] [5] [6] [7] ... → Append only
               │                               │
               oldest                          newest (high-water mark)

Partition 1:  [0] [1] [2] [3] [4] [5] ...
               │                       │
               oldest                  newest

Partition 2:  [0] [1] [2] [3] [4] [5] [6] [7] [8] [9] ...
               │                                       │
               oldest                                  newest

Each partition maps to disk segments:

Partition 0/
├── 00000000000000000000.log    ← Segment file (messages 0-15234)
├── 00000000000000000000.index  ← Offset index
├── 00000000000000000000.timeindex ← Timestamp index
├── 00000000000000015235.log    ← Next segment (messages 15235+)
├── 00000000000000015235.index
└── 00000000000000015235.timeindex
```

### The Commit Log: Append-Only Model

Kafka's core abstraction is the **commit log** - an append-only, ordered sequence of records. This design choice has profound implications:

1. **Sequential I/O**: Writes always append to the end of a segment file. Sequential disk writes are dramatically faster than random writes - often matching or exceeding network throughput. On modern SSDs, Kafka achieves 800 MB/s+ write throughput per broker.

2. **Zero-Copy Transfers**: Kafka uses the `sendfile` system call to transfer data directly from the page cache to the network socket, bypassing user-space entirely. This eliminates two memory copies and two context switches per read.

3. **Immutability**: Once written, records are never modified. This eliminates the need for write locks, enables aggressive caching, and makes replication straightforward.

4. **Time-Based and Size-Based Retention**: Records are retained for a configurable period (default 7 days) or size limit. Kafka does not track whether a record has been consumed - consumers track their own position via offsets.

### Partition Leadership and Replication

Every partition has exactly one **leader** broker and zero or more **follower** brokers. All produce and consume requests go to the leader. Followers passively replicate the leader's log.

The **In-Sync Replica Set (ISR)** contains all replicas that are fully caught up with the leader (within `replica.lag.time.max.ms`, default 30 seconds). When a leader fails, a new leader is elected from the ISR.

```
Partition 0 Replication (replication-factor=3):

Broker 0 (LEADER)          Broker 1 (FOLLOWER/ISR)    Broker 2 (FOLLOWER/ISR)
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│ [0][1][2][3][4]  │──────►│ [0][1][2][3][4]  │       │ [0][1][2][3][4]  │
│                  │       │                  │       │                  │
│ High Watermark: 4│──────►│ Replicated: 4    │       │ Replicated: 4    │
└──────────────────┘       └──────────────────┘       └──────────────────┘
        │                                                      ▲
        └──────────────────────────────────────────────────────┘
                            Replication

Producer writes → Leader only
Consumer reads  → Leader only (unless rack-aware consumer configured)

If Broker 0 fails:
  → Controller detects failure
  → Broker 1 or 2 elected as new leader (from ISR)
  → Producers/Consumers redirect to new leader
  → Zero data loss (if acks=all was used)
```

### KRaft Mode (ZooKeeper Removed in Kafka 4.0)

Historically, Kafka depended on Apache ZooKeeper for metadata management, broker registration, topic configuration, partition leadership election, and consumer group coordination. This external dependency added operational complexity and imposed scalability limits.

**KRaft (Kafka Raft)** replaces ZooKeeper with a native Raft-based consensus protocol. The timeline:

- Kafka 2.8 (2021): KRaft early access, not production-ready
- Kafka 3.3 (2022): KRaft marked production-ready
- Kafka 3.5 (2023): KRaft is the default for new clusters. ZooKeeper deprecated
- **Kafka 4.0 (March 2025): ZooKeeper mode removed entirely, KRaft is the only supported mode**
- Kafka 4.1 (September 2025): KRaft refinements, share groups preview, new Streams rebalance protocol

If you are running Kafka 3.x with ZooKeeper, you must migrate to KRaft before upgrading to 4.x. Migration uses the bridge release path (3.5/3.6 with `zookeeper.metadata.migration.enable=true`) documented in KIP-866.

In KRaft mode:

- A subset of brokers act as **controllers** running the Raft consensus protocol (typically 3 or 5 controllers for quorum)
- Cluster metadata (topics, partitions, ACLs, configs) is stored in an internal topic `__cluster_metadata`, replicated via Raft across controllers
- The active controller streams metadata deltas to all brokers. brokers keep a local replica and do not need to round-trip to the controller for reads
- Partition leadership elections are faster (sub-second vs seconds with ZooKeeper)
- Cluster startup and recovery is simpler (no ZooKeeper ensemble to manage, no split-brain between ZK and Kafka)
- Scalability improves: KRaft supports millions of partitions per cluster vs roughly 200K with ZooKeeper
- Combined mode (controller + broker on same node) is supported for dev/test but **not recommended for production**, isolate controllers on dedicated nodes

```
ZooKeeper Mode (Legacy):                KRaft Mode (Default since 3.5+):

┌─────────────┐                         ┌─────────────┐
│  ZooKeeper  │                         │  Broker 0   │
│  Ensemble   │                         │ (Controller)│ 
│  (3+ nodes) │◄──── metadata ────┐     │ ┌─────────┐ │
└─────────────┘                   │     │ │  Raft   │ │
                                  │     │ │ Quorum  │ │
┌─────────────┐                   │     │ └────┬────┘ │
│  Broker 0   │───────────────────┤     └──────┼──────┘
└─────────────┘                   │            │
┌─────────────┐                   │     ┌──────┼──────┐
│  Broker 1   │───────────────────┤     │  Broker 1   │
└─────────────┘                   │     │ (Controller)│ 
┌─────────────┐                   │     │ ┌─────────┐ │
│  Broker 2   │───────────────────┘     │ │  Raft   │ │
└─────────────┘                         │ │ Quorum  │ │
                                        │ └────┬────┘ │
Drawbacks:                              └──────┼──────┘
- Extra infra to manage                        │
- Split-brain risks                     ┌──────┼──────┐
- Slow leader election                  │  Broker 2   │
- Limited to ~200K partitions           │ (Controller)│ 
                                        │ ┌─────────┐ │
                                        │ │  Raft   │ │
                                        │ │ Quorum  │ │
                                        │ └─────────┘ │
                                        └─────────────┘

                                        Benefits:
                                        - No external dependency
                                        - Faster failover (<1s)
                                        - Millions of partitions
                                        - Simpler operations
```

### Key Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `num.partitions` | 1 | Default partitions for auto-created topics |
| `default.replication.factor` | 1 | Default replication factor |
| `min.insync.replicas` | 1 | Minimum ISR size for acks=all writes |
| `log.retention.hours` | 168 (7 days) | How long to retain messages |
| `log.segment.bytes` | 1073741824 (1 GB) | Maximum segment file size |
| `log.cleanup.policy` | delete | `delete` or `compact` |
| `replica.lag.time.max.ms` | 30000 | Max lag before removing from ISR |
| `unclean.leader.election.enable` | false | Allow out-of-sync replica as leader |

### Go Code: Connecting to a Kafka Cluster

Here's establishing connections to a Kafka cluster using both major Go libraries. First, we need to set up our Go module:

```go
// File: kafka-fundamentals/go.mod
module github.com/example/kafka-fundamentals

go 1.27

require (
    github.com/segmentio/kafka-go v0.4.47
    github.com/twmb/franz-go v1.18.0
)
```

> **Senior track**: For new greenfield Go services in 2026, prefer `franz-go` over `segmentio/kafka-go`. Franz-go supports transactions, EOS, cooperative-sticky assignment, and KIP-848 consumer group protocol, features the segmentio client lacks. The segmentio client is shown here because its `Dialer` API is pedagogically simpler for illustrating TLS/SASL wiring.

Now, let's build a reliable connection manager:

```go
// File: kafka-fundamentals/connection/manager.go
package connection

import (
    "context"
    "crypto/tls"
    "crypto/x509"
    "errors"
    "fmt"
    "log/slog"
    "net"
    "os"
    "sync"
    "time"

    "github.com/segmentio/kafka-go"
    "github.com/segmentio/kafka-go/sasl"
    "github.com/segmentio/kafka-go/sasl/plain"
    "github.com/segmentio/kafka-go/sasl/scram"
)

// ClusterConfig holds all configuration for connecting to a Kafka cluster.
type ClusterConfig struct {
    // Brokers is the list of broker addresses in host:port format.
    Brokers []string

    // TLS configuration for encrypted connections.
    TLSEnabled bool
    CACertFile string
    CertFile   string
    KeyFile    string

    // SASL authentication.
    SASLMechanism string // "plain", "scram-sha-256", "scram-sha-512"
    SASLUsername  string
    SASLPassword  string

    // Connection tuning.
    DialTimeout  time.Duration
    ReadTimeout  time.Duration
    WriteTimeout time.Duration

    // Logger for operational visibility.
    Logger *slog.Logger
}

// DefaultClusterConfig returns a ClusterConfig with sensible defaults.
func DefaultClusterConfig(brokers []string) ClusterConfig {
    return ClusterConfig{
        Brokers:      brokers,
        TLSEnabled:   false,
        DialTimeout:  10 * time.Second,
        ReadTimeout:  30 * time.Second,
        WriteTimeout: 30 * time.Second,
        Logger:       slog.Default(),
    }
}

// ClusterManager manages connections and metadata for a Kafka cluster.
type ClusterManager struct {
    config ClusterConfig
    dialer *kafka.Dialer
    mu     sync.RWMutex
    conn   *kafka.Conn // control connection for admin operations
}

// NewClusterManager creates a new ClusterManager with the given configuration.
func NewClusterManager(config ClusterConfig) (*ClusterManager, error) {
    if len(config.Brokers) == 0 {
        return nil, errors.New("at least one broker address is required")
    }

    if config.Logger == nil {
        config.Logger = slog.Default()
    }

    dialer := &kafka.Dialer{
        Timeout:   config.DialTimeout,
        DualStack: true,
    }

    // Configure TLS if enabled.
    if config.TLSEnabled {
        tlsConfig, err := buildTLSConfig(config)
        if err != nil {
            return nil, fmt.Errorf("building TLS config: %w", err)
        }
        dialer.TLS = tlsConfig
    }

    // Configure SASL authentication if specified.
    if config.SASLMechanism != "" {
        mechanism, err := buildSASLMechanism(config)
        if err != nil {
            return nil, fmt.Errorf("building SASL mechanism: %w", err)
        }
        dialer.SASLMechanism = mechanism
    }

    return &ClusterManager{
        config: config,
        dialer: dialer,
    }, nil
}

// Connect establishes a control connection to the Kafka cluster and verifies
// connectivity by fetching cluster metadata.
func (cm *ClusterManager) Connect(ctx context.Context) error {
    cm.mu.Lock()
    defer cm.mu.Unlock()

    cm.config.Logger.Info("connecting to Kafka cluster",
        "brokers", cm.config.Brokers,
        "tls", cm.config.TLSEnabled,
        "sasl", cm.config.SASLMechanism,
    )

    // Try each broker until one succeeds.
    var lastErr error
    for _, broker := range cm.config.Brokers {
        conn, err := cm.dialer.DialContext(ctx, "tcp", broker)
        if err != nil {
            lastErr = err
            cm.config.Logger.Warn("failed to connect to broker",
                "broker", broker,
                "error", err,
            )
            continue
        }

        // Verify the connection by fetching the controller.
        controller, err := conn.Controller()
        if err != nil {
            conn.Close()
            lastErr = err
            cm.config.Logger.Warn("failed to fetch controller",
                "broker", broker,
                "error", err,
            )
            continue
        }

        cm.conn = conn
        cm.config.Logger.Info("connected to Kafka cluster",
            "controller_host", controller.Host,
            "controller_port", controller.Port,
            "controller_id", controller.ID,
        )
        return nil
    }

    return fmt.Errorf("failed to connect to any broker: %w", lastErr)
}

// ListTopics returns metadata for all topics in the cluster.
func (cm *ClusterManager) ListTopics(ctx context.Context) ([]TopicMetadata, error) {
    cm.mu.RLock()
    defer cm.mu.RUnlock()

    if cm.conn == nil {
        return nil, errors.New("not connected: call Connect() first")
    }

    partitions, err := cm.conn.ReadPartitions()
    if err != nil {
        return nil, fmt.Errorf("reading partitions: %w", err)
    }

    // Aggregate partition info by topic.
    topicMap := make(map[string]*TopicMetadata)
    for _, p := range partitions {
        tm, exists := topicMap[p.Topic]
        if !exists {
            tm = &TopicMetadata{
                Name: p.Topic,
            }
            topicMap[p.Topic] = tm
        }
        tm.Partitions = append(tm.Partitions, PartitionInfo{
            ID:       p.ID,
            Leader:   p.Leader.ID,
            Replicas: brokerIDs(p.Replicas),
            ISR:      brokerIDs(p.Isr),
        })
    }

    topics := make([]TopicMetadata, 0, len(topicMap))
    for _, tm := range topicMap {
        topics = append(topics, *tm)
    }
    return topics, nil
}

// CreateTopic creates a new topic with the given configuration.
func (cm *ClusterManager) CreateTopic(ctx context.Context, config TopicConfig) error {
    cm.mu.RLock()
    defer cm.mu.RUnlock()

    if cm.conn == nil {
        return errors.New("not connected: call Connect() first")
    }

    // Connect to the controller for admin operations.
    controller, err := cm.conn.Controller()
    if err != nil {
        return fmt.Errorf("fetching controller: %w", err)
    }

    controllerAddr := net.JoinHostPort(controller.Host, fmt.Sprintf("%d", controller.Port))
    controllerConn, err := cm.dialer.DialContext(ctx, "tcp", controllerAddr)
    if err != nil {
        return fmt.Errorf("connecting to controller: %w", err)
    }
    defer controllerConn.Close()

    topicConfig := kafka.TopicConfig{
        Topic:             config.Name,
        NumPartitions:     config.Partitions,
        ReplicationFactor: config.ReplicationFactor,
        ConfigEntries: []kafka.ConfigEntry{
            {ConfigName: "retention.ms", ConfigValue: fmt.Sprintf("%d", config.RetentionMs)},
            {ConfigName: "cleanup.policy", ConfigValue: config.CleanupPolicy},
            {ConfigName: "min.insync.replicas", ConfigValue: fmt.Sprintf("%d", config.MinISR)},
        },
    }

    err = controllerConn.CreateTopics(topicConfig)
    if err != nil {
        return fmt.Errorf("creating topic %s: %w", config.Name, err)
    }

    cm.config.Logger.Info("topic created",
        "topic", config.Name,
        "partitions", config.Partitions,
        "replication_factor", config.ReplicationFactor,
    )
    return nil
}

// DescribeCluster returns information about the cluster's brokers.
func (cm *ClusterManager) DescribeCluster(ctx context.Context) (*ClusterInfo, error) {
    cm.mu.RLock()
    defer cm.mu.RUnlock()

    if cm.conn == nil {
        return nil, errors.New("not connected: call Connect() first")
    }

    brokers, err := cm.conn.Brokers()
    if err != nil {
        return nil, fmt.Errorf("fetching brokers: %w", err)
    }

    controller, err := cm.conn.Controller()
    if err != nil {
        return nil, fmt.Errorf("fetching controller: %w", err)
    }

    info := &ClusterInfo{
        ControllerID: controller.ID,
    }
    for _, b := range brokers {
        info.Brokers = append(info.Brokers, BrokerInfo{
            ID:   b.ID,
            Host: b.Host,
            Port: b.Port,
        })
    }
    return info, nil
}

// Close closes the control connection.
func (cm *ClusterManager) Close() error {
    cm.mu.Lock()
    defer cm.mu.Unlock()

    if cm.conn != nil {
        err := cm.conn.Close()
        cm.conn = nil
        return err
    }
    return nil
}

// Dialer returns the configured dialer for creating producers and consumers.
func (cm *ClusterManager) Dialer() *kafka.Dialer {
    return cm.dialer
}

// --- Types ---

// TopicMetadata holds metadata about a Kafka topic.
type TopicMetadata struct {
    Name       string
    Partitions []PartitionInfo
}

// PartitionInfo holds metadata about a single partition.
type PartitionInfo struct {
    ID       int
    Leader   int
    Replicas []int
    ISR      []int
}

// TopicConfig defines the configuration for creating a new topic.
type TopicConfig struct {
    Name              string
    Partitions        int
    ReplicationFactor int
    RetentionMs       int64
    CleanupPolicy     string // "delete" or "compact"
    MinISR            int
}

// DefaultTopicConfig returns a TopicConfig with production-ready defaults.
func DefaultTopicConfig(name string) TopicConfig {
    return TopicConfig{
        Name:              name,
        Partitions:        6,
        ReplicationFactor: 3,
        RetentionMs:       7 * 24 * 60 * 60 * 1000, // 7 days
        CleanupPolicy:     "delete",
        MinISR:            2,
    }
}

// ClusterInfo holds information about the Kafka cluster.
type ClusterInfo struct {
    ControllerID int
    Brokers      []BrokerInfo
}

// BrokerInfo holds information about a single broker.
type BrokerInfo struct {
    ID   int
    Host string
    Port int
}

// --- Helpers ---

func buildTLSConfig(config ClusterConfig) (*tls.Config, error) {
    tlsConfig := &tls.Config{
        MinVersion: tls.VersionTLS12,
    }

    if config.CACertFile != "" {
        caCert, err := os.ReadFile(config.CACertFile)
        if err != nil {
            return nil, fmt.Errorf("reading CA cert: %w", err)
        }
        caCertPool := x509.NewCertPool()
        if !caCertPool.AppendCertsFromPEM(caCert) {
            return nil, errors.New("failed to parse CA certificate")
        }
        tlsConfig.RootCAs = caCertPool
    }

    if config.CertFile != "" && config.KeyFile != "" {
        cert, err := tls.LoadX509KeyPair(config.CertFile, config.KeyFile)
        if err != nil {
            return nil, fmt.Errorf("loading client certificate: %w", err)
        }
        tlsConfig.Certificates = []tls.Certificate{cert}
    }

    return tlsConfig, nil
}

func buildSASLMechanism(config ClusterConfig) (sasl.Mechanism, error) {
    switch config.SASLMechanism {
    case "plain":
        return plain.Mechanism{
            Username: config.SASLUsername,
            Password: config.SASLPassword,
        }, nil
    case "scram-sha-256":
        mechanism, err := scram.Mechanism(scram.SHA256, config.SASLUsername, config.SASLPassword)
        if err != nil {
            return nil, fmt.Errorf("creating SCRAM-SHA-256: %w", err)
        }
        return mechanism, nil
    case "scram-sha-512":
        mechanism, err := scram.Mechanism(scram.SHA512, config.SASLUsername, config.SASLPassword)
        if err != nil {
            return nil, fmt.Errorf("creating SCRAM-SHA-512: %w", err)
        }
        return mechanism, nil
    default:
        return nil, fmt.Errorf("unsupported SASL mechanism: %s", config.SASLMechanism)
    }
}

func brokerIDs(brokers []kafka.Broker) []int {
    ids := make([]int, len(brokers))
    for i, b := range brokers {
        ids[i] = b.ID
    }
    return ids
}
```

Here is the main program that demonstrates cluster connectivity and metadata inspection:

```go
// File: kafka-fundamentals/cmd/cluster-info/main.go
package main

import (
    "context"
    "fmt"
    "log/slog"
    "os"
    "os/signal"
    "strings"
    "syscall"
    "time"

    "github.com/example/kafka-fundamentals/connection"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))

    // Read broker addresses from environment or use defaults.
    brokersEnv := os.Getenv("KAFKA_BROKERS")
    if brokersEnv == "" {
        brokersEnv = "localhost:9092,localhost:9093,localhost:9094"
    }
    brokers := strings.Split(brokersEnv, ",")

    config := connection.DefaultClusterConfig(brokers)
    config.Logger = logger

    // Enable TLS if configured.
    if os.Getenv("KAFKA_TLS_ENABLED") == "true" {
        config.TLSEnabled = true
        config.CACertFile = os.Getenv("KAFKA_CA_CERT")
        config.CertFile = os.Getenv("KAFKA_CLIENT_CERT")
        config.KeyFile = os.Getenv("KAFKA_CLIENT_KEY")
    }

    // Enable SASL if configured.
    if mechanism := os.Getenv("KAFKA_SASL_MECHANISM"); mechanism != "" {
        config.SASLMechanism = mechanism
        config.SASLUsername = os.Getenv("KAFKA_SASL_USERNAME")
        config.SASLPassword = os.Getenv("KAFKA_SASL_PASSWORD")
    }

    manager, err := connection.NewClusterManager(config)
    if err != nil {
        logger.Error("failed to create cluster manager", "error", err)
        os.Exit(1)
    }
    defer manager.Close()

    ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    // Connect to cluster.
    connectCtx, connectCancel := context.WithTimeout(ctx, 30*time.Second)
    defer connectCancel()

    if err := manager.Connect(connectCtx); err != nil {
        logger.Error("failed to connect to Kafka", "error", err)
        os.Exit(1)
    }

    // Describe the cluster.
    clusterInfo, err := manager.DescribeCluster(ctx)
    if err != nil {
        logger.Error("failed to describe cluster", "error", err)
        os.Exit(1)
    }

    fmt.Println("=== Kafka Cluster Info ===")
    fmt.Printf("Controller ID: %d\n", clusterInfo.ControllerID)
    fmt.Printf("Brokers (%d):\n", len(clusterInfo.Brokers))
    for _, b := range clusterInfo.Brokers {
        role := "  follower"
        if b.ID == clusterInfo.ControllerID {
            role = "  controller"
        }
        fmt.Printf("  Broker %d: %s:%d %s\n", b.ID, b.Host, b.Port, role)
    }

    // List topics.
    topics, err := manager.ListTopics(ctx)
    if err != nil {
        logger.Error("failed to list topics", "error", err)
        os.Exit(1)
    }

    fmt.Printf("\nTopics (%d):\n", len(topics))
    for _, t := range topics {
        fmt.Printf("  %s (%d partitions)\n", t.Name, len(t.Partitions))
        for _, p := range t.Partitions {
            fmt.Printf("    Partition %d: leader=%d, replicas=%v, isr=%v\n",
                p.ID, p.Leader, p.Replicas, p.ISR)
        }
    }

    // Create a sample topic for our examples.
    topicCfg := connection.DefaultTopicConfig("orders")
    if err := manager.CreateTopic(ctx, topicCfg); err != nil {
        // Topic may already exist - log but don't fail.
        logger.Warn("topic creation result", "topic", topicCfg.Name, "error", err)
    }
}
```

> **Production Note**: LinkedIn's Kafka clusters run hundreds of brokers serving over 7 trillion messages per day. Immutable commit logs, partition-based parallelism, and ISR-based replication make this scale possible.

### Junior -> FAANG: Connecting Theory to Code in Your First Kafka Service

The architecture fundamentals section is dense, and it is tempting to skim it and jump to code. Resist this. The configuration parameters in the table at the end of this section are the first thing experienced reviewers check in a pull request for a new Kafka producer or consumer.

The most common beginner mistakes rooted in missing fundamentals:

**`min.insync.replicas` left at 1 with `acks=all`.** This combination sounds safe but is not. With `min.insync.replicas=1`, `acks=all` only requires the leader to acknowledge. A single replica. If the leader crashes before replication, the data is lost. The correct production default is `min.insync.replicas=2` with `replication.factor=3`.

**Not understanding the high-watermark.** The code in this section fetches the controller and lists partitions. New engineers often confuse "log end offset" (what the leader has written) with "high watermark" (the highest offset acknowledged by all ISR members). Consumers can only read up to the high watermark. This is why a consumer can appear to be "behind" a producer even when the producer has no errors: the replication lag is delaying the high watermark advancement.

**Not connecting segment files to retention.** Kafka does not delete individual messages. It deletes entire segment files. A 7-day retention policy does not mean a message written 7 days ago is deleted at exactly day 7. The segment containing that message is deleted only when the entire segment is older than 7 days. A long-running segment (due to low write volume) can hold messages much older than the retention period. Set `segment.ms` appropriately to ensure segments roll over often enough.

Worked habit: after running the cluster-info command in this section, also run `kafka-log-dirs.sh --topic-list orders --broker-list localhost:9092` to see the actual segment files on disk. Connecting the Go code output to physical files closes the abstraction gap permanently.

### Senior @ FAANG: KRaft Operational Implications and Migration Governance

The transition from ZooKeeper to KRaft is the most significant operational change in Kafka's history. At the senior level, understanding KRaft is not about knowing the Raft paper. It is about understanding the operational footprint change and the migration governance required for clusters with years of ZooKeeper-era tooling.

**KRaft controller sizing and placement.** KRaft controllers run the Raft consensus protocol for cluster metadata. In production, deploy 3 or 5 dedicated controller nodes (separate from broker nodes). Use 5 controllers for clusters where metadata volume is high (many topics, frequent ACL changes, large number of partitions). Controller nodes do not serve client data traffic, so they can be sized for CPU and memory rather than disk I/O. A common mistake is running combined mode (controller + broker) in production to save cost. This violates the principle of isolating the control plane from the data plane: a broker disk failure that triggers an OOM kill takes out a controller vote.

**Metadata log growth.** The `__cluster_metadata` topic is a Raft-replicated internal topic. Every topic creation, deletion, ACL change, and config update is an entry in this log. In clusters with frequent topic churn (many short-lived topics being created and deleted), this log can grow large. Kafka compacts it periodically, but the compaction lag means the snapshot size can exceed expected bounds. Monitor `kafka.controller:type=ControllerEventManager,name=EventQueueTimeMs` and the size of the metadata log directory on controller nodes.

**Migration runbook requirements.** The KIP-866 bridge migration (ZooKeeper to KRaft) requires: running a 3.5 or 3.6 cluster in "migration mode" where both ZooKeeper and KRaft coexist, verifying metadata consistency, then completing the migration by disabling ZooKeeper access. Before starting this migration, every piece of operational tooling that reads ZooKeeper directly (legacy monitoring scripts, custom partition reassignment tools, Cruise Control configurations) must be audited and updated. Teams that skip the audit frequently discover broken tooling mid-migration under time pressure. Write the migration ADR to require a 30-day tooling audit before migration begins.

**Scalability proof point for capacity planning.** KRaft's ability to support millions of partitions per cluster (vs approximately 200K for ZooKeeper) is not just a theoretical improvement. It changes capacity planning math: you can now afford fine-grained topic-per-entity designs (e.g., one topic per customer tenant) that were previously impractical. This enables per-tenant retention and access control policies that shared topics cannot provide. Model the partition count implications before adopting this pattern: a 10,000-tenant system with 10 topics per tenant requires 100,000 partitions minimum, comfortably within KRaft limits but impossible on ZooKeeper.

---
