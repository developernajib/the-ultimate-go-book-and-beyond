// pkg/alerting/engine.go
package alerting

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/example/observability-platform/pkg/query"
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
