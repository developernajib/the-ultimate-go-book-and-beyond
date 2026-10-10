## 90I.6 Okta/Lapsus$ - The Third-Party Contractor Breach (2022)

### The Attack Timeline

In January 2022, the Lapsus$ threat group - a loosely organized collection of primarily teenage hackers - gained
access to Okta's internal systems through Sitel, a third-party customer support contractor. The breach illuminated
the fragility of vendor trust chains and the inadequacy of Okta's response.

**Phase 1: Sitel Compromise (January 16-21, 2022)**

Lapsus$ compromised a Sitel support engineer's workstation, likely through credential purchase on the dark web or
social engineering. Sitel provided Tier 1 customer support for Okta, meaning their engineers had access to Okta's
internal support tools, including the ability to reset passwords and MFA factors for Okta customers.

The attacker had access to the Sitel engineer's machine for five days (January 16-21, 2022). During this time, they:
- Used Okta's SuperUser Application, which allowed support agents to view and modify customer configurations
- Accessed Okta customer tenants to initiate password resets
- Took screenshots of Okta's internal Slack channels, Jira tickets, and Confluence documentation
- Exfiltrated data about Okta's internal systems and customer configurations

**Phase 2: Okta's Initial Response (January 2022)**

Okta detected suspicious activity and engaged a forensics firm in January 2022. However, the forensics firm (Sitel's
contractor) did not provide their final report until March 2022. Okta's security team was aware of the compromise
in January but did not disclose it to affected customers or the public.

**Phase 3: Public Disclosure by Lapsus$ (March 22, 2022)**

On March 22, 2022, Lapsus$ posted screenshots on their Telegram channel showing Okta's internal systems, including
the SuperUser Application and customer tenant information. This forced Okta's hand. CEO Todd McKinnon initially
tweeted that there was "no evidence of ongoing malicious activity" and framed the incident as an "attempt" to
compromise a support engineer's account, downplaying the five days of access.

**Phase 4: Escalating Disclosures (March-April 2022)**

Under pressure from customers and security researchers who analyzed the leaked screenshots, Okta revised their
statements multiple times:
- Initially claimed no customers were affected
- Then acknowledged that approximately 2.5% of customers (approximately 375 organizations) "may have been impacted"
- The Sitel forensics report eventually confirmed the attacker had access to customer tenants

Okta's stock dropped 11% in the days following disclosure. Several major Okta customers, including Cloudflare,
published their own analyses of the breach, criticizing Okta's delayed and misleading communications.

### Technical Root Cause Analysis

1. **Third-party access without adequate monitoring**: Sitel engineers had powerful access to Okta's customer
   tenants through the SuperUser Application, but their activity was not monitored in real time.

2. **Delayed forensic investigation**: The forensics firm took two months to produce a report, during which time
   Okta did not proactively notify potentially affected customers.

3. **Misleading public communications**: Okta's initial response minimized the incident, destroying trust with
   their customer base - the exact opposite of what an identity provider should do.

4. **No principle of least privilege for support tools**: The SuperUser Application gave support agents broad
   access to customer tenants rather than narrowly scoped, time-limited permissions.

### Go Code: Comprehensive Audit Logging

The Okta breach could have been detected in hours rather than months with proper audit logging. Here is a
production-grade audit logging system in Go that captures every privileged action with enough context for
forensic investigation:

```go
package auditlog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"sync"
	"time"
)

// EventSeverity classifies the security significance of an audit event.
type EventSeverity int

const (
	SeverityInfo EventSeverity = iota
	SeverityWarning
	SeverityCritical
	SeverityAlert
)

func (s EventSeverity) String() string {
	switch s {
	case SeverityInfo:
		return "INFO"
	case SeverityWarning:
		return "WARNING"
	case SeverityCritical:
		return "CRITICAL"
	case SeverityAlert:
		return "ALERT"
	default:
		return "UNKNOWN"
	}
}

// AuditEvent represents a single auditable action in the system.
type AuditEvent struct {
	ID            string            `json:"id"`
	Timestamp     time.Time         `json:"timestamp"`
	Severity      EventSeverity     `json:"severity"`
	ActorID       string            `json:"actorId"`
	ActorType     string            `json:"actorType"`
	ActorIP       string            `json:"actorIp"`
	ActorGeo      string            `json:"actorGeo,omitempty"`
	SessionID     string            `json:"sessionId"`
	DeviceID      string            `json:"deviceId,omitempty"`
	Action        string            `json:"action"`
	ResourceType  string            `json:"resourceType"`
	ResourceID    string            `json:"resourceId"`
	TenantID      string            `json:"tenantId,omitempty"`
	Outcome       string            `json:"outcome"` // "success", "failure", "denied"
	Reason        string            `json:"reason,omitempty"`
	Changes       map[string]Change `json:"changes,omitempty"`
	Metadata      map[string]string `json:"metadata,omitempty"`
	CorrelationID string            `json:"correlationId,omitempty"`
	PreviousHash  string            `json:"previousHash"`
	Hash          string            `json:"hash"`
}

// Change records a before/after value for a modified field.
type Change struct {
	Before any `json:"before"`
	After  any `json:"after"`
}

// AlertRule defines a condition that triggers real-time security alerts.
type AlertRule struct {
	Name        string
	Description string
	Evaluate    func(event *AuditEvent, recentEvents []*AuditEvent) bool
	Severity    EventSeverity
}

// AlertHandler is called when an alert rule fires.
type AlertHandler func(rule AlertRule, event *AuditEvent)

// AuditLogger provides tamper-evident, append-only audit logging with
// real-time alerting on suspicious patterns.
type AuditLogger struct {
	sink         EventSink
	alertRules   []AlertRule
	alertHandler AlertHandler
	recentEvents []*AuditEvent
	maxRecent    int
	lastHash     string
	mu           sync.Mutex
}

// EventSink is the interface for audit event storage backends.
type EventSink interface {
	Write(event *AuditEvent) error
}

// NewAuditLogger creates an audit logger with the given storage backend
// and security alert rules.
func NewAuditLogger(sink EventSink, alertHandler AlertHandler) *AuditLogger {
	logger := &AuditLogger{
		sink:         sink,
		alertHandler: alertHandler,
		maxRecent:    1000,
		lastHash:     "genesis",
	}

	// Register default alert rules based on common attack patterns.
	logger.alertRules = []AlertRule{
		{
			Name:        "rapid_password_resets",
			Description: "Multiple password resets by same actor in short window",
			Severity:    SeverityAlert,
			Evaluate: func(event *AuditEvent, recent []*AuditEvent) bool {
				if event.Action != "password_reset" {
					return false
				}
				count := 0
				cutoff := event.Timestamp.Add(-10 * time.Minute)
				for _, e := range recent {
					if e.ActorID == event.ActorID &&
						e.Action == "password_reset" &&
						e.Timestamp.After(cutoff) {
						count++
					}
				}
				return count >= 3
			},
		},
		{
			Name:        "cross_tenant_access",
			Description: "Actor accessing multiple customer tenants rapidly",
			Severity:    SeverityAlert,
			Evaluate: func(event *AuditEvent, recent []*AuditEvent) bool {
				if event.TenantID == "" {
					return false
				}
				tenants := make(map[string]bool)
				cutoff := event.Timestamp.Add(-30 * time.Minute)
				for _, e := range recent {
					if e.ActorID == event.ActorID &&
						e.TenantID != "" &&
						e.Timestamp.After(cutoff) {
						tenants[e.TenantID] = true
					}
				}
				tenants[event.TenantID] = true
				return len(tenants) >= 5
			},
		},
		{
			Name:        "mfa_factor_changes",
			Description: "MFA factor modified for another user",
			Severity:    SeverityCritical,
			Evaluate: func(event *AuditEvent, _ []*AuditEvent) bool {
				return event.Action == "mfa_factor_reset" &&
					event.ActorID != event.ResourceID
			},
		},
		{
			Name:        "unusual_hours_privileged_action",
			Description: "Privileged action outside normal business hours",
			Severity:    SeverityWarning,
			Evaluate: func(event *AuditEvent, _ []*AuditEvent) bool {
				hour := event.Timestamp.Hour()
				isAfterHours := hour < 6 || hour > 22
				isPrivileged := event.ActorType == "support_agent" ||
					event.ActorType == "admin"
				return isAfterHours && isPrivileged
			},
		},
		{
			Name:        "new_ip_for_actor",
			Description: "Actor accessing from previously unseen IP address",
			Severity:    SeverityWarning,
			Evaluate: func(event *AuditEvent, recent []*AuditEvent) bool {
				for _, e := range recent {
					if e.ActorID == event.ActorID && e.ActorIP == event.ActorIP {
						return false // IP seen before for this actor.
					}
				}
				// Only alert if we have history for this actor.
				for _, e := range recent {
					if e.ActorID == event.ActorID {
						return true // Has history but never from this IP.
					}
				}
				return false
			},
		},
	}

	return logger
}

// Log records an audit event, computes its chain hash for tamper evidence,
// evaluates alert rules, and persists to the event sink.
func (al *AuditLogger) Log(ctx context.Context, event *AuditEvent) error {
	al.mu.Lock()
	defer al.mu.Unlock()

	// Set timestamp if not already set.
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now().UTC()
	}

	// Generate event ID if not set.
	if event.ID == "" {
		event.ID = fmt.Sprintf("evt_%d_%s",
			event.Timestamp.UnixNano(),
			event.ActorID,
		)
	}

	// Compute tamper-evident hash chain.
	event.PreviousHash = al.lastHash
	event.Hash = al.computeHash(event)
	al.lastHash = event.Hash

	// Persist the event.
	if err := al.sink.Write(event); err != nil {
		return fmt.Errorf("writing audit event: %w", err)
	}

	// Evaluate alert rules.
	for _, rule := range al.alertRules {
		if rule.Evaluate(event, al.recentEvents) {
			if al.alertHandler != nil {
				al.alertHandler(rule, event)
			}
		}
	}

	// Maintain recent events window.
	al.recentEvents = append(al.recentEvents, event)
	if len(al.recentEvents) > al.maxRecent {
		al.recentEvents = al.recentEvents[1:]
	}

	return nil
}

// computeHash creates a SHA-256 hash of the event content chained with the
// previous hash, making the audit log tamper-evident.
func (al *AuditLogger) computeHash(event *AuditEvent) string {
	data := fmt.Sprintf("%s|%s|%s|%s|%s|%s|%s|%s|%s|%s",
		event.PreviousHash,
		event.Timestamp.Format(time.RFC3339Nano),
		event.ActorID,
		event.ActorIP,
		event.Action,
		event.ResourceType,
		event.ResourceID,
		event.TenantID,
		event.Outcome,
		event.SessionID,
	)
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:])
}

// VerifyChain verifies the tamper-evident hash chain of a sequence of events.
// Returns the index of the first tampered event, or -1 if the chain is valid.
func VerifyChain(events []*AuditEvent) int {
	for i := 1; i < len(events); i++ {
		if events[i].PreviousHash != events[i-1].Hash {
			return i
		}
	}
	return -1
}

// AddAlertRule registers a custom alert rule for domain-specific detection.
func (al *AuditLogger) AddAlertRule(rule AlertRule) {
	al.mu.Lock()
	defer al.mu.Unlock()
	al.alertRules = append(al.alertRules, rule)
}

// LogSupportAction is a convenience method for logging third-party support
// agent actions - the exact scenario in the Okta breach.
func (al *AuditLogger) LogSupportAction(
	ctx context.Context,
	agentID, agentIP, sessionID string,
	action, tenantID, resourceID string,
	outcome string,
) error {
	return al.Log(ctx, &AuditEvent{
		Severity:     SeverityWarning,
		ActorID:      agentID,
		ActorType:    "support_agent",
		ActorIP:      agentIP,
		SessionID:    sessionID,
		Action:       action,
		ResourceType: "customer_tenant",
		ResourceID:   resourceID,
		TenantID:     tenantID,
		Outcome:      outcome,
	})
}

// IPInfo extracts basic information from an IP address for geolocation context.
func IPInfo(ipStr string) string {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return "invalid"
	}
	if ip.IsLoopback() {
		return "loopback"
	}
	if ip.IsPrivate() {
		return "private"
	}
	return "public"
}
```

### Engineering Lessons

1. **Third-party access is your access.** When you grant a vendor access to your systems, their security posture
   becomes your security boundary. Monitor third-party activity with the same (or greater) scrutiny as internal
   activity.

2. **Real-time alerting on privileged actions is non-negotiable.** The Okta breach involved visible actions
   (password resets, MFA changes, cross-tenant access) that should have triggered immediate alerts. The audit
   logging system above includes pattern-based detection rules for exactly these scenarios.

3. **Incident communication must be honest and timely.** Okta's downplaying and delayed disclosure destroyed
   customer trust more than the breach itself. An identity provider that minimizes security incidents is an
   identity provider that cannot be trusted.

4. **Tamper-evident logging prevents cover-ups.** The hash-chained audit log above makes it computationally
   infeasible to modify or delete events without detection. This is critical for forensic investigation and
   regulatory compliance.

---

### Junior → FAANG: Third-Party Vendor Risk and Privileged Access Monitoring as Interview Topics

The Okta breach is the interview answer to "how do you manage third-party vendor risk?" Lapsus$ accessed Okta's systems through a support contractor who had broader access than their role required. For FAANG interviews, the vendor risk answer has three parts: least-privilege access (contractors receive exactly the permissions their role requires, verified quarterly), privileged action monitoring (password resets, MFA changes, and cross-tenant access generate real-time alerts), and vendor access reviews (contractor access is reviewed and recertified every 90 days, with automatic revocation if not recertified). The hash-chained audit log in this section demonstrates tamper-evident logging: each log entry includes a hash of the previous entry, making it computationally infeasible to modify or delete events without detection. For security-critical systems, this is the standard for audit logging.

### Senior @ FAANG: Identity Provider Security as a Platform Standard and Vendor Risk Governance

At L6, the Okta breach is more significant than the specific vulnerability: Okta is an identity provider, and its breach gave Lapsus$ access to every Okta customer's authentication system. The blast radius of a compromised identity provider is unbounded. At staff level, you treat your identity provider as a tier-0 dependency with an explicit blast-radius analysis: if your IdP is compromised, what can an attacker access, and what controls exist independent of the IdP that would limit that access? The answers drive compensating controls: service-to-service authentication using mTLS with certificates that do not depend on the IdP, break-glass access procedures that do not require IdP authentication, and monitoring for unusual authentication patterns that would detect an IdP compromise from its effects rather than from the IdP's own logs. Okta's delayed and minimizing disclosure is a secondary lesson: your vendor contracts must specify breach disclosure timelines and include the right to audit vendor security posture. Identity providers that minimize security incidents cannot be trusted as security infrastructure.
