## 83D.7 Section 5: Database Design in System Design Interviews

### How to Discuss Schema Design

When an interviewer asks you to design a database schema:

**1. Start with entities and relationships:**
- "The core entities are Users, Posts, and Comments"
- "Users have many Posts (1:N), Posts have many Comments (1:N)"

**2. Define the schema:**
- Primary keys, foreign keys, data types
- Indexes for common query patterns
- Constraints (UNIQUE, NOT NULL, CHECK)

**3. Discuss access patterns:**
- "The most common query is fetching a user's feed - Posts by people they follow, ordered by time"
- "This requires an index on `posts(author_id, created_at DESC)`"

**4. Address scale:**
- Sharding strategy (by user_id for social, by region for geo)
- Read replicas for heavy read workloads
- Caching layer (Redis) for hot data

### Example: Design a Social Media Feed Schema

The reference SQL below is written to the standard an interviewer expects.

```sql
CREATE TABLE users (
    id         BIGSERIAL PRIMARY KEY,
    username   VARCHAR(50) UNIQUE NOT NULL,
    email      VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE follows (
    follower_id  BIGINT REFERENCES users(id),
    following_id BIGINT REFERENCES users(id),
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id)
);

CREATE TABLE posts (
    id         BIGSERIAL PRIMARY KEY,
    author_id  BIGINT NOT NULL REFERENCES users(id),
    content    TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_posts_author_time ON posts(author_id, created_at DESC);
CREATE INDEX idx_follows_follower ON follows(follower_id);
CREATE INDEX idx_follows_following ON follows(following_id);
```

**Feed query:**
```sql
SELECT p.id, p.content, p.created_at, u.username
FROM posts p
JOIN follows f ON p.author_id = f.following_id
JOIN users u ON p.author_id = u.id
WHERE f.follower_id = $1
ORDER BY p.created_at DESC
LIMIT 20;
```

**Go Integration (sqlc):**
```go
// -- name: GetFeed :many
// SELECT p.id, p.content, p.created_at, u.username
// FROM posts p
// JOIN follows f ON p.author_id = f.following_id
// JOIN users u ON p.author_id = u.id
// WHERE f.follower_id = $1
// ORDER BY p.created_at DESC
// LIMIT $2;
type FeedItem struct {
    PostID    int64
    Content   string
    CreatedAt time.Time
    Username  string
}

type GetFeedParams struct {
    FollowerID int64
    Limit      int32
}

func (s *FeedService) GetFeed(ctx context.Context, userID int64, limit int32) ([]FeedItem, error) {
    return s.queries.GetFeed(ctx, GetFeedParams{
        FollowerID: userID,
        Limit:      limit,
    })
}
```

**At scale (millions of users):**
- Fan-out-on-write: Pre-compute feeds into a `feed` table when a post is created
- Fan-out-on-read: Compute feeds at read time (what the query above does)
- Hybrid: Fan-out-on-write for regular users, fan-out-on-read for celebrities


### Junior → FAANG: Database Design in System Design Interviews

Database design in a system design interview is evaluated on three dimensions: correctness (does the schema support all the required operations), efficiency (are the access patterns served efficiently by the schema), and evolvability (can the schema accommodate likely future requirements without a full rewrite). The minimum bar includes: appropriate primary keys (avoid natural keys that can change), foreign key relationships for referential integrity, and index design that supports the primary query patterns described in the requirements.

### Senior @ FAANG: Database Design as an Architectural Decision with Long-Term Consequences

At the senior level, database design is one of the hardest decisions to reverse in a live system. The schema you choose in the early stages of a system crystallizes the access patterns for years, because changing the schema requires data migrations on tables that may have billions of rows and cannot tolerate downtime. The ADR for a schema design choice should capture: the primary query patterns and their frequency, the expected data volume and growth rate, the normalization level and the trade-off accepted (normalized schemas are more consistent but require more JOINs, denormalized schemas are faster but have higher risk of inconsistency), and the migration path if requirements change. Staff-level concerns include multi-tenancy schema design, which has three options: shared schema with a tenant_id column (simple but requires careful query filtering to prevent cross-tenant data leakage), separate schemas per tenant (good isolation, manageable up to a few thousand tenants), and separate databases per tenant (maximum isolation, high operational overhead). Each option is an ADR with explicit trade-offs.

---
