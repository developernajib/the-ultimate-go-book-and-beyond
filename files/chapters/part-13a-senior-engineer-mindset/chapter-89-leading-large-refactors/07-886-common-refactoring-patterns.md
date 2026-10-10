## 89.6 Common Refactoring Patterns

### API Migration

Migrating an API while consumers are actively using it requires a versioning strategy that supports both old and new formats simultaneously. The adapter pattern shown below lets you run both API versions behind a single facade, routing requests based on the version header. This gives consumers time to migrate to the new API at their own pace while you maintain backward compatibility. The deprecation timeline at the end ensures the old version does not live forever.

```go
// Pattern: API Versioning During Migration

// Old API
type OrderServiceV1 interface {
    CreateOrder(ctx context.Context, req *CreateOrderV1Request) (*OrderV1, error)
}

// New API
type OrderServiceV2 interface {
    CreateOrder(ctx context.Context, req *CreateOrderV2Request) (*OrderV2, error)
}

// Adapter to support both during migration
type OrderServiceAdapter struct {
    v1 OrderServiceV1
    v2 OrderServiceV2
}

func (a *OrderServiceAdapter) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    version := getAPIVersion(ctx)

    switch version {
    case "v1":
        v1Req := convertToV1Request(req)
        v1Resp, err := a.v1.CreateOrder(ctx, v1Req)
        return convertFromV1Response(v1Resp), err
    case "v2":
        v2Req := convertToV2Request(req)
        v2Resp, err := a.v2.CreateOrder(ctx, v2Req)
        return convertFromV2Response(v2Resp), err
    default:
        return nil, fmt.Errorf("unsupported API version: %s", version)
    }
}

// Deprecation timeline
/*
Week 1-4: V2 available, V1 default
Week 5-8: V2 default, V1 deprecated (warning logs)
Week 9-12: V1 removed, V2 only
*/
```

### Database Schema Migration

Database schema changes are among the riskiest parts of any refactor because they affect persisted data and are harder to roll back than code changes. The expand-contract pattern solves this by splitting a schema change into three safe phases: first you expand the schema by adding new columns (the old code still works), then you migrate data and code to use the new columns, and finally you contract by removing the old columns only after everything is proven. This approach guarantees zero downtime and safe rollback at every step except the final cleanup.

```go
// Expand-Contract Pattern for Zero-Downtime Schema Changes

// Step 1: EXPAND - Add new column (nullable)
/*
ALTER TABLE users ADD COLUMN full_name VARCHAR(255);
*/

// Step 2: DUAL-WRITE - Write to both columns
func (r *UserRepository) UpdateName(ctx context.Context, id, firstName, lastName string) error {
    fullName := firstName + " " + lastName

    _, err := r.db.ExecContext(ctx, `
        UPDATE users
        SET first_name = $1,
            last_name = $2,
            full_name = $3
        WHERE id = $4
    `, firstName, lastName, fullName, id)
    return err
}

// Step 3: BACKFILL - Populate existing rows
/*
UPDATE users SET full_name = first_name || ' ' || last_name
WHERE full_name IS NULL;
*/

// Step 4: MIGRATE CODE - Read from new column only
func (r *UserRepository) GetUser(ctx context.Context, id string) (*User, error) {
    var user User
    err := r.db.QueryRowContext(ctx, `
        SELECT id, full_name FROM users WHERE id = $1
    `, id).Scan(&user.ID, &user.FullName)
    return &user, err
}

// Step 5: CONTRACT - Remove old columns (after all code migrated)
/*
ALTER TABLE users DROP COLUMN first_name;
ALTER TABLE users DROP COLUMN last_name;
ALTER TABLE users ALTER COLUMN full_name SET NOT NULL;
*/
```

### Junior → FAANG: Pattern Recognition in Interviews

When a FAANG interviewer asks "how would you rename a column in a database used by a production system," the expected answer is the expand-contract pattern in full: add the new column, write both, migrate reads, stop writing to the old column, remove it. Answering "I'd run a migration and update the code" identifies you as someone who has not thought about the production deployment window. The pattern vocabulary in this section gives you the precise terminology that signals production experience.

### Senior @ FAANG: Patterns as Org-Wide Standards

At L6, the expand-contract pattern and the parallel-run pattern should be documented in your org's engineering standards guide, not just practiced informally. Staff engineers at FAANG are expected to codify patterns as reusable standards that teams cite in RFCs. When a team writes "we will use the expand-contract migration strategy per the platform migration guide," they are benefiting from work you did six months ago. That downstream leverage is how you demonstrate L6 scope.

Branch-by-abstraction is particularly powerful in Go because the language's interface system makes it syntactically lightweight to introduce an abstraction layer. The staff-level concern is not how to implement the abstraction but when to remove the abstraction after the migration is complete. Leaving permanent abstraction layers in place as migration scaffolding is technical debt. Document the removal criteria in the ADR so the next engineer knows when it is safe to collapse the abstraction.

---
