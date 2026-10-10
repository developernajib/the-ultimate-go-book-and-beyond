## 37C.1 Data Modeling Fundamentals Review

### Normalization: Theory and Pragmatics

Normalization is a systematic approach to reducing data redundancy and eliminating update anomalies. The normal forms are cumulative: 3NF implies 2NF implies 1NF.

**First Normal Form (1NF)**: Eliminate repeating groups and ensure atomic values.

```sql
-- Violation: multiple values in one column
CREATE TABLE orders (
    id         uuid PRIMARY KEY,
    product_ids text  -- "prod_1,prod_2,prod_3" - violation
);

-- 1NF: atomic values, separate rows
CREATE TABLE order_items (
    id         uuid PRIMARY KEY,
    order_id   uuid NOT NULL REFERENCES orders(id),
    product_id uuid NOT NULL REFERENCES products(id),
    quantity   int  NOT NULL,
    unit_price numeric(10,2) NOT NULL
);
```

**Second Normal Form (2NF)**: All non-key attributes must be fully dependent on the entire primary key (matters for composite keys).

```sql
-- Violation: product_name depends on product_id, not on (order_id, product_id)
CREATE TABLE order_items (
    order_id     uuid,
    product_id   uuid,
    product_name text,  -- violation: depends only on product_id
    quantity     int,
    PRIMARY KEY (order_id, product_id)
);

-- 2NF: product_name belongs in products table
CREATE TABLE order_items (
    order_id   uuid,
    product_id uuid,
    quantity   int,
    unit_price numeric(10,2),  -- price at time of order - this DOES depend on the composite key
    PRIMARY KEY (order_id, product_id)
);
```

**Third Normal Form (3NF)**: No transitive dependencies - non-key attributes must not depend on other non-key attributes.

```sql
-- Violation: zip_code → city, state (transitive dependency)
CREATE TABLE customers (
    id         uuid PRIMARY KEY,
    name       text,
    zip_code   text,
    city       text,  -- violation: determined by zip_code
    state      text   -- violation: determined by zip_code
);

-- 3NF: extract the transitive dependency
CREATE TABLE zip_codes (
    zip_code text PRIMARY KEY,
    city     text NOT NULL,
    state    text NOT NULL
);

CREATE TABLE customers (
    id       uuid PRIMARY KEY,
    name     text,
    zip_code text REFERENCES zip_codes(zip_code)
);
```

**Boyce-Codd Normal Form (BCNF)**: A stricter version of 3NF. Every determinant must be a candidate key. Relevant in tables with multiple overlapping candidate keys (rare in practice).

### When to Normalize

3NF is a *starting point*, not a goal. It is the default because it prevents update anomalies by construction, but production systems routinely denormalize specific read paths once the read/write ratio and query patterns are known. The rule is: normalize first, measure, then denormalize with a clear plan for maintaining invariants.

Normalize by default when:
- Data is frequently updated (normalization prevents update anomalies - change a customer name in one place)
- Data integrity is critical (foreign keys enforce consistency)
- Storage is a constraint
- Write performance is more important than read performance
- Query patterns are not yet known (premature denormalization locks you into assumptions)

### Denormalization: When Normalized Is Too Slow

Denormalization is a deliberate decision to introduce redundancy to improve read performance. It always involves a trade-off.

```sql
-- Normalized: need JOIN to get order total
SELECT o.id, SUM(oi.unit_price * oi.quantity) as total
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.id = $1
GROUP BY o.id;

-- Denormalized: total is stored directly on orders
-- Must be kept consistent when items change
ALTER TABLE orders ADD COLUMN cached_total numeric(10,2);
```

Common denormalization patterns:

1. **Cached aggregates**: Store counts, sums directly on parent row (`orders.item_count`, `posts.comment_count`)
2. **Duplicated frequently-read fields**: Copy `customer.email` to `orders.customer_email` to avoid the JOIN
3. **Materialized views**: Precomputed query results refreshed on a schedule or trigger
4. **Read replicas with denormalized schema**: Different schema optimized for reporting

**Every denormalization needs an invariant owner.** If `orders.customer_email` duplicates `customers.email`, you must name the mechanism that keeps them consistent: a trigger, an application-layer dual-write, an event-driven projection, or a scheduled reconciliation job. "We'll remember to update both" is not a mechanism - it is a future incident. For order-line-item denormalization specifically, the common practice is to freeze the copy (orders record the price *at the time of purchase*, not the current price) which eliminates the consistency problem entirely by design.

The normalization-performance trade-off in numbers: a fully normalized order schema might require 5 JOINs for a typical order display query. On a table with 100 million orders and proper indexes, this query takes 50ms. Denormalizing to a single `orders_with_details` materialized view reduces it to 5ms. The cost: 3x storage, background refresh complexity, and potential stale data.

### Junior → FAANG: Functional Dependencies Without the Jargon

A functional dependency `A → B` means "given A, B is determined." In `zip_codes(zip_code, city, state)`, `zip_code → city` and `zip_code → state`. Normal forms are nothing more than rules for where dependencies are allowed to live. 1NF says no lists in a cell. 2NF says non-key columns cannot depend on only part of a composite key. 3NF says non-key columns cannot depend on other non-key columns. BCNF tightens 3NF for the rare case where a non-key column determines part of a candidate key.

Worked example to grind the rules into muscle memory. Take `enrollment(student_id, course_id, student_name, course_title, instructor, instructor_office)`. Find the dependencies. `student_id → student_name`. `course_id → course_title, instructor`. `instructor → instructor_office`. Decompose. `students(student_id, student_name)`, `courses(course_id, course_title, instructor_id)`, `instructors(instructor_id, instructor_office)`, `enrollments(student_id, course_id)`. Notice how `instructor → instructor_office` was a transitive dependency that 3NF forced out. If you can run that exercise on any schema in an interview, you pass the relational-theory bar.

First-job context and interview entry-point. You will be handed a schema with a `text` column full of comma-separated tags and asked to refactor. The steps are one, create `tags(tag_id, name)`. Two, create `entity_tags(entity_id, tag_id)`. Three, backfill with a script that splits and inserts. Four, dual-write from the application while the old column still exists. Five, switch reads. Six, drop the old column. That is the expand-and-contract pattern you will see formalized later in the chapter, and it is the single most common migration an L4 is expected to drive end-to-end.

### Senior @ FAANG: When 3NF Is the Wrong Default

The section above states "3NF is a starting point." At staff level you need a sharper position. 3NF is the right default for OLTP tables under a billion rows where writes are mixed with reads. It is the wrong default in three regimes, and recognizing them early saves years of migration work.

Regime one. Analytical workloads. Star and snowflake schemas deliberately violate 3NF by duplicating dimension attributes across fact rows or by keeping dimension tables wide and flat. The reason is that columnar engines (BigQuery, Snowflake, ClickHouse, Redshift, Druid) scan and compress wide tables efficiently and pay heavy cost for joins across billions of rows. A dimension table with 50 columns and 10 million rows joined to a 500 billion row fact table on every query is a non-starter. The correct model is a denormalized fact with dimension attributes copied in (a "one big table" pattern in some shops) or a star schema with dimension caching in the engine. The ADR must document that analytical consistency is eventual and refreshed via ETL, not transactional.

Regime two. Wide-column query-first stores. Cassandra, Scylla, and DynamoDB punish normalization because every additional table is another round trip and there are no joins. The pattern is denormalized duplicate-per-access-path. A `user_by_email`, a `user_by_id`, and a `user_by_org` are three physical tables sharing no storage and kept in sync by application writes or by CDC (change data capture) fanout. DynamoDB single-table design pushes this further by embedding multiple entity types in one table distinguished by partition-key prefixes. The price is that schema evolution requires rewriting every access-path table. The reward is predictable single-digit millisecond latency at any scale.

Regime three. Hot read paths on billion-row OLTP. When a 3NF query costs a five-way join at p99, a materialized projection maintained by CDC (Debezium to Kafka to a projection service) or by PostgreSQL logical replication into a denormalized read-only table typically beats index tuning. The invariant owner is the projection pipeline, and the reconciliation job runs nightly to detect drift. LinkedIn's Databus and Netflix's DBLog are published examples of this CDC-driven projection pattern.

The deeper principle. Normalization is a property of the write model. Query performance is a property of the read model. CQRS makes this explicit by separating them. Whenever a team insists on "one schema to serve all queries," either the schema is small enough that it does not matter or the team has not yet hit the scale wall. At FAANG scale you always end up with multiple physical representations of the same logical data, and your architecture documentation must enumerate every copy, its owner, its staleness budget, and its reconciliation mechanism. Teams that fail to document this end up with ghost copies nobody owns and data quality incidents that take weeks to root-cause.

One more senior-level nuance. BCNF violations are rare in practice but catastrophic when they occur. The canonical example is a table `advisors(student_id, subject, advisor_id)` where `advisor_id → subject` (each advisor teaches one subject) and `(student_id, subject) → advisor_id`. This is in 3NF but violates BCNF because `advisor_id` is a non-key determinant of a key attribute. Decomposing into `advisor_subject(advisor_id, subject)` and `student_advisor(student_id, advisor_id)` fixes it. In interviews this is a distinguishing question for senior candidates. Most L4s cannot articulate BCNF. Most L6s can spot the violation in ten seconds.

---
