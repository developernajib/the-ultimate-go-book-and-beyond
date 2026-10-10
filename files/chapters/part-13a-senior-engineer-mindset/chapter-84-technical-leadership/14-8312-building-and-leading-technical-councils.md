## 84.13 Building and Leading Technical Councils

### Establishing an Architecture Review Board

An Architecture Review Board (ARB) is a group of senior engineers who meet regularly to review and approve major technical decisions across the organization. Without an ARB, teams make isolated decisions that can lead to incompatible architectures, duplicated solutions, and missed opportunities for shared infrastructure. The board is not meant to be a bottleneck or a gatekeeping body, its purpose is to share knowledge, ensure consistency, and make binding decisions on cross-cutting concerns that no single team should own alone.

```
┌──────────────────────────────────────────────────────────────────┐
│              ARCHITECTURE REVIEW BOARD STRUCTURE                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  PURPOSE:                                                        │
│  - Ensure architectural consistency across teams                 │
│  - Share knowledge and patterns                                  │
│  - Prevent duplicate solutions to similar problems               │
│  - Make binding decisions on cross-cutting concerns              │
│                                                                  │
│  COMPOSITION:                                                    │
│  ┌──────────────────────────────────────────────────────┐        │
│  │  Chair: Principal Engineer (rotating yearly)         │        │
│  │  Members:                                            │        │
│  │  - 1 Staff+ Engineer per major team/domain           │        │
│  │  - Platform team representative                      │        │
│  │  - SRE representative                                │        │
│  │  - Security representative                           │        │
│  │  Optional: Engineering Manager observer              │        │
│  └──────────────────────────────────────────────────────┘        │
│                                                                  │
│  MEETING CADENCE:                                                │
│  - Weekly 1-hour review sessions                                 │
│  - Monthly 2-hour strategy discussions                           │
│  - Quarterly all-hands architecture presentations                │
│                                                                  │
│  DECISION AUTHORITY:                                             │
│  - Standard choices (databases, frameworks, languages)           │
│  - Cross-team interfaces and contracts                           │
│  - Major architectural changes                                   │
│  - Technology introductions                                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Running Effective Architecture Reviews

A well-run architecture review produces a clear decision, not just a discussion. The key is structure: the presenter gets a fixed amount of time, reviewers come prepared with written questions, and the chair manages time strictly. The Go code below models the review process as types, making the criteria and outcomes explicit. A common mistake is turning reviews into free-form debates, the criteria and outcome types below prevent that by forcing a structured evaluation and a definitive decision.

```go
// Architecture Review Process - Documented as Code

package archreview

import "time"

// ReviewCriteria defines what we evaluate in architecture reviews
type ReviewCriteria struct {
    // Technical Merit
    SolvesProblem        bool   // Does it actually solve the stated problem?
    Scalability          string // How does it scale? What are limits?
    Reliability          string // Failure modes and recovery?
    Security             string // Threat model and mitigations?

    // Organizational Fit
    TeamCapability       bool   // Can the team build and maintain this?
    ExistingPatterns     bool   // Does it follow or diverge from patterns?
    ReusePotential       bool   // Can other teams benefit?

    // Operational Readiness
    Observability        bool   // Can we monitor and debug it?
    DeploymentPlan       bool   // How do we roll it out safely?
    RollbackPlan         bool   // How do we undo if things go wrong?
}

// ReviewOutcome represents the board's decision
type ReviewOutcome string

const (
    Approved         ReviewOutcome = "approved"          // Go ahead
    ApprovedWithItems ReviewOutcome = "approved_with_items" // Approved but must address items
    NeedsWork        ReviewOutcome = "needs_work"        // Significant changes needed
    Rejected         ReviewOutcome = "rejected"          // Fundamental concerns
)

// ReviewSession represents a single review
type ReviewSession struct {
    RFC          string        // Link to RFC document
    Presenter    string        // Who is presenting
    Reviewers    []string      // Board members present
    Duration     time.Duration // Typically 30-60 minutes

    // Process
    PresentationTime  time.Duration // Max 15 minutes
    QuestionTime      time.Duration // 15-30 minutes
    DiscussionTime    time.Duration // 10-15 minutes

    // Outcome
    Decision         ReviewOutcome
    ActionItems      []string
    FollowUpDate     time.Time
}

// BestPractices for running reviews
var ReviewBestPractices = []string{
    "Distribute RFC at least 3 days before review",
    "Reviewers come prepared with written questions",
    "Focus on architecture decisions, not implementation details",
    "Capture decisions and reasoning in writing",
    "Follow up on action items within 2 weeks",
    "Presenter should not be defensive - reviewers are helpers",
    "Chair manages time strictly",
    "Anyone can raise concerns but board decides",
}
```

### Technology Radar for Go Projects

A technology radar is a living document that categorizes technologies into four rings: Adopt (approved for production), Trial (use in non-critical projects), Assess (explore in spikes), and Hold (do not start new projects with). Maintaining a radar for your Go ecosystem prevents the chaos of every team choosing different libraries for the same purpose. It also provides clear guidance for new team members who would otherwise spend hours researching which logging library or database driver to use. The radar should be reviewed and updated quarterly by the Architecture Review Board.

```
┌──────────────────────────────────────────────────────────────────┐
│                    GO TECHNOLOGY RADAR                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ADOPT (Use freely in production)                                │
│  ├── Go 1.27+ standard library                                   │
│  ├── Protocol Buffers / gRPC                                     │
│  ├── PostgreSQL with pgx driver                                  │
│  ├── Redis with go-redis                                         │
│  ├── OpenTelemetry for observability                             │
│  ├── slog for structured logging                                 │
│  └── testify for test assertions                                 │
│                                                                  │
│  TRIAL (Use in non-critical projects)                            │
│  ├── NATS / NATS JetStream                                       │
│  ├── Temporal for workflows                                      │
│  ├── sqlc for database access                                    │
│  ├── Connect (buf.build) for APIs                                │
│  └── Watermill for event-driven patterns                         │
│                                                                  │
│  ASSESS (Explore in spikes/prototypes)                           │
│  ├── WASM compilation                                            │
│  ├── CockroachDB for global distribution                         │
│  ├── Raft implementations                                        │
│  └── eBPF observability tools                                    │
│                                                                  │
│  HOLD (Don't start new projects with)                            │
│  ├── GOPATH-based projects                                       │
│  ├── dep (use Go modules)                                        │
│  ├── mgo MongoDB driver (use official driver)                    │
│  └── logrus (use slog for new projects)                          │
│                                                                  │
│  Updated: Q1 2026                                                │
│  Owner: Architecture Review Board                                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Understanding Technical Councils Before You Join One

Technical councils, architecture review boards, and engineering steering committees are organizational structures that most engineers encounter but few understand deeply. Before your FAANG interview, research how the company you are targeting structures these bodies. Google uses a formal Engineering Council for major cross-org decisions. Amazon relies on S-Team and VP-level mechanisms. Meta uses a combination of Engineering Directors and named reviewers for significant system changes.

Showing awareness of these structures in an interview signals organizational maturity. A candidate who asks "how does architectural review work here, and what level of decision goes to a review board vs gets made at the team level?" is demonstrating the kind of system-thinking that FAANG values at L5 and above.

### Senior @ FAANG: Designing Technical Councils That Actually Work

Technical councils fail in predictable ways: they become bottlenecks when required too broadly, they lose credibility when their decisions are ignored, and they become theater when members lack the time or context to give real feedback. Staff engineers who design or reform these bodies need to solve all three problems simultaneously.

The governance design principles: define the exact category of decision that requires council review and make that definition narrow enough to be sustainable. Establish a clear timeline contract: if the council cannot respond within X days, the decision-maker can proceed. Require that decisions come to the council with a written proposal, alternatives considered, and a recommendation, not as open-ended questions. Rotate membership to prevent stagnation and distribute the organizational learning across more engineers.

The most effective technical councils at FAANG are those that have clear written scope, predictable response times, and a track record of decisions that were actually better than what the submitter originally proposed. That track record is what makes engineers voluntarily seek council input on decisions that are not technically required to go through review.

---
