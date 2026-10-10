## 118D.12 Team Collaboration with AI

### Establishing Team AI Usage Guidelines

As AI tools become ubiquitous, teams need explicit guidelines to maintain code quality and collaboration standards.

```
┌────────────────────────────────────────────────────────────────┐
│             TEAM AI USAGE GUIDELINES (Template)                │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ALLOWED (no review required beyond normal PR process):        │
│  ├── AI-generated test cases                                   │
│  ├── AI-generated documentation (godoc, README updates)        │
│  ├── AI-assisted debugging (using AI to analyze errors)        │
│  ├── AI-generated boilerplate (CRUD handlers, DTOs)            │
│  ├── AI-assisted code review (as pre-screening)                │
│  └── AI for learning and exploration                           │
│                                                                │
│  ALLOWED WITH EXTRA REVIEW:                                    │
│  ├── AI-generated business logic (requires domain expert)      │
│  ├── AI-generated database migrations (requires DBA review)    │
│  ├── AI-generated CI/CD pipelines (requires DevOps review)     │
│  └── AI-generated API contracts (requires team discussion)     │
│                                                                │
│  NEVER:                                                        │
│  ├── Pasting secrets, credentials, customer data, or           │
│  │   production dumps into a prompt (use synthetic fixtures)   │
│  ├── AI-generated security-critical code without security      │
│  │   team review (auth, encryption, access control)            │
│  ├── AI-generated financial calculations without domain        │
│  │   expert verification                                       │
│  ├── Shipping AI output without reading and understanding it   │
│  └── Using AI-generated code without running the test suite    │
│                                                                │
│  CODE OWNERSHIP:                                               │
│  ├── The person who submits the PR owns ALL code in it,        │
│  │   regardless of who (or what) wrote it                      │
│  ├── "AI wrote it" is not a valid defense for bugs             │
│  └── AI-generated code must meet the same quality bar          │
│      as human-written code                                     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Pair Programming with AI (Driver/Navigator Model)

The most effective team pattern for AI collaboration is the **driver/navigator** model:

```
┌──────────────────────────────────────────────────────────────┐
│          AI PAIR PROGRAMMING: DRIVER/NAVIGATOR               │
│                                                              │
│  PATTERN 1: Human Drives, AI Navigates                       │
│  ┌──────────────┐          ┌──────────────┐                  │
│  │    Human     │  asks    │     AI       │                  │
│  │   (driver)   │────────►│  (navigator) │                   │
│  │              │          │              │                  │
│  │ Writes code  │◄────────│ Suggests     │                   │
│  │ Makes final  │ suggests │ patterns,    │                  │
│  │ decisions    │          │ catches bugs │                  │
│  └──────────────┘          └──────────────┘                  │
│  Best for: security-critical code, novel algorithms          │
│                                                              │
│  PATTERN 2: AI Drives, Human Navigates                       │
│  ┌──────────────┐          ┌──────────────┐                  │
│  │    Human     │  reviews │     AI       │                  │
│  │ (navigator)  │◄────────│   (driver)   │                   │
│  │              │          │              │                  │
│  │ Reviews all  │────────►│ Writes code, │                   │
│  │ output,      │ directs  │ generates    │                  │
│  │ sets goals   │          │ tests        │                  │
│  └──────────────┘          └──────────────┘                  │
│  Best for: boilerplate, tests, documentation, CRUD           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Ethical Considerations and Responsible AI Use

Teams using AI tools need an explicit policy that addresses licensing (does the AI reproduce copyrighted training data?), attribution (is AI-generated code disclosed in PR descriptions?), and data handling (are confidential codebases or customer data sent to third-party APIs?). The `AIUsagePolicy` struct below encodes these rules as machine-checkable fields so CI pipelines can enforce them automatically.

```go
// AIUsagePolicy encodes team rules for AI tool usage.
// This is a living document: update it as tools and team norms evolve.
package policy

// UsageCategory defines the level of oversight required for AI-generated code.
type UsageCategory int

const (
	// Standard means AI output is reviewed through the normal PR process.
	Standard UsageCategory = iota

	// ExtraReview means AI output requires an additional domain expert review.
	ExtraReview

	// Prohibited means this type of code must not be AI-generated.
	Prohibited
)

// CategorizeTask determines the oversight level for an AI-assisted task.
//
// Two properties of this function are deliberate and were both wrong in the
// first draft, in the same direction: toward less oversight.
//
// It never returned Prohibited. The constant was declared, the policy table
// above lists things that are never allowed, and no input could produce that
// answer. A policy category that nothing maps to is not a policy, it is a
// comment.
//
// And its default branch returned Standard, so any task type nobody had
// thought of got the *least* oversight. That is backwards. An unrecognised
// task is precisely the one nobody has reasoned about, and "we have not
// classified this yet" must never resolve to "wave it through". Default to
// more scrutiny, not less: the cost of a wrong ExtraReview is a slightly
// slower PR, and the cost of a wrong Standard is an unreviewed change in a
// category you did not know existed.
func CategorizeTask(taskType string, securitySensitive bool, financialImpact bool) UsageCategory {
	// Some categories are off-limits for AI generation entirely, and the
	// function has to be able to say so.
	switch taskType {
	case "crypto_primitive", "auth_protocol":
		return Prohibited
	}

	// Security-sensitive code always requires extra review when AI-generated.
	if securitySensitive {
		return ExtraReview
	}

	// Financial calculations require domain expert verification.
	if financialImpact {
		return ExtraReview
	}

	switch taskType {
	case "test", "documentation", "boilerplate", "refactoring":
		return Standard
	case "business_logic", "migration", "api_contract":
		return ExtraReview
	case "auth", "encryption", "access_control":
		return ExtraReview
	default:
		// Fail closed on anything unrecognised.
		return ExtraReview
	}
}
```

> **What AI Gets Wrong**: AI has no concept of organizational politics or interpersonal dynamics. When you ask it about team processes, it gives textbook answers. Your team's actual AI adoption will depend on trust, culture, and individual comfort levels. Start with low-risk, high-value use cases (test generation, documentation) to build confidence before introducing AI into higher-stakes workflows.

> **Pro Tip**: The biggest resistance to team AI adoption comes from engineers who fear it devalues their skills. Frame AI as a power tool, not a replacement: "A chainsaw doesn't replace a carpenter, it lets them build bigger things." Resist the urge to win the argument with a productivity statistic, though. The published numbers disagree wildly, the most-quoted one comes from the vendor, and a sceptic who looks it up will find the counter-evidence in a minute and trust you less. A concrete before/after on your own team's work, at the same quality bar, is both more persuasive and more honest. And take the strongest version of their objection seriously: an engineer who says "I get slower because reviewing plausible-but-wrong code costs more than writing it" is describing a real, measured effect, not fear.

---

### Junior → FAANG: Team AI Adoption as Leadership Opportunity

The team collaboration section describes a leadership opportunity that junior engineers can seize: becoming the team's AI tool champion. The engineer who researches the best AI tool for Go development, writes the team CLAUDE.md, builds the shared prompt library, and documents the effective workflows is contributing to team productivity in a way that is visible and impactful beyond their individual output. This kind of organizational contribution demonstrates the scope and impact thinking that FAANG promotion committees look for in L4-to-L5 candidates.

The "start with low-risk, high-value use cases" advice is the correct adoption strategy for any new technology in a team setting. Test generation is low-risk (tests are run and validated before merging, so AI test errors are caught before they affect production) and high-value (test writing is tedious, so AI assistance significantly accelerates it). Documentation generation is low-risk (documentation errors are caught by readers, not by production failures) and high-value (documentation is often underprioritized, so AI assistance brings a backlog to current). Starting with these use cases builds confidence and evidence for adoption before introducing AI into higher-stakes workflows like security reviews or architecture decisions.

### Senior @ FAANG: Team AI Adoption as Change Management

At senior level, team AI adoption is a change management challenge, not just a technology adoption challenge. The "organizational politics and interpersonal dynamics" limitation noted in "What AI Gets Wrong" is the insight that distinguishes engineers who understand organizations from those who only understand technology. Engineers who fear AI devalues their skills need concrete evidence that it does not. Showing the before-and-after on a specific task provides that evidence more effectively than explaining it conceptually.

The adoption strategy (low-risk, high-value first, then expand) maps to the diffusion of innovations model: early adopters try new tools independently, early majority adopt once they see concrete benefits, late majority adopt once the tool is team standard, and laggards adopt last or not at all. A change management strategy that provides the early majority with concrete evidence and reduces their adoption friction (shared CLAUDE.md, shared prompts, documented workflows) accelerates the adoption curve across the team. Senior engineers who understand and apply this adoption strategy move faster than those who announce a new tool and expect the team to adopt it voluntarily.
