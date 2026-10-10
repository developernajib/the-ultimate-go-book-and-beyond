## Section 10: Game Days

A game day is a structured, company-wide exercise where engineers deliberately cause failures in production (or a production mirror) to test the organization's response - detection, communication, mitigation, and recovery.

```go
// file: internal/dr/gameday/simulator.go
package gameday

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// GameDayScenario defines a specific failure scenario.
type GameDayScenario struct {
	ID          string
	Name        string
	Description string
	Severity    int // 1=SEV1, 2=SEV2, 3=SEV3
	Faults      []FaultSpec
	Duration    time.Duration
	SuccessCriteria []SuccessCriterion
}

// FaultSpec describes a fault and when to inject it.
type FaultSpec struct {
	Name     string
	DelayAfterStart time.Duration
	Injector func(ctx context.Context) error
	Reverter func(ctx context.Context) error
}

// SuccessCriterion is evaluated at the end of a game day scenario.
type SuccessCriterion struct {
	Name      string
	Evaluator func(ctx context.Context, observations []Observation) bool
}

// Observation is an event captured during the game day.
type Observation struct {
	Timestamp  time.Time
	Category   string // "detection", "response", "communication", "resolution"
	Detail     string
	ActorID    string
	Automated  bool
}

// GameDayReport is the final game day deliverable.
type GameDayReport struct {
	ScenarioID    string
	ScenarioName  string
	StartedAt     time.Time
	EndedAt       time.Time
	Participants  []string
	Observations  []Observation
	Metrics       GameDayMetrics
	CriteriaResults map[string]bool
	ActionItems   []string
	Passed        bool
}

// GameDayMetrics captures timing data.
type GameDayMetrics struct {
	TimeToDetect   time.Duration // from fault injection to first alert
	TimeToRespond  time.Duration // from alert to first human action
	TimeToMitigate time.Duration // from first action to user impact resolved
	TimeToResolve  time.Duration // from fault injection to full resolution
	MTTR           time.Duration // = TimeToResolve for single incident
}

// GameDaySimulator orchestrates a game day exercise.
type GameDaySimulator struct {
	logger       *slog.Logger
	observations []Observation
	mu           sync.Mutex
}

func NewGameDaySimulator(logger *slog.Logger) *GameDaySimulator {
	return &GameDaySimulator{
		logger: logger.With("component", "gameday_simulator"),
	}
}

// RecordObservation adds a timestamped observation during the exercise.
func (s *GameDaySimulator) RecordObservation(category, detail, actorID string, automated bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.observations = append(s.observations, Observation{
		Timestamp: time.Now().UTC(),
		Category:  category,
		Detail:    detail,
		ActorID:   actorID,
		Automated: automated,
	})
	s.logger.Info("game day observation",
		"category", category,
		"detail", detail,
		"actor", actorID,
		"automated", automated,
	)
}

// Run executes a game day scenario.
func (s *GameDaySimulator) Run(ctx context.Context, scenario GameDayScenario, participants []string) (*GameDayReport, error) {
	s.mu.Lock()
	s.observations = nil
	s.mu.Unlock()

	s.logger.InfoContext(ctx, "GAME DAY STARTING",
		"scenario", scenario.Name,
		"severity", scenario.Severity,
		"participants", participants,
		"duration", scenario.Duration,
	)

	report := &GameDayReport{
		ScenarioID:      scenario.ID,
		ScenarioName:    scenario.Name,
		StartedAt:       time.Now().UTC(),
		Participants:    participants,
		CriteriaResults: make(map[string]bool),
	}

	scenarioCtx, cancel := context.WithTimeout(ctx, scenario.Duration)
	defer cancel()

	// Inject faults on their scheduled delays.
	var wg sync.WaitGroup
	injectedFaults := make([]*FaultSpec, 0, len(scenario.Faults))
	for i := range scenario.Faults {
		fault := &scenario.Faults[i]
		wg.Add(1)
		go func(f *FaultSpec) {
			defer wg.Done()
			select {
			case <-time.After(f.DelayAfterStart):
			case <-scenarioCtx.Done():
				return
			}

			s.logger.WarnContext(scenarioCtx, "FAULT INJECTED",
				"fault", f.Name,
				"scenario", scenario.Name,
			)
			s.RecordObservation("fault_injection", fmt.Sprintf("Injected: %s", f.Name), "simulator", true)

			if err := f.Injector(scenarioCtx); err != nil {
				s.logger.ErrorContext(scenarioCtx, "fault injection error",
					"fault", f.Name,
					"error", err,
				)
			} else {
				s.mu.Lock()
				injectedFaults = append(injectedFaults, f)
				s.mu.Unlock()
			}
		}(fault)
	}

	// Wait for scenario duration.
	select {
	case <-scenarioCtx.Done():
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	wg.Wait()

	// Revert all injected faults.
	revertCtx, revertCancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer revertCancel()

	s.mu.Lock()
	toRevert := make([]*FaultSpec, len(injectedFaults))
	copy(toRevert, injectedFaults)
	s.mu.Unlock()

	for _, f := range toRevert {
		if f.Reverter != nil {
			if err := f.Reverter(revertCtx); err != nil {
				s.logger.ErrorContext(revertCtx, "fault revert error",
					"fault", f.Name,
					"error", err,
				)
			} else {
				s.logger.InfoContext(revertCtx, "fault reverted", "fault", f.Name)
			}
		}
	}

	report.EndedAt = time.Now().UTC()

	s.mu.Lock()
	report.Observations = make([]Observation, len(s.observations))
	copy(report.Observations, s.observations)
	s.mu.Unlock()

	// Evaluate success criteria.
	allPassed := true
	for _, criterion := range scenario.SuccessCriteria {
		passed := criterion.Evaluator(ctx, report.Observations)
		report.CriteriaResults[criterion.Name] = passed
		if !passed {
			allPassed = false
			s.logger.WarnContext(ctx, "success criterion failed", "criterion", criterion.Name)
		}
	}
	report.Passed = allPassed

	s.logger.InfoContext(ctx, "GAME DAY COMPLETE",
		"scenario", scenario.Name,
		"passed", report.Passed,
		"observations", len(report.Observations),
		"duration", report.EndedAt.Sub(report.StartedAt),
	)

	return report, nil
}
```

---

### Junior -> FAANG: GameDays as Organizational Learning Events

A GameDay is not just a technical test. It is an organizational learning event. The most valuable outcome of a GameDay is not a passed RTO measurement. It is the discoveries made along the way: the runbook step that took 5 minutes longer than expected because the tool was missing from the on-call engineer's laptop, the escalation path that was outdated because the team lead changed, the monitoring dashboard that did not show the right metric during the failure.

For your first GameDay as a junior engineer, your role is observer and note-taker, not decision-maker. Take notes on every anomaly: things that took longer than expected, tools that were confusing, information that was hard to find. These notes feed the post-GameDay retrospective and are the raw material for runbook improvements.

After your first GameDay, identify one specific improvement you can make (update an outdated escalation contact, add a metric to a dashboard, automate one manual step) and complete it before the next GameDay. This is how GameDays compound into lasting reliability improvements.

### Senior @ FAANG: GameDay Program Design and Organizational Impact

**GameDays as a cultural investment, not just a technical exercise.** At FAANG, the most important outcome of a GameDay is not the RTO measurement. It is the shared understanding across engineering, SRE, and product leadership of how the system actually behaves under failure conditions. A GameDay where senior leadership observes the incident response process builds organizational trust in the reliability team and reveals gaps in cross-team coordination that cannot be discovered any other way. At L6, you invite stakeholders intentionally and brief them before and after.

**Hypothesis selection for maximum learning.** Not all GameDay scenarios are equally informative. A GameDay that tests the same failure mode every quarter teaches the same lesson repeatedly without discovering new gaps. A mature GameDay program rotates through a catalog of scenarios, testing each failure mode on a multi-year rotation and prioritizing scenarios based on two factors: likelihood of occurring in production and uncertainty about the system's behavior under that failure. The highest-priority GameDay scenarios are those where the team is most uncertain about what would happen.

**Post-GameDay action item tracking.** A GameDay generates a list of issues: runbook gaps, missing monitoring, configuration errors, documentation inconsistencies. Without a structured tracking system, these issues are discussed in the postmortem and then forgotten. A production GameDay program creates tracked issues for each finding, assigns owners, and reviews completion before the next GameDay. The ratio of "issues found" to "issues resolved before next GameDay" is a program health metric.

**Scaling GameDays across teams.** A single team running quarterly GameDays is a local practice. An organization where every team runs GameDays on a coordinated schedule, shares learnings across teams, and maintains a cross-team failure mode catalog is a reliability culture. At L7, you design the cross-team GameDay coordination: shared hypothesis templates, shared result reporting format, quarterly cross-team learnings review, and organizational-level failure mode analysis that identifies systemic weaknesses spanning multiple services.

**Measuring organizational readiness, not just technical RTO.** A GameDay that achieves RTO within the SLA but required heroic effort from the most senior engineer on the team has exposed a skills gap. A production-ready DR posture means any on-call engineer can execute the recovery procedure successfully, not just the expert who designed it. At L6, you measure "what is the skill level of the engineer who executed the recovery?" in addition to "did we meet RTO?" A recovery that required L6 intervention to complete within RTO is a gap that must be addressed by improving runbook clarity and training, not by ensuring an L6 is always on-call.

