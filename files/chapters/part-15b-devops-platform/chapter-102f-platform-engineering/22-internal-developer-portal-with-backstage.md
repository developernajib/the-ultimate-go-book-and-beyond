## 102F.20 Internal Developer Portal with Backstage

An Internal Developer Portal (IDP) is the single pane of glass that surfaces everything a developer needs: service catalog, documentation, scaffolding, and operational health. Backstage - open-sourced by Spotify in 2020 and now a CNCF incubating project - has become the de-facto standard for building IDPs. This section covers everything from catalog YAML to custom plugins backed by Go services.

### Software Catalog: catalog-info.yaml

Every service in your platform registers itself by committing a `catalog-info.yaml` at the repository root. Backstage auto-discovers these files via GitHub integrations or explicit registration.

```yaml
# catalog-info.yaml - committed to every Go service repository
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: payment-api
  title: Payment API
  description: |
    Handles payment processing, refunds, and ledger reconciliation
    for the checkout platform.
  annotations:
    backstage.io/techdocs-ref: dir:.
    github.com/project-slug: acme-corp/payment-api
    grafana/dashboard-selector: "title=Payment API"
    pagerduty.com/integration-key: abc123def456
    prometheus.io/rule: payment_api
    runbook.url: https://wiki.internal/runbooks/payment-api
  tags:
    - go
    - payments
    - golden-path-v2
  links:
    - url: https://grafana.internal/d/payment-api
      title: Grafana Dashboard
      icon: dashboard
    - url: https://argocd.internal/applications/payment-api
      title: ArgoCD Application
      icon: web
spec:
  type: service
  lifecycle: production
  owner: group:payments-team
  system: checkout-platform
  dependsOn:
    - component:postgres-payments
    - component:kafka-events
    - resource:s3-receipts
  providesApis:
    - payment-api-v2
---
apiVersion: backstage.io/v1alpha1
kind: API
metadata:
  name: payment-api-v2
  description: Payment processing REST API
spec:
  type: openapi
  lifecycle: production
  owner: group:payments-team
  definition:
    $text: ./api/openapi.yaml
---
apiVersion: backstage.io/v1alpha1
kind: System
metadata:
  name: checkout-platform
  description: End-to-end checkout and payment processing platform
spec:
  owner: group:platform-team
---
apiVersion: backstage.io/v1alpha1
kind: Group
metadata:
  name: payments-team
  description: Payments engineering team
spec:
  type: team
  profile:
    displayName: Payments Team
    email: payments-eng@acme-corp.com
  parent: engineering
  members:
    - user:alice
    - user:bob
    - user:carol
```

### Custom Backstage Plugin Architecture

Backstage plugins are React/TypeScript frontend packages that can call any backend. The recommended pattern for Go backends is a **Backstage Backend Plugin** that proxies requests to your internal Go service - keeping auth and rate-limiting centralized.

```typescript
// packages/backend/src/plugins/platform-metrics.ts
// Backstage backend plugin - proxies to Go platform metrics service
import { createRouter } from '@backstage/backend-common';
import { Router } from 'express';
import { Logger } from 'winston';
import fetch from 'node-fetch';

interface PluginEnvironment {
  logger: Logger;
  config: any;
}

export async function createPlugin(env: PluginEnvironment): Promise<Router> {
  const router = createRouter({ logger: env.logger });
  const platformApiUrl = env.config.getString('platformMetrics.baseUrl');
  const platformToken = env.config.getString('platformMetrics.token');

  router.get('/components/:name/metrics', async (req, res) => {
    const { name } = req.params;
    const { window = '24h' } = req.query;
    try {
      const response = await fetch(
        `${platformApiUrl}/api/v1/services/${name}/metrics?window=${window}`,
        {
          headers: {
            Authorization: `Bearer ${platformToken}`,
            'X-Backstage-User': req.headers['x-forwarded-user'] as string,
          },
        },
      );
      if (!response.ok) {
        res.status(response.status).json({ error: 'upstream error' });
        return;
      }
      res.json(await response.json());
    } catch (err) {
      env.logger.error(`platform-metrics plugin error: ${err}`);
      res.status(502).json({ error: 'platform metrics service unavailable' });
    }
  });

  router.get('/components/:name/dora', async (req, res) => {
    const { name } = req.params;
    try {
      const response = await fetch(
        `${platformApiUrl}/api/v1/services/${name}/dora`,
        { headers: { Authorization: `Bearer ${platformToken}` } },
      );
      res.status(response.status).json(await response.json());
    } catch {
      res.status(502).json({ error: 'unavailable' });
    }
  });

  return router;
}
```

```typescript
// plugins/platform-metrics/src/components/ServiceMetricsCard.tsx
import React, { useEffect, useState } from 'react';
import { useApi, discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { useEntity } from '@backstage/plugin-catalog-react';
import { InfoCard, Progress } from '@backstage/core-components';
import { Grid, Typography, Chip } from '@material-ui/core';

interface DoraMetrics {
  deploymentFrequency: string;
  leadTimeForChanges: string;
  changeFailureRate: number;
  timeToRestore: string;
  doraLevel: 'elite' | 'high' | 'medium' | 'low';
}

export const ServiceMetricsCard = () => {
  const { entity } = useEntity();
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [dora, setDora] = useState<DoraMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const baseUrl = await discoveryApi.getBaseUrl('platform-metrics');
      const resp = await fetchApi.fetch(
        `${baseUrl}/components/${entity.metadata.name}/dora`,
      );
      if (resp.ok) setDora(await resp.json());
      setLoading(false);
    };
    load();
  }, [entity.metadata.name]);

  if (loading) return <Progress />;
  if (!dora) return <Typography>No DORA data available.</Typography>;

  const levelColor = {
    elite: 'primary', high: 'default', medium: 'default', low: 'secondary',
  } as const;

  return (
    <InfoCard title="DORA Metrics" subheader="Last 90 days">
      <Grid container spacing={2}>
        <Grid item xs={6}>
          <Typography variant="caption">Deployment Frequency</Typography>
          <Typography variant="body1">{dora.deploymentFrequency}</Typography>
        </Grid>
        <Grid item xs={6}>
          <Typography variant="caption">Lead Time for Changes</Typography>
          <Typography variant="body1">{dora.leadTimeForChanges}</Typography>
        </Grid>
        <Grid item xs={6}>
          <Typography variant="caption">Change Failure Rate</Typography>
          <Typography variant="body1">{dora.changeFailureRate.toFixed(1)}%</Typography>
        </Grid>
        <Grid item xs={6}>
          <Typography variant="caption">Time to Restore</Typography>
          <Typography variant="body1">{dora.timeToRestore}</Typography>
        </Grid>
        <Grid item xs={12}>
          <Chip
            label={`DORA Level: ${dora.doraLevel.toUpperCase()}`}
            color={levelColor[dora.doraLevel]}
          />
        </Grid>
      </Grid>
    </InfoCard>
  );
};
```

### Go Scaffolder Template (Cookiecutter-Style)

Backstage Software Templates use a YAML-driven scaffolding engine. The template calls a custom Go scaffolder action that expands a service template, pushes to GitHub, and registers the catalog entry - all in one flow.

```yaml
# templates/go-service/template.yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: go-microservice
  title: Go Microservice (Golden Path v2)
  description: |
    Scaffolds a production-ready Go microservice with CI/CD, observability,
    structured logging, health checks, and Kubernetes manifests pre-wired.
  tags: [go, microservice, golden-path]
spec:
  owner: group:platform-team
  type: service
  parameters:
    - title: Service Information
      required: [name, description, owner, system]
      properties:
        name:
          title: Service Name
          type: string
          pattern: '^[a-z][a-z0-9-]{2,39}$'
          ui:autofocus: true
        description:
          title: Description
          type: string
          maxLength: 200
        owner:
          title: Owning Team
          type: string
          ui:field: OwnerPicker
          ui:options:
            allowedKinds: [Group]
        system:
          title: System
          type: string
          ui:field: EntityPicker
          ui:options:
            allowedKinds: [System]
    - title: Runtime Configuration
      properties:
        port:
          title: HTTP Port
          type: integer
          default: 8080
        enableGRPC:
          title: Enable gRPC
          type: boolean
          default: false
        database:
          title: Database
          type: string
          default: none
          enum: [none, postgres, mysql, redis]
  steps:
    - id: fetch-template
      name: Fetch Template Skeleton
      action: fetch:template
      input:
        url: ./skeleton
        values:
          name: ${{ parameters.name }}
          description: ${{ parameters.description }}
          owner: ${{ parameters.owner }}
          system: ${{ parameters.system }}
          port: ${{ parameters.port }}
          enableGRPC: ${{ parameters.enableGRPC }}
          database: ${{ parameters.database }}
    - id: publish
      name: Publish to GitHub
      action: publish:github
      input:
        allowedHosts: [github.com]
        description: ${{ parameters.description }}
        repoUrl: github.com?owner=acme-corp&repo=${{ parameters.name }}
        defaultBranch: main
        repoVisibility: internal
        topics: [go, microservice, golden-path]
    - id: register
      name: Register in Catalog
      action: catalog:register
      input:
        repoContentsUrl: ${{ steps.publish.output.repoContentsUrl }}
        catalogInfoPath: /catalog-info.yaml
    - id: provision-namespace
      name: Provision Kubernetes Namespace
      action: http:backstage:request
      input:
        method: POST
        path: /api/platform/namespaces
        body:
          name: ${{ parameters.name }}
          team: ${{ parameters.owner }}
          system: ${{ parameters.system }}
  output:
    links:
      - title: Repository
        url: ${{ steps.publish.output.remoteUrl }}
      - title: Open in Catalog
        icon: catalog
        entityRef: ${{ steps.register.output.entityRef }}
```

### Go Backend: Platform Metrics and DORA API

This Go service backs the Backstage plugin, aggregating data from Prometheus, GitHub, and PagerDuty into DORA metrics:

```go
// internal/dora/calculator.go
package dora

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/prometheus/client_golang/api"
	v1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"
)

// Level represents a DORA performance classification.
type Level string

const (
	LevelElite  Level = "elite"
	LevelHigh   Level = "high"
	LevelMedium Level = "medium"
	LevelLow    Level = "low"
)

// Metrics holds computed DORA data for one service over a window.
type Metrics struct {
	Service             string        `json:"service"`
	Window              time.Duration `json:"window_hours"`
	DeploymentFrequency string        `json:"deploymentFrequency"`
	LeadTimeForChanges  string        `json:"leadTimeForChanges"`
	ChangeFailureRate   float64       `json:"changeFailureRate"`
	TimeToRestore       string        `json:"timeToRestore"`
	DoraLevel           Level         `json:"doraLevel"`
	DeploymentsPerDay   float64       `json:"deploymentsPerDay"`
	MedianLeadTimeHours float64       `json:"medianLeadTimeHours"`
	MttrHours           float64       `json:"mttrHours"`
}

// Calculator computes DORA metrics from Prometheus.
type Calculator struct {
	promAPI v1.API
}

// NewCalculator creates a Calculator backed by the given Prometheus address.
func NewCalculator(prometheusAddr string) (*Calculator, error) {
	client, err := api.NewClient(api.Config{Address: prometheusAddr})
	if err != nil {
		return nil, fmt.Errorf("prometheus client: %w", err)
	}
	return &Calculator{promAPI: v1.NewAPI(client)}, nil
}

// Compute calculates DORA metrics for a service over the given window.
func (c *Calculator) Compute(ctx context.Context, service string, window time.Duration) (*Metrics, error) {
	end := time.Now()
	start := end.Add(-window)
	r := v1.Range{Start: start, End: end, Step: time.Hour}

	deploymentsPerDay, err := c.deploymentsPerDay(ctx, service, r)
	if err != nil {
		return nil, fmt.Errorf("deployment frequency: %w", err)
	}
	cfr, err := c.changeFailureRate(ctx, service, r)
	if err != nil {
		return nil, fmt.Errorf("change failure rate: %w", err)
	}
	mttrHours, err := c.mttrHours(ctx, service, r)
	if err != nil {
		return nil, fmt.Errorf("MTTR: %w", err)
	}

	m := &Metrics{
		Service:             service,
		Window:              window,
		DeploymentsPerDay:   deploymentsPerDay,
		ChangeFailureRate:   cfr,
		MttrHours:           mttrHours,
		DeploymentFrequency: classifyDeployFreq(deploymentsPerDay),
		TimeToRestore:       classifyMTTR(mttrHours),
		LeadTimeForChanges:  "< 1 day", // populated from GitHub API
	}
	m.DoraLevel = computeLevel(m)
	return m, nil
}

func (c *Calculator) deploymentsPerDay(ctx context.Context, svc string, r v1.Range) (float64, error) {
	query := fmt.Sprintf(
		`sum(increase(deployment_total{service=%q,status="success"}[%s]))`,
		svc, durationToPromRange(r.End.Sub(r.Start)),
	)
	result, _, err := c.promAPI.Query(ctx, query, r.End)
	if err != nil {
		return 0, err
	}
	vec, ok := result.(model.Vector)
	if !ok || len(vec) == 0 {
		return 0, nil
	}
	days := r.End.Sub(r.Start).Hours() / 24
	return float64(vec[0].Value) / days, nil
}

func (c *Calculator) changeFailureRate(ctx context.Context, svc string, r v1.Range) (float64, error) {
	promRange := durationToPromRange(r.End.Sub(r.Start))
	totalQ := fmt.Sprintf(`sum(increase(deployment_total{service=%q}[%s]))`, svc, promRange)
	failQ := fmt.Sprintf(`sum(increase(deployment_total{service=%q,status="rollback"}[%s]))`, svc, promRange)

	total, _, err := c.promAPI.Query(ctx, totalQ, r.End)
	if err != nil {
		return 0, err
	}
	fail, _, err := c.promAPI.Query(ctx, failQ, r.End)
	if err != nil {
		return 0, err
	}

	totalVec, _ := total.(model.Vector)
	failVec, _ := fail.(model.Vector)
	if len(totalVec) == 0 || float64(totalVec[0].Value) == 0 {
		return 0, nil
	}
	var failVal float64
	if len(failVec) > 0 {
		failVal = float64(failVec[0].Value)
	}
	return (failVal / float64(totalVec[0].Value)) * 100, nil
}

func (c *Calculator) mttrHours(ctx context.Context, svc string, r v1.Range) (float64, error) {
	query := fmt.Sprintf(
		`avg(avg_over_time(incident_resolution_duration_seconds{service=%q}[%s])) / 3600`,
		svc, durationToPromRange(r.End.Sub(r.Start)),
	)
	result, _, err := c.promAPI.Query(ctx, query, r.End)
	if err != nil {
		return 0, err
	}
	vec, _ := result.(model.Vector)
	if len(vec) == 0 {
		return 0, nil
	}
	return math.Round(float64(vec[0].Value)*100) / 100, nil
}

func classifyDeployFreq(perDay float64) string {
	switch {
	case perDay >= 1:
		return "multiple per day"
	case perDay >= 1.0/7:
		return "weekly"
	case perDay >= 1.0/30:
		return "monthly"
	default:
		return "less than monthly"
	}
}

func classifyMTTR(hours float64) string {
	switch {
	case hours < 1:
		return "< 1 hour"
	case hours < 24:
		return "< 1 day"
	case hours < 168:
		return "< 1 week"
	default:
		return "> 1 week"
	}
}

func computeLevel(m *Metrics) Level {
	score := 0
	if m.DeploymentsPerDay >= 1 {
		score++
	}
	if m.MedianLeadTimeHours < 24 {
		score++
	}
	if m.ChangeFailureRate < 5 {
		score++
	}
	if m.MttrHours < 1 {
		score++
	}
	switch score {
	case 4:
		return LevelElite
	case 3:
		return LevelHigh
	case 2:
		return LevelMedium
	default:
		return LevelLow
	}
}

func durationToPromRange(d time.Duration) string {
	h := int(d.Hours())
	if h < 1 {
		return "1h"
	}
	return fmt.Sprintf("%dh", h)
}
```

### TechDocs Integration

TechDocs renders Markdown from your repository into Backstage's documentation hub. Place a `mkdocs.yml` at the repo root and wire up CI to publish on every merge to main:

```yaml
# mkdocs.yml
site_name: Payment API
docs_dir: docs
nav:
  - Home: index.md
  - Architecture: architecture.md
  - API Reference: api-reference.md
  - Runbooks:
      - Incident Response: runbooks/incident-response.md
      - Database Failover: runbooks/db-failover.md
  - ADRs:
      - ADR-001 Choose Kafka over SQS: adrs/adr-001-kafka.md
plugins:
  - techdocs-core
markdown_extensions:
  - admonition
  - pymdownx.details
  - pymdownx.superfences
```

```yaml
# .github/workflows/techdocs.yaml
name: Publish TechDocs
on:
  push:
    branches: [main]
    paths: [docs/**, mkdocs.yml]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install mkdocs-techdocs-core==1.*
      - run: npx @techdocs/cli generate --source-dir . --output-dir site
      - run: |
          npx @techdocs/cli publish \
            --publisher-type awsS3 \
            --storage-name ${{ vars.TECHDOCS_BUCKET }} \
            --entity default/Component/payment-api
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: us-east-1
```

### Junior → FAANG: Understanding What Makes a Backstage Implementation Actually Work

This section contains substantially more Backstage implementation detail than the earlier introduction. The key shift from basic to advanced understanding is recognizing that the catalog YAML is not just metadata. It is the linking mechanism that connects all platform tooling.

The `dependsOn` field in the catalog YAML is more than documentation. Backstage uses it to render dependency graphs, calculate blast radius for incidents, and trigger downstream notifications when a dependency changes health status. A component that declares `dependsOn: [component:postgres-payments, component:kafka-events]` gives the platform tooling enough information to automatically alert the payments team when the kafka-events component has a degraded SLO. This is machine-readable operational context, not human-readable documentation.

The TypeScript backend plugin that proxies to the Go DORA service is worth studying carefully even if you do not write TypeScript professionally. The pattern (Backstage plugin forwards requests to a Go service, Go service computes data from Prometheus and returns JSON) is the standard architecture for extending Backstage with custom data. If you are working on a platform team, you will almost certainly implement this pattern for some internal data source. The key design principle is that the Go service should not know it is serving a Backstage plugin. It exposes a standard REST API. The Backstage plugin is just one of potentially many consumers.

The `ServiceMetricsCard` React component shows the pattern for displaying async data in Backstage: `useEffect` to fetch, `useState` for loading and data states, and a graceful fallback when data is unavailable. The `doraLevel` chip using `color` based on the DORA performance classification is a UX decision: developers can see at a glance whether their service is performing at elite, high, medium, or low level without reading numbers.

### Senior @ FAANG: Backstage at Production Scale and the Data Quality Problem

The rich catalog YAML shown in this section depends on accurate data: the Grafana dashboard must exist at that URL, the PagerDuty integration key must be valid, the `dependsOn` entries must refer to entities that actually exist in the catalog. As an organization scales to thousands of services, maintaining this accuracy becomes the central challenge of operating Backstage.

The data quality problem has three root causes. Teams change without updating ownership. Services are deprecated without updating lifecycle. Dependencies are added or removed without updating the `dependsOn` list. Each of these failures produces a catalog that is systematically misleading. A Backstage installation with a high catalog accuracy rate is an organizational achievement, not just a technical one. Achieving it requires automated validation in CI (pull request checks that verify entity references exist), periodic reconciliation jobs (weekly jobs that detect stale ownership by cross-referencing HR data with catalog entries), and a team accountability model (the catalog entry for your service is your team's responsibility, not the platform team's).

The DORA metrics API backed by Prometheus queries is a production-critical integration that requires careful attention to query performance. Prometheus range queries over 90-day windows across hundreds of services can be slow. The caching layer described in the exercises is not optional at scale. It is a prerequisite. The production pattern is a pre-computation job that runs nightly, computes DORA metrics for every service in the catalog, and writes the results to PostgreSQL or Redis. The API then serves from the pre-computed cache rather than querying Prometheus in real time. This trades slightly stale data (metrics are 24 hours old) for consistent sub-100ms response times regardless of the number of services.

The TechDocs publishing workflow deserves a security review before production deployment. The workflow uses long-lived AWS credentials stored as GitHub secrets. In a production environment, the preferred approach is OIDC federation: the GitHub Actions workflow authenticates to AWS using its OIDC token (no static credentials) and assumes a role with minimal permissions (S3 write to the TechDocs bucket, nothing else). This eliminates the risk of secret leakage through workflow log exposure or repository access control failures.
