// pkg/alerting/notifiers.go
package alerting

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/smtp"
	"strings"
	"time"
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
	var body strings.Builder
	body.WriteString("Firing Alerts:\n\n")
	for _, alert := range alerts {
		body.WriteString(fmt.Sprintf("Alert: %s\n", alert.Rule.Name))
		body.WriteString(fmt.Sprintf("Severity: %s\n", alert.Rule.Severity))
		body.WriteString(fmt.Sprintf("Value: %f\n", alert.Value))
		body.WriteString(fmt.Sprintf("Active Since: %s\n", alert.ActiveAt.Format(time.RFC3339)))
		body.WriteString("\n")
	}

	// Send email
	auth := smtp.PlainAuth("", n.username, n.password, n.smtpHost)

	msg := fmt.Appendf(nil, "To: %s\r\n"+
		"Subject: Alert Notification\r\n"+
		"\r\n"+
		"%s\r\n", n.to[0], body.String())

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
