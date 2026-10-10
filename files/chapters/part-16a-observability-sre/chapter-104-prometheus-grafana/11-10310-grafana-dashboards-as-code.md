## 104.11 Grafana Dashboards as Code

### Dashboard Provisioning

Grafana provisioning loads dashboards from files on disk instead of the Grafana database, which is what makes dashboards-as-code possible. Each provider entry below points Grafana at a directory of dashboard JSON files and assigns them to a folder in the UI.

```yaml
# grafana/provisioning/dashboards/default.yaml
apiVersion: 1
providers:
  - name: 'Go Services'
    folder: 'Services'
    type: file
    options:
      path: /var/lib/grafana/dashboards/services

  - name: 'SRE'
    folder: 'SRE'
    type: file
    options:
      path: /var/lib/grafana/dashboards/sre
```

### Complete Go Service Dashboard

The dashboard below is a full provisioning-ready definition: template variables for service and namespace selection, golden-signal stat and gauge panels in the top row, and time series, heatmap, and runtime panels beneath. Commit this JSON to the directory your provider watches and Grafana loads it automatically.

```json
{
  "title": "Go Service Overview",
  "uid": "go-service-overview",
  "tags": ["go", "production"],
  "timezone": "browser",
  "refresh": "30s",
  "time": {"from": "now-1h", "to": "now"},
  "templating": {
    "list": [
      {
        "name": "service",
        "type": "query",
        "query": "label_values(http_requests_total, service)",
        "current": {"text": "All", "value": "$__all"},
        "includeAll": true,
        "multi": true
      },
      {
        "name": "namespace",
        "type": "query",
        "query": "label_values(kube_pod_info, namespace)",
        "current": {"text": "production", "value": "production"}
      }
    ]
  },
  "panels": [
    {
      "title": "Request Rate",
      "type": "stat",
      "gridPos": {"x": 0, "y": 0, "w": 6, "h": 4},
      "targets": [
        {
          "expr": "sum(rate(http_requests_total{service=~\"$service\"}[5m]))",
          "legendFormat": ""
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "reqps",
          "thresholds": {
            "steps": [
              {"color": "red", "value": null},
              {"color": "green", "value": 10}
            ]
          }
        }
      }
    },
    {
      "title": "Error Rate",
      "type": "gauge",
      "gridPos": {"x": 6, "y": 0, "w": 6, "h": 4},
      "targets": [
        {
          "expr": "sum(rate(http_requests_total{service=~\"$service\",status=~\"5..\"}[5m])) / sum(rate(http_requests_total{service=~\"$service\"}[5m])) * 100",
          "legendFormat": ""
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "max": 10,
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
      "title": "P99 Latency",
      "type": "stat",
      "gridPos": {"x": 12, "y": 0, "w": 6, "h": 4},
      "targets": [
        {
          "expr": "histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{service=~\"$service\"}[5m])))",
          "legendFormat": ""
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "thresholds": {
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 0.5},
              {"color": "red", "value": 1}
            ]
          }
        }
      }
    },
    {
      "title": "SLO Budget Remaining",
      "type": "gauge",
      "gridPos": {"x": 18, "y": 0, "w": 6, "h": 4},
      "targets": [
        {
          "expr": "slo:error_budget_remaining{service=~\"$service\"} * 100",
          "legendFormat": ""
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "min": 0,
          "max": 100,
          "thresholds": {
            "steps": [
              {"color": "red", "value": null},
              {"color": "yellow", "value": 25},
              {"color": "green", "value": 50}
            ]
          }
        }
      }
    },
    {
      "title": "Request Rate Over Time",
      "type": "timeseries",
      "gridPos": {"x": 0, "y": 4, "w": 12, "h": 8},
      "targets": [
        {
          "expr": "sum by (status) (rate(http_requests_total{service=~\"$service\"}[5m]))",
          "legendFormat": "{{status}}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "reqps",
          "custom": {
            "drawStyle": "line",
            "lineInterpolation": "smooth",
            "fillOpacity": 20
          }
        }
      }
    },
    {
      "title": "Latency Distribution",
      "type": "heatmap",
      "gridPos": {"x": 12, "y": 4, "w": 12, "h": 8},
      "targets": [
        {
          "expr": "sum by (le) (rate(http_request_duration_seconds_bucket{service=~\"$service\"}[5m]))",
          "format": "heatmap",
          "legendFormat": "{{le}}"
        }
      ],
      "options": {
        "calculate": false,
        "color": {"scheme": "Spectral", "reverse": true}
      }
    },
    {
      "title": "Memory Usage",
      "type": "timeseries",
      "gridPos": {"x": 0, "y": 12, "w": 8, "h": 6},
      "targets": [
        {
          "expr": "go_memstats_alloc_bytes{service=~\"$service\"} / 1024 / 1024",
          "legendFormat": "{{instance}} - Allocated"
        },
        {
          "expr": "go_memstats_heap_inuse_bytes{service=~\"$service\"} / 1024 / 1024",
          "legendFormat": "{{instance}} - Heap In Use"
        }
      ],
      "fieldConfig": {"defaults": {"unit": "mbytes"}}
    },
    {
      "title": "Goroutines",
      "type": "timeseries",
      "gridPos": {"x": 8, "y": 12, "w": 8, "h": 6},
      "targets": [
        {
          "expr": "go_goroutines{service=~\"$service\"}",
          "legendFormat": "{{instance}}"
        }
      ]
    },
    {
      "title": "GC Duration",
      "type": "timeseries",
      "gridPos": {"x": 16, "y": 12, "w": 8, "h": 6},
      "targets": [
        {
          "expr": "rate(go_gc_duration_seconds_sum{service=~\"$service\"}[5m])",
          "legendFormat": "{{instance}}"
        }
      ],
      "fieldConfig": {"defaults": {"unit": "s"}}
    }
  ]
}
```

### Generating Dashboards Programmatically in Go

Jsonnet with grafonnet is the most common dashboard generator, but a plain Go program that marshals typed structs to dashboard JSON achieves the same goal with tooling your team already knows. The generator below produces a standard dashboard per service from one template.

```go
// tools/dashboards/generate.go
package main

import (
    "encoding/json"
    "fmt"
    "os"
)

// Dashboard builder using Go
type Dashboard struct {
    Title     string            `json:"title"`
    UID       string            `json:"uid"`
    Tags      []string          `json:"tags"`
    Timezone  string            `json:"timezone"`
    Refresh   string            `json:"refresh"`
    Time      TimeRange         `json:"time"`
    Panels    []Panel           `json:"panels"`
    Templating Templating       `json:"templating"`
}

type TimeRange struct {
    From string `json:"from"`
    To   string `json:"to"`
}

type Templating struct {
    List []Variable `json:"list"`
}

type Variable struct {
    Name       string `json:"name"`
    Type       string `json:"type"`
    Query      string `json:"query"`
    IncludeAll bool   `json:"includeAll"`
    Multi      bool   `json:"multi"`
}

type Panel struct {
    Title     string      `json:"title"`
    Type      string      `json:"type"`
    GridPos   GridPos     `json:"gridPos"`
    Targets   []Target    `json:"targets"`
    FieldConfig *FieldConfig `json:"fieldConfig,omitempty"`
}

type GridPos struct {
    X int `json:"x"`
    Y int `json:"y"`
    W int `json:"w"`
    H int `json:"h"`
}

type Target struct {
    Expr         string `json:"expr"`
    LegendFormat string `json:"legendFormat"`
}

type FieldConfig struct {
    Defaults Defaults `json:"defaults"`
}

type Defaults struct {
    Unit       string     `json:"unit"`
    Thresholds Thresholds `json:"thresholds,omitempty"`
}

type Thresholds struct {
    Steps []ThresholdStep `json:"steps"`
}

type ThresholdStep struct {
    Color string   `json:"color"`
    Value *float64 `json:"value"`
}

// ServiceDashboard generates a standard dashboard for a Go service
func ServiceDashboard(serviceName string) *Dashboard {
    return &Dashboard{
        Title:    fmt.Sprintf("%s Service Dashboard", serviceName),
        UID:      fmt.Sprintf("%s-dashboard", serviceName),
        Tags:     []string{"go", "production", serviceName},
        Timezone: "browser",
        Refresh:  "30s",
        Time:     TimeRange{From: "now-1h", To: "now"},
        Templating: Templating{
            List: []Variable{
                {
                    Name:       "instance",
                    Type:       "query",
                    Query:      fmt.Sprintf("label_values(up{service=\"%s\"}, instance)", serviceName),
                    IncludeAll: true,
                    Multi:      true,
                },
            },
        },
        Panels: []Panel{
            requestRatePanel(serviceName, 0, 0),
            errorRatePanel(serviceName, 6, 0),
            latencyPanel(serviceName, 12, 0),
            requestRateTimeSeriesPanel(serviceName, 0, 4),
        },
    }
}

func requestRatePanel(service string, x, y int) Panel {
    return Panel{
        Title:   "Request Rate",
        Type:    "stat",
        GridPos: GridPos{X: x, Y: y, W: 6, H: 4},
        Targets: []Target{
            {
                Expr:         fmt.Sprintf("sum(rate(http_requests_total{service=\"%s\"}[5m]))", service),
                LegendFormat: "",
            },
        },
        FieldConfig: &FieldConfig{
            Defaults: Defaults{Unit: "reqps"},
        },
    }
}

func errorRatePanel(service string, x, y int) Panel {
    return Panel{
        Title:   "Error Rate",
        Type:    "gauge",
        GridPos: GridPos{X: x, Y: y, W: 6, H: 4},
        Targets: []Target{
            {
                Expr: fmt.Sprintf(
                    "sum(rate(http_requests_total{service=\"%s\",status=~\"5..\"}[5m])) / sum(rate(http_requests_total{service=\"%s\"}[5m])) * 100",
                    service, service,
                ),
                LegendFormat: "",
            },
        },
        FieldConfig: &FieldConfig{
            Defaults: Defaults{
                Unit: "percent",
                Thresholds: Thresholds{
                    Steps: []ThresholdStep{
                        {Color: "green", Value: nil},
                        {Color: "yellow", Value: floatPtr(1)},
                        {Color: "red", Value: floatPtr(5)},
                    },
                },
            },
        },
    }
}

func latencyPanel(service string, x, y int) Panel {
    return Panel{
        Title:   "P99 Latency",
        Type:    "stat",
        GridPos: GridPos{X: x, Y: y, W: 6, H: 4},
        Targets: []Target{
            {
                Expr:         fmt.Sprintf("histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{service=\"%s\"}[5m])))", service),
                LegendFormat: "",
            },
        },
        FieldConfig: &FieldConfig{
            Defaults: Defaults{Unit: "s"},
        },
    }
}

func requestRateTimeSeriesPanel(service string, x, y int) Panel {
    return Panel{
        Title:   "Request Rate Over Time",
        Type:    "timeseries",
        GridPos: GridPos{X: x, Y: y, W: 24, H: 8},
        Targets: []Target{
            {
                Expr:         fmt.Sprintf("sum by (status) (rate(http_requests_total{service=\"%s\"}[5m]))", service),
                LegendFormat: "{{status}}",
            },
        },
        FieldConfig: &FieldConfig{
            Defaults: Defaults{Unit: "reqps"},
        },
    }
}

func floatPtr(f float64) *float64 {
    return &f
}

func main() {
    services := []string{"api-gateway", "user-service", "order-service"}

    for _, svc := range services {
        dashboard := ServiceDashboard(svc)
        data, err := json.MarshalIndent(dashboard, "", "  ")
        if err != nil {
            fmt.Fprintf(os.Stderr, "marshal %s: %v\n", svc, err)
            os.Exit(1)
        }
        filename := fmt.Sprintf("dashboards/%s.json", svc)
        if err := os.WriteFile(filename, data, 0644); err != nil {
            fmt.Fprintf(os.Stderr, "write %s: %v\n", filename, err)
            os.Exit(1)
        }
        fmt.Printf("Generated %s\n", filename)
    }
}
```

### Junior → FAANG: Why Dashboards Need to Be Code

A Grafana dashboard created through the UI is fragile. There is no version history, no code review, and no way to validate changes before they affect everyone watching the dashboard during an incident. Dashboard-as-code solves all three: the dashboard definition is a file in the repository, changes go through PR review, and CI can render and validate the JSON before merge.

For a first job, start with Grafana provisioning: mount YAML files into the Grafana container that define data sources and dashboards. This is simpler than Jsonnet and sufficient for most use cases. The discipline of storing dashboards in version control is more important than the specific tool used.

Interview entry point: "How would you prevent a dashboard change from breaking an on-call workflow?" Store dashboards as code, review changes in PRs, run a Grafana rendering test in CI that loads the dashboard and takes a screenshot, and deploy dashboard changes through the same release process as code changes.

### Senior @ FAANG: Dashboard-as-Code Governance, Templating, and CI Integration

**Jsonnet and grafonnet for large-scale dashboard management.** When an organization has 500 dashboards across 100 services, each with a service overview and a detailed breakdown, the naive approach of one JSON file per dashboard is unmanageable. Jsonnet libraries (grafonnet, grafana-foundation-sdk) enable dashboard composition: define a base template with standard panels (golden signals, infrastructure metrics, error budget burn rate), then extend it per service by overriding specific panel queries and thresholds. A change to the base template (adding a new standard panel, updating the color scheme for SLO thresholds) propagates to all 500 dashboards automatically on the next CI run.

**Dashboard rendering tests in CI.** A dashboard that has valid JSON but invalid PromQL produces empty panels during an incident, which is worse than no dashboard. A CI step that calls the Grafana rendering API with a fixed time range and compares the result against a snapshot baseline catches PromQL errors and panel configuration mistakes before they reach production. This test runs on every PR that modifies a dashboard file.

**Access control and dashboard ownership.** In Grafana, dashboards organized into folders can have folder-level permissions. The platform team owns the "Platform Standards" folder and restricts edit access. Service teams own their own folders with full edit access. This structure prevents service teams from accidentally (or intentionally) modifying platform-wide dashboards while giving them full autonomy over their service dashboards. Dashboard folder structure and permissions are managed as code in the same repository as the dashboard JSON files.

---
