## 37C.6 Hierarchical Data Patterns

Hierarchical data appears constantly: product categories, organizational charts, threaded comments, file systems, geographic regions.

### Adjacency List

The adjacency list is the simplest hierarchical model: each row stores a `parent_id` that points to its parent in the same table. It maps directly to the way most developers think about trees, and inserting or moving a node requires updating only one row.

```sql
CREATE TABLE categories (
    id        uuid PRIMARY KEY,
    name      text NOT NULL,
    parent_id uuid REFERENCES categories(id)
);
```

**Retrieve all descendants** (N+1 without recursive CTE):

```sql
-- Recursive CTE: get full subtree for a node
WITH RECURSIVE subtree AS (
    -- Base case: start with the given category
    SELECT id, name, parent_id, 0 AS depth
    FROM categories
    WHERE id = $1

    UNION ALL

    -- Recursive case: join children
    SELECT c.id, c.name, c.parent_id, s.depth + 1
    FROM categories c
    JOIN subtree s ON s.id = c.parent_id
)
SELECT * FROM subtree ORDER BY depth, name;
```

Pros: Simple to insert/update (just set `parent_id`).
Cons: Fetching entire subtrees requires recursive CTEs. Deep trees have poor performance.

### Nested Sets

Nested sets encode the tree structure as a pair of left/right integers. Every node's `lft` and `rgt` values enclose its descendants' range, so subtree and ancestor queries reduce to simple range comparisons with no recursion.

```sql
CREATE TABLE categories (
    id    uuid PRIMARY KEY,
    name  text NOT NULL,
    lft   int NOT NULL,
    rgt   int NOT NULL
);

-- For a tree: Electronics (1-8) > Phones (2-5) > Smartphones (3-4), Tablets (6-7)
-- Electronics: lft=1, rgt=8
-- Phones: lft=2, rgt=5
-- Smartphones: lft=3, rgt=4
-- Tablets: lft=6, rgt=7

-- Get all descendants of Electronics
SELECT * FROM categories
WHERE lft BETWEEN 1 AND 8
ORDER BY lft;

-- Get all ancestors of Smartphones (lft=3, rgt=4)
SELECT * FROM categories
WHERE lft < 3 AND rgt > 4
ORDER BY lft;
```

Pros: Extremely fast reads (no recursion, pure range scan).
Cons: Inserts and moves require updating up to half the table (renumbering lft/rgt). Unusable for write-heavy hierarchies.

### Closure Table (Recommended for Most Use Cases)

A closure table stores every ancestor-descendant relationship explicitly in a separate join table, including a `depth` column. This makes both subtree queries (all descendants of X) and ancestor queries (all parents of X) fast indexed lookups rather than recursive walks. The trade-off is that inserts require writing one row per ancestor of the new node.

```sql
CREATE TABLE categories (
    id   uuid PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE category_paths (
    ancestor   uuid NOT NULL REFERENCES categories(id),
    descendant uuid NOT NULL REFERENCES categories(id),
    depth      int NOT NULL,  -- 0 = self-reference, 1 = direct child, etc.
    PRIMARY KEY (ancestor, descendant)
);

-- Insert Electronics (self-reference only initially)
INSERT INTO category_paths VALUES ('elec-id', 'elec-id', 0);

-- Insert Phones as child of Electronics
INSERT INTO categories VALUES ('phone-id', 'Phones');
-- Copy all ancestors of Electronics + the new node itself
INSERT INTO category_paths (ancestor, descendant, depth)
SELECT p.ancestor, 'phone-id', p.depth + 1
FROM category_paths p
WHERE p.descendant = 'elec-id'
UNION ALL
SELECT 'phone-id', 'phone-id', 0;
```

Once the closure table is populated, querying descendants or ancestors is a straightforward indexed join, no recursion required.

```sql
-- Get all descendants of Electronics
SELECT c.*
FROM categories c
JOIN category_paths cp ON cp.descendant = c.id
WHERE cp.ancestor = 'elec-id'
  AND cp.depth > 0;

-- Get all ancestors of Smartphones
SELECT c.*
FROM categories c
JOIN category_paths cp ON cp.ancestor = c.id
WHERE cp.descendant = 'smartphone-id'
  AND cp.depth > 0
ORDER BY cp.depth DESC;

-- Move a subtree: close the old paths, open new paths
-- (requires transaction and care to not create cycles)
```

Pros: Fast reads AND writes. Both directions (ancestors/descendants) are efficient.
Cons: Extra table, more complex inserts/moves.

### ltree in PostgreSQL

PostgreSQL's `ltree` extension provides path enumeration:

```sql
CREATE EXTENSION ltree;

CREATE TABLE categories (
    id   uuid PRIMARY KEY,
    name text NOT NULL,
    path ltree NOT NULL  -- e.g., 'Electronics.Phones.Smartphones'
);

CREATE INDEX idx_categories_path ON categories USING GIST (path);

-- Insert
INSERT INTO categories VALUES (gen_random_uuid(), 'Smartphones', 'Electronics.Phones.Smartphones');

-- Get all descendants of Electronics
SELECT * FROM categories WHERE path <@ 'Electronics';

-- Get all ancestors of Smartphones
SELECT * FROM categories WHERE 'Electronics.Phones.Smartphones' ~ (path::text || '.*')::lquery;

-- Get direct children of Electronics
SELECT * FROM categories WHERE path ~ 'Electronics.*{1}';
```

Pros: Clean syntax, good performance with GiST index, built into PostgreSQL.
Cons: Renaming a parent requires updating all descendant paths.

### Go: Working with Hierarchical Data

Hierarchical data is stored using the Closure Table pattern: a separate `ancestors` table stores every (ancestor, descendant, depth) triple, so a subtree query is a single `WHERE ancestor_id = $1` join rather than a recursive CTE that visits nodes one level at a time. The Closure Table makes reads very fast but adds overhead to writes (insert one row into the hierarchy table plus one row per ancestor into the closure table), making it the best choice for read-heavy hierarchies with infrequent structural changes like category trees or organizational charts. PostgreSQL's `ltree` extension represents paths as labels separated by dots (`root.child.grandchild`) and provides GiST-indexed operators for subtree, ancestor, and pattern queries, offering an alternative to Closure Table for hierarchies with frequent path-based navigation.

```go
type Category struct {
    ID       uuid.UUID  `db:"id"`
    Name     string     `db:"name"`
    ParentID *uuid.UUID `db:"parent_id"`
    Depth    int        `db:"depth"`
    Children []*Category
}

func (r *CategoryRepo) GetSubtree(ctx context.Context, rootID uuid.UUID) (*Category, error) {
    rows, err := r.db.Query(ctx, `
        WITH RECURSIVE subtree AS (
            SELECT id, name, parent_id, 0 AS depth
            FROM categories WHERE id = $1
            UNION ALL
            SELECT c.id, c.name, c.parent_id, s.depth + 1
            FROM categories c
            JOIN subtree s ON s.id = c.parent_id
        )
        SELECT id, name, parent_id, depth FROM subtree ORDER BY depth, name
    `, rootID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    // Build tree from flat list
    nodeMap := make(map[uuid.UUID]*Category)
    var root *Category

    for rows.Next() {
        var c Category
        if err := rows.Scan(&c.ID, &c.Name, &c.ParentID, &c.Depth); err != nil {
            return nil, err
        }
        nodeMap[c.ID] = &c
        if c.Depth == 0 {
            root = &c
        } else if c.ParentID != nil {
            parent := nodeMap[*c.ParentID]
            if parent != nil {
                parent.Children = append(parent.Children, &c)
            }
        }
    }

    return root, rows.Err()
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

The first mental model to fix. "Hierarchy" in a relational database is not one thing. It is at least five different storage patterns with wildly different read and write costs, and picking the wrong one costs you an afternoon at small scale and a quarter at large scale. The choice depends on three questions: how deep can the tree get, what is the read/write ratio, and do you need to move subtrees. If you cannot answer those three questions, you cannot pick a model, so always ask them before coding.

Worked example for a first job. You are building a comment thread for a blog. Reddit-style nesting, users reply to replies, depth can reach 20 levels. The junior trap is adjacency list with a recursive CTE per page load. At 10 comments per post, fine. At 10k comments per post, your page takes 3 seconds. The right answer here is either (a) cap depth at something small like 6 and use adjacency list with a single recursive query, or (b) use a materialized path / ltree so fetching the entire thread is `WHERE path <@ 'thread_root'` with a GiST index and no recursion. For a product hierarchy where nodes move rarely and reads dominate, closure table is usually the right call because both ancestor and descendant queries are indexed point lookups.

Interview entry-point question. "How would you store a category tree with 500k nodes where users frequently browse subtrees?" A junior names one pattern. A FAANG-ready answer walks the matrix: adjacency list (simple, recursive CTE on read, good for shallow trees, good write perf), nested sets (blazing reads, terrible writes because inserts renumber half the table, only viable for nearly-static trees), materialized path / ltree (good reads with GiST, rename-parent requires updating all descendants), closure table (fast reads and writes in both directions, extra storage O(n*avg_depth), extra complexity on inserts and moves), recursive CTE on adjacency list (acceptable up to a few thousand nodes per subtree). Then you pick based on the read/write ratio and whether moves are common. For a category tree (mostly static, read-heavy, both ancestor and descendant queries), closure table or ltree. For an org chart with frequent reorgs, adjacency list plus cached computed paths refreshed on reorg.

One more prerequisite. When the business says "it is a tree" and you find two parents for one node, it is not a tree, it is a DAG. A DAG breaks nested sets and closure tables silently (closure table breaks less badly but still requires cycle detection on insert). For DAGs, use adjacency list with careful cycle prevention, or graph databases if the access pattern is graph traversal rather than tree walks.

### Senior @ FAANG: Staff and Principal Material

The decision matrix at scale is more nuanced than the junior version. For trees with millions of nodes where reads and writes both matter, closure table is the safe default but the storage cost is real. A balanced tree with average depth 8 costs roughly 8x the row count in the closure table. For a 10M node tree, that is 80M closure rows, which is still manageable but starts to matter for index maintenance and vacuum. Partial closure (only depths up to N) cuts storage but loses the full ancestor query. Compressed closure variants (store only (parent, child) and (ancestor, descendant, depth) separately with different indexes) exist but the complexity rarely pays off versus just using ltree or a graph database.

ltree in Postgres at scale is underrated. The GiST index supports `@>` (ancestor), `<@` (descendant), and `~` lquery pattern match. For trees up to low millions of nodes, ltree on a GiST index performs within 2x of closure table for descendant queries and beats it for pattern queries like "all nodes three levels below Electronics matching Phones.*." The cost is renames. Changing a parent requires updating all descendant paths, which is O(subtree size). For trees where the top of the hierarchy rarely changes and only leaf churn is high, ltree is ideal. A single `ltree` column is indexed with GiST (`gist_ltree_ops`) for the tree operators (`@>`, `<@`, `~`); GIN applies to `ltree[]` array columns. Check your Postgres version's `ltree` docs for the exact operator and index support before relying on it.

Recursive CTE performance. A recursive CTE on adjacency list with a good parent_id index performs well up to subtrees of a few thousand nodes. The planner cannot push down filters through the recursion, which is the biggest foot-gun. If you filter "give me the subtree of X where active = true," the CTE still walks every row and filters at the top. Workaround: add the filter condition inside the recursive term, or use a LATERAL join pattern. For Postgres 14+ there is `SEARCH` and `CYCLE` syntax in WITH RECURSIVE which handles cycle detection in the query rather than in application code. Use it. Skipping cycle detection is how you discover that someone made a circular reporting chain and your query ran for three days.

When to move to a graph database. The rule: if your queries are "find all paths from A to B with length < 5 where edges satisfy some predicate," you have a graph query, not a tree query, and relational patterns will be painful. Neo4j, Dgraph, JanusGraph, TigerGraph, or ArangoDB are the options. Neo4j is the default for graph-native workloads with Cypher. Dgraph is a distributed alternative with GraphQL-native. For fraud detection, recommendation engines, social graphs, and knowledge graphs, use a graph database. For hierarchies that happen to be trees or near-trees, stay in Postgres. The migration cost of moving to a separate graph database is significant: dual writes, separate operational expertise, and most of the tree queries you actually need are not graph queries.

Postgres hybrid pattern. Keep your transactional data in Postgres with adjacency list, and maintain a denormalized path column (ltree or text) as a generated column or via trigger. On insert or move, update the path for the moved subtree. This gives you fast ancestor and descendant queries via GiST without the full closure table storage, while keeping move operations tractable. For read-heavy analytics on the hierarchy, replicate to ClickHouse or a graph database via CDC.

Materialized path at FAANG scale: watch for text path length. A 30-level deep tree with UUID labels produces paths around 1 KB per row, which hurts index size and cache efficiency. Use short labels (compact integer IDs or base62 encodings) in the path, not UUIDs. Keep a separate table mapping path label to real ID.

Concurrency on tree modifications. Moving a subtree in closure table or ltree is not a single-row operation. You are updating hundreds or thousands of rows, and a concurrent insert under the moved node can easily produce inconsistent state. Use `SELECT FOR UPDATE` on the subtree root, or use advisory locks keyed on the tree root. Avoid moving subtrees on the hot path. If users can reorg live, queue the reorg as an async job with a visible "reorg in progress" state so that clients do not see a half-moved tree.

Graph database choice in 2026. Neo4j 5.x with clustering is the mature enterprise choice. Memgraph is in-memory and targets real-time. Dgraph and NebulaGraph are the distributed choices for graphs that will not fit in one machine. Apache AGE is a Postgres extension that adds Cypher to Postgres, which lets you keep relational data and graph queries in one store, with the trade-off that AGE query performance is not in the same league as native graph databases. For recommendation and fraud, prefer dedicated graph. For "we have an occasional graph query," AGE is the pragmatic path.

CTE optimization fence. Prior to Postgres 12, CTEs were optimization fences, meaning the planner materialized them even when it could have inlined. Since 12, CTEs are inlined when referenced once and not recursive. Recursive CTEs are still fences by necessity. For complex tree queries, sometimes rewriting a recursive CTE as a LATERAL join plus a level limit produces a faster plan because the planner has more freedom. Always EXPLAIN ANALYZE before and after.

What to push back on. If a PM says "we want unlimited nesting depth," ask what the product actually needs. Most comment threads cap at 6 to 10 levels visually. Most category trees cap at 5. Unbounded depth is rarely a real requirement, and constraining it to 20 levels lets you skip every nested-set-vs-closure-table debate and just use adjacency list with a recursive CTE capped at the depth limit. If an engineer proposes denormalizing the full path into every node "for convenience," ask who updates it on rename and what happens if the update partially fails. That is a materialized path without any of the correctness infrastructure.

---
