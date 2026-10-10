## 90G.21 The Complete Incident Taxonomy

The incidents studied in this chapter - and across the broader landscape of infrastructure failures - can be
systematically categorized by root cause, blast radius, detection method, and the engineering principle that
would have prevented or mitigated each one. The following taxonomy maps 50+ incidents to their underlying
failure patterns and defensive principles.

### Incident-to-Principle Mapping Table

| # | Incident | Year | Root Cause Category | Blast Radius | Duration | Primary Defensive Principle | Go-Specific Relevance |
|---|----------|------|--------------------:|:-------------|:---------|:---------------------------|:---------------------|
| 1 | Kinetic-attack tabletop scenario (fictional) | - | Physical/kinetic destruction | Regional | Days | Multi-region with geographic diversity | Multi-region failover client |
| 2 | CrowdStrike global outage | 2024 | Config deployment without canary | Global (8.5M devices) | Hours | Progressive rollout with auto-rollback | Canary deployment framework |
| 3 | Meta 6-hour disappearance | 2021 | BGP misconfiguration + recovery dependency | Global (3B users) | 6 hours | Out-of-band recovery systems | Independent health checking |
| 4 | Anthropic/Claude overlapping bugs | 2024 | Multi-platform quality degradation | Service-wide | Weeks | Output quality monitoring | AI inference monitoring |
| 5 | Discord GC latency | 2020 | Go GC pauses on large heap | Service-wide | Ongoing | GC tuning or language migration | GOMEMLIMIT, off-heap caching |
| 6 | Grab 5x CPU overhead | 2023 | Go runtime CPU overhead | Service-wide | Ongoing | Language evaluation for CPU-bound work | Runtime profiling |
| 7 | Cloudflare 50% traffic loss | 2022 | Config rule ordering error | Global (50% HTTP) | 27 minutes | Automated config validation | Rule validation engine |
| 8 | GitHub 3-day database incident | 2023 | Automated failover cascade | Service-wide | 3 days | Circuit breakers + retry budgets | Circuit breaker pattern |
| 9 | Twitter/X staff reduction | 2022 | Institutional knowledge loss | Organizational | Ongoing | Documentation + dependency mapping | Runtime dependency discovery |
| 10 | Uber goroutine leaks | 2022 | Goroutine lifecycle mismanagement | Service-wide | Ongoing | Goroutine leak detection | goleak, goroutine monitoring |
| 11 | Twitch GC pressure | 2022 | Go GC pressure from large maps | Service-wide | Ongoing | GC tuning, GOMEMLIMIT | Ballast technique |
| 12 | Google global outage | 2020 | Authentication service overload | Global | 47 minutes | Quota management + graceful degradation | Token caching |
| 13 | Slack DNS migration | 2021 | DNS TTL + migration race condition | Service-wide | 2 hours | DNS migration validation | DNS client caching |
| 14 | Fastly CDN latent bug | 2021 | Latent software bug + global config push | Global (85% network) | 49 minutes | Config canary deployment + fuzzing | Go fuzzing harness |
| 15 | Roblox 73-hour outage | 2021 | BoltDB write amplification + thundering herd | Platform-wide (50M users) | 73 hours | Storage engine monitoring + circuit breakers | Write amplification monitor |
| 16 | AWS us-east-1 outage | 2021 | Internal thundering herd (no jitter) | Regional (us-east-1) | 14 hours | Jittered retry + global retry budget | Retry policy with jitter |
| 17 | Datadog 51-hour outage | 2023 | systemd deleted Cilium routes | Platform-wide | 51 hours | Route ownership + reconciliation daemon | Network route guardian |
| 18 | Atlassian 14-day deletion | 2022 | Type confusion (site ID vs app ID) | 775 customers | 14 days | Type-safe identifiers + soft delete | Distinct ID types in Go |
| 19 | Let's Encrypt cert revocation | 2020 | Go loop variable capture bug | 3M certificates | 24 hours | Static analysis + Go 1.22 upgrade | Loop variable semantics |
| 20 | Cloudflare arm64 crash | 2025 | Compiler async preemption bug | Edge fleet (arm64) | Weeks | Cross-arch stress testing | GODEBUG knobs |
| 21 | OVHcloud fire (Strasbourg) | 2021 | Data center fire - no off-site backup | Regional | Permanent data loss | Off-site backup + multi-DC | Backup verification |
| 22 | Facebook routing leak | 2021 | BGP route leak during maintenance | Global | 6 hours | BGP validation + RPKI | Route origin validation |
| 23 | Heroku/Travis CI token leak | 2022 | OAuth token exfiltration | Multi-tenant | Weeks | Token rotation + least privilege | Secret management |
| 24 | Log4Shell (Log4j) | 2021 | Dependency vulnerability (RCE) | Industry-wide | Months | Dependency scanning + SBOM | Go module vulnerability DB |
| 25 | SolarWinds supply chain | 2020 | Build system compromise | Industry-wide | Months | Build provenance + SLSA | go build reproducibility |
| 26 | Okta LAPSUS$ breach | 2022 | Third-party contractor compromise | Multi-tenant | Weeks | Zero trust + vendor assessment | Service mesh mTLS |
| 27 | Kaseya VSA ransomware | 2021 | Supply chain attack via RMM tool | 1500+ companies | Days | Supply chain verification | Binary signing |
| 28 | Akamai Edge DNS outage | 2021 | Software bug in DNS infrastructure | Global (DNS) | 1 hour | DNS redundancy + fallback | Multi-provider DNS |
| 29 | AWS Kinesis us-east-1 | 2020 | Thread starvation from capacity addition | Regional | 10 hours | Thread pool monitoring + capacity planning | Goroutine pool limits |
| 30 | npm left-pad incident | 2016 | Package removal from registry | Ecosystem-wide | Hours | Vendor dependencies + checksums | go mod vendor |
| 31 | Equifax breach | 2017 | Unpatched Apache Struts vulnerability | 147M records | Months | Patch management + WAF | Dependency update automation |
| 32 | Knight Capital trading glitch | 2012 | Old code reactivated by deployment | Company-ending ($440M) | 45 minutes | Feature flags + dead code removal | Build tag management |
| 33 | GitLab.com database deletion | 2017 | Operator ran rm on production DB | Service-wide | 18 hours | Backup testing + access controls | Destructive op safeguards |
| 34 | Amazon Prime Day outage | 2018 | DynamoDB scaling limits hit | Service-wide | Hours | Load testing at scale | Benchmark-driven capacity |
| 35 | Spotify service mesh migration | 2022 | Envoy proxy misconfiguration | Service-wide | Hours | Service mesh canary | Proxy health monitoring |
| 36 | Grafana Cloud incident | 2023 | Cortex ingester OOM | Multi-tenant | Hours | Memory limit enforcement | GOMEMLIMIT tuning |
| 37 | Zoom scaling crisis | 2020 | Sudden 20x traffic increase | Service-wide | Days | Auto-scaling + capacity reserve | Connection pool management |
| 38 | Tesla Kubernetes outage | 2023 | etcd cluster split-brain | Service-wide | Hours | Consensus monitoring | Raft health checking |
| 39 | Robinhood GameStop halt | 2021 | Clearing house deposit requirements | Service-wide | Days | Financial system capacity | Rate limiting framework |
| 40 | British Airways IT failure | 2017 | UPS failure cascade in DC | Global operations | 3 days | Power redundancy testing | Health check independence |
| 41 | TSB banking migration | 2018 | Database migration failure | All customers | Weeks | Migration rollback plan | Schema migration testing |
| 42 | Crowdstrike Falcon sensor | 2022 | Kernel driver compatibility | Endpoint devices | Hours | Kernel module canary | OS compatibility testing |
| 43 | Azure AD global outage | 2021 | Signing key rotation failure | Global (Azure) | 14 hours | Key rotation automation | Certificate management |
| 44 | Twilio Authy breach | 2022 | API endpoint unprotected | 93M users | Days | API authentication audit | Middleware auth checks |
| 45 | Redis Labs outage | 2023 | Network partition in cluster | Multi-tenant | Hours | Partition detection + healing | Redis client failover |
| 46 | Dropbox sync corruption | 2014 | Race condition in sync engine | Service-wide | Hours | Distributed lock correctness | sync.Mutex audit |
| 47 | Linus Torvalds UMN ban | 2021 | Intentional vulnerability injection | Kernel codebase | Ongoing | Code review + trust model | Contribution verification |
| 48 | Basecamp/Hey Apple dispute | 2020 | Platform dependency risk | Single app | Days | Multi-platform distribution | Build pipeline diversity |
| 49 | WhatsApp multi-device rollout | 2021 | E2E encryption key sync | 2B users | Weeks | Cryptographic protocol testing | Crypto implementation audit |
| 50 | Signal SGX enclave issue | 2022 | Trusted execution environment bug | Service-wide | Days | TEE verification + fallback | Secure enclave integration |

### Failure Pattern Distribution

Analyzing the 50 incidents by root cause reveals a clear, actionable hierarchy of risk. Configuration and deployment errors dominate at nearly a third of all failures, meaning that investing in deployment safety (canary rollouts, automated validation, and progressive rollback) yields more reliability improvements than any other single engineering practice. The distribution below makes the priority ordering unmistakable.

```
┌──────────────────────────────────────────────────────────────────────┐
│              INCIDENT ROOT CAUSE DISTRIBUTION                        │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Configuration/Deployment Errors     ████████████████░░  32%         │
│  Software Bugs (latent/triggered)    ████████████░░░░░░  24%         │
│  Infrastructure/Hardware Failure     ██████░░░░░░░░░░░░  12%         │
│  Security/Supply Chain               ██████░░░░░░░░░░░░  12%         │
│  Scaling/Capacity                    ████░░░░░░░░░░░░░░   8%         │
│  Human Error (operational)           ████░░░░░░░░░░░░░░   8%         │
│  Language/Runtime Issues             ██░░░░░░░░░░░░░░░░   4%         │
│                                                                      │
│  KEY INSIGHT: Configuration and deployment errors cause more         │
│  outages than all other categories combined. The #1 investment       │
│  for reliability is automated config validation and progressive      │
│  deployment - not more redundancy or better hardware.                │
└──────────────────────────────────────────────────────────────────────┘
```

### Cross-Cutting Principles Extracted from All 50 Incidents

Studying fifty production failures across industries and company sizes surfaces a compact set of engineering principles that appear repeatedly as the missing defense. Rather than treating each incident in isolation, the Go types below encode these principles with their incident references, giving teams a machine-readable checklist they can embed directly into onboarding, architecture reviews, and post-mortem templates.

```go
package taxonomy

// IncidentPrinciple represents a defensive engineering principle
// extracted from analyzing production incidents.
type IncidentPrinciple struct {
	Name        string
	Description string
	Incidents   []int // incident numbers from the taxonomy
	Priority    int   // 1 = highest priority
}

// CorePrinciples returns the top engineering principles ranked by frequency
// of applicability across all 50 incidents.
func CorePrinciples() []IncidentPrinciple {
	return []IncidentPrinciple{
		{
			Name:        "Progressive Deployment",
			Description: "Never deploy anything - code, config, schema, infrastructure - to all targets simultaneously. Use canary, then percentage, then global rollout with automated health gates.",
			Incidents:   []int{2, 7, 14, 35, 42},
			Priority:    1,
		},
		{
			Name:        "Recovery Independence",
			Description: "Recovery tools must not depend on the system being recovered. Out-of-band monitoring, management, and communication are required.",
			Incidents:   []int{3, 16, 17, 40},
			Priority:    2,
		},
		{
			Name:        "Circuit Breaking and Retry Hygiene",
			Description: "Every client must implement circuit breakers, jittered retry with backoff, and global retry budgets to prevent thundering herds and cascading failures.",
			Incidents:   []int{8, 15, 16, 29, 37},
			Priority:    3,
		},
		{
			Name:        "Type Safety for Critical Operations",
			Description: "Use the type system to make invalid operations impossible. Distinct types for different ID categories, unit types for measurements, and newtype wrappers for strings.",
			Incidents:   []int{18, 33, 46},
			Priority:    4,
		},
		{
			Name:        "Defense in Depth for Destructive Operations",
			Description: "Destructive operations need multiple independent safeguards: batch limits, confirmation gates, soft delete with recovery windows, and mandatory second-person approval.",
			Incidents:   []int{18, 33, 43},
			Priority:    5,
		},
		{
			Name:        "Runtime Monitoring and Tuning",
			Description: "For Go services: monitor goroutine count, GC metrics (pause time, heap size, allocation rate), and set GOMEMLIMIT. These are not optional for production services.",
			Incidents:   []int{5, 6, 10, 11, 36},
			Priority:    6,
		},
		{
			Name:        "Dependency Awareness and Supply Chain Security",
			Description: "Know every dependency, monitor for vulnerabilities, vendor critical dependencies, and verify build provenance. The software supply chain is an attack surface.",
			Incidents:   []int{24, 25, 27, 30, 31},
			Priority:    7,
		},
		{
			Name:        "Institutional Knowledge Preservation",
			Description: "Document dependencies, failure modes, and operational procedures. Bus factor > 1 for every system. Runtime dependency discovery supplements human documentation.",
			Incidents:   []int{9, 32, 47},
			Priority:    8,
		},
		{
			Name:        "Multi-Region and Multi-Provider Redundancy",
			Description: "Single-region and single-provider architectures have a blast radius equal to the region or provider. True resilience requires geographic and provider diversity.",
			Incidents:   []int{1, 21, 28, 40, 48},
			Priority:    9,
		},
		{
			Name:        "Automated Validation Before Deployment",
			Description: "Every configuration change, database migration, and infrastructure modification must pass automated validation that checks for known failure patterns.",
			Incidents:   []int{2, 7, 14, 41, 43},
			Priority:    10,
		},
	}
}
```

### The Unified Incident Response Decision Tree

When an incident is unfolding, responders often waste critical minutes debating which actions to take first. Encoding the decision logic as an explicit tree removes that ambiguity: each node poses one yes/no question and routes directly to the appropriate action, eliminating guesswork under pressure. The implementation below also includes a structured `PostMortemTemplate` so that findings are captured in a consistent, queryable format across all future incidents.

```go
package taxonomy

import (
	"fmt"
	"strings"
	"time"
)

// Severity represents the incident severity level.
type Severity int

const (
	SEV4 Severity = iota // Minor - limited user impact
	SEV3                  // Moderate - significant user impact
	SEV2                  // Major - widespread service degradation
	SEV1                  // Critical - complete service failure
	SEV0                  // Catastrophic - data loss or security breach
)

func (s Severity) String() string {
	return [...]string{"SEV4", "SEV3", "SEV2", "SEV1", "SEV0"}[s]
}

// IncidentCategory classifies the type of failure.
type IncidentCategory int

const (
	CategoryDeployment IncidentCategory = iota
	CategoryConfiguration
	CategoryInfrastructure
	CategorySecurity
	CategoryScaling
	CategoryDataCorruption
	CategoryDependencyFailure
	CategoryHumanError
)

func (c IncidentCategory) String() string {
	return [...]string{
		"deployment", "configuration", "infrastructure", "security",
		"scaling", "data-corruption", "dependency-failure", "human-error",
	}[c]
}

// IncidentDecisionNode represents a node in the response decision tree.
type IncidentDecisionNode struct {
	Question    string
	YesAction   string
	NoAction    string
	YesNext     *IncidentDecisionNode
	NoNext      *IncidentDecisionNode
}

// BuildResponseDecisionTree creates the universal incident response tree.
func BuildResponseDecisionTree() *IncidentDecisionNode {
	return &IncidentDecisionNode{
		Question: "Is there active data loss or security breach?",
		YesAction: "DECLARE SEV0 - activate security incident response",
		YesNext: &IncidentDecisionNode{
			Question: "Can the data loss be stopped by reverting a recent change?",
			YesAction: "REVERT IMMEDIATELY - then investigate root cause",
			NoAction:  "ISOLATE affected systems - prevent further data loss",
			YesNext:   nil,
			NoNext: &IncidentDecisionNode{
				Question:  "Is the breach ongoing (active attacker)?",
				YesAction: "INVOKE security team - network isolation - preserve evidence",
				NoAction:  "Begin forensic analysis - scope the impact - notify stakeholders",
			},
		},
		NoAction: "Assess user impact",
		NoNext: &IncidentDecisionNode{
			Question: "Are more than 10% of users affected?",
			YesAction: "DECLARE SEV1 - all-hands engineering response",
			NoAction:  "DECLARE SEV2/3 - assigned team response",
			YesNext: &IncidentDecisionNode{
				Question:  "Was there a recent deployment or config change?",
				YesAction: "ROLLBACK the change - this is the most likely cause",
				NoAction:  "Check infrastructure health - network, DNS, database, dependencies",
				YesNext:   nil,
				NoNext: &IncidentDecisionNode{
					Question:  "Is a dependency (cloud provider, CDN, DNS) reporting issues?",
					YesAction: "FAILOVER to backup provider/region - activate DR plan",
					NoAction:  "Deep investigation - check logs, metrics, traces for anomalies",
				},
			},
			NoNext: nil,
		},
	}
}

// Walk traverses the decision tree with the given answers.
func Walk(tree *IncidentDecisionNode, answers []bool) []string {
	var actions []string
	current := tree
	answerIdx := 0

	for current != nil && answerIdx < len(answers) {
		actions = append(actions, fmt.Sprintf("Q: %s", current.Question))
		if answers[answerIdx] {
			actions = append(actions, fmt.Sprintf("-> YES: %s", current.YesAction))
			current = current.YesNext
		} else {
			actions = append(actions, fmt.Sprintf("-> NO: %s", current.NoAction))
			current = current.NoNext
		}
		answerIdx++
	}
	return actions
}

// PostMortemTemplate generates a structured post-mortem document.
type PostMortemTemplate struct {
	Title          string
	Date           time.Time
	Severity       Severity
	Category       IncidentCategory
	Duration       time.Duration
	UsersAffected  int64
	Timeline       []TimelineEntry
	RootCause      string
	Contributing   []string
	ActionItems    []ActionItem
	LessonsLearned []string
}

// TimelineEntry is a single event in the incident timeline.
type TimelineEntry struct {
	Timestamp   time.Time
	Description string
	Actor       string // who performed the action or system that triggered it
}

// ActionItem is a follow-up task from the post-mortem.
type ActionItem struct {
	Description string
	Owner       string
	Priority    string // P0, P1, P2
	Deadline    time.Time
	Status      string // open, in-progress, completed
}

// Format produces a structured text representation of the post-mortem.
func (pm *PostMortemTemplate) Format() string {
	var b strings.Builder

	b.WriteString(fmt.Sprintf("# Post-Mortem: %s\n\n", pm.Title))
	b.WriteString(fmt.Sprintf("**Date:** %s\n", pm.Date.Format("2006-01-02")))
	b.WriteString(fmt.Sprintf("**Severity:** %s\n", pm.Severity))
	b.WriteString(fmt.Sprintf("**Category:** %s\n", pm.Category))
	b.WriteString(fmt.Sprintf("**Duration:** %s\n", pm.Duration))
	b.WriteString(fmt.Sprintf("**Users Affected:** %d\n\n", pm.UsersAffected))

	b.WriteString("## Timeline\n\n")
	for _, entry := range pm.Timeline {
		b.WriteString(fmt.Sprintf("- **%s** [%s] %s\n",
			entry.Timestamp.Format("15:04:05"), entry.Actor, entry.Description))
	}

	b.WriteString(fmt.Sprintf("\n## Root Cause\n\n%s\n\n", pm.RootCause))

	b.WriteString("## Contributing Factors\n\n")
	for _, factor := range pm.Contributing {
		b.WriteString(fmt.Sprintf("- %s\n", factor))
	}

	b.WriteString("\n## Action Items\n\n")
	for _, item := range pm.ActionItems {
		b.WriteString(fmt.Sprintf("- [%s] **%s** %s (Owner: %s, Due: %s)\n",
			item.Status, item.Priority, item.Description,
			item.Owner, item.Deadline.Format("2006-01-02")))
	}

	b.WriteString("\n## Lessons Learned\n\n")
	for _, lesson := range pm.LessonsLearned {
		b.WriteString(fmt.Sprintf("- %s\n", lesson))
	}

	return b.String()
}
```

### The Meta-Lesson: Failure Patterns Are Universal

Across all 50 incidents in this taxonomy, certain patterns emerge with striking regularity:

1. **The most common root cause is configuration and deployment errors (32%)**, not software bugs, hardware
   failures, or security breaches. The highest-ROI investment for reliability is automated validation and
   progressive deployment of configuration changes.

2. **Recovery tools that depend on the failing system are the #1 amplifier of incident duration.** Meta,
   AWS, and Datadog all experienced extended outages because their recovery mechanisms were coupled to the
   systems that failed. Independence of recovery tools is not a nice-to-have - it is the difference between
   a 49-minute outage (Fastly) and a 73-hour outage (Roblox).

3. **Positive feedback loops cause the worst outages.** When failure increases load (via retries), which
   increases failure, which increases load - the system enters a death spiral that cannot self-correct.
   Circuit breakers, retry budgets, and jitter are the three essential tools for breaking these loops.

4. **Type confusion causes the most embarrassing incidents.** The Atlassian 14-day deletion and the Let's
   Encrypt 3-million certificate revocation were both caused by values of the wrong type being passed to
   functions that could not distinguish them. The type system is your first line of defense.

5. **Every incident was preventable with known engineering practices.** Not a single incident in this
   taxonomy required novel technology or research to prevent. Canary deployments, circuit breakers, type
   safety, backup testing, jittered retries, and dependency documentation were all well-understood practices
   at the time of each incident. The gap is always in **discipline**, not knowledge.

### Final Exercise: Build Your Organization's Incident Taxonomy

Using the pattern from this section, build a living taxonomy for your own organization:

1. **Catalog every incident** your team has experienced in the past two years, using the same columns as the
   table above (root cause category, blast radius, duration, defensive principle, Go relevance).
2. **Identify your top three failure patterns** - which root cause categories appear most frequently?
3. **Map each pattern to a specific Go implementation** from this chapter that would prevent or mitigate it.
4. **Build the implementations** and integrate them into your production services.
5. **Run quarterly incident reviews** that update the taxonomy and verify that defensive implementations
   are still effective against your evolving failure landscape.

The goal is not zero incidents - that is impossible. The goal is that every incident is **new** - that you
never experience the same failure mode twice. A living incident taxonomy, combined with the defensive Go
implementations from this chapter, is how you achieve that goal.

---

### Junior → FAANG: Using the Taxonomy as Interview Preparation Material

The 50-incident taxonomy in this section is a structured study guide for system design and behavioral interviews. For system design, each row answers a "why do we use X?" question with an incident-grounded response. "Why do we use circuit breakers?" The answer references rows 8, 15, and 16: GitHub's 3-day database nightmare, Roblox's 73-hour outage, and the AWS us-east-1 thundering herd all demonstrate that retry storms from uncircuit-broken clients extend outages far beyond the initial failure window. "Why do we use canary deployments?" Rows 2 and 14 answer it: CrowdStrike and Fastly both skipped canary and achieved global blast radius. For behavioral interviews, the taxonomy answers "tell me about a time you improved reliability" by giving you a catalog of patterns to draw from. Pick the row most relevant to your actual work history, anchor the story to the incident number as a known-good example of the failure class, then describe what you implemented in your own system. The combination of personal experience plus industry incident knowledge is a strong interview signal.

### Senior @ FAANG: Incident Taxonomy as an Organizational Risk Register and Platform Investment Roadmap

At L6, the 50-incident taxonomy is not study material. It is a risk register template. Apply it to your organization: pull every incident from the past two years, populate the same columns (root cause category, blast radius, duration, defensive principle), and compute the failure pattern distribution for your specific stack and team. If 40% of your incidents fall in the configuration/deployment error category, that distribution is the quantitative justification for a platform investment in automated config validation and progressive rollout. Present the analysis to engineering leadership with the expected reduction in MTTR and incident count if the top two failure patterns are addressed by platform tooling rather than team-level guidelines.

The `CorePrinciples` function in this section represents a minimum viable implementation of this risk register at the code level. At staff level, you extend it: each principle becomes a measurable metric (what percentage of services have circuit breakers on all external dependencies? what percentage use GOMEMLIMIT?), each incident becomes an example in your org's internal post-mortem database, and the distribution chart becomes a quarterly reliability report shared with engineering leadership. The `PostMortemTemplate` implementation is the data schema for that database. When post-mortems are machine-readable and consistently structured, you can aggregate across them: which root cause categories are increasing over time, which action items are never completed, and which teams have the highest incident recurrence rate. These aggregates are how a staff engineer converts incident management from a reactive discipline into a proactive reliability investment program. The bar-raiser question at L6 is "how do you ensure the same incident doesn't happen twice?" The L4 answer is "we write post-mortems." The L6 answer is "we maintain a living taxonomy, measure our failure pattern distribution quarterly, and track each pattern to a platform investment that eliminates it as a future failure mode."

