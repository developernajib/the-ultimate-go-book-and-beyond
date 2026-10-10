## 105D.6 Grafana Dashboard as Code

Managing Grafana dashboards through the UI leads to configuration drift, undocumented changes, and lost dashboards after cluster rebuilds. Defining dashboards as Go structs that serialize to Grafana's JSON API format enables version-controlled, reproducible dashboard deployments that can be applied idempotently from a CI pipeline. The `GrafanaClient` below authenticates with a service account token and creates or updates dashboards via the HTTP API with overwrite semantics, so repeated CI runs are idempotent.

```go
package grafana

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

// GrafanaClient manages Grafana resources
type GrafanaClient struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

// NewGrafanaClient creates a Grafana API client
func NewGrafanaClient(baseURL, apiKey string) *GrafanaClient {
	return &GrafanaClient{
		baseURL:    baseURL,
		apiKey:     apiKey,
		httpClient: &http.Client{},
	}
}

// Dashboard represents a Grafana dashboard
type Dashboard struct {
	ID          int            `json:"id,omitempty"`
	UID         string         `json:"uid,omitempty"`
	Title       string         `json:"title"`
	Tags        []string       `json:"tags,omitempty"`
	Timezone    string         `json:"timezone,omitempty"`
	Panels      []Panel        `json:"panels"`
	Templating  *Templating    `json:"templating,omitempty"`
	Time        *TimeRange     `json:"time,omitempty"`
	Refresh     string         `json:"refresh,omitempty"`
	SchemaVersion int          `json:"schemaVersion"`
	Version     int            `json:"version,omitempty"`
}

// Panel represents a Grafana panel
type Panel struct {
	ID          int                    `json:"id"`
	Type        string                 `json:"type"`
	Title       string                 `json:"title"`
	Description string                 `json:"description,omitempty"`
	GridPos     GridPos                `json:"gridPos"`
	Targets     []Target               `json:"targets"`
	FieldConfig *FieldConfig           `json:"fieldConfig,omitempty"`
	Options     map[string]any `json:"options,omitempty"`
}

// GridPos defines panel position
type GridPos struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// Target defines a data source query
type Target struct {
	Expr         string `json:"expr"`
	LegendFormat string `json:"legendFormat,omitempty"`
	RefID        string `json:"refId"`
	Instant      bool   `json:"instant,omitempty"`
}

// FieldConfig configures field display
type FieldConfig struct {
	Defaults FieldDefaults `json:"defaults"`
}

// FieldDefaults sets default field settings
type FieldDefaults struct {
	Unit       string      `json:"unit,omitempty"`
	Min        *float64    `json:"min,omitempty"`
	Max        *float64    `json:"max,omitempty"`
	Thresholds *Thresholds `json:"thresholds,omitempty"`
}

// Thresholds defines color thresholds
type Thresholds struct {
	Mode  string      `json:"mode"`
	Steps []Threshold `json:"steps"`
}

// Threshold represents one threshold step
type Threshold struct {
	Color string   `json:"color"`
	Value *float64 `json:"value"`
}

// Templating holds dashboard template variables
type Templating struct {
	List []TemplateVar `json:"list"`
}

// TemplateVar defines a template variable
type TemplateVar struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Query      string `json:"query,omitempty"`
	Datasource string `json:"datasource,omitempty"`
	Multi      bool   `json:"multi,omitempty"`
	IncludeAll bool   `json:"includeAll,omitempty"`
}

// TimeRange defines dashboard time range
type TimeRange struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// UpsertDashboard creates or updates a Grafana dashboard
func (c *GrafanaClient) UpsertDashboard(dashboard Dashboard, folderID int) error {
	payload := map[string]any{
		"dashboard": dashboard,
		"folderId":  folderID,
		"overwrite": true,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequest(http.MethodPost,
		c.baseURL+"/api/dashboards/db", bytes.NewReader(body))
	if err != nil {
		return err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("dashboard upsert failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("Grafana API error: %d", resp.StatusCode)
	}

	return nil
}

// ServiceDashboardBuilder creates service dashboards programmatically
type ServiceDashboardBuilder struct {
	service   string
	namespace string
	panels    []Panel
	nextID    int
	nextY     int
}

// NewServiceDashboardBuilder creates a dashboard builder
func NewServiceDashboardBuilder(service, namespace string) *ServiceDashboardBuilder {
	return &ServiceDashboardBuilder{
		service:   service,
		namespace: namespace,
		nextID:    1,
	}
}

// AddRequestRate adds an HTTP request rate panel
func (b *ServiceDashboardBuilder) AddRequestRate() *ServiceDashboardBuilder {
	b.panels = append(b.panels, Panel{
		ID:    b.nextID,
		Type:  "timeseries",
		Title: "Request Rate",
		GridPos: GridPos{X: 0, Y: b.nextY, W: 12, H: 6},
		Targets: []Target{
			{
				Expr:         fmt.Sprintf(`rate(%s_%s_http_requests_total[5m])`, b.namespace, b.service),
				LegendFormat: "{{method}} {{path}} {{status}}",
				RefID:        "A",
			},
		},
		FieldConfig: &FieldConfig{
			Defaults: FieldDefaults{
				Unit: "reqps",
			},
		},
	})
	b.nextID++
	return b
}

// AddLatencyPercentiles adds p50/p95/p99 latency panels
func (b *ServiceDashboardBuilder) AddLatencyPercentiles() *ServiceDashboardBuilder {
	b.panels = append(b.panels, Panel{
		ID:    b.nextID,
		Type:  "timeseries",
		Title: "Request Latency Percentiles",
		GridPos: GridPos{X: 12, Y: b.nextY, W: 12, H: 6},
		Targets: []Target{
			{
				Expr: fmt.Sprintf(
					`histogram_quantile(0.50, rate(%s_%s_http_request_duration_seconds_bucket[5m]))`,
					b.namespace, b.service),
				LegendFormat: "p50",
				RefID:        "A",
			},
			{
				Expr: fmt.Sprintf(
					`histogram_quantile(0.95, rate(%s_%s_http_request_duration_seconds_bucket[5m]))`,
					b.namespace, b.service),
				LegendFormat: "p95",
				RefID:        "B",
			},
			{
				Expr: fmt.Sprintf(
					`histogram_quantile(0.99, rate(%s_%s_http_request_duration_seconds_bucket[5m]))`,
					b.namespace, b.service),
				LegendFormat: "p99",
				RefID:        "C",
			},
		},
		FieldConfig: &FieldConfig{
			Defaults: FieldDefaults{
				Unit: "s",
			},
		},
	})
	b.nextID++
	b.nextY += 6
	return b
}

// AddErrorRate adds an error rate panel
func (b *ServiceDashboardBuilder) AddErrorRate() *ServiceDashboardBuilder {
	b.panels = append(b.panels, Panel{
		ID:    b.nextID,
		Type:  "timeseries",
		Title: "Error Rate",
		GridPos: GridPos{X: 0, Y: b.nextY, W: 12, H: 6},
		Targets: []Target{
			{
				Expr: fmt.Sprintf(
					`rate(%s_%s_http_requests_total{status=~"5.."}[5m]) / rate(%s_%s_http_requests_total[5m])`,
					b.namespace, b.service, b.namespace, b.service),
				LegendFormat: "Error Rate",
				RefID:        "A",
			},
		},
		FieldConfig: &FieldConfig{
			Defaults: FieldDefaults{
				Unit: "percentunit",
				Thresholds: &Thresholds{
					Mode: "absolute",
					Steps: []Threshold{
						{Color: "green"},
						{Color: "yellow", Value: floatPtr(0.01)},
						{Color: "red", Value: floatPtr(0.05)},
					},
				},
			},
		},
	})
	b.nextID++
	return b
}

// Build creates the final dashboard
func (b *ServiceDashboardBuilder) Build() Dashboard {
	return Dashboard{
		UID:     fmt.Sprintf("%s-service", b.service),
		Title:   fmt.Sprintf("%s Service Dashboard", b.service),
		Tags:    []string{"service", b.service, "auto-generated"},
		Timezone: "browser",
		Refresh: "1m",
		SchemaVersion: 39,
		Time: &TimeRange{From: "now-1h", To: "now"},
		Panels: b.panels,
		Templating: &Templating{
			List: []TemplateVar{
				{
					Name:       "datasource",
					Type:       "datasource",
					Query:      "prometheus",
				},
			},
		},
	}
}

func floatPtr(v float64) *float64 {
	return &v
}
```

### Junior → FAANG: Dashboard-as-Code Is a Discipline, Not a Tool Choice

The specific tool (Go HTTP client, grafonnet Jsonnet, Terraform Grafana provider) matters less than the discipline: dashboards must be in version control and deployed through CI, not edited in the Grafana UI. Any UI-edited dashboard can be overwritten by the next CI deployment, and any CI deployment can be reviewed in a PR. These two facts make the case for the discipline without needing to choose a specific tool.

For a first job, start simple: export your existing dashboards from the Grafana UI as JSON, commit them to the repository, and set up a CI job that deploys them on merge. This gives you version history and reviewability immediately, without requiring any code generation tooling.

### Senior @ FAANG: Grafana Dashboard as Code as a Platform Standard

At L6, the Grafana provisioning system (directory of JSON files mounted as a ConfigMap) is the platform standard. The Go-based dashboard generator in this section is for services that need programmatic dashboard generation from metadata (service catalogs, SLO databases). For most teams, provisioning static JSON is the right approach.

The governance requirement is: every Grafana dashboard in the `production` folder must be in the repository and deployed via CI. Dashboards in the UI that are not in the repository are deleted during the next deployment. This strict enforcement prevents the accumulation of "shadow dashboards" that are created for one-off investigations and never cleaned up, which become maintenance debt when their data sources change.

---
