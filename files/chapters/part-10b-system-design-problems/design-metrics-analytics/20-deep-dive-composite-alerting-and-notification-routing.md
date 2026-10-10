## Deep Dive: Composite Alerting and Notification Routing

Simple threshold alerts generate enormous noise in production systems because a single noisy metric can fire thousands of alerts during an incident. Composite alerts address this by requiring multiple independent conditions to be true simultaneously before an alert fires, for example, only page on-call when both error rate exceeds 5% AND latency P99 exceeds 500ms, reducing false positives. The `CompositeAlertRule` below supports AND/OR operators across arbitrary condition combinations, and the `NotificationRouter` fans the alert out to the channels the rule names, which is how a warning ends up in Slack while a critical also pages PagerDuty. The router honors silence windows and gives each channel its own timeout so one slow webhook cannot block the rest, and it reports a failure when no channel accepted the alert rather than pretending the page went out.

```go
package alerting

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type DataPoint struct {
	Timestamp int64
	Value     float64
}

type QueryRequest struct {
	MetricName  string
	Tags        map[string]string
	Start       time.Time
	End         time.Time
	Aggregation string
	Interval    string
}

type QueryResult struct {
	Metric     string
	DataPoints []DataPoint
}

type TimeSeriesQuerier interface {
	Query(ctx context.Context, req QueryRequest) ([]QueryResult, error)
}

// CompositeAlertRule supports complex alert conditions
type CompositeAlertRule struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Conditions   []AlertCondition  `json:"conditions"`
	Operator     string            `json:"operator"` // AND, OR
	Window       string            `json:"window"`
	Severity     string            `json:"severity"`
	Channels     []string          `json:"channels"`
	Annotations  map[string]string `json:"annotations"`
	SilenceUntil *time.Time        `json:"silence_until,omitempty"`
}

type AlertCondition struct {
	Metric      string            `json:"metric"`
	Tags        map[string]string `json:"tags"`
	Aggregation string            `json:"aggregation"`
	Operator    string            `json:"operator"`
	Threshold   float64           `json:"threshold"`
}

// EvaluateComposite evaluates a multi-condition alert rule. A query
// failure returns an error instead of treating the condition as "not
// firing", because silently resolving an alert while the TSDB is down
// would hide exactly the incidents alerting exists to catch.
func EvaluateComposite(ctx context.Context, rule CompositeAlertRule, tsdb TimeSeriesQuerier) (bool, []string, error) {
	var results []bool
	var details []string

	for _, cond := range rule.Conditions {
		value, err := queryMetricValue(ctx, tsdb, cond, rule.Window)
		if err != nil {
			return false, details, fmt.Errorf("condition %s: %w", cond.Metric, err)
		}

		firing := evaluateCondition(value, cond.Operator, cond.Threshold)
		results = append(results, firing)
		details = append(details, fmt.Sprintf("%s %s(%.2f) %s %.2f = %v",
			cond.Metric, cond.Aggregation, value, cond.Operator, cond.Threshold, firing))
	}

	// Combine with operator
	switch rule.Operator {
	case "AND":
		for _, r := range results {
			if !r {
				return false, details, nil
			}
		}
		return true, details, nil
	case "OR":
		for _, r := range results {
			if r {
				return true, details, nil
			}
		}
		return false, details, nil
	}
	return false, details, fmt.Errorf("unknown operator %q", rule.Operator)
}

func queryMetricValue(ctx context.Context, tsdb TimeSeriesQuerier, cond AlertCondition, window string) (float64, error) {
	dur, err := time.ParseDuration(window)
	if err != nil {
		dur = 5 * time.Minute
	}
	end := time.Now()

	result, err := tsdb.Query(ctx, QueryRequest{
		MetricName:  cond.Metric,
		Tags:        cond.Tags,
		Start:       end.Add(-dur),
		End:         end,
		Aggregation: cond.Aggregation,
		Interval:    window,
	})
	if err != nil {
		return 0, err
	}
	if len(result) == 0 || len(result[0].DataPoints) == 0 {
		return 0, fmt.Errorf("no data")
	}
	pts := result[0].DataPoints
	return pts[len(pts)-1].Value, nil
}

func evaluateCondition(value float64, operator string, threshold float64) bool {
	switch operator {
	case "gt":
		return value > threshold
	case "lt":
		return value < threshold
	case "gte":
		return value >= threshold
	case "lte":
		return value <= threshold
	}
	return false
}

// NotificationRouter sends alerts to the right channels
type NotificationRouter struct {
	channels map[string]NotificationChannel
}

type NotificationChannel interface {
	Send(ctx context.Context, msg AlertMessage) error
}

type AlertMessage struct {
	RuleID      string
	RuleName    string
	Severity    string
	Message     string
	Value       float64
	Threshold   float64
	Annotations map[string]string
	FiredAt     time.Time
}

// Route sends an alert to every channel the rule names. One failing
// channel must not stop the others, so errors are collected rather than
// returned early. If nothing was delivered the caller gets an error:
// reporting success for an alert that reached no one is the failure mode
// that lets an incident run unattended.
func (r *NotificationRouter) Route(ctx context.Context, rule CompositeAlertRule, msg AlertMessage) error {
	// Honor silence windows set by operators during planned maintenance
	if rule.SilenceUntil != nil && time.Now().Before(*rule.SilenceUntil) {
		return nil
	}

	var errs []error
	delivered := 0

	for _, channelName := range rule.Channels {
		channel, ok := r.channels[channelName]
		if !ok {
			errs = append(errs, fmt.Errorf("channel %q not configured", channelName))
			continue
		}

		// Each channel gets its own deadline so a slow webhook cannot
		// consume the budget the remaining channels need.
		sendCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := channel.Send(sendCtx, msg)
		cancel()

		if err != nil {
			errs = append(errs, fmt.Errorf("send to %s: %w", channelName, err))
			continue
		}
		delivered++
	}

	if delivered == 0 {
		return fmt.Errorf("alert %s reached no channel: %w", rule.ID, errors.Join(errs...))
	}
	// Partial delivery: the page went out, but the operator still needs to
	// know a channel is broken.
	return errors.Join(errs...)
}
```

---
