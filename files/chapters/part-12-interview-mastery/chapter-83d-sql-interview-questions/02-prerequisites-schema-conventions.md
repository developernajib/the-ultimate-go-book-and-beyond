## 83D.2 Prerequisites: Schema Conventions

All questions use PostgreSQL syntax. Unless stated otherwise, assume:

```sql
-- Timestamps on every table
created_at TIMESTAMP NOT NULL DEFAULT NOW(),
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
```

We omit these from schemas below for brevity but they are always present in production.


### Junior → FAANG: Understanding the Schema Conventions

Schema conventions are the shared vocabulary that makes SQL question solutions reproducible. Before writing any query, confirm your understanding of the schema - which columns represent IDs (usually integers), which represent strings, which represent timestamps, and what the primary and foreign key relationships are. The most common mistake in SQL interviews is writing a query that produces incorrect results because you made an assumption about the data type or the uniqueness constraint of a column.

### Senior @ FAANG: Schema Conventions as a Design Communication Tool

At the senior level, schema conventions are a governance tool. A consistent naming convention (snake_case column names, id as the primary key name, created_at and updated_at on every table, foreign keys named as referenced_table_id) reduces the cognitive load on every engineer who touches the database and makes migration scripts more predictable. When reviewing a new schema design, senior engineers should verify not just correctness but compliance with the team's conventions. Staff-level concerns include the enforcement mechanism: are conventions documented in a style guide, enforced by linting in CI, or only enforced by code review? The most reliable enforcement is automated (a migration linter that rejects non-compliant column names), because code review enforcement is inconsistent and creates friction.

---

