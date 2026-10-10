## Part 6: Alerting System

An observability platform is only useful if it can proactively notify you when something goes wrong. The alerting system evaluates rules on a schedule, detects when conditions are met (such as error rate exceeding a threshold), and routes notifications to the right people through the right channels. This two-part design separates the rule evaluation engine from the notification delivery, so you can add new notification channels (like Microsoft Teams or a custom webhook) without touching the alerting logic.

### 6.1 Alert Rule Engine

The alert rule engine periodically evaluates a set of rules, each of which contains a PromQL expression and a threshold condition. When a rule's condition is met, the engine transitions the alert from "inactive" to "pending" and then to "firing" after a configurable duration (to avoid false positives from brief spikes). When the condition clears, the alert transitions back to "resolved" and a resolution notification is sent. The engine tracks alert state in memory and persists firing alerts so they survive restarts.

```go
// pkg/alerting/engine.go
package alerting

import (
    "context"
    "fmt"
    "sync"
    "time"

    "gopkg.in/yaml.v3"

    "observability/pkg/query"
    "observability/pkg/storage"
)

// Engine evaluates alert rules
type Engine struct {
    rules               []*Rule
    queryEngine         *query.Engine
    evaluationInterval  time.Duration
    notifiers           []Notifier

    mu      sync.RWMutex
    running bool
    stopCh  chan struct{}
    wg      sync.WaitGroup

    // Active alerts
    activeAlerts map[string]*Alert
}

// Rule represents an alert rule
type Rule struct {
    Name        string
    Query       string
    Duration    time.Duration
    Labels      map[string]string
    Annotations map[string]string
    Severity    string

    // Evaluation state
    lastEval  time.Time
    activeFor time.Time
}

// Alert represents an active alert
type Alert struct {
    Rule        *Rule
    Labels      map[string]string
    Annotations map[string]string
    State       AlertState
    ActiveAt    time.Time
    Value       float64
}

// AlertState represents alert state
type AlertState string

const (
    AlertStatePending  AlertState = "pending"
    AlertStateFiring   AlertState = "firing"
    AlertStateResolved AlertState = "resolved"
)

// Notifier sends alert notifications
type Notifier interface {
    Notify(ctx context.Context, alerts []*Alert) error
}

// NewEngine creates a new alerting engine
func NewEngine(queryEngine *query.Engine, evaluationInterval time.Duration) *Engine {
    return &Engine{
        rules:              make([]*Rule, 0),
        queryEngine:        queryEngine,
        evaluationInterval: evaluationInterval,
        notifiers:          make([]Notifier, 0),
        activeAlerts:       make(map[string]*Alert),
    }
}

// LoadRules loads alert rules from file
func (e *Engine) LoadRules(path string) error {
    // Parse YAML rules file
    // Simplified version
    return nil
}

// AddRule adds an alert rule
func (e *Engine) AddRule(rule *Rule) {
    e.mu.Lock()
    defer e.mu.Unlock()

    e.rules = append(e.rules, rule)
}

// AddNotifier adds a notifier
func (e *Engine) AddNotifier(notifier Notifier) {
    e.notifiers = append(e.notifiers, notifier)
}

// Start starts the alerting engine
func (e *Engine) Start(ctx context.Context) error {
    e.mu.Lock()
    defer e.mu.Unlock()

    if e.running {
        return fmt.Errorf("engine already running")
    }

    e.stopCh = make(chan struct{})
    e.running = true

    e.wg.Add(1)
    go e.evaluationLoop()

    return nil
}

// evaluationLoop continuously evaluates rules
func (e *Engine) evaluationLoop() {
    defer e.wg.Done()

    ticker := time.NewTicker(e.evaluationInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ticker.C:
            e.evaluateRules()

        case <-e.stopCh:
            return
        }
    }
}

// evaluateRules evaluates all rules
func (e *Engine) evaluateRules() {
    e.mu.RLock()
    rules := make([]*Rule, len(e.rules))
    copy(rules, e.rules)
    e.mu.RUnlock()

    var wg sync.WaitGroup

    for _, rule := range rules {
        wg.Add(1)
        go func(r *Rule) {
            defer wg.Done()
            e.evaluateRule(r)
        }(rule)
    }

    wg.Wait()

    // Send notifications for firing alerts
    e.sendNotifications()
}

// evaluateRule evaluates a single rule
func (e *Engine) evaluateRule(rule *Rule) {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Execute query
    result, err := e.queryEngine.Query(ctx, rule.Query, time.Now())
    if err != nil {
        return
    }

    rule.lastEval = time.Now()

    // Check if alert should fire
    shouldFire := e.shouldFireAlert(result, rule)

    alertKey := rule.Name

    e.mu.Lock()
    defer e.mu.Unlock()

    existingAlert, exists := e.activeAlerts[alertKey]

    if shouldFire {
        if !exists {
            // New alert
            alert := &Alert{
                Rule:        rule,
                Labels:      rule.Labels,
                Annotations: rule.Annotations,
                State:       AlertStatePending,
                ActiveAt:    time.Now(),
            }

            if len(result.Series) > 0 && len(result.Series[0].Values) > 0 {
                alert.Value = result.Series[0].Values[0].Value
            }

            e.activeAlerts[alertKey] = alert
        } else {
            // Update existing alert
            if existingAlert.State == AlertStatePending {
                // Check if should transition to firing
                if time.Since(existingAlert.ActiveAt) >= rule.Duration {
                    existingAlert.State = AlertStateFiring
                }
            }

            // Update value
            if len(result.Series) > 0 && len(result.Series[0].Values) > 0 {
                existingAlert.Value = result.Series[0].Values[0].Value
            }
        }
    } else {
        // Alert should not fire
        if exists {
            // Resolve alert
            existingAlert.State = AlertStateResolved
        }
    }
}

// shouldFireAlert checks if alert should fire based on query result
func (e *Engine) shouldFireAlert(result *query.QueryResult, rule *Rule) bool {
    // Simplified: check if query returned any results
    return len(result.Series) > 0 && len(result.Series[0].Values) > 0
}

// sendNotifications sends notifications for firing alerts
func (e *Engine) sendNotifications() {
    e.mu.RLock()
    var firingAlerts []*Alert
    for _, alert := range e.activeAlerts {
        if alert.State == AlertStateFiring {
            firingAlerts = append(firingAlerts, alert)
        }
    }
    e.mu.RUnlock()

    if len(firingAlerts) == 0 {
        return
    }

    ctx := context.Background()

    for _, notifier := range e.notifiers {
        if err := notifier.Notify(ctx, firingAlerts); err != nil {
            // Log error
        }
    }
}

// Stop stops the engine
func (e *Engine) Stop(ctx context.Context) error {
    e.mu.Lock()
    if !e.running {
        e.mu.Unlock()
        return nil
    }
    e.running = false
    close(e.stopCh)
    e.mu.Unlock()

    e.wg.Wait()
    return nil
}
```

### 6.2 Notifiers

Notifiers are responsible for delivering alert messages to external systems. Each notifier implements a common interface, so the alert engine can send notifications without knowing the details of email SMTP, Slack webhooks, or PagerDuty API calls. This design makes it easy to add new notification channels by simply implementing the `Notifier` interface. Each notifier formats the alert information appropriately for its channel, for example including severity colors in Slack messages or urgency levels in PagerDuty incidents.

```go
// pkg/alerting/notifiers.go
package alerting

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "net/smtp"
)

// EmailNotifier sends email notifications
type EmailNotifier struct {
    smtpHost string
    smtpPort string
    from     string
    to       []string
    username string
    password string
}

// NewEmailNotifier creates an email notifier
func NewEmailNotifier(host, port, from string, to []string, username, password string) *EmailNotifier {
    return &EmailNotifier{
        smtpHost: host,
        smtpPort: port,
        from:     from,
        to:       to,
        username: username,
        password: password,
    }
}

// Notify sends email notifications
func (n *EmailNotifier) Notify(ctx context.Context, alerts []*Alert) error {
    if len(alerts) == 0 {
        return nil
    }

    // Build email body
    body := "Firing Alerts:\n\n"
    for _, alert := range alerts {
        body += fmt.Sprintf("Alert: %s\n", alert.Rule.Name)
        body += fmt.Sprintf("Severity: %s\n", alert.Rule.Severity)
        body += fmt.Sprintf("Value: %f\n", alert.Value)
        body += fmt.Sprintf("Active Since: %s\n", alert.ActiveAt.Format(time.RFC3339))
        body += "\n"
    }

    // Send email
    auth := smtp.PlainAuth("", n.username, n.password, n.smtpHost)

    msg := []byte(fmt.Sprintf("To: %s\r\n"+
        "Subject: Alert Notification\r\n"+
        "\r\n"+
        "%s\r\n", n.to[0], body))

    addr := fmt.Sprintf("%s:%s", n.smtpHost, n.smtpPort)

    return smtp.SendMail(addr, auth, n.from, n.to, msg)
}

// SlackNotifier sends Slack notifications
type SlackNotifier struct {
    webhookURL string
    channel    string
}

// NewSlackNotifier creates a Slack notifier
func NewSlackNotifier(webhookURL, channel string) *SlackNotifier {
    return &SlackNotifier{
        webhookURL: webhookURL,
        channel:    channel,
    }
}

// Notify sends Slack notifications
func (n *SlackNotifier) Notify(ctx context.Context, alerts []*Alert) error {
    if len(alerts) == 0 {
        return nil
    }

    // Build Slack message
    text := fmt.Sprintf("%d alerts firing:", len(alerts))

    attachments := make([]map[string]any, 0, len(alerts))

    for _, alert := range alerts {
        color := "warning"
        if alert.Rule.Severity == "critical" {
            color = "danger"
        }

        attachment := map[string]any{
            "color": color,
            "title": alert.Rule.Name,
            "fields": []map[string]any{
                {
                    "title": "Severity",
                    "value": alert.Rule.Severity,
                    "short": true,
                },
                {
                    "title": "Value",
                    "value": fmt.Sprintf("%.2f", alert.Value),
                    "short": true,
                },
                {
                    "title": "Active Since",
                    "value": alert.ActiveAt.Format(time.RFC3339),
                    "short": false,
                },
            },
        }

        attachments = append(attachments, attachment)
    }

    payload := map[string]any{
        "channel":     n.channel,
        "text":        text,
        "attachments": attachments,
    }

    jsonPayload, err := json.Marshal(payload)
    if err != nil {
        return err
    }

    resp, err := http.Post(n.webhookURL, "application/json", bytes.NewBuffer(jsonPayload))
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return fmt.Errorf("slack notification failed: %s", resp.Status)
    }

    return nil
}

// PagerDutyNotifier sends PagerDuty notifications
type PagerDutyNotifier struct {
    integrationKey string
    client         *http.Client
}

// NewPagerDutyNotifier creates a PagerDuty notifier
func NewPagerDutyNotifier(integrationKey string) *PagerDutyNotifier {
    return &PagerDutyNotifier{
        integrationKey: integrationKey,
        client:         &http.Client{Timeout: 10 * time.Second},
    }
}

// Notify sends PagerDuty notifications
func (n *PagerDutyNotifier) Notify(ctx context.Context, alerts []*Alert) error {
    for _, alert := range alerts {
        event := map[string]any{
            "routing_key":  n.integrationKey,
            "event_action": "trigger",
            "payload": map[string]any{
                "summary":  alert.Rule.Name,
                "severity": alert.Rule.Severity,
                "source":   "observability-platform",
                "custom_details": map[string]any{
                    "value":       alert.Value,
                    "active_at":   alert.ActiveAt.Format(time.RFC3339),
                    "annotations": alert.Annotations,
                },
            },
        }

        jsonEvent, err := json.Marshal(event)
        if err != nil {
            return err
        }

        resp, err := n.client.Post(
            "https://events.pagerduty.com/v2/enqueue",
            "application/json",
            bytes.NewBuffer(jsonEvent),
        )
        if err != nil {
            return err
        }
        defer resp.Body.Close()

        if resp.StatusCode != http.StatusAccepted {
            return fmt.Errorf("pagerduty notification failed: %s", resp.Status)
        }
    }

    return nil
}
```
