## 105.4 Incident Management

### Incident Response Structure

Incident management processes define how teams detect, declare, communicate, and resolve production outages in a coordinated and documented manner. The following implementation automates the mechanical steps, paging, channel creation, status page updates, so engineers can focus on diagnosis and recovery.

```go
package incident

import (
    "context"
    "fmt"
    "time"
)

type Severity int

const (
    SeverityP4 Severity = iota // Low - minor issues, no user impact
    SeverityP3                 // Medium - degraded service, limited impact
    SeverityP2                 // High - significant impact, partial outage
    SeverityP1                 // Critical - complete outage
)

type Incident struct {
    ID           string
    Title        string
    Description  string
    Severity     Severity
    Status       IncidentStatus
    Commander    string
    StartTime    time.Time
    EndTime      *time.Time
    Timeline     []TimelineEntry
    AffectedServices []string
    CustomerImpact   string
}

type IncidentStatus string

const (
    StatusDetected    IncidentStatus = "detected"
    StatusInvestigate IncidentStatus = "investigating"
    StatusIdentified  IncidentStatus = "identified"
    StatusMonitoring  IncidentStatus = "monitoring"
    StatusResolved    IncidentStatus = "resolved"
)

type TimelineEntry struct {
    Timestamp time.Time
    Action    string
    Author    string
    Details   string
}

type DeclareRequest struct {
    Title            string
    Description      string
    Severity         Severity
    Commander        string
    AffectedServices []string
}

type Notifier interface {
    Notify(ctx context.Context, incident *Incident) error
}

type IncidentStore interface {
    Save(ctx context.Context, incident *Incident) error
    Get(ctx context.Context, id string) (*Incident, error)
}

func generateID() string {
    return fmt.Sprintf("INC-%d", time.Now().UnixNano())
}

// IncidentManager handles incident lifecycle
type IncidentManager struct {
    notifier Notifier
    store    IncidentStore
}

func (m *IncidentManager) notifyStakeholders(ctx context.Context, incident *Incident) {
    if m.notifier != nil {
        _ = m.notifier.Notify(ctx, incident)
    }
}

func (m *IncidentManager) DeclareIncident(ctx context.Context, req DeclareRequest) (*Incident, error) {
    incident := &Incident{
        ID:           generateID(),
        Title:        req.Title,
        Description:  req.Description,
        Severity:     req.Severity,
        Status:       StatusDetected,
        Commander:    req.Commander,
        StartTime:    time.Now(),
        AffectedServices: req.AffectedServices,
    }

    incident.Timeline = append(incident.Timeline, TimelineEntry{
        Timestamp: time.Now(),
        Action:    "Incident declared",
        Author:    req.Commander,
        Details:   req.Description,
    })

    if err := m.store.Save(ctx, incident); err != nil {
        return nil, err
    }

    // Notify based on severity
    m.notifyStakeholders(ctx, incident)

    return incident, nil
}

func (m *IncidentManager) UpdateStatus(ctx context.Context, incidentID string, status IncidentStatus, notes string, author string) error {
    incident, err := m.store.Get(ctx, incidentID)
    if err != nil {
        return err
    }

    incident.Status = status
    incident.Timeline = append(incident.Timeline, TimelineEntry{
        Timestamp: time.Now(),
        Action:    string(status),
        Author:    author,
        Details:   notes,
    })

    if status == StatusResolved {
        now := time.Now()
        incident.EndTime = &now
    }

    return m.store.Save(ctx, incident)
}

// ResponseTimeTargets defines response time expectations by severity
var ResponseTimeTargets = map[Severity]struct {
    Acknowledge time.Duration
    Mitigate    time.Duration
}{
    SeverityP1: {5 * time.Minute, 30 * time.Minute},
    SeverityP2: {15 * time.Minute, 2 * time.Hour},
    SeverityP3: {30 * time.Minute, 4 * time.Hour},
    SeverityP4: {1 * time.Hour, 24 * time.Hour},
}
```

### Junior → FAANG: Incident Response Is a Skill You Practice Before You Need It

The worst time to learn incident response is during an actual incident. The sequence (detect, acknowledge, triage, mitigate, resolve, document) must be so familiar that you execute it without thinking. For a first job, practice by reviewing post-mortems from other companies (Google publishes many, as does Cloudflare and GitLab) and mentally simulating how you would have responded at each stage.

Interview entry point: "Walk me through how you would respond to a P1 incident where your payment service is returning 500 errors." The expected answer covers: acknowledge the alert immediately, check the error rate and start mitigation (rollback if a recent deploy, scale if capacity, route around if an external dependency), communicate status to stakeholders, and open a post-mortem after resolution. The order matters: mitigation before root cause analysis during an active incident.

### Senior @ FAANG: Incident Management as a Platform Responsibility

At L6 and above, incident management is not just about individual response skill. It is about designing the incident management system so that any engineer can respond effectively, not just the most experienced ones.

This means: clear severity definitions that all teams use consistently (so a P1 at one team means the same thing as a P1 at another), incident commander role training so the communication and coordination load is separated from the technical investigation, pre-approved runbooks for the top 10 incident categories that any on-call engineer can execute without escalating, and automatic incident creation from alert manager that pre-populates the severity and the relevant runbook link.

An L6 engineer who has designed or significantly improved an incident management system has a concrete story about reducing MTTR across the organization, which is a strong bar-raiser signal in L7 interviews.

---
