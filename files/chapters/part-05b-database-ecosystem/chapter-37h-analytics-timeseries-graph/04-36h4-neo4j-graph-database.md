## 37H.4 Neo4j: Graph Database

### Graph Data Modeling

Neo4j uses the **property graph model**: data is stored as nodes (entities with one or more labels) and directed, typed relationships (edges) between them, and both nodes and relationships can carry arbitrary key-value properties. Cypher - Neo4j's query language - expresses graph patterns using an ASCII-art syntax where `()` denotes a node, `[]` denotes a relationship, and `-->` denotes direction. So `MATCH (u:User)-[:PURCHASED]->(p:Product)` executes as a pointer-chase rather than a JOIN, making multi-hop graph traversals orders of magnitude faster than equivalent SQL with foreign key joins.

**Cypher basics:**
- `MATCH` - find existing patterns (like `SELECT ... FROM ... JOIN`)
- `CREATE` - create nodes and relationships unconditionally
- `MERGE` - upsert: match if it exists, create if it does not
- `WHERE`, `RETURN`, `ORDER BY`, `LIMIT` - similar to SQL
- `[:REL*1..3]` - variable-length paths (1 to 3 hops)
- `shortestPath((a)-[*..6]-(b))` - built-in shortest-path finder

```
Graph Database Model
═══════════════════════════════════════════════════════════════════

  Nodes: entities (Users, Products, Categories, Orders)
  Edges: relationships with direction and properties
  Labels: node types  Relationship types: uppercase

  Social Network Example:
  (Alice:User)-[:FOLLOWS]->(Bob:User)
  (Alice:User)-[:PURCHASED]->(laptop:Product {price_cents: 99900})
  (laptop:Product)-[:IN_CATEGORY]->(electronics:Category)
  (Bob:User)-[:REVIEWED {rating: 5}]->(laptop:Product)
  (Alice:User)-[:FRIENDS_WITH]->(Carol:User)
  (Carol:User)-[:FOLLOWS]->(Bob:User)

  Why Graph for Recommendations:
  "Products bought by people Carol follows who also follow Alice"
  SQL: 5-table JOIN, slow at scale
  Cypher: simple traversal, sub-millisecond
```

### Go Neo4j Client

The `neo4j-go-driver/v5` package communicates over the Bolt binary protocol, which maintains persistent connections and supports transaction functions with automatic retry on transient errors (leader elections, network blips). The client below demonstrates MERGE-based upserts for user nodes, relationship creation for social follows and purchases, collaborative-filtering recommendations via multi-hop traversal, shortest-path queries, fraud ring detection through shared device/IP analysis, and PageRank computation using the Graph Data Science (GDS) library.

```go
package neo4j

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/neo4j/neo4j-go-driver/v5/neo4j"
)

// Config for Neo4j connection
type Config struct {
	URI      string
	Username string
	Password string
	Realm    string
	MaxConns int
}

// Client wraps Neo4j driver
type Client struct {
	driver neo4j.DriverWithContext
	log    *slog.Logger
}

// NewClient creates a production Neo4j client
func NewClient(cfg Config, log *slog.Logger) (*Client, error) {
	driver, err := neo4j.NewDriverWithContext(
		cfg.URI,
		neo4j.BasicAuth(cfg.Username, cfg.Password, cfg.Realm),
		func(config *neo4j.Config) {
			config.MaxConnectionPoolSize = cfg.MaxConns
			config.ConnectionAcquisitionTimeout = 5 * time.Second
		},
	)
	if err != nil {
		return nil, fmt.Errorf("neo4j driver: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := driver.VerifyConnectivity(ctx); err != nil {
		return nil, fmt.Errorf("neo4j connectivity: %w", err)
	}

	log.Info("neo4j connected", "uri", cfg.URI)
	return &Client{driver: driver, log: log}, nil
}

// Close gracefully shuts down the driver
func (c *Client) Close(ctx context.Context) error {
	return c.driver.Close(ctx)
}

// UserNode represents a user in the graph
type UserNode struct {
	ID        string    `neo4j:"id"`
	Email     string    `neo4j:"email"`
	Name      string    `neo4j:"name"`
	CreatedAt time.Time `neo4j:"created_at"`
}

// ProductNode represents a product in the graph
type ProductNode struct {
	ID         string   `neo4j:"id"`
	Name       string   `neo4j:"name"`
	Category   string   `neo4j:"category"`
	PriceCents int64    `neo4j:"price_cents"`
	Tags       []string `neo4j:"tags"`
}

// GraphRepository handles graph operations
type GraphRepository struct {
	client *Client
}

// CreateUser creates a user node
func (r *GraphRepository) CreateUser(ctx context.Context, user UserNode) error {
	session := r.client.driver.NewSession(ctx, neo4j.SessionConfig{
		AccessMode: neo4j.AccessModeWrite,
	})
	defer session.Close(ctx)

	_, err := session.ExecuteWrite(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
		result, err := tx.Run(ctx, `
			MERGE (u:User {id: $id})
			SET u.email = $email,
			    u.name = $name,
			    u.created_at = $created_at
			RETURN u.id
		`, map[string]any{
			"id":         user.ID,
			"email":      user.Email,
			"name":       user.Name,
			"created_at": user.CreatedAt.UTC().Unix(),
		})
		if err != nil {
			return nil, err
		}
		return result.Collect(ctx)
	})
	return err
}

// CreateFollowRelationship creates a FOLLOWS relationship
func (r *GraphRepository) Follow(ctx context.Context, followerID, followeeID string) error {
	session := r.client.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
	defer session.Close(ctx)

	_, err := session.ExecuteWrite(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
		result, err := tx.Run(ctx, `
			MATCH (follower:User {id: $follower_id})
			MATCH (followee:User {id: $followee_id})
			MERGE (follower)-[r:FOLLOWS]->(followee)
			SET r.since = timestamp()
			RETURN r
		`, map[string]any{
			"follower_id": followerID,
			"followee_id": followeeID,
		})
		if err != nil {
			return nil, err
		}
		return result.Collect(ctx)
	})
	return err
}

// RecordPurchase creates PURCHASED relationship
func (r *GraphRepository) RecordPurchase(ctx context.Context, userID, productID string, amountCents int64) error {
	session := r.client.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
	defer session.Close(ctx)

	_, err := session.ExecuteWrite(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
		_, err := tx.Run(ctx, `
			MATCH (u:User {id: $user_id})
			MATCH (p:Product {id: $product_id})
			CREATE (u)-[r:PURCHASED {amount_cents: $amount_cents, at: timestamp()}]->(p)
			RETURN r
		`, map[string]any{
			"user_id":      userID,
			"product_id":   productID,
			"amount_cents": amountCents,
		})
		return nil, err
	})
	return err
}

// RecommendProducts: collaborative filtering via graph traversal
// "Products bought by people you follow that you haven't bought"
func (r *GraphRepository) RecommendProducts(ctx context.Context, userID string, limit int) ([]ProductNode, error) {
	session := r.client.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
	defer session.Close(ctx)

	results, err := session.ExecuteRead(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
		result, err := tx.Run(ctx, `
			MATCH (me:User {id: $user_id})-[:FOLLOWS]->(followed:User)
			MATCH (followed)-[:PURCHASED]->(p:Product)
			WHERE NOT (me)-[:PURCHASED]->(p)
			  AND NOT (me)-[:DISMISSED]->(p)
			WITH p, count(DISTINCT followed) AS purchase_count
			ORDER BY purchase_count DESC
			LIMIT $limit
			RETURN p.id AS id, p.name AS name, p.category AS category,
			       p.price_cents AS price_cents, purchase_count
		`, map[string]any{
			"user_id": userID,
			"limit":   limit,
		})
		if err != nil {
			return nil, err
		}
		return result.Collect(ctx)
	})
	if err != nil {
		return nil, fmt.Errorf("recommend products: %w", err)
	}

	var products []ProductNode
	for _, record := range results.([]*neo4j.Record) {
		p := ProductNode{
			ID:         record.Values[0].(string),
			Name:       record.Values[1].(string),
			Category:   record.Values[2].(string),
			PriceCents: record.Values[3].(int64),
		}
		products = append(products, p)
	}
	return products, nil
}

// ShortestPath finds the shortest connection path between two users
func (r *GraphRepository) ShortestPath(ctx context.Context, fromUserID, toUserID string) ([]string, error) {
	session := r.client.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
	defer session.Close(ctx)

	results, err := session.ExecuteRead(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
		result, err := tx.Run(ctx, `
			MATCH p = shortestPath(
				(from:User {id: $from_id})-[:FOLLOWS*..6]->(to:User {id: $to_id})
			)
			RETURN [n IN nodes(p) | n.name] AS path_names,
			       length(p) AS hops
		`, map[string]any{
			"from_id": fromUserID,
			"to_id":   toUserID,
		})
		if err != nil {
			return nil, err
		}
		return result.Single(ctx)
	})
	if err != nil {
		return nil, fmt.Errorf("shortest path: %w", err)
	}

	record := results.(*neo4j.Record)
	rawPath := record.Values[0].([]any)
	var path []string
	for _, name := range rawPath {
		path = append(path, name.(string))
	}
	return path, nil
}

// FraudDetection: find users with suspicious shared attributes
func (r *GraphRepository) DetectFraudRing(ctx context.Context, userID string) ([]string, error) {
	session := r.client.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeRead})
	defer session.Close(ctx)

	results, err := session.ExecuteRead(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
		result, err := tx.Run(ctx, `
			MATCH (u:User {id: $user_id})
			MATCH (u)-[:USES_DEVICE]->(d:Device)<-[:USES_DEVICE]-(other:User)
			WHERE other.id <> $user_id
			WITH other, count(DISTINCT d) AS shared_devices
			WHERE shared_devices >= 2
			MATCH (other)-[:USES_IP]->(ip:IPAddress)<-[:USES_IP]-(u)
			RETURN other.id AS suspicious_user, shared_devices
			ORDER BY shared_devices DESC
			LIMIT 20
		`, map[string]any{"user_id": userID})
		if err != nil {
			return nil, err
		}
		return result.Collect(ctx)
	})
	if err != nil {
		return nil, err
	}

	var suspects []string
	for _, record := range results.([]*neo4j.Record) {
		suspects = append(suspects, record.Values[0].(string))
	}
	return suspects, nil
}

// CategoryInfluence: find most influential products in a category (PageRank)
func (r *GraphRepository) CategoryInfluence(ctx context.Context, category string) error {
	session := r.client.driver.NewSession(ctx, neo4j.SessionConfig{AccessMode: neo4j.AccessModeWrite})
	defer session.Close(ctx)

	// Run GDS (Graph Data Science) PageRank algorithm
	_, err := session.ExecuteWrite(ctx, func(tx neo4j.ManagedTransaction) (any, error) {
		_, err := tx.Run(ctx, `
			CALL gds.pageRank.write({
				nodeQuery: 'MATCH (p:Product {category: $category}) RETURN id(p) AS id',
				relationshipQuery: 'MATCH (p1:Product)-[:CO_PURCHASED]->(p2:Product) RETURN id(p1) AS source, id(p2) AS target',
				writeProperty: 'pagerank',
				maxIterations: 20,
				dampingFactor: 0.85
			})
			YIELD nodePropertiesWritten
		`, map[string]any{"category": category})
		return nil, err
	})
	return err
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

If you are coming from SQL, the mental flip is that relationships are first-class storage, not derived from foreign keys at query time. In Postgres, a friends-of-friends query joins the `follows` table to itself three times, each join producing a Cartesian expansion that the planner must then filter. In Neo4j, each node stores direct pointers (physical offsets on disk) to its relationship records, so traversing from Alice to Bob to Carol is a pointer dereference, not a B-tree lookup. This is called **index-free adjacency**. The practical consequence: a 3-hop traversal on a 10 million node graph runs in constant time relative to total graph size, while the SQL equivalent degrades with table size.

Worked example, recommending products using collaborative filtering. In SQL you write `SELECT p.* FROM purchases p1 JOIN purchases p2 ON p1.product_id = p2.product_id JOIN follows f ON f.followee_id = p2.user_id WHERE f.follower_id = ? AND p1.user_id = ? AND p2.product_id NOT IN (SELECT product_id FROM purchases WHERE user_id = ?)`. That is three joins and a correlated subquery. The Cypher version in this chapter is eight lines and runs faster because it walks the graph directly. At your first job you will be asked to justify Neo4j over Postgres recursive CTEs. The honest answer: recursive CTEs work until depth 3, then fall over. If your product needs depth 4 or more, or if the set of paths is what you want to rank, use a graph database.

Interview entry-points you should be able to answer in thirty seconds. What is the property graph model. Why is Cypher faster than recursive SQL for deep traversal. What does `MERGE` do that `CREATE` does not. What is the Bolt protocol and why does Neo4j use it instead of HTTP. What is the difference between a node label and a relationship type. If asked to model Twitter, sketch `(User)-[:FOLLOWS]->(User)`, `(User)-[:POSTED]->(Tweet)`, `(Tweet)-[:REPLIES_TO]->(Tweet)`, `(User)-[:LIKED]->(Tweet)`. Mention that you would index `User.handle` with `CREATE INDEX FOR (u:User) ON (u.handle)` so lookups are not full scans.

First-job traps. Forgetting to create indexes on the property you `MATCH` by is the most common performance bug. Running `MATCH (u:User {email: $email})` without an index on `email` scans every user node. Run `EXPLAIN` and `PROFILE` on every query before shipping. The second trap is using `CREATE` instead of `MERGE` in idempotent handlers, which produces duplicate nodes after retries. The third trap is unbounded variable-length paths like `[*]`, which will try to enumerate every path in the graph and either time out or crash the server. Always bound with `[*..6]` or similar.

### Senior @ FAANG: Architecture, Clustering, and Cross-Engine Trade-offs

At staff level you are choosing a graph engine for a production workload with a five-year horizon, and you have to defend the choice in a design review. Start with Neo4j's storage architecture. Nodes live in `neostore.nodestore.db` as fixed-size 15-byte records. Each node record contains a pointer to its first relationship and first property, enabling O(1) access to both. Relationships live in `neostore.relationshipstore.db` as 34-byte records forming a doubly-linked list per node. This layout is what makes index-free adjacency work on disk, and it is also what makes Neo4j write-amplification sensitive, since updating a relationship can require rewriting both endpoints' linked lists. Properties are stored separately in a key-value store with string and array values spilling to dynamic stores. Understand this layout before you quote traversal performance numbers.

Clustering in Neo4j 5.25 is **causal clustering** built on the Raft consensus protocol. A cluster has core servers (the Raft group, typically 3 or 5) that handle writes, and read replicas that tail the transaction log asynchronously for read scale-out. Writes go to the leader, replicate to a quorum of cores, then fan out to replicas. Causal consistency is enforced via **bookmarks**: a client that wrote transaction T holds a bookmark, and subsequent reads include that bookmark so the server routes to a replica that has applied at least T. This is the same pattern as MongoDB's causal consistency and Spanner's TrueTime, and it is what you cite in a design doc when the reviewer asks how you avoid read-your-own-writes anomalies on replicas. For multi-region, Neo4j Fabric federates multiple clusters under one Cypher endpoint, but cross-shard joins are expensive, so you shard by tenant or by weakly-connected subgraph, never by relationship.

The Bolt protocol matters for latency budgets. Bolt is a stateful binary protocol over TCP with PackStream serialization, supporting pipelined requests, streaming results, and explicit transaction control. Unlike HTTP-based graph APIs (Neptune's Gremlin-over-HTTP, Dgraph's GraphQL), Bolt keeps the connection warm, amortizes TLS handshake, and streams result records as they are produced rather than buffering the full result. For a recommendation service returning 100 products, Bolt shaves roughly 2 to 5 ms per call versus HTTP+JSON. The Go driver in this chapter uses Bolt by default when the URI is `neo4j://` or `bolt://`, and it does connection pooling and automatic routing (client reads the cluster topology and routes writes to the leader, reads to replicas). Tune `MaxConnectionPoolSize` to match your expected concurrency, and set `ConnectionAcquisitionTimeout` shorter than your request SLO so you fail fast on pool exhaustion.

Query language choice. Cypher is Neo4j-native and now an ISO standard as **GQL** (ISO/IEC 39075:2024, ratified April 2024), which means Cypher semantics are portable to any GQL-compliant engine. **Gremlin** is Apache TinkerPop's imperative traversal language, used by Neptune, JanusGraph, and CosmosDB Graph API. Gremlin is more verbose and harder to optimize since the planner sees a procedural traversal rather than a declarative pattern. **SPARQL** is for RDF triple stores (Stardog, GraphDB, Blazegraph before Amazon bought it), and is the right choice only if your data is genuinely RDF with ontology reasoning, not labeled property graphs. For most FAANG workloads, Cypher or GQL is the answer. If you are locked into AWS and cannot run Neo4j Aura on AWS, Neptune with openCypher (Neptune added openCypher support in 2021) is the pragmatic fallback, but know that Neptune's openCypher is a subset and lacks APOC.

Engine comparison at staff depth. **Neo4j** is mature, best tooling, Aura cloud on AWS/GCP/Azure, GDS library with 60+ algorithms, and the largest Cypher community. Downsides: single-leader writes cap you around 10k writes per second per cluster, licensing (GPLv3 community or commercial for clustering), and no native multi-region write. **Dgraph** is distributed by design, uses GraphQL± as its query language, and scales writes horizontally via Raft groups per predicate, but its graph model is RDF-like (subject-predicate-object) which is awkward for property-heavy edges, and the company behind it (Hypermode, formerly Dgraph Labs) has had business continuity questions. **Memgraph** is in-memory, Cypher-compatible, streams-first (Kafka and Pulsar sources), aimed at real-time graph analytics, and is 10 to 100x faster than Neo4j for hot-data workloads at the cost of RAM-bounded graph size and weaker durability story. **Apache AGE** is a Postgres extension that bolts openCypher onto Postgres, which is tempting because you keep one database, but performance is bounded by Postgres row storage and you lose index-free adjacency, so it is fine for graphs under 10 million edges and wrong above that. **Amazon Neptune** is fully managed, supports Gremlin, SPARQL, and openCypher, integrates with IAM, but has no GDS-equivalent, no APOC, proprietary storage, and egress costs. **ArangoDB** is multi-model (document + graph + key-value) with AQL query language, useful when you want JSON documents and graph in one engine, but it is a jack-of-all-trades and loses to Neo4j on pure graph and to Mongo on pure documents. **TigerGraph** is the performance king for massive analytical graphs (billion+ edges, heavy algorithmics) with GSQL, used by FINRA and Jumio, but operationally heavy and expensive. **Kuzu** is embedded (like SQLite for graphs), Cypher-compatible, columnar storage, excellent for analytical notebooks and ML pipelines where you ship the database with the application, but not a server. **FalkorDB** (formerly RedisGraph, rebranded after Redis deprecated the module in 2023) runs as a Redis module with sparse matrix representation and GraphBLAS, very fast for small-to-medium graphs that fit in memory and already using Redis, but limited by Redis single-threaded execution per shard. **NebulaGraph** is the Chinese hyperscaler choice (Kuaishou, Meituan, JD), distributed by design, nGQL query language close to Cypher, strong at trillion-edge scale but smaller community outside China.

Decision matrix for staff design reviews. Pure OLTP graph under 100 million nodes, mixed workload, need mature tooling: Neo4j Aura. Real-time streaming graph, sub-millisecond queries, memory-bound OK: Memgraph. Must run on AWS with IAM integration and cannot bring in a vendor: Neptune. Embedded analytics in a Python/Go service: Kuzu. Massive analytical graph, billions of edges, batch algorithmics: TigerGraph. Already on Postgres, graph is secondary: Apache AGE or stay in Postgres with recursive CTEs if depth is bounded. Existing Redis deployment, small graph, simple traversals: FalkorDB. Multi-model single-engine requirement: ArangoDB but expect compromises.

When graph beats relational, quantified. For hierarchical queries the crossover is around depth 3 to 4. At depth 2, Postgres with proper indexes is within 2x of Neo4j and often wins on point lookups due to smaller working set. At depth 3, Neo4j pulls ahead by 5 to 10x. At depth 4 or deeper, or when the query is "find all paths matching a pattern" rather than "find the shortest path," Neo4j is 100x or more faster because Postgres has to materialize intermediate join results that Neo4j walks incrementally. The second axis is **pattern complexity**: if your query has optional segments, alternation, or variable-length paths, Cypher expresses it in a few lines while SQL needs dynamic query generation or stored procedures. Third axis is **write patterns**: if your graph is append-only (event logs, audit trails), relational with partitioning is often simpler. If your graph mutates relationships frequently (social follow/unfollow, fraud ring evolution), graph engines amortize those writes better.

APOC and GDS. **APOC** (Awesome Procedures on Cypher) is the standard library Neo4j should have shipped, covering periodic iteration (`apoc.periodic.iterate` for batched writes to avoid transaction bloat), data import (`apoc.load.json`, `apoc.load.csv`), graph refactoring, and text utilities. In production you will use `apoc.periodic.iterate` to backfill relationships without blowing up the transaction log. **GDS** (Graph Data Science) is the algorithms library: PageRank, Louvain community detection, node2vec embeddings, Dijkstra, betweenness centrality, link prediction. GDS runs on a projected in-memory graph (`gds.graph.project`) separate from the transactional store, so algorithmic workloads do not contend with OLTP queries. The PageRank example in this chapter writes results back with `write` mode, but in production you usually `stream` results to an application that consumes them, or you write to a separate label so you can version the computation. Know that GDS enterprise license gates clustering-distributed algorithms, and that GDS running on a 100M-edge projection can consume 50 to 100 GB of RAM, so size your cores accordingly.

Production patterns you should know by reflex. Batch writes through `apoc.periodic.iterate` with batches of 1000 to 10000 and parallel=true on independent subgraphs. Model time-varying relationships with `valid_from` and `valid_to` properties and filter in `MATCH`, not by deleting edges, because deletion loses history. Use relationship direction meaningfully (`(a)-[:FOLLOWS]->(b)` is not the same as `(b)-[:FOLLOWS]->(a)`) and index relationship properties in Neo4j 5.x when you filter on them heavily. Avoid supernodes (a single node with millions of relationships) by introducing intermediate bucket nodes or by filtering with indexed relationship properties. Monitor `dbms.metrics` for page cache hit ratio (want >99%), transaction log rotation, and bolt connection pool saturation. For backups use `neo4j-admin database backup` with incremental mode, store to S3, and test restores quarterly. For multi-tenancy, either namespace with labels (`:TenantA_User`) for small tenant counts, or run one database per tenant in Neo4j 4+ which supports multi-database natively, or shard tenants across Fabric federations for very large fleets.

---
