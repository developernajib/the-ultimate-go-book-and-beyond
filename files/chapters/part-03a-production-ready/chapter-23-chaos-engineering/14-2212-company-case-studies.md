## 23.12 Company Case Studies

The major technology companies that practice chaos engineering have each developed a distinct approach shaped by their scale, architecture, and failure modes. Netflix pioneered the field with their Simian Army, Google tests disaster recovery at company-wide scale, Uber focuses on critical business path resilience, and Amazon originated the GameDay exercise. Studying these approaches helps you pick the right strategy for your organization's maturity level.

A caution before the examples. Almost everything published about these programs is a conference talk or a blog post, which means it describes the program at its best on the day it was presented, and often the aspirational version rather than the running one. The code sketches below are illustrative models of each philosophy, not reconstructions of internal source. Where a specific claim is checkable, this section states it and where it came from. Where it is not, the section says so rather than inventing a plausible detail.

### Netflix: Chaos Monkey and the Simian Army

Netflix's Simian Army is a collection of chaos tools at escalating severity, from instance termination (Chaos Monkey) through availability zone failure (Chaos Gorilla) to full region kill (Chaos Kong). Latency Monkey injects delay into service calls. The architecture models each tool as a `Monkey` interface with `ShouldRun` and `Execute` methods, letting a central scheduler invoke them independently.

The dates are worth knowing because the field is younger than it feels. Netflix described Chaos Monkey publicly in December 2010 and open-sourced it in 2012. Chaos Monkey 2.0, released in 2016, is written in Go and integrates with Spinnaker, which is a pleasant fact for readers of this book: the canonical chaos tool is a Go program.

```go
// A model of the Simian Army's structure, not Netflix's source.
type SimianArmy struct {
    monkeys []Monkey
    logger  *slog.Logger
}

type Monkey interface {
    Name() string
    ShouldRun(now time.Time) bool
    Execute(ctx context.Context) error
}

// ChaosMonkey terminates random instances.
type ChaosMonkey struct {
    instanceSelector InstanceSelector
    killProbability  float64
    window           BusinessHours
}

func (m *ChaosMonkey) Name() string { return "Chaos Monkey" }

// ShouldRun gates on the clock before it gates on the dice. Netflix ran
// Chaos Monkey only during business hours, on purpose: the point is not to
// find out whether an instance can die, it is to find out whether the
// engineers who own it notice and respond. A monkey that kills instances at
// 3am is not running an experiment, it is generating a pager alert.
func (m *ChaosMonkey) ShouldRun(now time.Time) bool {
    if !m.window.Contains(now) {
        return false
    }
    return rand.Float64() < m.killProbability
}

func (m *ChaosMonkey) Execute(ctx context.Context) error {
    instances := m.instanceSelector.SelectRandom(1)
    for _, inst := range instances {
        if err := inst.Terminate(ctx); err != nil {
            return err
        }
    }
    return nil
}

// LatencyMonkey injects latency - ChaosGorilla fails an availability zone - // ChaosKong fails a region. Each would implement Monkey the same way.
```

Note what `Monkey` deliberately lacks: a `Cleanup`. You cannot un-terminate an instance. That is not an oversight in the model, it is the defining property of this family of faults, and it changes the safety design completely. Where the framework in 23.5 relies on removing the fault when the hypothesis breaks, Chaos Monkey relies on the fault being survivable by construction: one instance, inside a business-hours window, in a system whose autoscaler will replace it. When your abort switch cannot undo the damage, the blast radius has to be small enough that you never need it to.

**Key learnings from Netflix:**
- Start with instance termination, graduate to region failures
- Always have a "big red button" to stop experiments
- Run during business hours with engineers on call
- Use feature flags to gradually roll out chaos
- Measure everything before, during, and after

The five principles Netflix engineers formalised are worth quoting under their real name. They are the **Principles of Chaos Engineering**, published at principlesofchaos.org and developed by the Netflix chaos team alongside the O'Reilly report *Chaos Engineering* (Basiri, Rosenthal, and colleagues):

1. Build a hypothesis around steady-state behavior
2. Vary real-world events
3. Run experiments in production
4. Automate experiments to run continuously
5. Minimize blast radius

Principle 3 is the one most often quoted and least often understood. "Run in production" is a conclusion, not a starting point, and it presupposes every piece of machinery in principles 1 and 5: a measurable steady state, an automatic abort, and a bounded radius. Netflix earned production chaos over years of building those. A team that adopts principle 3 first, without the rest, has not adopted chaos engineering. It has scheduled an outage.

### Google: DiRT (Disaster Recovery Testing)

Google's DiRT exercises simulate large-scale disasters, including datacenter power failures, multi-region network partitions, authentication service outages, and DNS failures. DiRT is an **annual**, company-wide, multi-day event, not a quarterly one, and it has run since roughly 2006. Kripa Krishnan led the program for about a decade and documented it in the ACM Queue article "Weathering the Unexpected" and the USENIX LISA15 talk "10 Years of Crashing Google". Those two sources are the ones to read, and they are more candid about what went wrong than most vendor material on the subject.

The distinguishing feature of DiRT is scope. It tests recovery *procedures* and the humans running them, not only systems. Exercises have included asking whether payroll would still run, whether staff could physically get into buildings, and whether the on-call engineer with the critical knowledge could be reached, which are the failure modes that a purely technical chaos tool cannot reach at all.

```go
// A model of DiRT's structure.
type DiRTExercise struct {
    Name         string
    Scope        string // team, org, company
    Duration     time.Duration
    Scenarios    []DisasterScenario
    Participants []string
    Observers    []string
}

type DisasterScenario struct {
    Name        string
    Description string
    Inject      func(ctx context.Context) error
    Verify      func(ctx context.Context) []Finding
}

type Finding struct {
    Severity    string // critical, high, medium, low
    Description string
    ActionItem  string
    Owner       string
}

// Key Google practices:
// 1. Run the company-wide exercise annually, with smaller ones in between
// 2. Involve the entire organization, not only engineering
// 3. Test recovery procedures and people, not just systems
// 4. Document all findings
// 5. Follow up on action items, which is where the value actually is
```

### Uber: Critical-Path Chaos Testing

Uber targets the services on its most important business paths, ride matching, payments, and driver dispatch, with scenarios that specify an expected recovery time. If a service does not recover within its budget, the scenario fails and produces an action item.

Uber's publicly named tools are **uDestroy**, used for infrastructure-level chaos, and **uHavoc**, a service-level fault injection platform with production-safe controls. Those are the names to look for in Uber's engineering blog. Details of their internal APIs are not public, so the sketch below models the *shape* of a critical-path test rather than either tool's real interface.

```go
// A model of critical-path chaos testing, in the spirit of uHavoc.
type CriticalPathTest struct {
    Scenario     string
    Services     []string
    FaultType    string
    Duration     time.Duration
    RecoveryTime time.Duration // Budget: how fast the path must come back.
}

func CriticalPathSuite() []CriticalPathTest {
    return []CriticalPathTest{
        {
            Scenario:     "Payment service degradation",
            Services:     []string{"payment-service", "wallet-service"},
            FaultType:    "latency",
            Duration:     5 * time.Minute,
            RecoveryTime: 30 * time.Second,
        },
        {
            Scenario:     "Ride matching partition",
            Services:     []string{"matching-service"},
            FaultType:    "network-partition",
            Duration:     2 * time.Minute,
            RecoveryTime: 10 * time.Second,
        },
    }
}

// Key practices on this model:
// 1. Focus on critical path services (ride booking, payments)
// 2. Test during low-traffic periods initially
// 3. Use shadow testing before production
// 4. Measure business metrics, not just technical ones
// 5. Automate regression testing for known issues
```

The transferable idea is `RecoveryTime`. Most chaos tests ask "did it survive". This one asks "how fast did it come back, and was that fast enough", which is a far harder question and the one your users are actually asking. A service that recovers in nine minutes and a service that recovers in nine seconds both pass a survival test, and only one of them is a business you would want to run.

### Amazon: GameDay

Amazon created **GameDay** in the early 2000s. Jesse Robbins, whose internal title was "Master of Disaster", architected it, drawing explicitly on his training as a firefighter: the discipline of rehearsing incident response until it is muscle memory. He described it in the ACM Queue article "Resilience Engineering: Learning to Embrace Failure" and the LISA11 talk "GameDay: Creating Resiliency Through Destruction". GameDay predates Chaos Monkey by most of a decade and is the direct ancestor of the whole practice.

Two things commonly get conflated here, and it is worth separating them because they suggest very different exercises.

Amazon's original internal GameDay was a round-the-clock exercise of roughly 72 to 96 hours, in which teams knew a window was coming but not what would break or when, and were expected to respond as if each disruption were real. It was not scored. The goal was rehearsal under genuine stress.

The gamified format, with teams, points, difficulty ratings, time limits, and a live scoreboard, is the shape of **AWS GameDay**, the public event run at re:Invent and similar venues, typically over a few hours. It is an excellent teaching format and it is not what Robbins built.

Both are useful. Pick deliberately. The competitive version is better at engaging people who have never done this before and at surfacing runbook gaps quickly. The original is better at answering whether your organisation can actually withstand a bad night, because a bad night does not stop after four hours and does not award points.

```go
// A model of the gamified (AWS-style) GameDay format.
type GameDay struct {
    Theme      string // e.g., "Peak traffic preparation"
    Teams      []Team
    Scenarios  []GameDayScenario
    Duration   time.Duration
    Scoreboard *Scoreboard
}

type Team struct {
    Name     string
    Members  []string
    Services []string
    OnCall   string
}

type GameDayScenario struct {
    Name        string
    Description string
    Difficulty  int // 1-5
    Points      int
    TimeLimit   time.Duration
    Inject      func(ctx context.Context) error
    // Success must query something real. A stub that returns true awards
    // full points to every team for doing nothing, forever.
    Success func(ctx context.Context) (bool, error)
}

// GameDay rules:
// 1. Teams compete to resolve incidents fastest
// 2. Unknown scenarios keep teams on their toes
// 3. Real consequences, with a rollback ready
// 4. Post-game review and scoring
// 5. Identify runbook gaps, which is the actual deliverable
```

### Staff Lens: Case Studies Show Maturity Path

Netflix, Amazon, and Google have mature chaos programs. Your org is probably at an earlier stage. Map your maturity to these examples: crawl, walk, run. Do not skip stages. Each builds the discipline needed for the next.

The specific way teams skip stages is by copying the artifact instead of the practice. Chaos Monkey is a few hundred lines of Go and you could write something like it this afternoon. What took Netflix years was the part that is not in the repository: the regional failover that works, the autoscaler that replaces the instance, the dashboards that show the effect within seconds, and the organisational agreement that a killed instance in the middle of a Tuesday is normal rather than an incident. Build the thing that makes the monkey survivable, and the monkey itself is a weekend.

---
