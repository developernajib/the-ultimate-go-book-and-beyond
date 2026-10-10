## 104.6 Grafana Dashboards

### Dashboard JSON (Go Service)

Dashboards translate raw metrics into actionable visualizations that surface system behavior at a glance for on-call engineers. The following configuration demonstrates key panel types and query patterns for Grafana dashboards backed by Prometheus data.

```json
{
  "title": "Go Service Dashboard",
  "panels": [
    {
      "title": "Request Rate",
      "type": "stat",
      "targets": [
        {
          "expr": "sum(rate(http_requests_total[5m]))",
          "legendFormat": "req/s"
        }
      ],
      "options": {
        "colorMode": "value",
        "graphMode": "area"
      }
    },
    {
      "title": "Error Rate",
      "type": "gauge",
      "targets": [
        {
          "expr": "sum(rate(http_requests_total{status=~\"5..\"}[5m])) / sum(rate(http_requests_total[5m])) * 100"
        }
      ],
      "options": {
        "showThresholdLabels": false,
        "showThresholdMarkers": true
      },
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "thresholds": {
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 1},
              {"color": "red", "value": 5}
            ]
          }
        }
      }
    },
    {
      "title": "Latency (P50, P95, P99)",
      "type": "timeseries",
      "targets": [
        {
          "expr": "histogram_quantile(0.50, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))",
          "legendFormat": "P50"
        },
        {
          "expr": "histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))",
          "legendFormat": "P95"
        },
        {
          "expr": "histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))",
          "legendFormat": "P99"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "s"
        }
      }
    },
    {
      "title": "Memory Usage",
      "type": "timeseries",
      "targets": [
        {
          "expr": "go_memstats_alloc_bytes / 1024 / 1024",
          "legendFormat": "Allocated"
        },
        {
          "expr": "go_memstats_sys_bytes / 1024 / 1024",
          "legendFormat": "System"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "mbytes"
        }
      }
    },
    {
      "title": "Goroutines",
      "type": "timeseries",
      "targets": [
        {
          "expr": "go_goroutines",
          "legendFormat": "Goroutines"
        }
      ]
    }
  ]
}
```

### Junior → FAANG: Grafana Dashboard Design Fundamentals

A Grafana dashboard serves one purpose: give an engineer the information they need to understand system health or diagnose a problem, as quickly as possible. Many dashboards fail at this by including too many panels with no clear hierarchy.

Follow the "overview to details" layout: the top row shows aggregate health (total RPS, error rate, p99 latency), the middle rows show breakdowns by dimension (by endpoint, by region, by status code), and the bottom rows show infrastructure metrics (CPU, memory, goroutines). An engineer responding to an alert starts at the top to confirm the scope, then drills down to identify the affected dimension.

Label everything: panel titles, axis units (seconds not a raw number), and legend labels using `{{label_name}}` syntax. A panel with no unit and a raw number is meaningless during an incident.

### Senior @ FAANG: Dashboard Governance, Templating, and Dashboard-as-Code

**Template variables for multi-service reuse.** A well-designed Grafana dashboard uses template variables (`$service`, `$namespace`, `$region`) that parameterize all PromQL queries. This transforms a dashboard from a one-service artifact into a reusable template that works for every service following the platform naming standard. The platform team publishes a base dashboard template that all services inherit, reducing the work to "fill in the service-specific panels" rather than building from scratch.

**Dashboard-as-code prevents drift.** Dashboards created through the Grafana UI are fragile: they live in the Grafana database, have no version history, and cannot be reviewed in code review. The platform team enforces dashboard-as-code using Grafana provisioning (YAML files mounted into the Grafana pod) or `grafonnet` (a Jsonnet library for generating dashboard JSON). Changes to dashboards go through the same PR review process as code changes, with a Grafana rendering test that validates the JSON produces a valid dashboard.

**Dashboard ownership and SLO alignment.** Every production dashboard must have a corresponding SLO document that defines the alert thresholds displayed on the dashboard. A dashboard that shows metrics without corresponding alerts is observability theater: it looks good in demos but provides no operational value because nobody is watching it during an incident. An L6 engineer audits dashboards quarterly to verify that every displayed metric either feeds an alert or is explicitly documented as informational.

---
