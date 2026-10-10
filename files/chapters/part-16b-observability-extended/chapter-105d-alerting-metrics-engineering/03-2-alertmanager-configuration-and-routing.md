## 105D.3 AlertManager Configuration and Routing

Alertmanager receives alerts from Prometheus and routes them to the correct receiver based on label matchers: PagerDuty for critical incidents, Slack for warnings, email for informational notifications. The Go client below sends alerts directly to Alertmanager's `/api/v2/alerts` endpoint, which is useful for application-generated alerts (SLO burn events, deployment signals) that Prometheus rules cannot capture because they are event-driven rather than metric-threshold-based.

```go
package alertmanager

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Alert represents a Prometheus alert
type Alert struct {
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
	StartsAt    time.Time         `json:"startsAt,omitempty"`
	EndsAt      time.Time         `json:"endsAt,omitempty"`
	GeneratorURL string            `json:"generatorURL,omitempty"`
}

// AlertManagerClient sends alerts to AlertManager
type AlertManagerClient struct {
	baseURL    string
	httpClient *http.Client
}

// NewAlertManagerClient creates an AlertManager client
func NewAlertManagerClient(baseURL string) *AlertManagerClient {
	return &AlertManagerClient{
		baseURL:    baseURL,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// SendAlerts sends alerts to AlertManager
func (c *AlertManagerClient) SendAlerts(ctx context.Context, alerts []Alert) error {
	body, err := json.Marshal(alerts)
	if err != nil {
		return fmt.Errorf("failed to marshal alerts: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/api/v2/alerts", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send alerts: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("AlertManager returned %d", resp.StatusCode)
	}

	return nil
}

// Silence represents an AlertManager silence
type Silence struct {
	ID        string            `json:"id,omitempty"`
	Matchers  []Matcher         `json:"matchers"`
	StartsAt  time.Time         `json:"startsAt"`
	EndsAt    time.Time         `json:"endsAt"`
	Comment   string            `json:"comment"`
	CreatedBy string            `json:"createdBy"`
}

// Matcher matches alert labels
type Matcher struct {
	Name    string `json:"name"`
	Value   string `json:"value"`
	IsRegex bool   `json:"isRegex"`
	IsEqual bool   `json:"isEqual"`
}

// CreateSilence creates a silence in AlertManager
func (c *AlertManagerClient) CreateSilence(ctx context.Context, silence Silence) (string, error) {
	body, err := json.Marshal(silence)
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/api/v2/silences", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to create silence: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		SilenceID string `json:"silenceID"`
	}
	json.NewDecoder(resp.Body).Decode(&result)

	return result.SilenceID, nil
}

// AlertManagerConfig generates AlertManager configuration
type AlertManagerConfig struct {
	Routes    []AlertRoute
	Receivers []AlertReceiver
}

// AlertRoute defines how alerts are routed
type AlertRoute struct {
	Receiver       string
	Match          map[string]string
	MatchRe        map[string]string
	GroupBy        []string
	GroupWait      time.Duration
	GroupInterval  time.Duration
	RepeatInterval time.Duration
	Continue       bool
	Routes         []AlertRoute
}

// AlertReceiver defines where alerts are sent
type AlertReceiver struct {
	Name         string
	SlackConfigs []SlackConfig
	PagerDutyConfigs []PagerDutyConfig
	EmailConfigs []EmailConfig
}

// SlackConfig defines Slack notification settings
type SlackConfig struct {
	APIURL   string
	Channel  string
	Text     string
	Title    string
	Color    string
	IconEmoji string
	SendResolved bool
}

// PagerDutyConfig defines PagerDuty settings
type PagerDutyConfig struct {
	RoutingKey  string
	Description string
	Severity    string
	Details     map[string]string
	SendResolved bool
}

// EmailConfig defines email notification settings
type EmailConfig struct {
	To          string
	From        string
	Smarthost   string
	Subject     string
	Body        string
	SendResolved bool
}

// GenerateConfig generates AlertManager YAML configuration
func GenerateConfig(config AlertManagerConfig) string {
	var sb strings.Builder

	sb.WriteString(`global:
  resolve_timeout: 5m
  slack_api_url: 'https://hooks.slack.com/services/...'

templates:
  - '/etc/alertmanager/templates/*.tmpl'

route:
  group_by: ['alertname', 'cluster', 'service']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'default'
  routes:
`)

	for _, route := range config.Routes {
		sb.WriteString(fmt.Sprintf(`    - receiver: '%s'
      matchers:
`, route.Receiver))
		for k, v := range route.Match {
			sb.WriteString(fmt.Sprintf("        - %s = %q\n", k, v))
		}
	}

	sb.WriteString("\nreceivers:\n")
	for _, recv := range config.Receivers {
		sb.WriteString(fmt.Sprintf("  - name: '%s'\n", recv.Name))
		if len(recv.SlackConfigs) > 0 {
			sb.WriteString("    slack_configs:\n")
			for _, slack := range recv.SlackConfigs {
				sb.WriteString(fmt.Sprintf(`      - channel: '%s'
        title: '%s'
        text: '%s'
        send_resolved: %v
`, slack.Channel, slack.Title, slack.Text, slack.SendResolved))
			}
		}
	}

	return sb.String()
}

// DeadMansSwitchMonitor sends regular heartbeats to detect job failures
type DeadMansSwitchMonitor struct {
	alertsClient *AlertManagerClient
	jobName      string
	interval     time.Duration
	tolerance    time.Duration
	lastSeen     time.Time
	mu           sync.RWMutex
	stopCh       chan struct{}
}

// NewDeadMansSwitchMonitor creates a dead man's switch for a job
func NewDeadMansSwitchMonitor(
	client *AlertManagerClient,
	jobName string,
	interval time.Duration,
) *DeadMansSwitchMonitor {
	return &DeadMansSwitchMonitor{
		alertsClient: client,
		jobName:      jobName,
		interval:     interval,
		tolerance:    interval * 3, // Alert if missed 3 heartbeats
		lastSeen:     time.Now(),   // Grace period until the first heartbeat
		stopCh:       make(chan struct{}),
	}
}

// Heartbeat records that the job is alive
func (m *DeadMansSwitchMonitor) Heartbeat() {
	m.mu.Lock()
	m.lastSeen = time.Now()
	m.mu.Unlock()
}

// Start begins monitoring for heartbeats
func (m *DeadMansSwitchMonitor) Start(ctx context.Context) {
	ticker := time.NewTicker(m.interval / 2)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			m.mu.RLock()
			lastSeen := m.lastSeen
			m.mu.RUnlock()

			if time.Since(lastSeen) > m.tolerance {
				m.sendAlert(ctx)
			}

		case <-m.stopCh:
			return
		case <-ctx.Done():
			return
		}
	}
}

// Stop stops the monitor
func (m *DeadMansSwitchMonitor) Stop() {
	close(m.stopCh)
}

func (m *DeadMansSwitchMonitor) sendAlert(ctx context.Context) {
	m.mu.RLock()
	lastSeen := m.lastSeen
	m.mu.RUnlock()

	alerts := []Alert{
		{
			Labels: map[string]string{
				"alertname": "DeadManSwitch",
				"job":       m.jobName,
				"severity":  "critical",
			},
			Annotations: map[string]string{
				"summary": fmt.Sprintf("Job %s has not sent heartbeat for %v",
					m.jobName, m.tolerance),
				"description": fmt.Sprintf(
					"The last heartbeat from %s was at %s. This indicates the job may be down.",
					m.jobName, lastSeen.Format(time.RFC3339)),
			},
			StartsAt: time.Now(),
		},
	}

	if err := m.alertsClient.SendAlerts(ctx, alerts); err != nil {
		log.Printf("failed to send dead man's switch alert: %v", err)
	}
}
```

### Junior → FAANG: Alertmanager Routing Is Configuration, Not Code

Alertmanager routing is declarative YAML configuration, but understanding it requires understanding the matching model. Routes are evaluated top to bottom, and the first route that matches an alert's labels handles it. The `continue: true` flag allows an alert to match multiple routes (useful for audit trails). Without this understanding, Alertmanager configurations become brittle: adding a new route unexpectedly captures alerts intended for an existing route.

For interviews, be ready to describe an Alertmanager configuration that routes: P1 alerts to PagerDuty (24/7 page), P2/P3 alerts to Slack (business hours notification), and all database alerts to a DBA team regardless of severity. The gotcha is the database routing: it must use `continue: true` so that a P1 database alert also goes to PagerDuty, not only to the DBA channel.

### Senior @ FAANG: Alertmanager Configuration as Infrastructure Code

At L6, Alertmanager configuration is managed as Terraform or Kubernetes ConfigMap resources, not as manually edited YAML files. The configuration is version-controlled, reviewed in PRs, and deployed through the same CI/CD pipeline as the rest of the platform infrastructure. An Alertmanager configuration that routes hundreds of alerts from dozens of services is a critical piece of the incident response infrastructure: a misconfiguration that silences P1 alerts from a service is a production reliability risk equivalent to a service outage.

Testing Alertmanager routing is done with `amtool check-config` (validates YAML syntax) and with integration tests that fire synthetic alerts through the API and verify their routing in a test Alertmanager instance. The test suite runs on every configuration change in CI.

---
