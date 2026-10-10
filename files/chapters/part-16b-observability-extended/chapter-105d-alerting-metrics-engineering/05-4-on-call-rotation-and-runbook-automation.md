## 105D.5 On-Call Rotation and Runbook Automation

An on-call schedule that can be queried programmatically enables automated runbook execution: when an alert fires, the system can look up the current on-call engineer, send a targeted page, and trigger remediation steps without human triage. The `OnCallSchedule` below manages a rotation of engineers with configurable shift slots, exposes a `GetCurrentOnCall` method for alert routing, and pairs with a `RunbookAutomation` engine that maps alert names to predefined remediation steps executed through a pluggable `RunbookExecutor`.

```go
package oncall

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"sync"
	"time"
)

// OnCallSchedule manages on-call rotations
type OnCallSchedule struct {
	mu        sync.RWMutex
	rotations []Rotation
	overrides []ScheduleOverride
}

// Rotation represents a repeating on-call period
type Rotation struct {
	Name        string
	Description string
	Schedule    []RotationSlot
	TimeZone    string
}

// RotationSlot represents one person's on-call period
type RotationSlot struct {
	User      OnCallUser
	StartTime time.Time
	EndTime   time.Time
}

// OnCallUser represents an on-call person
type OnCallUser struct {
	ID       string
	Name     string
	Email    string
	Phone    string
	SlackID  string
	Timezone string
}

// ScheduleOverride overrides the normal rotation
type ScheduleOverride struct {
	User      OnCallUser
	StartTime time.Time
	EndTime   time.Time
	Reason    string
}

// NewOnCallSchedule creates a schedule manager
func NewOnCallSchedule() *OnCallSchedule {
	return &OnCallSchedule{}
}

// AddRotation adds a rotation to the schedule
func (s *OnCallSchedule) AddRotation(rotation Rotation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rotations = append(s.rotations, rotation)
}

// GetCurrentOnCall returns who is currently on call
func (s *OnCallSchedule) GetCurrentOnCall() (*OnCallUser, error) {
	return s.GetOnCallAt(time.Now())
}

// GetOnCallAt returns who is on call at a specific time
func (s *OnCallSchedule) GetOnCallAt(t time.Time) (*OnCallUser, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Check overrides first
	for _, override := range s.overrides {
		if t.After(override.StartTime) && t.Before(override.EndTime) {
			return &override.User, nil
		}
	}

	// Check regular rotation
	for _, rotation := range s.rotations {
		for _, slot := range rotation.Schedule {
			if t.After(slot.StartTime) && t.Before(slot.EndTime) {
				return &slot.User, nil
			}
		}
	}

	return nil, fmt.Errorf("no one on call at %s", t.Format(time.RFC3339))
}

// GetUpcomingShifts returns upcoming on-call shifts
func (s *OnCallSchedule) GetUpcomingShifts(hours int) []RotationSlot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	now := time.Now()
	end := now.Add(time.Duration(hours) * time.Hour)

	var upcoming []RotationSlot
	for _, rotation := range s.rotations {
		for _, slot := range rotation.Schedule {
			if slot.StartTime.Before(end) && slot.EndTime.After(now) {
				upcoming = append(upcoming, slot)
			}
		}
	}

	slices.SortFunc(upcoming, func(a, b RotationSlot) int {
		return a.StartTime.Compare(b.StartTime)
	})

	return upcoming
}

// EscalationPolicy defines how alerts escalate
type EscalationPolicy struct {
	Name    string
	Levels  []EscalationLevel
}

// EscalationLevel represents one level of escalation
type EscalationLevel struct {
	DelayMinutes int
	Targets      []EscalationTarget
}

// EscalationTarget defines who to notify
type EscalationTarget struct {
	Type    string // "user", "schedule", "slack"
	ID      string
	Channel string // For Slack
}

// RunbookAutomation executes automated remediation
type RunbookAutomation struct {
	mu       sync.RWMutex
	runbooks map[string]Runbook
	executor RunbookExecutor
}

// Runbook represents an automated remediation procedure
type Runbook struct {
	Name        string
	Description string
	AlertNames  []string // Alert names this runbook handles
	Steps       []RunbookStep
	DryRun      bool
}

// RunbookStep represents one step in a runbook
type RunbookStep struct {
	Name       string
	Type       string // "http", "shell", "notification", "wait"
	Action     string
	Parameters map[string]string
	OnFailure  string // "continue", "abort"
}

// RunbookExecutor executes runbook steps
type RunbookExecutor interface {
	Execute(ctx context.Context, step RunbookStep) error
}

// NewRunbookAutomation creates a runbook automation system
func NewRunbookAutomation(executor RunbookExecutor) *RunbookAutomation {
	return &RunbookAutomation{
		runbooks: make(map[string]Runbook),
		executor: executor,
	}
}

// RegisterRunbook registers a runbook
func (r *RunbookAutomation) RegisterRunbook(runbook Runbook) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, alertName := range runbook.AlertNames {
		r.runbooks[alertName] = runbook
	}
}

// HandleAlert executes the appropriate runbook for an alert
func (r *RunbookAutomation) HandleAlert(ctx context.Context, alertName string, labels map[string]string) error {
	r.mu.RLock()
	runbook, exists := r.runbooks[alertName]
	r.mu.RUnlock()

	if !exists {
		return fmt.Errorf("no runbook for alert: %s", alertName)
	}

	if runbook.DryRun {
		// Log what would happen
		for _, step := range runbook.Steps {
			fmt.Printf("DRY RUN: Would execute step '%s' (type=%s)\n", step.Name, step.Type)
		}
		return nil
	}

	// Execute steps
	for i, step := range runbook.Steps {
		if err := r.executor.Execute(ctx, step); err != nil {
			if step.OnFailure == "abort" {
				return fmt.Errorf("runbook aborted at step %d (%s): %w", i+1, step.Name, err)
			}
			// continue on failure
			fmt.Printf("Step %d failed (continuing): %v\n", i+1, err)
		}
	}

	return nil
}

// HTTPRunbookExecutor executes HTTP-based runbook steps
type HTTPRunbookExecutor struct {
	client *http.Client
}

// Execute executes a runbook step
func (e *HTTPRunbookExecutor) Execute(ctx context.Context, step RunbookStep) error {
	switch step.Type {
	case "http":
		return e.executeHTTP(ctx, step)
	case "wait":
		duration, err := time.ParseDuration(step.Action)
		if err != nil {
			return fmt.Errorf("invalid wait duration: %w", err)
		}
		select {
		case <-time.After(duration):
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	case "notification":
		fmt.Printf("NOTIFICATION: %s\n", step.Action)
		return nil
	default:
		return fmt.Errorf("unknown step type: %s", step.Type)
	}
}

func (e *HTTPRunbookExecutor) executeHTTP(ctx context.Context, step RunbookStep) error {
	method := step.Parameters["method"]
	if method == "" {
		method = http.MethodGet
	}

	req, err := http.NewRequestWithContext(ctx, method, step.Action, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := e.client.Do(req)
	if err != nil {
		return fmt.Errorf("HTTP step failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP step returned %d", resp.StatusCode)
	}

	return nil
}

// AlertCorrelationEngine correlates related alerts to reduce noise
type AlertCorrelationEngine struct {
	mu            sync.RWMutex
	activeAlerts  map[string]*CorrelatedAlert
	rules         []CorrelationRule
	suppressWindow time.Duration
}

// CorrelatedAlert groups related alerts
type CorrelatedAlert struct {
	RootAlert   string
	ChildAlerts []string
	Labels      map[string]string
	StartTime   time.Time
	Suppressed  bool
}

// CorrelationRule defines how to correlate alerts
type CorrelationRule struct {
	Name         string
	ParentAlert  string
	ChildAlerts  []string
	MustMatch    map[string]string
	SuppressFor  time.Duration
}

// NewAlertCorrelationEngine creates a correlation engine
func NewAlertCorrelationEngine(suppressWindow time.Duration) *AlertCorrelationEngine {
	return &AlertCorrelationEngine{
		activeAlerts:  make(map[string]*CorrelatedAlert),
		suppressWindow: suppressWindow,
	}
}

// AddRule adds a correlation rule
func (e *AlertCorrelationEngine) AddRule(rule CorrelationRule) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.rules = append(e.rules, rule)
}

// ProcessAlert determines if an alert should be suppressed
func (e *AlertCorrelationEngine) ProcessAlert(alertName string, labels map[string]string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()

	for _, rule := range e.rules {
		// Check if this is a child alert
		for _, child := range rule.ChildAlerts {
			if child == alertName {
				// Check if parent is active
				if correlated, exists := e.activeAlerts[rule.ParentAlert]; exists {
					if !correlated.Suppressed {
						// Label matching
						match := true
						for k, v := range rule.MustMatch {
							if labels[k] != v {
								match = false
								break
							}
						}
						if match {
							correlated.ChildAlerts = append(correlated.ChildAlerts, alertName)
							return true // Suppress child alert
						}
					}
				}
			}
		}

		// Check if this is a parent alert
		if rule.ParentAlert == alertName {
			e.activeAlerts[alertName] = &CorrelatedAlert{
				RootAlert: alertName,
				Labels:    labels,
				StartTime: time.Now(),
			}
		}
	}

	return false
}
```

### Junior → FAANG: Runbook Automation Starts with Automation Scripts, Not Buttons

The jump from "manual runbook" to "Slack bot with one-click remediation" is large. The intermediate step is a CLI tool that automates the diagnostic steps while keeping a human in the decision loop. A script that runs `kubectl get pods`, filters for crash-looping pods, fetches their recent logs, and prints a formatted summary is automation that saves 3 minutes per incident without removing human oversight.

For a first job, identify the three most time-consuming steps in your most common runbooks and write CLI tools that automate each one. Measure the time saved per incident. The data makes the case for investing more in automation.

### Senior @ FAANG: Runbook Automation as a Maturity Model Investment

At L6, runbook automation is a phased investment. Phase 1: automate diagnostic data collection (the "what is happening" steps). Phase 2: automate mitigation for the most common failure modes (restart a service, scale a deployment, flush a cache) with human approval via a Slack button. Phase 3: autonomous remediation for specific well-understood failure modes that have a clear safe action (restart a pod that has OOM-killed, reduce consumer parallelism when queue lag exceeds a threshold).

Phase 3 (autonomous remediation) requires high confidence in the detection accuracy: a false positive that autonomously restarts a healthy service can cause more impact than the original incident. An L6 engineer maintains an explicit list of approved autonomous remediation actions, each with a documented confidence threshold and a rollback mechanism. Any new autonomous remediation proposal goes through an incident simulation review before being enabled in production.

---
