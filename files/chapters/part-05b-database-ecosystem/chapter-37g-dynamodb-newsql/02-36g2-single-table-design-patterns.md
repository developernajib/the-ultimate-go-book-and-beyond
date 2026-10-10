## 37G.2 Single-Table Design Patterns

### Entity-Relationship Modeling

Single-table design in DynamoDB, popularized by Rick Houlihan (formerly AWS Principal Technologist, now Principal Architect for WW NoSQL at MongoDB), stores all entity types together using a prefixed generic `PK`/`SK` scheme (e.g., `USER#<id>`, `ORG#<id>`) so that relationships between entities can be queried in a single `GetItem` or `Query` call. Global Secondary Indexes (GSIs) provide alternate access patterns by projecting a different set of attributes as the GSI partition and sort keys. Sparse GSIs (where the GSI attributes are only populated for a subset of items) are a powerful pattern for filtering by a rare attribute without scanning, a common technique for "active sessions", "pending orders", or "in-flight approvals" queues.

> **Senior track**: The discipline that separates a healthy single-table design from a migration nightmare is writing the access pattern list first, as a numbered document, before any schema exists. Every entry maps to exactly one `GetItem`, `Query`, or `BatchGetItem` plus the index it uses. If you cannot write this list, you are not ready to model the table. Houlihan's rule of thumb: aim for one table, under five GSIs, and never more than two Scan operations in the entire application surface area.

```go
// Single-Table Design: all entities in one DynamoDB table
//
// Entity prefixes for PK/SK:
// USER#<id>     → user entities
// ORG#<id>      → organization entities
// PRODUCT#<id>  → product entities
// ORDER#<id>    → order entities
// REVIEW#<id>   → review entities
//
// Access Patterns Supported:
// 1. Get user by ID:           PK=USER#id, SK=PROFILE
// 2. Get user's orders:        PK=USER#id, SK begins_with ORDER#
// 3. Get order by ID:          PK=ORDER#id, SK=METADATA
// 4. Get product by ID:        PK=PRODUCT#id, SK=METADATA
// 5. Get product reviews:      PK=PRODUCT#id, SK begins_with REVIEW#
// 6. Get user's reviews:       GSI1: PK=USER#id, SK begins_with REVIEW#
// 7. Get orders by status:     GSI2: PK=STATUS#pending, SK=ORDER#<timestamp>
// 8. Get products by category: GSI3: PK=CATEGORY#electronics, SK=PRODUCT#id

// Table schema
package dynamodb

import (
	"fmt"
	"time"
)

// User represents the domain model for a user
type User struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Order represents the domain model for an order
type Order struct {
	ID         string     `json:"id"`
	UserID     string     `json:"user_id"`
	Status     string     `json:"status"`
	TotalCents int64      `json:"total_cents"`
	Items      []LineItem `json:"items"`
	CreatedAt  time.Time  `json:"created_at"`
}

// DynamoDB item base - every item has PK + SK
type DynamoItem struct {
	PK         string `dynamodbav:"PK"`
	SK         string `dynamodbav:"SK"`
	EntityType string `dynamodbav:"EntityType"`
	GSI1PK     string `dynamodbav:"GSI1PK,omitempty"`
	GSI1SK     string `dynamodbav:"GSI1SK,omitempty"`
	GSI2PK     string `dynamodbav:"GSI2PK,omitempty"`
	GSI2SK     string `dynamodbav:"GSI2SK,omitempty"`
}

// UserItem represents a user in DynamoDB
type UserItem struct {
	DynamoItem
	UserID    string `dynamodbav:"UserID"`
	Email     string `dynamodbav:"Email"`
	Name      string `dynamodbav:"Name"`
	Role      string `dynamodbav:"Role"`
	CreatedAt string `dynamodbav:"CreatedAt"` // ISO8601
	UpdatedAt string `dynamodbav:"UpdatedAt"`
	// GSI for email lookup
	// GSI1PK = EMAIL#<email>, GSI1SK = USER#<id>
}

// ToUserItem converts a User domain object to DynamoDB item
func ToUserItem(u User) UserItem {
	return UserItem{
		DynamoItem: DynamoItem{
			PK:         "USER#" + u.ID,
			SK:         "PROFILE",
			EntityType: "USER",
			GSI1PK:     "EMAIL#" + u.Email,
			GSI1SK:     "USER#" + u.ID,
		},
		UserID:    u.ID,
		Email:     u.Email,
		Name:      u.Name,
		Role:      u.Role,
		CreatedAt: u.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: u.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func fromUserItem(item UserItem) *User {
	ca, _ := time.Parse(time.RFC3339, item.CreatedAt)
	ua, _ := time.Parse(time.RFC3339, item.UpdatedAt)
	return &User{
		ID:        item.UserID,
		Email:     item.Email,
		Name:      item.Name,
		Role:      item.Role,
		CreatedAt: ca,
		UpdatedAt: ua,
	}
}

// OrderItem represents an order in DynamoDB
type OrderItem struct {
	DynamoItem
	OrderID    string     `dynamodbav:"OrderID"`
	UserID     string     `dynamodbav:"UserID"`
	Status     string     `dynamodbav:"Status"`
	TotalCents int64      `dynamodbav:"TotalCents"`
	Items      []LineItem `dynamodbav:"Items"`
	CreatedAt  string     `dynamodbav:"CreatedAt"`
	// GSI2PK = STATUS#<status>, GSI2SK = ORDER#<created_at>#<id>
	// → enables "get orders by status sorted by time"
	TTL        int64      `dynamodbav:"TTL,omitempty"` // Unix timestamp for auto-delete
}

type LineItem struct {
	ProductID  string `dynamodbav:"ProductID"`
	Name       string `dynamodbav:"Name"`
	PriceCents int64  `dynamodbav:"PriceCents"`
	Quantity   int    `dynamodbav:"Quantity"`
}

func ToOrderItem(o Order) OrderItem {
	gsi2SK := fmt.Sprintf("ORDER#%s#%s", o.CreatedAt.UTC().Format(time.RFC3339), o.ID)
	return OrderItem{
		DynamoItem: DynamoItem{
			PK:         "USER#" + o.UserID,
			SK:         "ORDER#" + o.ID,
			EntityType: "ORDER",
			GSI2PK:     "STATUS#" + o.Status,
			GSI2SK:     gsi2SK,
		},
		OrderID:    o.ID,
		UserID:     o.UserID,
		Status:     o.Status,
		TotalCents: o.TotalCents,
		Items:      o.Items,
		CreatedAt:  o.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func fromOrderItem(item OrderItem) Order {
	ca, _ := time.Parse(time.RFC3339, item.CreatedAt)
	return Order{
		ID:         item.OrderID,
		UserID:     item.UserID,
		Status:     item.Status,
		TotalCents: item.TotalCents,
		Items:      item.Items,
		CreatedAt:  ca,
	}
}
```

### Junior to FAANG: why a single table feels wrong and why it is right

Every junior coming from Postgres looks at the table above and feels physical discomfort. Users, orders, and products in the same table. Generic column names `PK` and `SK`. Redundant `EntityType` field. This reaction is normal and it is also wrong, and working through why is how you graduate into a DynamoDB engineer.

The relational instinct says tables model entities. DynamoDB's storage engine says tables are partitions of a physical key-value store, and cross-table reads require multiple network round trips that defeat the latency budget. One table means one Query can return a user plus their last 50 orders plus their addresses in a single 10 millisecond call. Multiple tables would require a BatchGetItem or a sequence of Gets, each adding latency and each requiring its own retry budget. At 10000 QPS, the difference is not stylistic. It is the difference between serving the traffic and not.

Worked example. You need to render a user dashboard showing profile, recent orders, and unread notifications. Relational: three tables, three queries or one query with two joins. DynamoDB single-table: one Query with `PK=USER#42` returns all three because you stored them with SKs `PROFILE`, `ORDER#2026-04-22#abc`, `NOTIF#unread#xyz`. One network call, consistent latency, no join engine to blame when it regresses.

First-job context. The interview question "how would you model Instagram in DynamoDB" is asking whether you can enumerate access patterns before writing a schema. Start with: view profile, view user's posts paginated by time, view followers, view feed, post comment, like post. For each, specify PK, SK, and whether it hits the base table or a GSI. The candidate who draws a diagram with `Users`, `Posts`, `Followers`, `Likes` as separate tables has failed. The candidate who draws one table with `PK=USER#id SK=PROFILE`, `PK=USER#id SK=POST#ts#postid`, `PK=POST#id SK=LIKE#userid`, and explains that the feed uses a materialized fan-out pattern with a GSI, has passed.

### Senior at FAANG: Houlihan discipline, GSI overloading, and the politics of access-pattern-first design

Rick Houlihan's single-table methodology is not a set of tricks. It is an engineering discipline that inverts the order of design: access patterns first as a numbered list, entity-relationship diagram second derived from the patterns, physical schema third derived from the ERD plus the patterns, application code last. The political difficulty is that every team that has ever built anything wants to start with entities because entities are how humans describe the domain. Staff engineers enforce the inversion by refusing to review a DynamoDB schema that does not ship with a numbered access pattern list. No list, no review. The list becomes the contract that the schema must satisfy, and future pattern additions trigger explicit schema evolution proposals rather than silent table sprawl.

GSI overloading is the technique that makes single-table design scale to dozens of access patterns without exhausting the five-GSI soft limit or the 20-GSI hard limit. The trick is that `GSI1PK` and `GSI1SK` are generic string columns. Different entity types populate them with different prefix patterns, so a single GSI serves multiple queries. Example: `GSI1PK=EMAIL#x SK=USER#id` for "lookup user by email", `GSI1PK=ORG#id SK=USER#role#id` for "list users in an org by role", `GSI1PK=CUSTOMER#id SK=INVOICE#date` for "list invoices for a customer by date". One physical GSI, three access patterns. The cost is that filtering and range operations on the GSI are only meaningful within the context of an entity type, so queries always include the entity prefix in the key condition.

Sparse GSIs extend the overloading idea by exploiting a DynamoDB property: items without the GSI partition key attribute do not appear in the GSI. This is enormous. A table with 10 billion items can have a GSI containing only the 10000 items matching some rare state, and queries on that GSI cost nothing per item not in the state. The production pattern: set `GSI2PK=PENDING_REVIEW` only on orders in pending review state, and delete the attribute (using `UpdateItem` with `REMOVE GSI2PK`) when state transitions. Queries on `GSI2PK=PENDING_REVIEW` return exactly the pending orders, no filter expressions, no scans. For approval queues, job schedulers, and flag-state workloads, sparse GSIs are the single most valuable pattern in the DynamoDB toolkit.

Composite key design under load. The SK format `ORDER#<timestamp>#<id>` in the example code is not arbitrary. Timestamp first enables sort-by-time. ID suffix breaks ties at the same timestamp so no two items collide. ISO 8601 format ensures lexicographic sort matches chronological sort. Staff engineers who design composite keys think about: ordering (what range queries do you need), cardinality (how many items per partition), and evolution (if you add a new sort dimension, do existing items need migration). The worst mistake is using a UUID as the SK suffix when the natural order is by time, because then range queries degenerate into full-partition reads plus filter expressions.

Hot partition avoidance at scale. Celebrity user problem: if one `PK=USER#bieber` has 50 million followers all reading the profile, that partition pegs at 3000 RCU and throttles. Solutions, in order of preference. First, cache the hot item in DAX or ElastiCache, because a profile read that hits cache never touches DynamoDB. Second, write-shard the hot key on write (store the profile at `PK=USER#bieber#0` through `PK=USER#bieber#9`) and read from one shard chosen randomly, accepting a 10x write amplification for the celebrity cohort only. Third, if writes to the hot item are the problem (celebrity post getting a million likes), use an aggregation pattern: writes go to `PK=POST#abc#LIKES#<shard>` shards and a periodic Lambda aggregates into `PK=POST#abc#LIKES#TOTAL`. The aggregated value is eventually consistent but human-scale users cannot tell the difference between 1.2M and 1.23M likes.

Write sharding is not free. It adds complexity to every read path, which now must fan out and merge, and to every write path, which now must choose a shard. Document the shard count as a schema property and never change it without a migration plan. A common anti-pattern is adding shards dynamically as traffic grows, which creates holes in the key space (old data lives at `#0` through `#9`, new data spreads to `#0` through `#99`, and read paths must query all 100 shards to find any record). If you must grow shard count, use consistent hashing on the shard key and a background job to rebalance.

Item collection size limits. An LSI is subject to a hard limit: the total size of all items sharing one partition key, including all LSI projections, cannot exceed 10GB. Exceed it and writes to that partition key fail with `ItemCollectionSizeLimitExceededException`. This is a silent timebomb in designs that put large collections under one PK (all messages for one user, all events for one device). Staff engineers either avoid LSIs on such tables or implement a time-based partitioning scheme: `PK=USER#id#2026-Q1`, `PK=USER#id#2026-Q2`, rolling forward by quarter. This sacrifices "all messages in one Query" for "predictable storage per partition".

PartiQL and document APIs, 2026. DynamoDB's PartiQL support lets you write SQL-like queries against a single-table schema. It is a productivity feature, not a performance feature: PartiQL compiles down to the same Query, GetItem, and Scan primitives, and a badly written `SELECT * FROM Table WHERE ...` still does a full table scan at enormous cost. Staff engineers permit PartiQL for operational tooling and ad-hoc investigation, and forbid it in production application code where implicit scans hide behind SQL-looking syntax. The 2026 zero-ETL integration to Redshift removes the historical pressure to support analytics access patterns in the OLTP table, which simplifies single-table designs because you no longer need to pre-compute rollups in DynamoDB just to serve analytics.

Migration exit plan, staff level. Single-table designs are the hardest DynamoDB schemas to migrate off of because the key encoding and GSI overloading assume DynamoDB semantics. If the business may move off DynamoDB within 3 years, document the logical schema (the entities and their access patterns) separately from the physical schema (the table and its keys). The logical schema is portable. The physical schema is not. Teams that only document the physical schema pay for the migration twice: once to reverse-engineer the logical intent, once to rebuild it on the new engine.

---
