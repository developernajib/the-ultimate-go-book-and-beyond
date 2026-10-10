## 105C.6 Error Tracking & Alerting

Error tracking groups similar errors together so that a burst of the same panic or database timeout appears as one incident with a count, rather than flooding an alert channel with thousands of identical notifications. The `ErrorTracker` below fingerprints errors by hashing their type and normalized message, groups repeat occurrences under a single record, and triggers an alert only on the first occurrence of a new error and again at every hundredth repeat, providing the signal-to-noise ratio required to act on alerts reliably in production.

```go
package errortracking

import (
	"bytes"
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"slices"
	"sync"
	"time"
)

// ErrorTracker tracks and deduplicates errors
type ErrorTracker struct {
	mu         sync.RWMutex
	errors     map[string]*TrackedError
	alerts     AlertManager
	maxAge     time.Duration
	thresholds AlertThresholds
}

// TrackedError represents a deduplicated error
type TrackedError struct {
	Fingerprint  string
	ErrorType    string
	Message      string
	StackTrace   string
	Occurrences  int
	FirstSeen    time.Time
	LastSeen     time.Time
	Contexts     []ErrorContext
	Resolved     bool
}

// ErrorContext provides context for a specific error occurrence
type ErrorContext struct {
	Timestamp   time.Time
	UserID      string
	RequestID   string
	Environment string
	Extra       map[string]any
}

// AlertThresholds defines when to trigger alerts
type AlertThresholds struct {
	ErrorsPerMinute  int
	ErrorsPerHour    int
	NewErrorAlert    bool
	CriticalTypes    []string
}

// AlertManager sends alerts
type AlertManager interface {
	SendAlert(ctx context.Context, alert Alert) error
}

// Alert represents a triggered alert
type Alert struct {
	Severity    string
	Title       string
	Description string
	Fingerprint string
	Count       int
	FirstSeen   time.Time
	LastSeen    time.Time
	Tags        map[string]string
}

// NewErrorTracker creates an error tracker
func NewErrorTracker(alerts AlertManager, maxAge time.Duration, thresholds AlertThresholds) *ErrorTracker {
	return &ErrorTracker{
		errors:     make(map[string]*TrackedError),
		alerts:     alerts,
		maxAge:     maxAge,
		thresholds: thresholds,
	}
}

// Track records an error occurrence
func (t *ErrorTracker) Track(ctx context.Context, err error, extra map[string]any) {
	if err == nil {
		return
	}

	// Generate fingerprint from error type and message
	// Excludes dynamic values like IDs, timestamps
	fingerprint := t.generateFingerprint(err)

	t.mu.Lock()
	tracked, exists := t.errors[fingerprint]
	if !exists {
		tracked = &TrackedError{
			Fingerprint: fingerprint,
			ErrorType:   fmt.Sprintf("%T", err),
			Message:     err.Error(),
			StackTrace:  captureStack(),
			FirstSeen:   time.Now(),
		}
		t.errors[fingerprint] = tracked
	}

	tracked.Occurrences++
	tracked.LastSeen = time.Now()

	// Store context (keep last 10)
	context_ := ErrorContext{
		Timestamp: time.Now(),
		Extra:     extra,
	}
	tracked.Contexts = append(tracked.Contexts, context_)
	if len(tracked.Contexts) > 10 {
		tracked.Contexts = tracked.Contexts[len(tracked.Contexts)-10:]
	}

	occurrences := tracked.Occurrences
	isNew := !exists
	t.mu.Unlock()

	// Check if alert should be triggered
	t.checkAlertThresholds(ctx, tracked, isNew, occurrences)
}

func (t *ErrorTracker) generateFingerprint(err error) string {
	// Create a stable fingerprint that groups similar errors
	// Remove dynamic parts (IDs, timestamps, etc.)
	errType := fmt.Sprintf("%T", err)
	// In production: use more sophisticated normalization
	h := sha256.Sum256([]byte(errType + "::" + normalizeErrorMessage(err.Error())))
	return fmt.Sprintf("%x", h[:8])
}

func normalizeErrorMessage(msg string) string {
	// Remove dynamic values like UUIDs, numbers
	// Simplified. Use regex in production
	return msg
}

func captureStack() string {
	buf := make([]byte, 4096)
	n := runtime.Stack(buf, false)
	return string(buf[:n])
}

func (t *ErrorTracker) checkAlertThresholds(
	ctx context.Context,
	err *TrackedError,
	isNew bool,
	count int,
) {
	if t.alerts == nil {
		return
	}

	var alert *Alert

	// New error alert
	if isNew && t.thresholds.NewErrorAlert {
		alert = &Alert{
			Severity:    "warning",
			Title:       fmt.Sprintf("New error: %s", err.ErrorType),
			Description: err.Message,
			Fingerprint: err.Fingerprint,
			Count:       1,
			FirstSeen:   err.FirstSeen,
			LastSeen:    err.LastSeen,
		}
	}

	// High frequency alert
	if count > 0 && count%100 == 0 {
		alert = &Alert{
			Severity:    "critical",
			Title:       fmt.Sprintf("Error spike: %s (%d occurrences)", err.ErrorType, count),
			Description: err.Message,
			Fingerprint: err.Fingerprint,
			Count:       count,
			FirstSeen:   err.FirstSeen,
			LastSeen:    err.LastSeen,
		}
	}

	if alert != nil {
		t.alerts.SendAlert(ctx, *alert)
	}
}

// GetTopErrors returns the most frequent errors
func (t *ErrorTracker) GetTopErrors(n int) []*TrackedError {
	t.mu.RLock()
	defer t.mu.RUnlock()

	errors := make([]*TrackedError, 0, len(t.errors))
	for _, e := range t.errors {
		errors = append(errors, e)
	}

	// Sort by occurrences (descending)
	slices.SortFunc(errors, func(a, b *TrackedError) int {
		return cmp.Compare(b.Occurrences, a.Occurrences)
	})

	if n > len(errors) {
		n = len(errors)
	}
	return errors[:n]
}

// HandleErrors provides an HTTP endpoint for viewing tracked errors
func (t *ErrorTracker) HandleErrors(w http.ResponseWriter, r *http.Request) {
	topErrors := t.GetTopErrors(50)

	response := make([]map[string]any, 0, len(topErrors))
	for _, err := range topErrors {
		response = append(response, map[string]any{
			"fingerprint": err.Fingerprint,
			"type":        err.ErrorType,
			"message":     err.Message,
			"occurrences": err.Occurrences,
			"first_seen":  err.FirstSeen,
			"last_seen":   err.LastSeen,
			"resolved":    err.Resolved,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// SlackAlertManager sends alerts to Slack
type SlackAlertManager struct {
	webhookURL string
	httpClient *http.Client
}

// SendAlert sends an alert to Slack
func (s *SlackAlertManager) SendAlert(ctx context.Context, alert Alert) error {
	payload := map[string]any{
		"text": fmt.Sprintf("*[%s] %s*\n%s\nOccurrences: %d",
			alert.Severity, alert.Title, alert.Description, alert.Count),
		"attachments": []map[string]any{
			{
				"color": severityColor(alert.Severity),
				"fields": []map[string]string{
					{"title": "Fingerprint", "value": alert.Fingerprint, "short": "true"},
					{"title": "First seen", "value": alert.FirstSeen.Format(time.RFC3339), "short": "true"},
					{"title": "Last seen", "value": alert.LastSeen.Format(time.RFC3339), "short": "true"},
				},
			},
		},
	}

	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.webhookURL,
		bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("slack alert failed: %w", err)
	}
	resp.Body.Close()

	return nil
}

func severityColor(severity string) string {
	switch severity {
	case "critical":
		return "#FF0000"
	case "warning":
		return "#FFA500"
	default:
		return "#36A64F"
	}
}
```

### Junior → FAANG: Error Tracking vs. Log Search

Error tracking tools (Sentry, Elastic APM, Rollbar) solve a specific problem that log search cannot: grouping. When a single bug affects 10,000 requests, a log search returns 10,000 individual error lines. An error tracker groups them into one issue with a count of 10,000, a stack trace, and a first-seen timestamp. This grouping is essential for prioritization: a new error with 1 occurrence may be more urgent than an old error with 10,000 occurrences if the old error is known and the new one is unknown.

For a first job, configure error alerting to page on new error groups (first occurrence of a never-before-seen error) and on error rate spikes, not on individual errors. Individual error alerts produce noise. Pattern alerts produce signal.

### Senior @ FAANG: Error Fingerprinting, Noise Reduction, and Error Budget Integration

**Fingerprinting strategy.** Error grouping depends on a fingerprinting algorithm that determines which errors are "the same." A naive fingerprinting algorithm that uses the error message will create separate groups for `"user 123 not found"` and `"user 456 not found"`, producing thousands of groups for one bug. A correct fingerprinting algorithm uses the stack trace (which is the same for both), creating one group. An L6 engineer evaluates error tracker fingerprinting quality and customizes it for common patterns (ORM not-found errors, HTTP timeout errors) that the default algorithm handles poorly.

**Error budget integration.** At FAANG scale, error events are not just for developer awareness: they feed the error budget calculation. An error tracker that counts distinct error events can be the source of truth for the error budget SLI: "availability = (total requests - error requests) / total requests." This requires the error tracker to record every request that resulted in a tracked error, not just sample them. An L6 engineer ensures the error tracker is configured for complete coverage, not sampling, when it is used as the SLI data source.

---
