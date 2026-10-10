## 37C.2 Schema Design Patterns

### Wide Table vs Narrow Table

**Wide table**: Many columns, each attribute is a column.
```sql
CREATE TABLE products (
    id             uuid PRIMARY KEY,
    name           text,
    description    text,
    price_cents    bigint,  -- price in minor units (cents)
    weight_grams   int,
    color          text,
    size           text,
    material       text,
    brand          text,
    sku            text,
    barcode        text,
    is_active      bool,
    created_at     timestamptz,
    updated_at     timestamptz
);
```

Pros: Simple queries, type-safe, indexed efficiently, easy to add constraints.
Cons: Schema migrations required for new attributes, sparse data (many NULLs for optional attributes).

**When to use**: When the attribute set is known and stable. Most entities in a well-understood domain.

### EAV (Entity-Attribute-Value) Pattern

EAV stores each attribute as a separate row with columns for entity ID, attribute name, and attribute value. This trades schema rigidity for flexibility, but at a steep cost to query performance and type safety.

```sql
CREATE TABLE product_attributes (
    product_id  uuid NOT NULL REFERENCES products(id),
    name        text NOT NULL,
    value       text NOT NULL,
    PRIMARY KEY (product_id, name)
);

-- Insert
INSERT INTO product_attributes VALUES ('prod_1', 'color', 'red');
INSERT INTO product_attributes VALUES ('prod_1', 'size', 'XL');
INSERT INTO product_attributes VALUES ('prod_1', 'material', 'cotton');
```

Pros: Infinite attributes without schema changes. Good for highly variable attribute sets.
Cons: No type safety, poor query performance (pivoting is expensive), no referential integrity on values, query complexity explodes for filtering.

```sql
-- Terrible: find all red XL products
SELECT DISTINCT p.id
FROM products p
JOIN product_attributes a1 ON a1.product_id = p.id AND a1.name = 'color' AND a1.value = 'red'
JOIN product_attributes a2 ON a2.product_id = p.id AND a2.name = 'size' AND a2.value = 'XL';
```

**When to use**: Almost never. JSONB is almost always better. If you have EAV in your codebase, it's a red flag.

### JSONB Columns for Semi-Structured Data

PostgreSQL's JSONB stores JSON as a binary structure with indexing support:

```sql
CREATE TABLE products (
    id         uuid PRIMARY KEY,
    name       text NOT NULL,
    price_cents bigint NOT NULL,  -- price in minor units (cents)
    attributes jsonb DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Insert with arbitrary attributes
INSERT INTO products (id, name, price_cents, attributes) VALUES (
    gen_random_uuid(),
    'Running Shoe',
    12999,  -- $129.99 in cents
    '{"color": "blue", "size": "10", "material": "mesh", "drop_mm": 8}'
);

-- Query by JSON attribute
SELECT id, name, price_cents
FROM products
WHERE attributes->>'color' = 'blue'
  AND (attributes->>'size')::int = 10;

-- Index for efficient JSONB queries
CREATE INDEX idx_products_attributes ON products USING GIN (attributes);

-- Index on a specific JSONB path (more efficient for known paths)
CREATE INDEX idx_products_color ON products ((attributes->>'color'));
CREATE INDEX idx_products_size  ON products ((attributes->>'size'));
```

On the Go side, JSONB columns map naturally to `map[string]any`. Marshal the map to JSON before inserting, and use the `||` operator with `::jsonb` to merge attributes without replacing the entire column.

```go
// Go: using JSONB with pgx
type Product struct {
    ID         uuid.UUID      `db:"id"`
    Name       string         `db:"name"`
    PriceCents int64          `db:"price_cents"`
    Attributes map[string]any `db:"attributes"`
    CreatedAt  time.Time      `db:"created_at"`
    UpdatedAt  time.Time      `db:"updated_at"`
}

func (r *ProductRepo) Create(ctx context.Context, p *Product) error {
    attrsJSON, err := json.Marshal(p.Attributes)
    if err != nil {
        return fmt.Errorf("marshaling attributes: %w", err)
    }

    _, err = r.db.Exec(ctx, `
        INSERT INTO products (id, name, price_cents, attributes)
        VALUES ($1, $2, $3, $4)
    `, p.ID, p.Name, p.PriceCents, attrsJSON)
    return err
}

// pgx v5 with pgtype for JSONB
func (r *ProductRepo) UpdateAttributes(ctx context.Context, productID uuid.UUID, attrs map[string]any) error {
    attrsJSON, _ := json.Marshal(attrs)
    _, err := r.db.Exec(ctx, `
        UPDATE products
        SET attributes = attributes || $2::jsonb,  -- merge, not replace
            updated_at = now()
        WHERE id = $1
    `, productID, attrsJSON)
    return err
}
```

**When to use JSONB**: Variable attributes per row, schema evolves rapidly, attributes are not queried frequently or are queried as a unit. Avoid JSONB for attributes that are always present, frequently filtered/sorted, or need referential integrity.

### Polymorphic Associations

Three approaches to "a comment can belong to a post or a video":

**Approach 1: Nullable foreign keys**
```sql
CREATE TABLE comments (
    id       uuid PRIMARY KEY,
    body     text NOT NULL,
    post_id  uuid REFERENCES posts(id),
    video_id uuid REFERENCES videos(id),
    -- constraint: exactly one must be set
    CONSTRAINT exactly_one_parent CHECK (
        (post_id IS NOT NULL)::int + (video_id IS NOT NULL)::int = 1
    )
);
```
Pros: Simple, foreign keys enforced. Cons: Must add a new column for every new parent type.

**Approach 2: Generic foreign key (polymorphic)**
```sql
CREATE TABLE comments (
    id              uuid PRIMARY KEY,
    body            text NOT NULL,
    commentable_type text NOT NULL,  -- 'post', 'video'
    commentable_id   uuid NOT NULL,
    -- Cannot use a foreign key here - no referential integrity
    UNIQUE (commentable_type, commentable_id, id)
);
```
Pros: Works for any parent type. Cons: No referential integrity (deleted posts leave orphan comments), all queries need to filter by type.

**Approach 3: Shared abstract table (recommended for new designs)**
```sql
-- Abstract parent table
CREATE TABLE commentable_items (
    id         uuid PRIMARY KEY,
    item_type  text NOT NULL,  -- 'post', 'video'
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Each concrete type has its own table with a FK to commentable_items
CREATE TABLE posts (
    id              uuid PRIMARY KEY REFERENCES commentable_items(id),
    title           text NOT NULL,
    content         text NOT NULL
);

CREATE TABLE videos (
    id              uuid PRIMARY KEY REFERENCES commentable_items(id),
    title           text NOT NULL,
    duration_seconds int NOT NULL
);

-- Comments reference the abstract parent
CREATE TABLE comments (
    id              uuid PRIMARY KEY,
    body            text NOT NULL,
    commentable_id  uuid NOT NULL REFERENCES commentable_items(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now()
);
```

Pros: Full referential integrity, deleting a post cascades to comments. Cons: Extra join to get the concrete type.

### Temporal Data: Bi-Temporal Modeling

Real-world data has two time dimensions:

- **Valid time**: When the fact was true in the real world (a salary was $100k from Jan 1 to Jun 30)
- **Transaction time**: When the fact was recorded in the database

```sql
-- Bi-temporal salary table
CREATE TABLE employee_salaries (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id      uuid NOT NULL REFERENCES employees(id),
    amount_cents     bigint NOT NULL,  -- salary in minor units (cents)

    -- Valid time: when this salary was effective in reality
    valid_from       date NOT NULL,
    valid_to         date,  -- NULL means currently effective

    -- Transaction time: when this row was recorded (system-managed)
    recorded_at      timestamptz NOT NULL DEFAULT now(),
    recorded_until   timestamptz,  -- NULL means current record in the DB
    recorded_by      uuid REFERENCES users(id),

    -- Exclude overlapping valid_time ranges for same employee
    EXCLUDE USING gist (
        employee_id WITH =,
        daterange(valid_from, valid_to, '[)') WITH &&
    ) WHERE (recorded_until IS NULL)  -- only check current DB records
);

-- Current salary (valid now, current DB record)
SELECT amount_cents
FROM employee_salaries
WHERE employee_id = $1
  AND valid_from <= CURRENT_DATE
  AND (valid_to IS NULL OR valid_to > CURRENT_DATE)
  AND recorded_until IS NULL;

-- What did we think their salary was on March 1, 2023?
SELECT amount_cents
FROM employee_salaries
WHERE employee_id = $1
  AND valid_from <= '2023-03-01'
  AND (valid_to IS NULL OR valid_to > '2023-03-01')
  AND recorded_at <= '2023-03-01 23:59:59'
  AND (recorded_until IS NULL OR recorded_until > '2023-03-01');
```

### Soft Delete vs Hard Delete vs Archive Table

**Hard delete**: `DELETE FROM users WHERE id = $1`
- Data is gone forever. Foreign key constraints enforced.
- Problem: impossible to audit who deleted what, audit logs lose context.

**Soft delete**: `UPDATE users SET deleted_at = now() WHERE id = $1`
```sql
ALTER TABLE users ADD COLUMN deleted_at timestamptz;

-- All queries must remember to filter
SELECT * FROM users WHERE deleted_at IS NULL AND id = $1;

-- Easy to miss in complex joins - creates data integrity issues
```
- Pros: Easy to implement, "undelete" is trivial.
- Cons: All queries need `WHERE deleted_at IS NULL`. Unique constraints break (`UNIQUE (email)` should only apply to non-deleted). Foreign keys still point to deleted records.

**Partial index for soft delete** (reduces most cons):
```sql
-- Unique email only among active users
CREATE UNIQUE INDEX idx_users_email_active
    ON users (email) WHERE deleted_at IS NULL;

-- Row-level security: hide deleted rows automatically
CREATE POLICY hide_deleted ON users
    FOR SELECT USING (deleted_at IS NULL);
```

**Archive table**: Move deleted rows to a `deleted_users` table.
```sql
CREATE TABLE deleted_users (
    LIKE users INCLUDING ALL,  -- same structure
    deleted_at  timestamptz NOT NULL DEFAULT now(),
    deleted_by  uuid REFERENCES users(id)
);

-- Trigger or application code moves rows on delete
CREATE OR REPLACE FUNCTION archive_deleted_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO deleted_users SELECT OLD.*, now(), current_user_id();
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER archive_user_before_delete
    BEFORE DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION archive_deleted_user();
```

Pros: Clean `users` table (no `deleted_at` filter everywhere), true deletion with audit trail.
Cons: Complexity, archive table queries for audit, application must handle the archive table.

### Audit Log Pattern

A generic audit log records every INSERT, UPDATE, and DELETE as a row in a separate table, capturing the old and new values as JSONB. A trigger-based approach keeps the audit logic out of application code entirely, so every change is captured regardless of which service or migration script made the modification.

```sql
CREATE TABLE audit_logs (
    id           bigserial PRIMARY KEY,
    table_name   text NOT NULL,
    record_id    uuid NOT NULL,
    operation    text NOT NULL,  -- 'INSERT', 'UPDATE', 'DELETE'
    old_values   jsonb,
    new_values   jsonb,
    changed_by   uuid,
    changed_at   timestamptz NOT NULL DEFAULT now(),
    ip_address   inet,
    user_agent   text
);

-- Index for fast lookups by record
CREATE INDEX idx_audit_logs_record ON audit_logs (table_name, record_id, changed_at DESC);

-- Generic audit trigger
CREATE OR REPLACE FUNCTION audit_trigger_function()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO audit_logs (
        table_name, record_id, operation, old_values, new_values
    ) VALUES (
        TG_TABLE_NAME,
        COALESCE(NEW.id, OLD.id),
        TG_OP,
        CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) END,
        CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) END
    );
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Apply to any table
CREATE TRIGGER audit_orders
    AFTER INSERT OR UPDATE OR DELETE ON orders
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
```

Go: reading audit logs:

```go
type AuditLog struct {
    ID         int64           `db:"id"`
    TableName  string          `db:"table_name"`
    RecordID   uuid.UUID       `db:"record_id"`
    Operation  string          `db:"operation"`
    OldValues  json.RawMessage `db:"old_values"`
    NewValues  json.RawMessage `db:"new_values"`
    ChangedBy  *uuid.UUID      `db:"changed_by"`
    ChangedAt  time.Time       `db:"changed_at"`
}

func (r *AuditRepo) GetHistory(ctx context.Context, tableName string, recordID uuid.UUID) ([]AuditLog, error) {
    rows, err := r.db.Query(ctx, `
        SELECT id, table_name, record_id, operation, old_values, new_values, changed_by, changed_at
        FROM audit_logs
        WHERE table_name = $1 AND record_id = $2
        ORDER BY changed_at DESC
        LIMIT 100
    `, tableName, recordID)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var logs []AuditLog
    for rows.Next() {
        var l AuditLog
        if err := rows.Scan(&l.ID, &l.TableName, &l.RecordID, &l.Operation,
            &l.OldValues, &l.NewValues, &l.ChangedBy, &l.ChangedAt); err != nil {
            return nil, err
        }
        logs = append(logs, l)
    }
    return logs, rows.Err()
}
```

### Junior → FAANG: Picking a Pattern Without Over-Engineering

Your instinct at L3 is to reach for JSONB the moment a field feels uncertain. Resist it. JSONB is the right answer only when the attribute set genuinely varies per row, or when the set changes fast enough that migrations cannot keep up. For a product catalog where every item has `color`, `size`, and `weight`, those are columns. For a product catalog where one item is a shoe with `drop_mm` and another is a lamp with `lumens`, the variable part is JSONB. The same rule applies to polymorphism. If you have two parent types and they are stable, nullable foreign keys with a CHECK constraint is the simplest correct answer. If you have five parent types and expect more, the shared abstract table (Approach 3) earns its complexity.

Worked example and interview entry-point. A common L4 design question is "model a notification system where notifications can come from many sources (comment, follow, mention, system)." The naive answer is a polymorphic `source_type` plus `source_id` with no foreign key. The better answer is the abstract-parent pattern with a `notification_sources` table and concrete tables per source type, each with its own `REFERENCES notification_sources(id)`. When the interviewer asks "what if we have 50 source types," you escalate to a discriminator column plus JSONB payload plus a schema registry that documents the shape per discriminator value. That progression (simple, correct, scalable) is what the interviewer is listening for.

For soft delete specifically. On your first job you will inherit a codebase that soft-deletes everything. Do not crusade against it on day one. Do add the partial unique index trick so that `email` is unique among non-deleted rows. Do add a view `active_users` that hides the filter so new queries do not forget it. Over time, push toward the archive-table pattern for entities where undelete is not a product requirement.

### Senior @ FAANG: STI vs CTI, Discriminator Discipline, and the Soft-Delete ADR

Polymorphic modeling at staff level splits into two camps with names borrowed from ORM theory. STI (single-table inheritance) puts all subclasses in one physical table with a discriminator column and nullable columns for the subclass-specific fields. CTI (class-table inheritance) gives each subclass its own table, all sharing a common parent table (the abstract-parent pattern above). A third option, concrete table inheritance, duplicates parent columns into each subclass table and is almost always wrong because it breaks referential integrity for foreign keys that point to "any subclass."

The choice criteria. STI wins when subclasses share 80 percent of columns and the set of subclasses is small and stable. Reads are single-table, no joins, trivially fast. The cost is that the table is sparse (NULLs in columns that only apply to some subclasses) and that adding a new subclass touches every query that filters on the discriminator. CTI wins when subclasses diverge substantially, when each subclass needs its own foreign-key targets, or when regulatory requirements demand strict column-level ownership per subclass. The cost is the join and the slight complexity of inserts (two rows per entity).

Discriminator discipline. Every discriminator column must have three properties. One, an enum or foreign-key-constrained type so the set of legal values is enforced by the database. Two, a documented mapping from discriminator value to the shape of any polymorphic payload (commonly JSONB), and that mapping must live in a schema registry (Protobuf, Avro, or JSON Schema) with versioning. Three, a code path in the application layer that refuses to deserialize an unknown discriminator value rather than silently treating it as the default. Teams that skip any of these three end up with rows whose discriminator says one thing and whose payload says another, and that class of bug is nearly impossible to detect without an explicit reconciliation job.

Soft delete ADR at scale. The honest position is that soft delete is an anti-pattern 80 percent of the time and a necessity the other 20. The 80 percent failure mode is "we might want to undelete this someday" which almost never happens, and meanwhile every query in the codebase carries a `WHERE deleted_at IS NULL` clause that humans forget, that ORMs apply inconsistently, that breaks unique indexes, that poisons foreign keys, and that inflates storage by keeping dead rows forever. The 20 percent legitimate cases are contractual or policy-driven undelete windows, user-facing "trash" folders (Gmail, Dropbox), and legal hold where data cannot be physically removed. For each legitimate case the ADR must specify the retention window, the mechanism that physically deletes rows past the window (a scheduled job with a query plan that uses an index on `deleted_at`), and the authorization model that gates undelete. Teams that adopt soft delete without that ADR typically discover years later that their "deleted" table is half their storage cost.

The archive-table pattern is strictly superior for most cases. The live table stays clean, no `deleted_at` filter pollutes queries, unique indexes work normally, and the archive table carries its own schema optimized for audit (including who-deleted-what and why). The cost is a trigger or application-layer move, which is trivial. At Meta, Airbnb, and Netflix, the prevailing pattern for "deletion" is a combination of archive tables for most entities plus event-sourced logs for anything regulated, with soft delete reserved for narrow UX cases where the user expects reversibility.

Bitemporal modeling. The section above gives the pattern. The staff-level nuance is that SQL:2011 `PERIOD FOR SYSTEM_TIME` standardizes system-time (transaction-time) but does not standardize valid-time. DB2, SQL Server, and MariaDB implement system-time natively. PostgreSQL requires extensions (temporal_tables, periods) or hand-rolled patterns. For applications touching money, insurance, healthcare, or legal obligations, bitemporal is not optional. The query pattern must default to "as of now, as known now" and every historical query must carry explicit `AS OF VALID_TIME x AND SYSTEM_TIME y` clauses. Getting this wrong in a financial system is a reporting incident and possibly a regulatory filing. Snowflake's Time Travel and BigQuery's FOR SYSTEM_TIME AS OF give a partial substitute for analytical workloads but are not a replacement for proper bitemporal modeling in the transactional store.

One more pattern worth naming. Event sourcing plus CQRS flips the modeling question entirely. The write model is an append-only event log (`events(aggregate_id, version, event_type, payload, occurred_at)`), and the read model is a projection rebuilt from the log. The benefit is perfect auditability and arbitrary read-model flexibility. The cost is event-schema evolution (which the schema-registry chapter covers), snapshot management for aggregates with long histories, and the cognitive load of eventual consistency. Adopt it where regulation demands it or where read patterns are genuinely heterogeneous. Reject it for a standard CRUD service where a boring `updated_at` audit trail and an archive table cover 95 percent of the requirement at 5 percent of the cost.

---
