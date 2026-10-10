## Exercises

### Exercise 6: Build the Platform CLI Create Command

**Objective**: Implement the `platform create service` scaffolding command in Go that generates a complete golden-path Go service directory from embedded templates.

**Requirements**:
1. Accept `--team`, `--with-db`, `--with-kafka`, `--with-grpc`, and `--dry-run` flags
2. Validate service name: lowercase, hyphens only, 3-40 characters. Error if directory already exists
3. Generate the following files from Go `text/template` embedded via `embed.FS`:
 - `main.go`, `go.mod`, `Dockerfile`, `Makefile`
 - `.github/workflows/ci.yaml`
 - `catalog-info.yaml`
 - `docs/index.md`
4. Conditionally include database migration scaffolding when `--with-db` is provided
5. Print a color-coded next-steps guide after successful generation

**Core generator implementation**:
```go
// internal/scaffold/generator.go
package scaffold

import (
    "embed"
    "io/fs"
    "os"
    "path/filepath"
    "text/template"
)

//go:embed templates/*
var templateFS embed.FS

type Options struct {
    Name      string
    Team      string
    Database  string
    Kafka     bool
    GRPC      bool
    OutputDir string
}

// Generate walks the embedded template tree and expands each file into OutputDir.
func Generate(opts Options) error {
    return fs.WalkDir(templateFS, "templates", func(path string, d fs.DirEntry, err error) error {
        if err != nil || d.IsDir() {
            return err
        }
        rel := path[len("templates/"):]
        tmpl, err := template.ParseFS(templateFS, path)
        if err != nil {
            return err
        }
        dest := filepath.Join(opts.OutputDir, rel)
        if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
            return err
        }
        f, err := os.Create(dest)
        if err != nil {
            return err
        }
        defer f.Close()
        return tmpl.Execute(f, opts)
    })
}
```

**Testing**: Use `t.TempDir()` as `OutputDir`. Assert each expected file exists and contains the correct service name and team name.

---

### Exercise 7: DORA Metrics HTTP API

**Objective**: Build a Go HTTP API that exposes DORA metrics for services, backed by Prometheus queries and a GitHub client for lead-time data.

**Requirements**:
1. `GET /api/v1/services/{name}/dora?window=30d` - return JSON DORA metrics
2. `GET /api/v1/services/{name}/dora/history?granularity=weekly` - weekly trend array
3. `GET /api/v1/teams/{team}/dora` - aggregate DORA across all team services from Backstage catalog
4. Rate limiting: 60 requests/minute per `X-Caller-ID` header using `golang.org/x/time/rate`
5. Response cache: 5-minute TTL using `sync.Map` keyed by `service+window`
6. Health check at `/healthz` returning `{"status":"ok"}`

**Interface design** - keep Prometheus and GitHub sources independently mockable in tests:

```go
package dora

import (
    "context"
    "time"
)

// DORASource abstracts all raw DORA data providers.
type DORASource interface {
    DeploymentFrequency(ctx context.Context, service string, window time.Duration) (float64, error)
    LeadTimeP50(ctx context.Context, service string, window time.Duration) (time.Duration, error)
    ChangeFailureRate(ctx context.Context, service string, window time.Duration) (float64, error)
    MTTR(ctx context.Context, service string, window time.Duration) (time.Duration, error)
}

type PrometheusSource interface{}
type GitHubSource interface{}

// CompositeSource satisfies DORASource by delegating to a Prometheus source for
// deployment/CFR/MTTR signals and a GitHub source for lead time.
type CompositeSource struct {
    prom   PrometheusSource
    github GitHubSource
}
```

**Testing**: Use `httptest.NewServer` for both Prometheus and GitHub stubs. Table-driven tests covering all four DORA metrics and the key error paths.

---

### Exercise 8: Backstage Software Catalog Sync Controller

**Objective**: Build a Kubernetes controller in Go that keeps the Backstage software catalog in sync with running Deployments.

**Requirements**:
1. Watch `apps/v1 Deployment` resources labeled `platform.acme.io/managed=true`
2. On create/update: upsert a Backstage `Component` entity via `POST /api/catalog/entities` with `X-Backstage-Auth` bearer token
3. On delete: mark the entity `spec.lifecycle: deprecated` - never hard-delete from the catalog
4. Reconcile interval: requeue every 10 minutes to catch any out-of-band catalog edits
5. `/healthz` liveness probe. Prometheus metrics: `catalog_sync_total{status}` and `catalog_sync_duration_seconds`

**Reconciler skeleton**:
```go
package controller

import (
    "context"
    "time"

    appsv1 "k8s.io/api/apps/v1"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/client-go/tools/record"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/reconcile"
)

type BackstageClient interface {
    MarkDeprecated(ctx context.Context, name string) error
    UpsertEntity(ctx context.Context, entity any) error
}

type CatalogSyncReconciler struct {
    client.Client
    backstage BackstageClient
    recorder  record.EventRecorder
}

func (r *CatalogSyncReconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
    var deploy appsv1.Deployment
    if err := r.Get(ctx, req.NamespacedName, &deploy); err != nil {
        if apierrors.IsNotFound(err) {
            // Deployment deleted - mark catalog entity deprecated
            return reconcile.Result{}, r.backstage.MarkDeprecated(ctx, req.Name)
        }
        return reconcile.Result{}, err
    }
    entity := buildCatalogEntity(&deploy)
    return reconcile.Result{RequeueAfter: 10 * time.Minute},
        r.backstage.UpsertEntity(ctx, entity)
}

func buildCatalogEntity(deploy *appsv1.Deployment) any {
    return deploy.Name
}
```

**Testing**: Use `sigs.k8s.io/controller-runtime/pkg/envtest` to run a real API server in process - no Kubernetes mocking required.

---

### Exercise 9: Platform Shadow IT Detector CronJob

**Objective**: Implement a Go CronJob that scans the cluster weekly for workloads outside platform governance and posts a color-coded Slack report.

**Requirements**:
1. List all non-system Kubernetes namespaces. Classify each as managed or unmanaged
2. For each unmanaged namespace, verify whether a `catalog-info.yaml` exists in the associated GitHub repo
3. Select Slack attachment color by unmanaged percentage: green (<1%), yellow (1-9%), red (>=10%)
4. Post the report to a configurable Slack webhook with a direct catalog link for each unregistered service
5. Expose `platform_unmanaged_namespaces_total` as a Prometheus Gauge scraped before the report is sent

**Slack payload**:
```go
package slack

type SlackPayload struct {
    Attachments []SlackAttachment `json:"attachments"`
}

type SlackAttachment struct {
    Color  string       `json:"color"`  // "good" | "warning" | "danger"
    Title  string       `json:"title"`
    Text   string       `json:"text"`
    Fields []SlackField `json:"fields"`
    Footer string       `json:"footer"`
    Ts     int64        `json:"ts"`
}

type SlackField struct {
    Title string `json:"title"`
    Value string `json:"value"`
    Short bool   `json:"short"`
}
```

**Testing**: Mock the Slack webhook with `httptest.NewServer`. Assert the correct color is chosen at each percentage threshold boundary.

---

### Exercise 10: Platform SLA Dashboard API

**Objective**: Build the HTTP API that powers a Grafana-backed SLA compliance dashboard for all platform services.

**Requirements**:
1. `GET /api/v1/sla/report?service=ci-cd&period=30d` - full SLA report: uptime %, error budget, incidents
2. `GET /api/v1/sla/report/all` - SLA summary for every service in `InternalCatalog`
3. `POST /api/v1/incidents` - record a new incident (auth required, write scope)
4. `GET /api/v1/incidents?service=ci-cd&since=2026-01-01` - paginated incident list
5. Persist incidents in PostgreSQL using `pgx/v5`. Derive uptime from Prometheus blackbox exporter
6. Trigger a PagerDuty alert via Events v2 API when `BurnRateAlert` exceeds the 14.4x critical threshold

**Stretch goal**: Add `GET /api/v1/sla/report/{service}/trend?granularity=daily&window=90d` returning daily uptime data suitable for a Grafana time-series panel.

---

### Exercise 11: Complete Internal Developer Portal Setup

**Objective**: End-to-end capstone - stand up a local Backstage instance backed by the Go DORA and SLA APIs built in Exercises 7 and 10.

**Steps**:
1. Bootstrap Backstage: `npx @backstage/create-app@latest`
2. Register three sample Go services via static `app-config.yaml` catalog locations pointing to local `catalog-info.yaml` files
3. Implement the TypeScript backend plugin from this chapter. Wire it to the local Go DORA API on `localhost:8090`
4. Mount `ServiceMetricsCard` on the entity overview page for all components tagged `go`
5. Add `mkdocs.yml` and a two-page `docs/` directory to one service. Generate and serve TechDocs locally with `techdocs-cli`
6. Implement `platform create service --dry-run` and verify the output file list is correct

**Validation checklist**:
- `backstage-cli package lint` passes on the custom plugin package
- Visiting a registered component shows the DORA level chip and four metric rows
- TechDocs tab renders at least two pages for the service with `mkdocs.yml`
- The DORA API returns HTTP 404 for an unregistered service name
- All tokens and URLs are read from `app-config.local.yaml` - never committed to source control
- `platform create service test-svc --team=platform --dry-run` prints the full expected file list without writing to disk

### Junior → FAANG: How to Present These Exercises in a Portfolio

Exercises 6 through 11 are substantial enough to serve as a portfolio project for a junior platform engineering interview. The key to presenting them effectively is not showing the finished code but being able to walk through the design decisions you made.

For Exercise 6 (`platform create service`), the interesting design question is how you chose to structure the template tree. Did you use a flat directory of files, or a nested structure that mirrors the generated repository? How did you handle conditional template inclusion (the `--with-db` flag adding migration files)? The `embed.FS` and `fs.WalkDir` pattern shows Go knowledge, but the template design decisions show product thinking.

For Exercise 7 (DORA metrics API), the `CompositeSource` pattern (combining Prometheus and GitHub sources behind a single interface) is the interview-ready design pattern. When asked "how would you design this API?", start by defining the `DORASource` interface and explaining why you separated Prometheus (for deployment frequency, CFR, MTTR) from GitHub (for lead time, which is measured between commit and deployment). The interface boundary makes each source independently testable and independently replaceable.

For Exercise 11 (complete developer portal), the validation checklist is the interview artifact. Being able to say "I set up a local Backstage instance, implemented a custom backend plugin in TypeScript that calls a Go service, verified it with the Backstage CLI linter, and confirmed the DORA metrics card renders with real data" is a concrete, credible answer to "have you worked with Backstage?" that most junior candidates cannot match.

### Senior @ FAANG: What Makes These Exercises Production-Grade vs. Learning Exercises

The exercises as written are learning-grade implementations. To understand the gap between learning-grade and production-grade, consider what would need to change before each exercise could serve production traffic.

Exercise 7 (DORA API with caching): the `sync.Map` cache has no expiration in the skeleton (the exercise specifies TTL but leaves implementation to the reader). In production, a global in-memory cache in a single-replica service is a reliability concern: if the cache is lost on restart, the first request after restart for every service queries Prometheus simultaneously, potentially overwhelming the Prometheus server. Production caching uses Redis or Memcached for durability and horizontal scalability across multiple API replicas.

Exercise 8 (catalog sync controller) with `RequeueAfter: 10 * time.Minute`: at 1,000 services and 60,000 seconds per hour, this generates 100 reconcile calls per minute for the steady-state case. If the Backstage API has a rate limit of 100 requests per minute, the controller will frequently hit the rate limit. Production controllers implement exponential backoff on rate limit responses and use local caching to avoid redundant API calls for unchanged entities.

Exercise 10 (SLA dashboard API) with PagerDuty alerting: the PagerDuty Events v2 API requires deduplication keys to prevent alert storms. If the `BurnRateAlert` function returns true on every invocation when the burn rate is high, the API will fire a new PagerDuty alert on every call. Production implementations use a deduplication key (service name plus alert type) and a state machine (firing, acknowledged, resolved) to prevent duplicate alerts and to automatically resolve alerts when the burn rate drops below the threshold.
