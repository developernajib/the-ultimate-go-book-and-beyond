## Section 12: Blameless Postmortems

A blameless postmortem focuses on systemic improvements, not individual fault. The goal is to understand *how* the system allowed the failure, not *who* made a mistake.

```go
// file: internal/dr/postmortem/model.go
package postmortem

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// ContributingFactor is a systemic cause (not an individual).
type ContributingFactor struct {
	Category    string // "process", "tooling", "architecture", "knowledge", "communication"
	Description string
	WhyItExists string
}

// FiveWhysChain traces root cause through 5 levels of "why".
type FiveWhysChain struct {
	InitialProblem string
	Whys           [5]string
	RootCause      string
}

// ActionItem is a concrete improvement task.
type ActionItem struct {
	ID          string
	Title       string
	Owner       string
	DueDate     time.Time
	Priority    int // 1=critical fix, 2=high, 3=medium
	Category    string
	Completed   bool
}

// Postmortem is the full blameless incident review document.
type Postmortem struct {
	IncidentID          string
	Title               string
	Authors             []string
	ReviewedBy          []string
	IncidentStartedAt   time.Time
	IncidentResolvedAt  time.Time
	DetectionMethod     string // "alert", "customer_report", "engineer_noticed"
	Severity            int
	UserImpact          string
	Timeline            []PostmortemEvent
	ContributingFactors []ContributingFactor
	FiveWhys            *FiveWhysChain
	WhatWentWell        []string
	WhatWentPoorly      []string
	ActionItems         []ActionItem
	MTTR                time.Duration
	PublishedAt         *time.Time
}

// PostmortemEvent is a timestamped narrative entry.
type PostmortemEvent struct {
	Timestamp time.Time
	Event     string
	IsKey     bool // highlight in summary
}

// Generator produces a postmortem from incident data.
type Generator struct {
	logger *slog.Logger
}

func NewGenerator(logger *slog.Logger) *Generator {
	return &Generator{logger: logger.With("component", "postmortem_generator")}
}

// Generate creates a draft postmortem from structured incident data.
func (g *Generator) Generate(ctx context.Context, pm *Postmortem) error {
	if pm.IncidentID == "" {
		return fmt.Errorf("incident ID is required")
	}
	if len(pm.Authors) == 0 {
		return fmt.Errorf("at least one author is required")
	}

	pm.MTTR = pm.IncidentResolvedAt.Sub(pm.IncidentStartedAt)

	g.logger.InfoContext(ctx, "postmortem generated",
		"incident_id", pm.IncidentID,
		"mttr", pm.MTTR,
		"action_items", len(pm.ActionItems),
		"contributing_factors", len(pm.ContributingFactors),
	)

	// Validate action items have owners and due dates.
	for i, ai := range pm.ActionItems {
		if ai.Owner == "" {
			g.logger.WarnContext(ctx, "action item missing owner",
				"item_index", i,
				"title", ai.Title,
			)
		}
		if ai.DueDate.IsZero() {
			g.logger.WarnContext(ctx, "action item missing due date",
				"item_index", i,
				"title", ai.Title,
			)
		}
	}

	return nil
}

// Validate checks postmortem completeness before publication.
func (g *Generator) Validate(pm *Postmortem) []string {
	var warnings []string

	if pm.FiveWhys == nil {
		warnings = append(warnings, "no 5-Whys analysis - root cause may not be identified")
	}
	if len(pm.ContributingFactors) == 0 {
		warnings = append(warnings, "no contributing factors listed")
	}
	if len(pm.ActionItems) == 0 {
		warnings = append(warnings, "no action items - postmortem may not drive improvement")
	}
	if len(pm.WhatWentWell) == 0 {
		warnings = append(warnings, "no 'what went well' section - missing blameless framing")
	}
	for _, ai := range pm.ActionItems {
		if ai.Priority == 1 && ai.DueDate.After(time.Now().Add(7*24*time.Hour)) {
			warnings = append(warnings, fmt.Sprintf(
				"critical action item '%s' due in more than 7 days", ai.Title,
			))
		}
	}

	return warnings
}
```

---

### Junior -> FAANG: Why Blameless Postmortems Produce Better Outcomes

The instinct to find who made the mistake is natural but counterproductive. If engineers fear being blamed for incidents, they take fewer risks, hide mistakes longer before escalating, and build defensive practices that slow down development. Blameless postmortems remove this fear by focusing on systemic causes: what conditions in the system allowed this mistake to have the impact it did?

A simple reframe: instead of "Engineer X made the wrong change that caused the outage," write "the deployment pipeline allowed an untested configuration change to reach production without review." The first sentence identifies a person to blame. The second identifies a system to fix. The second framing always produces a better action item.

For behavioral interviews: when asked about a time you made a mistake that caused a production incident, frame your answer in blameless language. Describe what you did, what the system allowed you to do (absence of validation, missing tests, unclear runbook), and what was changed to make the same mistake harder for the next engineer. This demonstrates both honesty and SRE culture.

### Senior @ FAANG: Postmortem Program Design and Organizational Learning

**Postmortem quality is a leadership responsibility.** The quality of a postmortem depends heavily on who facilitates it. A facilitator who asks leading questions ("why did you decide to deploy without testing?") produces a blame session. A facilitator who asks systemic questions ("what information would have changed the deployment decision?") produces systemic action items. At L6, you are often the facilitator for high-severity postmortems, and your facilitation technique shapes the organizational culture around incident response.

**Action item completion rate as a program health metric.** Postmortems generate action items. If action items are not completed, the postmortem was performative. A mature postmortem program tracks the completion rate of action items by priority tier: P0 items (prevent recurrence of the same incident) must be completed before the next release cycle, P1 items within 30 days, P2 items within 90 days. The completion rate is reviewed at the quarterly reliability review. Teams with low completion rates are not benefiting from their postmortem process regardless of how well-written their postmortems are.

**Postmortem distribution and organizational knowledge sharing.** A postmortem that is only read by the team that wrote it is a missed learning opportunity. High-severity postmortems should be distributed across the engineering organization at a level appropriate to the incident's blast radius: a service-level incident to the department, a platform-level incident to all engineering. FAANG companies maintain searchable postmortem databases where engineers can find historical incidents related to a pattern they are investigating. Building this searchability (tagging, categorization, full-text search) is a platform investment that compounds over years.

**The "corrective actions" field is the most important field.** A postmortem without clear, tracked corrective actions is a diagnostic document, not a reliability improvement. At L6, you review postmortems for action item quality: each action should be specific (what exactly will be built or changed), assigned to a named owner, have a due date, and have a measurable definition of done. Vague action items like "improve monitoring" fail all of these criteria and predictably go uncompleted.

**Postmortem tone and the "five whys" applied correctly.** The five whys technique asks "why" five times to get from symptoms to root causes. Applied without judgment, it surfaces systemic causes. Applied incorrectly, it becomes "why did you do X?" directed at a person, which is blame. At L7, you train your organization in the correct application: each "why" answer should be a system property or condition, not a human decision. "Why was the configuration invalid? Because the schema validation was not enforced in the deployment pipeline." Not "because Alice did not check the schema."

