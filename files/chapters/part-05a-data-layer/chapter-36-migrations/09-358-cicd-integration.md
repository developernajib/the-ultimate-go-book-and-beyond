## 36.8 CI/CD Integration

### GitHub Actions

The workflow below runs migration tests on every push or pull request that modifies files in the `migrations/` directory. It spins up a PostgreSQL service container, installs the `migrate` CLI, and runs the full up-down-up cycle to verify that all migrations apply cleanly and are reversible. The second job (`deploy-staging`) runs only on merges to `main` and applies pending migrations to the staging database using a secret connection string.

```yaml
name: Database Migrations

on:
  push:
    paths:
      - 'migrations/**'
  pull_request:
    paths:
      - 'migrations/**'

jobs:
  test-migrations:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: testdb
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4

      - name: Install migrate
        run: |
          curl -L https://github.com/golang-migrate/migrate/releases/download/v4.16.2/migrate.linux-amd64.tar.gz | tar xvz
          sudo mv migrate /usr/local/bin/

      - name: Test migrations up
        run: |
          migrate -path migrations -database "postgres://postgres:test@localhost/testdb?sslmode=disable" up

      - name: Test migrations down
        run: |
          migrate -path migrations -database "postgres://postgres:test@localhost/testdb?sslmode=disable" down -all

      - name: Test migrations up again
        run: |
          migrate -path migrations -database "postgres://postgres:test@localhost/testdb?sslmode=disable" up

  deploy-staging:
    needs: test-migrations
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run migrations on staging
        env:
          DATABASE_URL: ${{ secrets.STAGING_DATABASE_URL }}
        run: |
          migrate -path migrations -database "$DATABASE_URL" up
```

### Junior → FAANG: prerequisite gaps and first-job context

The mental shift from "I run migrations from my laptop" to "migrations run in CI/CD" is ownership. When you run `migrate up` against production from your laptop, you own the outcome, including the rollback, and the audit trail is whatever Slack message you remembered to post. When the pipeline runs migrations, the pipeline owns the outcome and the audit trail is automatic, which is exactly what a compliance auditor wants and exactly what your future self wants at 3am when someone asks "who ran this migration." The pipeline is not just automation, it is also a durable record of what changed, when, and under what commit.

Worked example for your first migration pipeline. Start with what this workflow does, then notice what it does not do. It runs migrations in CI against a disposable Postgres. Good. It applies migrations to staging on merge to main. Good. But it does not run migrations against production at all, and that is deliberate. A beginner-safe pipeline has a human-gated step between staging and production. In GitHub Actions that is `environment: production` with required reviewers configured in repository settings. The pipeline applies to staging automatically, opens a PR or Slack notification for production, and waits for a human to click approve. Your first real migration pipeline should have this gate. The pipeline that applies to production without human gating is a pipeline that will one day drop a column in production that still has live readers, and the postmortem will cite the missing gate as the root cause.

Interview entry-point. When asked "how do you deploy a schema change," the weak answer is "merge the PR." The strong answer walks through the four stages. Pre-merge CI runs up-down-up against a disposable database. Pre-deploy migration runs against production (the expand phase, adding the new column). Application deploy ships the code that uses the new column. Post-deploy migration runs the contract phase (adding constraints, dropping old columns) once the application has been stable for N hours or days. The key insight is that migrations split across the deploy rather than running as a single step, and the CI/CD system orchestrates that split.

### Senior @ FAANG: pre-deploy versus post-deploy, GitOps, and backfill orchestration

At scale the minimal two-job pipeline in this section gets replaced by a three-phase orchestration that separates expand, deploy, and contract into distinct pipeline stages with their own gates, approvals, and observability.

Phase one, pre-deploy. The pipeline applies only additive, backward-compatible migrations before the application deploys. Adding a nullable column. Adding an index concurrently. Creating a new table. Adding a `NOT VALID` constraint. These changes are safe to apply while the old application code is still running because the old code does not reference the new objects. At GitHub and Shopify this phase is gated by a schema review bot that rejects the migration if it detects non-additive patterns (DROP, NOT NULL without default, type change). The migration runs, a health check verifies the schema, and only then does the deploy pipeline unblock.

Phase two, application deploy. Standard rolling deploy or blue-green, with feature flags gating code that assumes the new schema. The application writes to both old and new columns (dual-write), reads from the old column, and emits a divergence metric on every request.

Phase three, post-deploy. After the application has been stable on the new code for a configured bake period (typically 24 to 72 hours at FAANG, longer for high-risk changes), the pipeline runs contract migrations. Validating the `NOT VALID` constraint. Dropping the old column. Removing dual-write code. This phase has its own approval gate because it is the destructive half, and it has its own rollback story which is usually "revert the contract migration is impossible, so we roll forward with a compensating migration."

Backfill jobs are the fourth phase that cuts across the other three. A backfill is not a migration, it is a long-running data job that populates new columns from old ones. The orchestration pattern at Uber and Airbnb runs backfills as a separate Kubernetes `Job` or Argo workflow, checkpointed so that a restart resumes from where it left off, throttled by replication lag and CPU on the primary, and observable through a dedicated dashboard that shows rows processed per second and ETA. The CI/CD pipeline does not run backfills inline because a backfill can take hours or days and tying it to a deploy blocks every subsequent deploy behind it. Instead, the pipeline submits the backfill to the orchestrator, records the job ID, and moves on. The contract phase gate includes "backfill job is complete" as a prerequisite check.

GitOps for migrations is the 2024-2026 direction of travel. Instead of the pipeline imperatively running migrations, the desired schema state lives in a Git repository (often as Atlas HCL or SQL files with a manifest), an operator in the cluster (Argo CD, Flux, or a dedicated schema operator like Atlas Operator or SchemaHero) observes the repository, computes the diff against the live database, and applies it. The advantage is reconciliation. If someone runs a manual migration that drifts the schema, the operator detects and surfaces the drift on the next sync. The disadvantage is that schema changes no longer feel like a deploy, they feel like a state change, which requires cultural adjustment. Shopify's internal schema platform and Figma's Postgres management both use variations of this model.

Pre-production mirroring is the FAANG-only layer most shops do not have. Before a migration merges, the CI pipeline replays it against a recent production snapshot (see the testing chapter for shadow-DB details) and measures wall-clock duration, lock wait time, and replication lag impact. If any metric exceeds a threshold, the PR is blocked with a concrete reason. "This migration held an ACCESS EXCLUSIVE lock for 47 seconds on a table with 200 active connections. Rewrite using `NOT VALID` plus `VALIDATE CONSTRAINT`." This feedback loop closes before code review rather than after production deploy, and it is the single highest-value investment a platform team can make.

Rollback automation is the piece every pipeline claims to have and most do not actually exercise. A production-grade pipeline includes a nightly job that picks a random recent migration, rolls it back in a shadow environment, and reports whether the rollback succeeded. If it did not, the migration author is paged (not the oncall) because the bug is in their code, not in the operations of the pipeline. This practice, sometimes called rollback-exercise or migration-chaos testing, rests on a simple principle: rollback code that is never executed in practice is not rollback code, it is rollback aspiration.

Observability that a senior engineer expects in the pipeline. A dashboard per environment showing current schema version, last migration duration, last migration author, drift from declared state. An alert when migration duration exceeds the p95 of the trailing 30 days (catches slow migrations before they become incidents). An alert when a migration runs outside business hours without an explicit emergency flag (catches oncall accidents). An immutable audit log of every migration application, keyed by commit SHA and operator identity. The pipeline that emits all of this is what separates "we have CI/CD for migrations" from "we have a production-grade schema change platform."

---
