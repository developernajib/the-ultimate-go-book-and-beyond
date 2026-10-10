## 52E.7 Tenant Onboarding and Offboarding

### Tenant Provisioning

Tenant provisioning creates the organization record, the owner user account, default settings, and seed data in a single database transaction. If any step fails, the entire operation rolls back. A `provisioning_state` column tracks progress so that failed provisions can be identified and retried:

```go
type TenantProvisioningState string

const (
    ProvisioningPending    TenantProvisioningState = "pending"
    ProvisioningInProgress TenantProvisioningState = "in_progress"
    ProvisioningComplete   TenantProvisioningState = "complete"
    ProvisioningFailed     TenantProvisioningState = "failed"
)

type TenantProvisioner struct {
    db      *pgxpool.Pool
    mailer  Mailer
    logger  *slog.Logger
}

func (p *TenantProvisioner) Provision(ctx context.Context, req ProvisionRequest) (*Organization, error) {
    // Use a transaction to make provisioning atomic
    tx, err := p.db.Begin(ctx)
    if err != nil {
        return nil, err
    }
    defer tx.Rollback(ctx)

    // Create organization
    orgID := uuid.New()
    _, err = tx.Exec(ctx, `
        INSERT INTO organizations (id, slug, name, plan, provisioning_state, created_at)
        VALUES ($1, $2, $3, $4, $5, now())
    `, orgID, req.Slug, req.Name, req.Plan, ProvisioningInProgress)
    if err != nil {
        if isUniqueViolation(err) {
            return nil, fmt.Errorf("organization with slug %q already exists", req.Slug)
        }
        return nil, fmt.Errorf("creating organization: %w", err)
    }

    // Create owner user
    ownerID := uuid.New()
    hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
    if err != nil {
        return nil, err
    }
    _, err = tx.Exec(ctx, `
        INSERT INTO users (id, tenant_id, email, password_hash, role, email_verified, created_at)
        VALUES ($1, $2, $3, $4, 'owner', false, now())
    `, ownerID, orgID, req.Email, hashedPassword)
    if err != nil {
        return nil, fmt.Errorf("creating owner user: %w", err)
    }

    // Create default settings
    _, err = tx.Exec(ctx, `
        INSERT INTO tenant_settings (tenant_id, max_projects, default_timezone, webhook_retries)
        VALUES ($1, $2, 'UTC', 3)
    `, orgID, planLimits[req.Plan].MaxProjects)
    if err != nil {
        return nil, fmt.Errorf("creating settings: %w", err)
    }

    // Seed initial data (e.g., default project)
    _, err = tx.Exec(ctx, `
        INSERT INTO projects (id, tenant_id, name, description, created_at)
        VALUES ($1, $2, 'My First Project', 'Welcome to your workspace!', now())
    `, uuid.New(), orgID)
    if err != nil {
        return nil, fmt.Errorf("seeding initial data: %w", err)
    }

    // Mark provisioning complete
    _, err = tx.Exec(ctx, `
        UPDATE organizations SET provisioning_state = $1, provisioned_at = now() WHERE id = $2
    `, ProvisioningComplete, orgID)
    if err != nil {
        return nil, err
    }

    if err := tx.Commit(ctx); err != nil {
        return nil, fmt.Errorf("committing provisioning transaction: %w", err)
    }

    // Post-transaction: send welcome email (can fail without rolling back)
    go func() {
        if err := p.mailer.SendWelcome(context.Background(), req.Email, req.Name); err != nil {
            p.logger.Error("failed to send welcome email", "error", err, "tenant_id", orgID)
        }
    }()

    return &Organization{ID: orgID, Slug: req.Slug, Name: req.Name, Plan: req.Plan}, nil
}
```

### Data Export on Offboarding

GDPR Article 20 requires data portability: tenants must be able to download all their data in a machine-readable format. The exporter below runs as an async job, iterates all tenant-scoped tables, writes each to a CSV file inside a zip archive, and uploads the result to object storage with a time-limited download URL:

```go
type TenantExporter struct {
    db     *pgxpool.Pool
    store  ObjectStorage
    logger *slog.Logger
}

func (e *TenantExporter) ExportTenantData(ctx context.Context, tenantID uuid.UUID) (string, error) {
    exportID := uuid.New().String()

    // Start async export job
    go func() {
        ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
        defer cancel()

        if err := e.runExport(ctx, tenantID, exportID); err != nil {
            e.logger.Error("export failed", "error", err, "tenant_id", tenantID, "export_id", exportID)
        }
    }()

    return exportID, nil
}

func (e *TenantExporter) runExport(ctx context.Context, tenantID uuid.UUID, exportID string) error {
    // Create a zip archive in memory (for small tenants) or on disk (for large)
    buf := &bytes.Buffer{}
    zw := zip.NewWriter(buf)

    tables := []string{"users", "projects", "tasks", "comments", "attachments"}

    for _, table := range tables {
        e.logger.Info("exporting table", "table", table, "tenant_id", tenantID)

        w, err := zw.Create(table + ".csv")
        if err != nil {
            return err
        }

        if err := e.exportTableToCSV(ctx, w, table, tenantID); err != nil {
            return fmt.Errorf("exporting %s: %w", table, err)
        }
    }

    if err := zw.Close(); err != nil {
        return err
    }

    // Upload to S3/GCS
    downloadURL, err := e.store.Upload(ctx, fmt.Sprintf("exports/%s.zip", exportID), buf.Bytes())
    if err != nil {
        return err
    }

    // Store download URL (expires in 7 days)
    _, err = e.db.Exec(ctx, `
        INSERT INTO data_exports (id, tenant_id, download_url, expires_at, completed_at)
        VALUES ($1, $2, $3, now() + interval '7 days', now())
    `, exportID, tenantID, downloadURL)

    return err
}

func (e *TenantExporter) exportTableToCSV(ctx context.Context, w io.Writer, table string, tenantID uuid.UUID) error {
    cw := csv.NewWriter(w)
    defer cw.Flush()

    // Use server-side cursor for large tables (avoids loading all rows in memory)
    rows, err := e.db.Query(ctx, fmt.Sprintf(`
        DECLARE export_cursor CURSOR FOR
        SELECT * FROM %s WHERE tenant_id = $1
    `, table), tenantID)
    // Note: In practice, use pgx's rows directly with batching
    // This is simplified for clarity

    // ... iterate rows, write to CSV
    return nil
}
```

### Data Deletion: GDPR Right to Erasure

GDPR Article 17 requires erasure of all personal data upon valid request. In a multi-tenant system, this means cascading deletes across every table that stores tenant-linked records. The implementation records the deletion request first for audit traceability, then deletes data table-by-table in dependency order (children before parents) to avoid foreign-key violations:

```go
func (d *TenantDeleter) DeleteTenantData(ctx context.Context, tenantID uuid.UUID, requestedBy uuid.UUID) error {
    d.logger.Info("starting tenant data deletion", "tenant_id", tenantID, "requested_by", requestedBy)

    // Record the deletion request for compliance
    _, err := d.db.Exec(ctx, `
        INSERT INTO deletion_requests (tenant_id, requested_by, requested_at, status)
        VALUES ($1, $2, now(), 'in_progress')
    `, tenantID, requestedBy)
    if err != nil {
        return err
    }

    // Delete in dependency order (children before parents)
    tables := []string{
        "audit_logs",
        "webhook_deliveries",
        "webhooks",
        "comments",
        "attachments",
        "tasks",
        "projects",
        "api_keys",
        "sessions",
        "users",
        "tenant_settings",
        "tenant_feature_overrides",
    }

    for _, table := range tables {
        d.logger.Info("deleting tenant data", "table", table, "tenant_id", tenantID)

        result, err := d.db.Exec(ctx, fmt.Sprintf(`
            DELETE FROM %s WHERE tenant_id = $1
        `, table), tenantID)
        if err != nil {
            d.logger.Error("failed to delete from table", "table", table, "error", err)
            return fmt.Errorf("deleting from %s: %w", table, err)
        }

        d.logger.Info("deleted rows", "table", table, "count", result.RowsAffected())
    }

    // Delete the organization itself
    _, err = d.db.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, tenantID)
    if err != nil {
        return err
    }

    // Purge any external storage (files, images, etc.)
    if err := d.store.DeleteTenantFiles(ctx, tenantID); err != nil {
        d.logger.Error("failed to delete tenant files", "error", err)
        // Continue - log but don't fail
    }

    // Mark deletion complete
    _, err = d.db.Exec(ctx, `
        UPDATE deletion_requests
        SET status = 'complete', completed_at = now()
        WHERE tenant_id = $1
    `, tenantID)

    d.logger.Info("tenant data deletion complete", "tenant_id", tenantID)
    return err
}
```

### Junior → FAANG: Provisioning Correctness and GDPR Basics

Tenant provisioning and data deletion are areas where correctness is not negotiable. A failed provisioning that leaves a partial tenant record causes customer-facing errors and requires manual cleanup. A failed deletion that leaves data behind is a GDPR violation. FAANG interviewers use these topics to test transaction design and error handling discipline.

Common junior gaps:

- Not wrapping provisioning in a transaction. Without `BEGIN/COMMIT`, a failure after the organization is created but before the owner user is created leaves an orphan tenant record in the database.
- Sending the welcome email inside the transaction. Email delivery is an external side effect that can fail or be retried independently. Moving it outside the transaction (via a goroutine, as shown above) ensures the commit is not blocked by email delivery latency, and a failed email does not roll back the provisioning.
- Deleting tables in the wrong order in GDPR deletion. Foreign keys enforce dependency order. Deleting a parent row before its children violates the constraint and causes an error. The table list in `DeleteTenantData` is ordered children-first.

Worked example for interviews: "A user clicks 'Delete My Account' in your SaaS. Walk me through what happens from the button click to complete data erasure."

Answer: the request hits the deletion API, which creates a `deletion_requests` record (the audit trail), marks the tenant as `pending_deletion` (stops new data ingestion), and enqueues an async deletion job. The job exports all tenant data to a time-limited download URL (GDPR portability), then deletes tables in dependency order, deletes external storage (S3 files), marks the deletion request as complete, and logs a deletion certificate. The user receives an email with the data export link and confirmation that deletion is complete.

First-job habits:

- Add a post-provisioning integration test that creates a tenant and immediately runs a cross-tenant isolation test. This catches provisioning bugs before they reach production.
- Add a post-deletion integration test that provisions a tenant, deletes all their data, then asserts that every tenant-scoped table returns zero rows for that tenant ID. This is your compliance verification test.

### Senior @ FAANG: Provisioning State Machines and Compliance-Grade Deletion

At staff level, provisioning and offboarding are not one-off workflows. They are recurring operations that must be observable, resumable, and auditable across thousands of tenants.

**Provisioning as a state machine:**

The `provisioning_state` column in the `organizations` table is the start of a state machine. A production-grade provisioning system models all states explicitly and provides tooling to inspect and repair stalled provisioning jobs:

```
pending → in_progress → complete
                     ↘ failed (retryable)
                     ↘ failed_permanent (requires human intervention)
```

A background reconciler runs every few minutes and finds organizations in `in_progress` state for more than five minutes. It attempts to determine which provisioning steps completed (idempotency check) and either resumes from the last completed step or escalates to `failed_permanent` with an alert.

This reconciler is not optional at scale. A provisioning failure at 2am for a new enterprise customer needs an automated recovery path, not an on-call page.

**Schema migrations as a provisioning step:**

For silo tenants (isolated database), provisioning includes running the full migration pipeline against the new database. This step must be synchronous: the provisioning is not complete until the database schema is at the correct version. The provisioning job should record the migration version that was applied, so the reconciler can detect schema drift later.

**Compliance-grade deletion:**

GDPR Article 17 right to erasure has a thirty-day clock from the time of request in most interpretations. The deletion pipeline must complete within this window. For large tenants with millions of rows, batch deletion is required:

```go
// Batch delete with controlled pace to avoid lock pressure
func (d *TenantDeleter) batchDelete(ctx context.Context, table string, tenantID uuid.UUID) error {
    for {
        result, err := d.db.Exec(ctx, fmt.Sprintf(`
            WITH to_delete AS (
                SELECT id FROM %s WHERE tenant_id = $1 LIMIT 1000
            )
            DELETE FROM %s WHERE id IN (SELECT id FROM to_delete)
        `, table, table), tenantID)
        if err != nil {
            return err
        }
        if result.RowsAffected() == 0 {
            return nil
        }
        // Brief pause to avoid saturating the database
        time.Sleep(10 * time.Millisecond)
    }
}
```

**Crypto-shredding as a complement:**

For regulated tenants (HIPAA, PCI-DSS), explicit row deletion is necessary but not sufficient. Backups, analytics warehouses, and search indexes may retain copies of the data. Crypto-shredding provides a cryptographic erasure guarantee: encrypt all sensitive data with a per-tenant key stored in a separate key management service, then delete the key on offboarding. The encrypted data in backups and analytics stores becomes computationally unrecoverable without the key.

Implementation: on provisioning, generate a unique data encryption key (DEK) for the tenant, encrypt it with a key encryption key (KEK) managed in HashiCorp Vault or AWS KMS, and store the encrypted DEK in the database. All sensitive fields are encrypted with the DEK before storage. On offboarding, delete the DEK after the DEK deletion is confirmed by the KMS. The deletion certificate includes the DEK deletion event timestamp and the KMS audit log reference.

**Deletion audit trail:**

The deletion certificate is a cryptographic record of what was deleted, when, by whom, and in what quantity. It must be retained even after the tenant's data is gone: the absence of data is the compliance claim, and you need proof that the deletion was complete. Store it in an append-only audit log table that is outside the tenant-scoped deletion cascade.

---
