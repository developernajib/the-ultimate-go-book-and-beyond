## Section 11: MTTR Reduction and Alert Correlation

Mean Time to Recovery (MTTR) is the average time from incident start to full resolution. Reducing MTTR requires:

1. Faster detection (better alerting thresholds)
2. Faster diagnosis (correlated observability)
3. Faster remediation (automated runbooks)
4. Better communication (structured war rooms)

```go
// file: internal/dr/mttr/tracker.go
package mttr

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// IncidentPhase tracks where in the lifecycle an incident is.
type IncidentPhase string

const (
	PhaseDetection    IncidentPhase = "detection"
	PhaseAcknowledge  IncidentPhase = "acknowledge"
	PhaseDiagnosis    IncidentPhase = "diagnosis"
	PhaseMitigation   IncidentPhase = "mitigation"
	PhaseResolution   IncidentPhase = "resolution"
	PhasePostmortem   IncidentPhase = "postmortem"
)

// Incident represents a production incident.
type Incident struct {
	ID               string
	Title            string
	Severity         int
	AffectedServices []string
	StartedAt        time.Time
	DetectedAt       *time.Time
	AcknowledgedAt   *time.Time
	MitigatedAt      *time.Time
	ResolvedAt       *time.Time
	CurrentPhase     IncidentPhase
	Owner            string
	Timeline         []TimelineEntry
	mu               sync.Mutex
}

// TimelineEntry is a timestamped event in an incident.
type TimelineEntry struct {
	Timestamp time.Time
	Phase     IncidentPhase
	Actor     string
	Note      string
	Automated bool
}

// MTTRMetrics captures timing across incident phases.
type MTTRMetrics struct {
	IncidentID      string
	TimeToDetect    time.Duration
	TimeToAck       time.Duration
	TimeToDiagnose  time.Duration
	TimeToMitigate  time.Duration
	TimeToResolve   time.Duration
	MTTR            time.Duration
}

// Tracker manages incident lifecycle and computes MTTR.
type Tracker struct {
	incidents map[string]*Incident
	mu        sync.RWMutex
	logger    *slog.Logger
}

func NewTracker(logger *slog.Logger) *Tracker {
	return &Tracker{
		incidents: make(map[string]*Incident),
		logger:    logger.With("component", "mttr_tracker"),
	}
}

// Open creates a new incident.
func (t *Tracker) Open(ctx context.Context, id, title string, severity int, services []string) *Incident {
	now := time.Now().UTC()
	inc := &Incident{
		ID:               id,
		Title:            title,
		Severity:         severity,
		AffectedServices: services,
		StartedAt:        now,
		CurrentPhase:     PhaseDetection,
	}
	inc.Timeline = []TimelineEntry{{
		Timestamp: now,
		Phase:     PhaseDetection,
		Note:      "Incident opened",
		Automated: false,
	}}

	t.mu.Lock()
	t.incidents[id] = inc
	t.mu.Unlock()

	t.logger.ErrorContext(ctx, "INCIDENT OPENED",
		"incident_id", id,
		"title", title,
		"severity", severity,
		"services", services,
	)
	return inc
}

// Advance moves an incident to the next phase.
func (t *Tracker) Advance(ctx context.Context, incidentID string, phase IncidentPhase, actor, note string, automated bool) error {
	t.mu.RLock()
	inc, ok := t.incidents[incidentID]
	t.mu.RUnlock()

	if !ok {
		return fmt.Errorf("incident %s not found", incidentID)
	}

	now := time.Now().UTC()
	inc.mu.Lock()
	defer inc.mu.Unlock()

	inc.CurrentPhase = phase
	inc.Timeline = append(inc.Timeline, TimelineEntry{
		Timestamp: now,
		Phase:     phase,
		Actor:     actor,
		Note:      note,
		Automated: automated,
	})

	switch phase {
	case PhaseDetection:
		inc.DetectedAt = &now
	case PhaseAcknowledge:
		inc.AcknowledgedAt = &now
	case PhaseMitigation:
		inc.MitigatedAt = &now
	case PhaseResolution:
		inc.ResolvedAt = &now
	}

	t.logger.InfoContext(ctx, "incident phase advanced",
		"incident_id", incidentID,
		"phase", phase,
		"actor", actor,
		"note", note,
	)
	return nil
}

// ComputeMetrics calculates MTTR components for a resolved incident.
func (t *Tracker) ComputeMetrics(incidentID string) (*MTTRMetrics, error) {
	t.mu.RLock()
	inc, ok := t.incidents[incidentID]
	t.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("incident %s not found", incidentID)
	}

	inc.mu.Lock()
	defer inc.mu.Unlock()

	if inc.ResolvedAt == nil {
		return nil, fmt.Errorf("incident %s is not yet resolved", incidentID)
	}

	m := &MTTRMetrics{IncidentID: incidentID}
	m.MTTR = inc.ResolvedAt.Sub(inc.StartedAt)

	if inc.DetectedAt != nil {
		m.TimeToDetect = inc.DetectedAt.Sub(inc.StartedAt)
	}
	if inc.AcknowledgedAt != nil && inc.DetectedAt != nil {
		m.TimeToAck = inc.AcknowledgedAt.Sub(*inc.DetectedAt)
	}
	if inc.MitigatedAt != nil && inc.AcknowledgedAt != nil {
		m.TimeToMitigate = inc.MitigatedAt.Sub(*inc.AcknowledgedAt)
	}
	if inc.ResolvedAt != nil && inc.MitigatedAt != nil {
		m.TimeToResolve = inc.ResolvedAt.Sub(*inc.MitigatedAt)
	}

	return m, nil
}
```

---

### Junior -> FAANG: MTTR as a Measurable Reliability Goal

MTTR (Mean Time to Recovery) is the average time from incident start to full resolution. Breaking MTTR into phases helps you identify where improvement investments have the highest impact. The phases are: detection time (from incident start to alert firing), triage time (from alert to diagnosis), remediation time (from diagnosis to fix applied), and verification time (from fix applied to confirmed normal). Most teams have the most to gain in triage and detection, not remediation.

For interviews: when asked "how do you reduce incident response time?", the strong answer is structured: "First, I measure MTTR by phase to find where time is lost. If detection is slow, I add more specific alerting. If triage is slow, I add alert correlation and runbook links in alerts. If remediation is slow, I automate the most common remediation steps." Phase-based analysis demonstrates that you approach reliability engineering systematically.

Alert fatigue is the primary enemy of fast detection. If on-call engineers receive 200 alerts per shift and learn to ignore most of them, the 1 real alert is missed or delayed. Reducing alert volume by improving alert quality (fewer, more actionable, correctly correlated alerts) is more impactful than any tooling investment. This is a culture shift that requires buy-in from the whole team.

### Senior @ FAANG: MTTR Reduction as an Engineering Organization Capability

**Alert correlation is a product, not a script.** The alert correlator described in this section groups related alerts into a single incident. In practice, building a correlation engine that is accurate, low-latency, and maintainable across hundreds of alert types is a significant engineering effort. At FAANG, this is a dedicated platform service maintained by the observability team, not a per-service script. As an L6, you consume this platform and contribute correlation rules (which alerts belong together) via a configuration API, rather than building your own correlator.

**MTTR SLA and error budget implications.** MTTR is inversely related to availability: a system that takes 60 minutes to recover from each incident can only have two incidents per month before exceeding the 99.99% availability SLA. This arithmetic connects MTTR to error budgets. If the error budget is being consumed faster than expected, reducing MTTR is an investment that extends the budget, reducing the frequency of feature slowdowns under error budget policies. At L6, you present MTTR improvement proposals in terms of their error budget impact.

**Proactive MTTR measurement and trending.** Most teams measure MTTR reactively (after an incident, the postmortem records how long recovery took). Proactive MTTR measurement runs regular DR tests and measures the recovery time mechanically, building a time series of MTTR values. When MTTR trends upward (recovery takes longer each test), it signals that system complexity is outpacing the team's recovery capability. The trend alert gives the team lead time to invest in runbook improvements, training, or tooling before the next real incident exposes the gap.

**Mean Time to Detection (MTTD) as a separate metric.** MTTR includes MTTD as its first phase. But MTTD deserves its own tracking because it has different improvement levers. MTTD is improved by: adding more specific synthetic monitors (alert within 30 seconds of failure, not after a user reports it), reducing alert evaluation intervals (from 5-minute evaluation windows to 1-minute), and implementing anomaly detection that fires before thresholds are breached. At L7, you invest in MTTD independently of MTTR, setting a target MTTD of under 60 seconds for Tier 0 services.

**Post-incident MTTR analysis and action item generation.** Every incident postmortem should include a phase-by-phase MTTR breakdown: how long was each phase, what caused each delay, and what specific action would have shortened each phase. These action items should feed into the team's backlog with estimated MTTR impact: "adding this alert would have reduced detection time from 8 minutes to 1 minute, saving 7 minutes of MTTR." Quantifying the MTTR impact of reliability investments makes it possible to prioritize them rationally alongside feature work.

