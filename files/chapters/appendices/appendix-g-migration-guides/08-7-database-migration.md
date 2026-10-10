## 7. Database Migration Architecture

### 7.1 The Database Paradigm Shift: ORM Magic vs Explicit SQL

When migrating from ecosystems like Ruby (ActiveRecord), Python (Django ORM / SQLAlchemy), or Java (Hibernate / Spring Data), developers frequently attempt to recreate full ORM magic in Go using tools like GORM. In enterprise production, this is an anti-pattern:

- **The Hidden Cost of ORM Magic**: ORMs encourage N+1 queries, unpredictable implicit joins, and hidden SQL generation that fails silently under load.
- **The Go Engineering Paradigm**: Go favors explicit, compile-time verified database interactions. In modern Go architectures, the industry standard is **sqlc** or native **pgx**: write raw, optimized SQL queries and let code generators create strictly typed, zero-allocation Go functions.

```
┌──────────────────────────────────────────────────────────────┐
│                  Database Layer Comparison                   │
├──────────────┬─────────────────────────────┬─────────────────┤
│ Approach     │ Strengths                   │ Production Risk │
├──────────────┼─────────────────────────────┼─────────────────┤
│ GORM         │ Rapid prototyping, hooks    │ Heavy reflection│
│ SQLx         │ Lightweight struct mapping  │ Runtime errors  │
│ sqlc (Best)  │ Compile-time type safe SQL  │ Requires SQL    │
│ pgx / native │ Raw PostgreSQL performance  │ More boilerplate│
└──────────────┴─────────────────────────────┴─────────────────┘
```

---

### 7.2 Zero-Downtime Schema Migration Architecture

When migrating from an existing system to Go, database schema changes must be completely backward-compatible with both the legacy and the new codebase:

1. **Expand and Contract (Parallel Run)**:
   - Never rename a column or drop a table in a single migration.
   - **Step 1 (Expand)**: Add the new column (e.g. `email_normalized`) alongside the old column (`email`).
   - **Step 2 (Dual-Write)**: Update both old and new services to write to both columns, while reading from the old column.
   - **Step 3 (Backfill)**: Run a background batch script to backfill historical rows.
   - **Step 4 (Switch Read)**: Point all services to read from the new column.
   - **Step 5 (Contract)**: Drop the old column after verifying 100% stability.

2. **Database Connection Pooling Best Practices**:
   ```go
   db, err := sql.Open("pgx", connStr)
   if err != nil {
       log.Fatal(err)
   }
   
   // Crucial: Set explicit connection bounds to prevent Postgres connection exhaustion
   db.SetMaxOpenConns(25)                  // Maximum active connections in pool
   db.SetMaxIdleConns(25)                  // Maintain warm connections
   db.SetConnMaxLifetime(15 * time.Minute) // Prevent stale connections through AWS NLB
   db.SetConnMaxIdleTime(5 * time.Minute)
   ```
