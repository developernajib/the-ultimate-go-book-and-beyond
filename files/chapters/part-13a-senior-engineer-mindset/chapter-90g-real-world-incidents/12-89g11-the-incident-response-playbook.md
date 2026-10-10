## 90G.11 The Incident Response Playbook

Every incident in this chapter could have been resolved faster - or prevented entirely - with a structured
incident response process. The following implementation provides the foundation for an incident management system.

```go
package incident

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Severity classifies incident urgency.
type Severity int

const (
	SeverityCritical Severity = iota // revenue/safety impact, all hands
	SeverityHigh                      // significant user impact
	SeverityMedium                    // partial degradation
	SeverityLow                       // minor issue, no user impact
)

func (s Severity) String() string {
	names := [...]string{"CRITICAL", "HIGH", "MEDIUM", "LOW"}
	if int(s) < len(names) {
		return names[s]
	}
	return "UNKNOWN"
}

// Phase tracks where in the incident lifecycle we are.
type Phase int

const (
	PhaseDetection Phase = iota
	PhaseTriage
	PhaseMitigation
	PhaseResolution
	PhasePostmortem
)

func (p Phase) String() string {
	names := [...]string{"DETECTION", "TRIAGE", "MITIGATION", "RESOLUTION", "POSTMORTEM"}
	if int(p) < len(names) {
		return names[p]
	}
	return "UNKNOWN"
}

// Incident represents an active or resolved incident.
type Incident struct {
	ID            string
	Title         string
	Severity      Severity
	Phase         Phase
	Commander     string    // incident commander
	DetectedAt    time.Time
	TriagedAt     time.Time
	MitigatedAt   time.Time
	ResolvedAt    time.Time
	PostmortemURL string

	mu       sync.RWMutex
	timeline []TimelineEntry
	actions  []ActionItem
}

// TimelineEntry records an event during incident response.
type TimelineEntry struct {
	Timestamp   time.Time
	Author      string
	Description string
	Phase       Phase
}

// ActionItem tracks a specific task during incident response.
type ActionItem struct {
	ID          string
	Description string
	Assignee    string
	Status      string // "pending", "in_progress", "done"
	CreatedAt   time.Time
	CompletedAt time.Time
}

// IncidentManager coordinates incident response.
type IncidentManager struct {
	mu        sync.RWMutex
	incidents map[string]*Incident
	notifier  IncidentNotifier
	logger    *slog.Logger
}

// IncidentNotifier sends alerts through appropriate channels.
type IncidentNotifier interface {
	NotifyIncidentDeclared(ctx context.Context, inc *Incident) error
	NotifyPhaseChange(ctx context.Context, inc *Incident, oldPhase, newPhase Phase) error
	NotifySeverityChange(ctx context.Context, inc *Incident, oldSev, newSev Severity) error
	NotifyResolved(ctx context.Context, inc *Incident) error
}

// NewIncidentManager creates a new incident manager.
func NewIncidentManager(notifier IncidentNotifier, logger *slog.Logger) *IncidentManager {
	return &IncidentManager{
		incidents: make(map[string]*Incident),
		notifier:  notifier,
		logger:    logger,
	}
}

// Declare creates a new incident and begins the response process.
func (m *IncidentManager) Declare(ctx context.Context, id, title, commander string, sev Severity) (*Incident, error) {
	now := time.Now()

	inc := &Incident{
		ID:         id,
		Title:      title,
		Severity:   sev,
		Phase:      PhaseDetection,
		Commander:  commander,
		DetectedAt: now,
		timeline: []TimelineEntry{
			{
				Timestamp:   now,
				Author:      commander,
				Description: fmt.Sprintf("Incident declared: %s (Severity: %s)", title, sev),
				Phase:       PhaseDetection,
			},
		},
	}

	m.mu.Lock()
	m.incidents[id] = inc
	m.mu.Unlock()

	m.logger.Error("incident declared",
		"id", id, "title", title, "severity", sev.String(), "commander", commander)

	if err := m.notifier.NotifyIncidentDeclared(ctx, inc); err != nil {
		m.logger.Warn("failed to send incident notification", "error", err)
	}

	return inc, nil
}

// AdvancePhase moves the incident to the next phase.
func (m *IncidentManager) AdvancePhase(ctx context.Context, incidentID string, newPhase Phase, note string) error {
	m.mu.RLock()
	inc, ok := m.incidents[incidentID]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("incident %s not found", incidentID)
	}

	inc.mu.Lock()
	oldPhase := inc.Phase
	inc.Phase = newPhase

	now := time.Now()
	switch newPhase {
	case PhaseTriage:
		inc.TriagedAt = now
	case PhaseMitigation:
		inc.MitigatedAt = now
	case PhaseResolution:
		inc.ResolvedAt = now
	}

	inc.timeline = append(inc.timeline, TimelineEntry{
		Timestamp:   now,
		Description: fmt.Sprintf("Phase: %s → %s. %s", oldPhase, newPhase, note),
		Phase:       newPhase,
	})
	inc.mu.Unlock()

	m.logger.Info("incident phase changed",
		"id", incidentID, "old_phase", oldPhase.String(), "new_phase", newPhase.String())

	if newPhase == PhaseResolution {
		return m.notifier.NotifyResolved(ctx, inc)
	}
	return m.notifier.NotifyPhaseChange(ctx, inc, oldPhase, newPhase)
}

// AddTimelineEntry adds a note to the incident timeline.
func (m *IncidentManager) AddTimelineEntry(incidentID, author, description string) error {
	m.mu.RLock()
	inc, ok := m.incidents[incidentID]
	m.mu.RUnlock()
	if !ok {
		return fmt.Errorf("incident %s not found", incidentID)
	}

	inc.mu.Lock()
	inc.timeline = append(inc.timeline, TimelineEntry{
		Timestamp:   time.Now(),
		Author:      author,
		Description: description,
		Phase:       inc.Phase,
	})
	inc.mu.Unlock()
	return nil
}

// GetTimeline returns the full incident timeline.
func (m *IncidentManager) GetTimeline(incidentID string) ([]TimelineEntry, error) {
	m.mu.RLock()
	inc, ok := m.incidents[incidentID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("incident %s not found", incidentID)
	}

	inc.mu.RLock()
	defer inc.mu.RUnlock()
	result := make([]TimelineEntry, len(inc.timeline))
	copy(result, inc.timeline)
	return result, nil
}
```

### The Incident Response Checklist

Based on every incident in this chapter, here is the complete checklist:

**Detection (Time to Detect - TTD):**
1. Automated monitoring detects anomaly
2. Alert fires through independent channels (not just Slack/email - those might be down)
3. On-call engineer acknowledges within SLA

**Triage (Time to Triage - TTT):**
1. Incident commander assigned
2. Severity determined
3. Communication channel established (if primary is down, use fallback)
4. Initial blast radius assessed

**Mitigation (Time to Mitigate - TTM):**
1. Immediate action to reduce user impact (not root cause - that comes later)
2. Rollback if possible (was a recent change the trigger?)
3. Traffic rerouting if regional failure
4. Circuit breakers engaged to prevent cascading
5. Customer communication issued

**Resolution (Time to Resolve - TTR):**
1. Root cause identified
2. Fix deployed through proper canary process (no shortcuts during incidents!)
3. Monitoring confirms recovery
4. All replicas/regions verified healthy

**Post-Incident:**
1. Blameless post-mortem within 48 hours
2. Timeline reconstructed
3. Root cause(s) documented
4. Action items assigned with deadlines
5. Follow-up items tracked to completion

### Junior → FAANG: Incident Response as an Interview Signal

"Tell me about a time you handled a production incident" is a near-universal FAANG behavioral question. The incident response checklist in this section is your answer structure: TTD (how it was detected), TTT (how severity was assessed), TTM (what you did to reduce impact immediately), TTR (how root cause was found and fixed), and post-incident (what you changed to prevent recurrence). Candidates who can describe an incident with this structure demonstrate production operations experience. Candidates who say "I fixed the bug" are describing one step in a five-step process.

### Senior @ FAANG: Incident Process as a Platform Capability

At L6, the incident response process is a platform tool, not an ad-hoc practice. The `IncidentManager` in this section is the kind of system that a platform team builds and maintains: it tracks severity, phase transitions, timeline, and action items in a structured way that produces a post-mortem automatically. At scale (dozens of incidents per month), an ad-hoc process produces inconsistent post-mortems that cannot be aggregated to identify systemic issues. A structured process produces comparable data that can be queried: which services have the most incidents, which root causes recur, which action items are never completed.

Bar-raiser interviewers at FAANG ask "how do you ensure post-mortem action items are completed?" The L5 answer is "we track them in Jira." The L6 answer is "we have a weekly review of open action items from post-mortems, with a quarterly report to engineering leadership showing the completion rate and the systemic themes. Incomplete action items from P1 incidents block the team's next roadmap allocation."

---
