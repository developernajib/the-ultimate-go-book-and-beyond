## 37.9 Company Case Studies

### Uber: Schemaless Sharding at Scale

Uber built Schemaless, a sharded MySQL system handling trillions of rows. Their approach:

```go
// Uber's Schemaless-inspired sharding pattern
package sharding

import (
    "context"
    "database/sql"
    "encoding/json"
    "fmt"
    "hash/fnv"
    "log/slog"
    "sync"
    "time"
)

// Cell represents a data cell in Schemaless
type Cell struct {
    RowKey    string          `json:"row_key"`
    ColumnKey string          `json:"column_key"`
    RefKey    int64           `json:"ref_key"`
    Body      json.RawMessage `json:"body"`
    CreatedAt time.Time       `json:"created_at"`
}

// SchemalessStore implements Uber's Schemaless pattern
type SchemalessStore struct {
    shards     []*sql.DB
    numShards  int
    logger     *slog.Logger
}

// NewSchemalessStore creates a new Schemaless store
func NewSchemalessStore(shards []*sql.DB, logger *slog.Logger) *SchemalessStore {
    return &SchemalessStore{
        shards:    shards,
        numShards: len(shards),
        logger:    logger,
    }
}

// Put stores a cell (immutable - always creates new version)
func (s *SchemalessStore) Put(ctx context.Context, cell *Cell) error {
    // Uber uses row_key for shard selection
    shardIdx := s.getShardIndex(cell.RowKey)
    shard := s.shards[shardIdx]

    // Auto-increment ref_key within row+column
    // This creates versioning without explicit version numbers
    query := `
        INSERT INTO cells (row_key, column_key, ref_key, body, created_at)
        SELECT $1, $2, COALESCE(MAX(ref_key), 0) + 1, $3, NOW()
        FROM cells
        WHERE row_key = $1 AND column_key = $2
        RETURNING ref_key, created_at
    `

    err := shard.QueryRowContext(ctx, query,
        cell.RowKey, cell.ColumnKey, cell.Body,
    ).Scan(&cell.RefKey, &cell.CreatedAt)

    return err
}

// GetLatest retrieves the latest version of a cell
func (s *SchemalessStore) GetLatest(ctx context.Context, rowKey, columnKey string) (*Cell, error) {
    shardIdx := s.getShardIndex(rowKey)
    shard := s.shards[shardIdx]

    query := `
        SELECT row_key, column_key, ref_key, body, created_at
        FROM cells
        WHERE row_key = $1 AND column_key = $2
        ORDER BY ref_key DESC
        LIMIT 1
    `

    var cell Cell
    err := shard.QueryRowContext(ctx, query, rowKey, columnKey).Scan(
        &cell.RowKey, &cell.ColumnKey, &cell.RefKey, &cell.Body, &cell.CreatedAt,
    )
    if err != nil {
        return nil, err
    }

    return &cell, nil
}

// GetVersion retrieves a specific version
func (s *SchemalessStore) GetVersion(ctx context.Context, rowKey, columnKey string, refKey int64) (*Cell, error) {
    shardIdx := s.getShardIndex(rowKey)
    shard := s.shards[shardIdx]

    query := `
        SELECT row_key, column_key, ref_key, body, created_at
        FROM cells
        WHERE row_key = $1 AND column_key = $2 AND ref_key = $3
    `

    var cell Cell
    err := shard.QueryRowContext(ctx, query, rowKey, columnKey, refKey).Scan(
        &cell.RowKey, &cell.ColumnKey, &cell.RefKey, &cell.Body, &cell.CreatedAt,
    )
    if err != nil {
        return nil, err
    }

    return &cell, nil
}

// GetHistory retrieves all versions of a cell
func (s *SchemalessStore) GetHistory(ctx context.Context, rowKey, columnKey string, limit int) ([]*Cell, error) {
    shardIdx := s.getShardIndex(rowKey)
    shard := s.shards[shardIdx]

    query := `
        SELECT row_key, column_key, ref_key, body, created_at
        FROM cells
        WHERE row_key = $1 AND column_key = $2
        ORDER BY ref_key DESC
        LIMIT $3
    `

    rows, err := shard.QueryContext(ctx, query, rowKey, columnKey, limit)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var cells []*Cell
    for rows.Next() {
        var cell Cell
        if err := rows.Scan(&cell.RowKey, &cell.ColumnKey, &cell.RefKey, &cell.Body, &cell.CreatedAt); err != nil {
            return nil, err
        }
        cells = append(cells, &cell)
    }

    return cells, rows.Err()
}

// Scan reads cells across shards (scatter-gather)
// Uber uses this for building indexes and analytics
func (s *SchemalessStore) Scan(ctx context.Context, columnKey string, since time.Time, limit int) ([]*Cell, error) {
    var (
        wg      sync.WaitGroup
        mu      sync.Mutex
        results []*Cell
        errors  []error
    )

    perShardLimit := (limit / s.numShards) + 1

    for i, shard := range s.shards {
        wg.Add(1)
        go func(idx int, db *sql.DB) {
            defer wg.Done()

            query := `
                SELECT row_key, column_key, ref_key, body, created_at
                FROM cells
                WHERE column_key = $1 AND created_at > $2
                ORDER BY created_at ASC
                LIMIT $3
            `

            rows, err := db.QueryContext(ctx, query, columnKey, since, perShardLimit)
            if err != nil {
                mu.Lock()
                errors = append(errors, fmt.Errorf("shard %d: %w", idx, err))
                mu.Unlock()
                return
            }
            defer rows.Close()

            var localCells []*Cell
            for rows.Next() {
                var cell Cell
                if err := rows.Scan(&cell.RowKey, &cell.ColumnKey, &cell.RefKey, &cell.Body, &cell.CreatedAt); err != nil {
                    mu.Lock()
                    errors = append(errors, err)
                    mu.Unlock()
                    return
                }
                localCells = append(localCells, &cell)
            }

            mu.Lock()
            results = append(results, localCells...)
            mu.Unlock()
        }(i, shard)
    }

    wg.Wait()

    if len(errors) > 0 {
        return nil, fmt.Errorf("scan errors: %v", errors)
    }

    // Sort by created_at and limit
    // In production, use a proper merge-sort for efficiency
    if len(results) > limit {
        results = results[:limit]
    }

    return results, nil
}

// getShardIndex uses consistent hashing
func (s *SchemalessStore) getShardIndex(rowKey string) int {
    h := fnv.New32a()
    h.Write([]byte(rowKey))
    return int(h.Sum32()) % s.numShards
}
```

**Key Lessons from Uber:**
- Use immutable data model with versioning (ref_key)
- Shard by row_key for locality
- Support scatter-gather for cross-shard queries
- Build secondary indexes asynchronously

### YouTube/Vitess: Sharding MySQL at Massive Scale

Vitess is YouTube's sharding middleware for MySQL, now open source:

```go
// Vitess-inspired routing and resharding
package vitess

import (
    "bytes"
    "context"
    "crypto/md5"
    "database/sql"
    "fmt"
    "sync"
)

// Keyspace represents a logical database
type Keyspace struct {
    Name    string
    Shards  map[string]*Shard
    Vindex  Vindex // Virtual index for routing
}

// Shard represents a range of data
type Shard struct {
    Name     string
    KeyRange KeyRange
    Primary  *sql.DB
    Replicas []*sql.DB
}

// KeyRange defines shard boundaries
type KeyRange struct {
    Start []byte // inclusive
    End   []byte // exclusive
}

// Vindex interface for shard routing
type Vindex interface {
    Map(ctx context.Context, ids []any) ([]KeyspaceID, error)
    Verify(ctx context.Context, ids []any, ksids []KeyspaceID) ([]bool, error)
}

// KeyspaceID identifies the shard for a row
type KeyspaceID []byte

// HashVindex uses consistent hashing
type HashVindex struct{}

func (v *HashVindex) Map(ctx context.Context, ids []any) ([]KeyspaceID, error) {
    result := make([]KeyspaceID, len(ids))
    for i, id := range ids {
        // MD5 hash for consistent distribution
        hash := md5.Sum([]byte(fmt.Sprintf("%v", id)))
        result[i] = hash[:8] // Use first 8 bytes as keyspace ID
    }
    return result, nil
}

// VTGate routes queries to appropriate shards
type VTGate struct {
    keyspaces map[string]*Keyspace
    mu        sync.RWMutex
}

// NewVTGate creates a new VTGate router
func NewVTGate() *VTGate {
    return &VTGate{
        keyspaces: make(map[string]*Keyspace),
    }
}

// Route routes a query to the appropriate shard
func (vt *VTGate) Route(ctx context.Context, keyspace string, key any) (*Shard, error) {
    vt.mu.RLock()
    ks, ok := vt.keyspaces[keyspace]
    vt.mu.RUnlock()

    if !ok {
        return nil, fmt.Errorf("keyspace %s not found", keyspace)
    }

    // Get keyspace ID from vindex
    ksids, err := ks.Vindex.Map(ctx, []any{key})
    if err != nil {
        return nil, err
    }

    // Find shard containing this keyspace ID
    for _, shard := range ks.Shards {
        if shard.KeyRange.Contains(ksids[0]) {
            return shard, nil
        }
    }

    return nil, fmt.Errorf("no shard found for key %v", key)
}

// Contains checks if a keyspace ID falls within this range
func (kr KeyRange) Contains(ksid KeyspaceID) bool {
    // Empty start means minimum
    if len(kr.Start) > 0 && bytes.Compare(ksid, kr.Start) < 0 {
        return false
    }
    // Empty end means maximum
    if len(kr.End) > 0 && bytes.Compare(ksid, kr.End) >= 0 {
        return false
    }
    return true
}

// Scatter sends query to all shards
func (vt *VTGate) Scatter(ctx context.Context, keyspace, query string, args ...any) ([]ShardResult, error) {
    vt.mu.RLock()
    ks, ok := vt.keyspaces[keyspace]
    vt.mu.RUnlock()

    if !ok {
        return nil, fmt.Errorf("keyspace %s not found", keyspace)
    }

    var (
        wg      sync.WaitGroup
        mu      sync.Mutex
        results []ShardResult
    )

    for name, shard := range ks.Shards {
        wg.Add(1)
        go func(shardName string, s *Shard) {
            defer wg.Done()

            rows, err := s.Primary.QueryContext(ctx, query, args...)

            mu.Lock()
            results = append(results, ShardResult{
                Shard: shardName,
                Rows:  rows,
                Error: err,
            })
            mu.Unlock()
        }(name, shard)
    }

    wg.Wait()
    return results, nil
}

// ShardResult holds result from one shard
type ShardResult struct {
    Shard string
    Rows  *sql.Rows
    Error error
}

// Reshard handles online resharding
type Resharding struct {
    source *Shard
    targets []*Shard
    state   ReshardState
    mu      sync.Mutex
}

type ReshardState int

const (
    ReshardStateCopying ReshardState = iota
    ReshardStateCatchingUp
    ReshardStateSwitching
    ReshardStateComplete
)

// StartReshard initiates resharding process
func (vt *VTGate) StartReshard(ctx context.Context, source *Shard, targets []*Shard) (*Resharding, error) {
    rs := &Resharding{
        source:  source,
        targets: targets,
        state:   ReshardStateCopying,
    }

    // 1. Copy existing data (snapshot)
    go func() {
        if err := rs.copyData(ctx); err != nil {
            rs.mu.Lock()
            rs.state = -1 // Error state
            rs.mu.Unlock()
        }
    }()

    return rs, nil
}

func (rs *Resharding) copyData(ctx context.Context) error {
    // Vitess uses VStream (MySQL binlog) for copying
    // This is simplified version
    rows, err := rs.source.Primary.QueryContext(ctx, "SELECT * FROM data")
    if err != nil {
        return err
    }
    defer rows.Close()

    for rows.Next() {
        // Determine target shard and copy
        // ...
    }

    rs.mu.Lock()
    rs.state = ReshardStateCatchingUp
    rs.mu.Unlock()

    return rs.catchUp(ctx)
}

func (rs *Resharding) catchUp(ctx context.Context) error {
    // Replay binlog events from copy start time
    // Until caught up with source
    // ...

    rs.mu.Lock()
    rs.state = ReshardStateSwitching
    rs.mu.Unlock()

    return nil
}
```

**Key Lessons from Vitess:**
- Use key ranges for shard boundaries (enables split/merge)
- Implement vindexes for query routing
- Support online resharding without downtime
- Use MySQL binlog for change data capture

### Pinterest: Sharding for Social Data

Pinterest shards by user_id for locality of user data:

```go
// Pinterest-inspired user-centric sharding
package pinterest

import (
    "context"
    "database/sql"
    "fmt"
    "sort"
    "sync"
    "time"

    "github.com/lib/pq"
)

// PinStore implements Pinterest's sharding model
type PinStore struct {
    shards       []*sql.DB
    numShards    int
    localIDGen   *LocalIDGenerator
}

// LocalID is Pinterest's ID format: shard_id + type + local_id
type LocalID struct {
    ShardID int64
    Type    int16  // 0=pin, 1=board, 2=user, etc.
    LocalID int64
}

// LocalIDGenerator generates IDs within a shard
type LocalIDGenerator struct {
    sequences map[int64]*shardSequence
    mu        sync.Mutex
}

type shardSequence struct {
    current int64
    max     int64
}

// NewLocalID creates a new local ID
func (l *LocalIDGenerator) NewLocalID(shardID int64, objType int16) LocalID {
    l.mu.Lock()
    defer l.mu.Unlock()

    seq := l.sequences[shardID]
    if seq == nil || seq.current >= seq.max {
        // Initialize or fetch new range from database
        seq = &shardSequence{current: 0, max: 1000000}
        l.sequences[shardID] = seq
    }

    seq.current++
    return LocalID{
        ShardID: shardID,
        Type:    objType,
        LocalID: seq.current,
    }
}

// ToInt64 converts LocalID to int64 for storage
func (id LocalID) ToInt64() int64 {
    // Format: [shard_id: 16 bits][type: 8 bits][local_id: 40 bits]
    return (id.ShardID << 48) | (int64(id.Type) << 40) | id.LocalID
}

// FromInt64 parses int64 back to LocalID
func FromInt64(n int64) LocalID {
    return LocalID{
        ShardID: (n >> 48) & 0xFFFF,
        Type:    int16((n >> 40) & 0xFF),
        LocalID: n & 0xFFFFFFFFFF,
    }
}

// Pin represents a Pinterest pin
type Pin struct {
    ID          int64
    UserID      int64
    BoardID     int64
    ImageURL    string
    Description string
    CreatedAt   time.Time
}

// CreatePin creates a pin on the user's shard
func (p *PinStore) CreatePin(ctx context.Context, pin *Pin) error {
    // Pinterest shards by user_id
    shardIdx := p.getShardForUser(pin.UserID)
    shard := p.shards[shardIdx]

    // Generate local ID on this shard
    localID := p.localIDGen.NewLocalID(int64(shardIdx), 0) // type=0 for pins
    pin.ID = localID.ToInt64()

    query := `
        INSERT INTO pins (id, user_id, board_id, image_url, description, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
    `

    _, err := shard.ExecContext(ctx, query,
        pin.ID, pin.UserID, pin.BoardID, pin.ImageURL, pin.Description,
    )
    return err
}

// GetPin retrieves a pin (ID contains shard info)
func (p *PinStore) GetPin(ctx context.Context, pinID int64) (*Pin, error) {
    localID := FromInt64(pinID)
    shard := p.shards[localID.ShardID%int64(p.numShards)]

    query := `
        SELECT id, user_id, board_id, image_url, description, created_at
        FROM pins WHERE id = $1
    `

    var pin Pin
    err := shard.QueryRowContext(ctx, query, pinID).Scan(
        &pin.ID, &pin.UserID, &pin.BoardID, &pin.ImageURL, &pin.Description, &pin.CreatedAt,
    )
    if err != nil {
        return nil, err
    }

    return &pin, nil
}

// GetUserPins retrieves all pins for a user (single shard)
func (p *PinStore) GetUserPins(ctx context.Context, userID int64, limit, offset int) ([]*Pin, error) {
    shardIdx := p.getShardForUser(userID)
    shard := p.shards[shardIdx]

    query := `
        SELECT id, user_id, board_id, image_url, description, created_at
        FROM pins
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
    `

    rows, err := shard.QueryContext(ctx, query, userID, limit, offset)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var pins []*Pin
    for rows.Next() {
        var pin Pin
        if err := rows.Scan(&pin.ID, &pin.UserID, &pin.BoardID, &pin.ImageURL, &pin.Description, &pin.CreatedAt); err != nil {
            return nil, err
        }
        pins = append(pins, &pin)
    }

    return pins, rows.Err()
}

// GetHomeFeed aggregates pins from followed users (cross-shard)
func (p *PinStore) GetHomeFeed(ctx context.Context, userID int64, followedUsers []int64, limit int) ([]*Pin, error) {
    // Group followed users by shard
    shardUsers := make(map[int][]int64)
    for _, followedID := range followedUsers {
        shardIdx := p.getShardForUser(followedID)
        shardUsers[shardIdx] = append(shardUsers[shardIdx], followedID)
    }

    var (
        wg      sync.WaitGroup
        mu      sync.Mutex
        allPins []*Pin
    )

    perShardLimit := (limit / len(shardUsers)) + 10 // Over-fetch for merge

    for shardIdx, userIDs := range shardUsers {
        wg.Add(1)
        go func(idx int, ids []int64) {
            defer wg.Done()

            shard := p.shards[idx]

            // Use ANY for multiple user IDs
            query := `
                SELECT id, user_id, board_id, image_url, description, created_at
                FROM pins
                WHERE user_id = ANY($1)
                ORDER BY created_at DESC
                LIMIT $2
            `

            rows, err := shard.QueryContext(ctx, query, pq.Array(ids), perShardLimit)
            if err != nil {
                return
            }
            defer rows.Close()

            var pins []*Pin
            for rows.Next() {
                var pin Pin
                if err := rows.Scan(&pin.ID, &pin.UserID, &pin.BoardID, &pin.ImageURL, &pin.Description, &pin.CreatedAt); err != nil {
                    continue
                }
                pins = append(pins, &pin)
            }

            mu.Lock()
            allPins = append(allPins, pins...)
            mu.Unlock()
        }(shardIdx, userIDs)
    }

    wg.Wait()

    // Sort by created_at descending and limit
    sort.Slice(allPins, func(i, j int) bool {
        return allPins[i].CreatedAt.After(allPins[j].CreatedAt)
    })

    if len(allPins) > limit {
        allPins = allPins[:limit]
    }

    return allPins, nil
}

func (p *PinStore) getShardForUser(userID int64) int {
    return int(userID % int64(p.numShards))
}
```

**Key Lessons from Pinterest:**
- Encode shard information in IDs for O(1) routing
- Shard by user for social data locality
- Pre-compute aggregations (home feed) where possible
- Accept eventual consistency for cross-shard feeds

### Junior → FAANG: Prerequisite Gaps and Worked Example

Case studies are more valuable than any blog post because they show what real teams actually shipped rather than what a textbook recommends. But a junior engineer reading the Schemaless, Vitess, and Pinterest patterns above needs a mental scaffolding to avoid cargo culting. These systems were built for specific problems at specific scales. Copying the design to a 10 million row table is as wrong as copying Google's Spanner to a hobby project.

A worked example. You are a junior engineer at a Series B startup and a staff engineer asks you to design storage for a new feature. Version one is a single Postgres primary with a read replica. Version two, at a few hundred million rows, adds table partitioning by time and a dedicated analytics replica. Version three, at a few billion rows with write saturation, moves to sharded Postgres with pgBouncer in front. Version four, at tens of billions of rows with multi region, adopts something like Vitess or CockroachDB. The junior mistake is jumping to version four on day one. The senior mistake is staying on version one until it catches fire.

The Pinterest LocalID pattern is worth studying carefully because it is the one trick you can apply in almost any sharded system. By encoding the shard id in the high bits of the primary key, you make `GetPin(pinID)` an O(1) routing decision: decode the shard id from the id, hit that shard, done. Without this trick you need a lookup table or a second round trip. Instagram uses the same pattern, Twitter's Snowflake IDs use a variant, Discord uses snowflake-style ids, Stripe uses typed prefix ids. When you design a sharded primary key, always embed the shard selector in the id.

Entry level interview questions a case study chapter should prepare you for. Why does Uber use immutable cells with ref_key versioning. Because immutability eliminates update lock contention and makes CDC trivial (every change is an append). Why does Vitess use key ranges instead of hash modulo. Because key ranges can be split and merged online (shard 00-7F splits into 00-3F and 40-7F) without remapping unaffected keys. Why does Pinterest pre compute home feeds. Because fan out on read across N followed users times M shards is O(N times M) scatter gather and the p99 kills you. Why does Discord use Cassandra and then Scylla. Because channel message writes are append only, read patterns are sequential by timestamp, and the workload fits a wide column store far better than relational.

### Senior @ FAANG: Case Studies, Architecture Evolution, and What Staff Engineers Extract

The only reason to read case studies as a senior engineer is to extract patterns you can defend in a design review. Every case study below has a specific architectural lesson that maps to a class of problems, and the staff level skill is to recognize which class your problem belongs to.

Vitess at YouTube, Slack, and GitHub. Vitess was built at YouTube starting 2011 to solve the problem of MySQL at a scale where a single primary could not hold the working set. The core insight is keyspace and key range, not hash modulo. A keyspace is a logical database. Each keyspace is split into shards by key range (binary ranges like `[00, 40)`, `[40, 80)`, `[80, C0)`, `[C0, FF]`). Adding a shard is splitting one range into two, which moves only the keys in that range. VTGate is the query router. VTTablet sits in front of each MySQL backend and handles query rewriting, connection pooling, and throttling. VReplication streams changes between shards for online resharding by tailing MySQL binlogs with row based replication. Slack migrated from manually sharded MySQL to Vitess in 2020 to 2022 and published a detailed blog series that is mandatory reading. GitHub moved mysql1 (the main monolith database) onto Vitess in 2022. The extracted pattern: range sharding with online split and merge is how you do resharding without downtime, and binlog tailing is how you stream state changes across shards. Every sharded MySQL deployment at scale converges on some variant of this design.

Citus at Microsoft and Azure. Citus started as an extension that turns Postgres into a distributed database by adding a coordinator node that knows about shard placement and worker nodes that hold shards. Microsoft acquired Citus Data in 2019 and folded it into Azure Cosmos DB for PostgreSQL. The distinguishing feature versus Vitess is SQL completeness. Citus runs full Postgres on every worker, so you get Postgres indexes, extensions, and data types with distributed query planning on top. Reference tables (small tables replicated to every shard for local joins) and distribution columns (the shard key) are the two core concepts. The extracted pattern: if your workload is fundamentally analytical with some OLTP, Citus plus a reference table strategy beats sharded MySQL because Postgres is a better analytical engine. Heap Analytics, CloudFlare's logging pipeline, and Microsoft Dynamics all use Citus in production.

Instagram's Postgres sharding, 2012 original and still running. The Instagram engineering team published the original 2012 post describing several thousand logical shards mapped onto a smaller physical Postgres fleet with PgBouncer, using `schema` per logical shard and IDs encoding the shard number in high bits. The trick is that adding physical capacity is a matter of moving logical schemas between machines, not resharding the key. This gives you near infinite horizontal runway with a simple operational model. In 2026 this architecture is still the backbone of Instagram writes. The extracted pattern: always shard logical from physical. Fix the logical shard count early (and high, like 4096 or 8192). Map logical shards to physical nodes through a directory. You can expand physical capacity without ever rehashing.

Notion's sharded Postgres, 480 logical shards. Notion originally had one Postgres instance. In 2021 they sharded into 480 logical shards distributed across 32 physical instances on RDS, and in 2023 they published an update describing the move to 96 physical instances to support their block-based data model at billions of blocks. The physical instances sit behind a PgBouncer tier with a logical replication pipeline for online migrations. The shard key is the block's workspace id, which is the natural tenant boundary. The extracted pattern: if you know your tenant distribution is heavy tailed, shard by tenant and plan from day one to dedicate shards for whale tenants. Also, plan for 10x growth in shard count, not 2x, because resharding is expensive and you want headroom.

Figma's 2023 horizontal sharding. Figma ran on a single Postgres primary until 2022 when writes saturated. Their 2023 blog series describes their first horizontal sharding migration using logical replication and pgBouncer pause and resume for the cutover. They built their own query router (DBProxy) rather than adopting Vitess because their query patterns were specific to their document model. The extracted pattern: if your application has a constrained set of query shapes, a custom lightweight router can beat a general purpose one in operational simplicity. The trade off is that you own every feature forever.

Discord's Cassandra to ScyllaDB migration, 2022. Discord wrote a detailed post in March 2023 describing their move from Cassandra to ScyllaDB to serve trillions of messages. Cassandra's garbage collection pauses and the JVM memory model caused tail latency spikes that got worse as scale grew. ScyllaDB is a C++ rewrite of Cassandra with per core sharding (shard per core, not per node) and no JVM. Discord saw p99 latency drop from tens of milliseconds to single digit milliseconds at the same query volume. The extracted pattern: for append heavy workloads with sequential access patterns, a wide column store with per core sharding beats a relational system, and within wide column stores, avoid JVM based implementations when tail latency is critical. ScyllaDB is also what Numberly, Comcast, and various crypto exchanges use for trillion row workloads.

Uber Schemaless and Docstore. Schemaless, described in 2015 to 2016 blog posts, is an immutable append only key value store on top of sharded MySQL. The row key and column key determine the shard, and a ref_key monotonic counter gives you MVCC for free. Reads always go to the latest ref_key unless you explicitly ask for a version. Docstore, the 2020 successor, moved to a multi region design with their own storage engine. The extracted pattern: immutability at the storage layer eliminates an entire category of consistency bugs, makes CDC trivial, and makes point in time reads cheap. The cost is write amplification and storage growth that you handle via background compaction. If your domain tolerates immutability (append heavy, versioning required, audit critical), lean into it.

Stripe's idempotency key sharding. Stripe's API is designed around idempotency keys that clients send on every write. The key hashes to a shard, and retries land on the same shard naturally, so dedup is a local lookup rather than a distributed coordination problem. Combined with an at least once delivery model and idempotent operations, this gives you exactly once semantics without 2PC. The extracted pattern: shard by the thing that is already unique per operation (idempotency key, request id) when your dominant operation is a retry safe mutation. This works for payments, message sending, and any API where client retries are expected.

Shopify Pod architecture. Shopify shards by `shop_id` and puts each shop's entire stack (web tier, background jobs, MySQL, Redis, ElasticSearch) in a vertical slice called a pod. A pod is a fault isolation domain. If one pod has a bad migration, only shops in that pod are affected. During Black Friday 2024 they scaled to hundreds of pods. The extracted pattern: horizontal sharding of stateless tiers is cheap, horizontal sharding of stateful tiers with vertical stack bundling is expensive but gives you perfect blast radius. It is a defensible choice when your business cannot tolerate a global incident affecting all tenants. The cost is that cross pod operations are impossible by design and any feature crossing pods must be redesigned.

What to extract as a staff engineer. Range versus hash is a decision about resharding strategy, not query patterns. Logical shard count fixed high and mapped to physical is the universal abstraction. Embed shard routing in the primary key. Reserve scatter gather for cold paths. Immutability and append only patterns eliminate distributed update problems. Idempotency keys are the cheapest form of exactly once semantics. Pod architecture is the ultimate blast radius isolation. Every single FAANG or near FAANG storage design lands somewhere on the grid formed by these axes, and knowing where yours sits is the staff level skill that gets you the role.

---
