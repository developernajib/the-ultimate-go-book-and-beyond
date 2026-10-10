## 90B.8 ADR Patterns for Different Decision Types

A common mistake when adopting ADRs is using one generic template for every kind of decision. In practice, a technology selection (choosing between PostgreSQL and MongoDB) requires a scoring matrix and benchmark data, while a process decision (defining a branching strategy) requires stakeholder sign-off and success metrics. Using the wrong template means you either capture irrelevant information or miss the details that matter most. This section provides four specialized templates and a Go CLI tool that generates the correct one based on the decision type.

Not all architectural decisions have the same shape. A technology selection decision (PostgreSQL vs MySQL) has different stakeholders and evaluation criteria than a process decision (mandatory code review SLA) or a security decision (choosing an encryption scheme). Using a single template for every decision type produces mediocre ADRs.

This section presents specialized templates and a Go-based template generator CLI.

### Technology Selection ADR Template

Technology selection decisions benefit from an explicit scoring matrix. Without one, "we evaluated three options" is vague. With one, the decision is auditable.

```markdown
# ADR-NNNN: [Technology Choice for Component]

## Status
Proposed

## Date
YYYY-MM-DD

## Deciders
- [Name, Role]
- [Name, Role]

## Context and Problem Statement
[What problem are we solving? What are the constraints? What is the scale/load?
What is the consequence of choosing poorly? How reversible is this decision?]

## Decision Drivers
- [Driver 1: e.g., operational complexity must stay low - team has no DBA]
- [Driver 2: e.g., must handle 50k writes/second at P99 < 10ms]
- [Driver 3: e.g., must integrate with existing Kubernetes + Helm stack]
- [Driver 4: e.g., must have active community and corporate support]

## Options Considered
| Option | Description |
|--------|-------------|
| Option A | [Brief description] |
| Option B | [Brief description] |
| Option C | [Brief description] |

## Scoring Matrix
Scale: 1 (poor) to 5 (excellent) per criterion.

| Criterion             | Weight | Option A | Option B | Option C |
|-----------------------|--------|----------|----------|----------|
| [Driver 1]            | 30%    | 4        | 2        | 5        |
| [Driver 2]            | 25%    | 5        | 4        | 3        |
| [Driver 3]            | 20%    | 3        | 5        | 4        |
| [Driver 4]            | 15%    | 5        | 3        | 4        |
| Team familiarity      | 10%    | 4        | 4        | 2        |
| **Weighted Total**    |        | **4.05** | **3.45** | **3.90** |

## Decision
We select **Option A** [Technology Name].

[Two paragraphs explaining the decision narrative. The matrix shows the numbers,
but the narrative explains the judgment calls behind the weights. Why did
Driver 1 get 30% weight? What would change that weighting? Which runner-up
came close and under what circumstances should it be reconsidered?]

## Consequences

### Positive
- [Consequence 1]
- [Consequence 2]

### Negative
- [Consequence 1 - be honest]
- [Consequence 2]

### Risks and Mitigations
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| [Risk 1] | Medium | High | [Mitigation] |

## Links
- [Proof of concept repository](link)
- [Benchmark results](link)
- [Related ADR](link)
```

### Architecture Pattern ADR Template

Pattern decisions - event sourcing, CQRS, saga orchestration - require a different emphasis. The key question is not "which tool" but "which pattern and under which invariants."

```markdown
# ADR-NNNN: [Pattern Name for Domain/Service]

## Status
Proposed

## Date
YYYY-MM-DD

## Context and Problem Statement
[What domain problem makes this pattern a candidate?
What invariants must the system maintain?
What are the consistency requirements?
What is the expected event/transaction volume?]

## Pattern Description
[Brief description of the pattern. Assume the reader is familiar with it but
not with how it applies to this specific domain. Include a diagram if helpful.]

## Why This Pattern Fits
[Map each key characteristic of the pattern to a specific constraint or requirement
from the context section. If a characteristic does not map to a requirement,
note that - it is overhead you are accepting.]

## Boundaries and Invariants
[Where does this pattern apply? Where does it explicitly NOT apply?
What invariants must always hold? What can be eventually consistent?]

## Alternative Patterns Considered
[List 2 to 3 alternatives with the specific reason each was rejected.]

## Decision
[Which pattern, with which constraints, applied to which domain.]

## Implementation Notes
[Key implementation decisions within the pattern, not boilerplate.]

## Consequences
[Standard positive/negative/neutral format. Include operational complexity.]

## Open Questions
[Questions not yet resolved, with owner and due date.]

## Links

The links section anchors the ADR to the broader decision context that prose alone cannot capture. A link to the GitHub issue where the original problem was reported, the benchmark repository used to compare options, or the ADR that this decision supersedes gives future readers a path to primary sources rather than forcing them to trust your summary alone. It also creates a navigable web of related decisions. When an engineer traces why a service uses zerolog, a link to the logging standardization ADR and from there to the observability platform ADR tells the full architectural story.

```

### Process ADR Template

Process decisions - branching strategy, on-call rotation policy, deployment cadence - affect team workflow rather than system architecture. Their consequences are social as much as technical.

```markdown
# ADR-NNNN: [Process Name]

## Status
Proposed

## Date
YYYY-MM-DD

## Deciders
[All team leads and ICs who must follow this process. Process ADRs require
broader sign-off than technical ADRs.]

## Context and Problem Statement
[What pain point does this process address? What incidents or inefficiencies
drove this proposal? What is the cost of the status quo?]

## Scope
[Which teams, services, and environments does this process apply to?
Explicit scope prevents "well, we thought this only applied to backend."]

## Proposed Process
[Step-by-step description. Include: who is responsible, what triggers the process,
what the expected duration is, what the exit criteria are.]

## Exceptions and Escape Hatches
[When is it acceptable to deviate from this process? Who can authorize a deviation?
How is a deviation documented?]

## Success Metrics
[How will we know if this process is working? What metrics will we track?
What is the 90-day review checkpoint?]

## Consequences

### Positive
### Negative (including overhead added to engineers)

## Links

The following resources provide foundational context on Architecture Decision Records: the original lightweight ADR format by Michael Nygard, the GitHub repository that tracks the evolving ADR tooling ecosystem, and the Thoughtworks Technology Radar entry that brought ADRs into mainstream engineering practice.

```

### Security ADR Template

Security decisions require additional review gates. A security ADR that has not been reviewed by a security engineer is insufficient at FAANG-scale.

```markdown
# ADR-NNNN: [Security Decision]

## Status
Proposed - Pending Security Review

## Date
YYYY-MM-DD

## Security Reviewer
[Name of security engineer who must approve before this ADR moves to Accepted]

## Threat Model Summary
[Brief description of what assets are being protected, from whom, and what
attack vectors are in scope. Reference the full threat model document if one exists.]

## Context and Problem Statement
[What security requirement or incident is driving this decision?
What is the blast radius if this decision is wrong?]

## Compliance Requirements
[PCI-DSS, SOC 2, GDPR, HIPAA requirements that constrain the decision space.]

## Options Considered
[Each option must include: attack surface analysis, key management approach
if applicable, and assumptions that must remain true for the option to be secure.]

## Decision
[Chosen option with rationale. Include: what the option does NOT protect against
 -  honest threat modeling acknowledges residual risk.]

## Key Assumptions
[List assumptions that, if violated, would make this decision insecure.
Each assumption should have an owner who is responsible for verifying it.]

## Consequences

### Positive
### Negative (including usability and performance impact)
### Residual Risk

## Security Review Sign-off
- [ ] Threat model reviewed
- [ ] Key management approach reviewed
- [ ] Compliance requirements satisfied
- [ ] Penetration test scope updated

## Links

The tools and references below complement the ADR practices covered in this chapter. The `adr-tools` CLI automates numbering and status transitions for file-based ADR workflows, while the log4brains project adds a web UI for browsing decision history directly from a repository. The Go ADR generator source is included for teams that prefer a type-safe, repository-native alternative to shell scripts.

```

### Go ADR Template Generator CLI

The following CLI generates the correct template based on decision type. It is designed to be added to a repository's `tools/` directory.

```go
// tools/adrnew/main.go
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"text/template"
	"time"
)

type ADRType string

const (
	TypeTechnology ADRType = "technology"
	TypePattern    ADRType = "pattern"
	TypeProcess    ADRType = "process"
	TypeSecurity   ADRType = "security"
	TypeGeneral    ADRType = "general"
)

// ADRData holds template variables.
type ADRData struct {
	Number string
	Title  string
	Date   string
	Type   ADRType
}

var templates = map[ADRType]string{
	TypeTechnology: technologyTemplate,
	TypePattern:    patternTemplate,
	TypeProcess:    processTemplate,
	TypeSecurity:   securityTemplate,
	TypeGeneral:    generalTemplate,
}

func nextADRNumber(dir string) (string, error) {
	entries, err := filepath.Glob(filepath.Join(dir, "[0-9][0-9][0-9][0-9]-*.md"))
	if err != nil {
		return "", err
	}

	maxNum := 0
	numRe := regexp.MustCompile(`^(\d{4})-`)
	for _, e := range entries {
		base := filepath.Base(e)
		if m := numRe.FindStringSubmatch(base); m != nil {
			n, _ := strconv.Atoi(m[1])
			if n > maxNum {
				maxNum = n
			}
		}
	}

	return fmt.Sprintf("%04d", maxNum+1), nil
}

func titleToSlug(title string) string {
	slug := strings.ToLower(title)
	slug = regexp.MustCompile(`[^a-z0-9\s-]`).ReplaceAllString(slug, "")
	slug = regexp.MustCompile(`\s+`).ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	return slug
}

func run() error {
	var (
		adrDir      = flag.String("dir", "docs/adr", "directory containing ADR files")
		adrType     = flag.String("type", "general", "ADR type: technology|pattern|process|security|general")
		adrTitle    = flag.String("title", "", "ADR title (required)")
	)
	flag.Parse()

	if *adrTitle == "" {
		return fmt.Errorf("--title is required")
	}

	t := ADRType(*adrType)
	tmplStr, ok := templates[t]
	if !ok {
		return fmt.Errorf("unknown ADR type %q; valid types: technology, pattern, process, security, general", t)
	}

	if err := os.MkdirAll(*adrDir, 0o755); err != nil {
		return fmt.Errorf("create adr dir: %w", err)
	}

	number, err := nextADRNumber(*adrDir)
	if err != nil {
		return fmt.Errorf("determine next ADR number: %w", err)
	}

	data := ADRData{
		Number: number,
		Title:  *adrTitle,
		Date:   time.Now().Format("2006-01-02"),
		Type:   t,
	}

	slug := titleToSlug(*adrTitle)
	filename := filepath.Join(*adrDir, fmt.Sprintf("%s-%s.md", number, slug))

	tmpl, err := template.New("adr").Parse(tmplStr)
	if err != nil {
		return fmt.Errorf("parse template: %w", err)
	}

	f, err := os.OpenFile(filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("create file: %w", err)
	}
	defer f.Close()

	if err := tmpl.Execute(f, data); err != nil {
		return fmt.Errorf("render template: %w", err)
	}

	fmt.Printf("Created ADR-%s: %s\n", data.Number, filename)
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

const generalTemplate = `# ADR-{{.Number}}: {{.Title}}

## Status
Proposed

## Date
{{.Date}}

## Context and Problem Statement
[Describe the context and problem here.]

## Decision Drivers
- [Driver 1]
- [Driver 2]

## Considered Options
- Option A
- Option B
- Option C

## Decision Outcome
Chosen option: **Option A**, because [justification].

### Positive Consequences
- [Consequence 1]

### Negative Consequences
- [Consequence 1]

## Links
- [Related ADR](link)
`

const technologyTemplate = `# ADR-{{.Number}}: {{.Title}}

## Status
Proposed

## Date
{{.Date}}

## Deciders
- [Name, Role]

## Context and Problem Statement
[What problem are we solving? What are the scale constraints?]

## Decision Drivers
- [Driver 1]
- [Driver 2]
- [Driver 3]

## Scoring Matrix
| Criterion | Weight | Option A | Option B | Option C |
|-----------|--------|----------|----------|----------|
| [Driver 1] | 30% | ? | ? | ? |
| [Driver 2] | 25% | ? | ? | ? |
| [Driver 3] | 25% | ? | ? | ? |
| Team familiarity | 20% | ? | ? | ? |
| **Weighted Total** | | | | |

## Decision
We select **[Option]**.

[Decision narrative - explain the judgment behind the weights.]

## Consequences

### Positive
- [Consequence]

### Negative
- [Consequence]

### Risks and Mitigations
| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| [Risk] | Medium | High | [Mitigation] |

## Links
`

const patternTemplate = `# ADR-{{.Number}}: {{.Title}}

## Status
Proposed

## Date
{{.Date}}

## Context and Problem Statement
[What domain problem makes this pattern a candidate?]

## Pattern Description
[Brief description of the pattern and how it applies here.]

## Why This Pattern Fits
[Map pattern characteristics to specific constraints.]

## Boundaries and Invariants
[Where does this apply? Where does it explicitly NOT apply?]

## Alternative Patterns Considered
- **Pattern B**: rejected because [reason]
- **Pattern C**: rejected because [reason]

## Decision
[Pattern choice, constraints, and domain scope.]

## Implementation Notes
[Key implementation decisions.]

## Consequences

### Positive
### Negative
### Neutral

## Open Questions
- [Question] - Owner: [Name] - Due: [Date]

## Links
`

const processTemplate = `# ADR-{{.Number}}: {{.Title}}

## Status
Proposed

## Date
{{.Date}}

## Deciders
[All team leads and ICs who must follow this process.]

## Context and Problem Statement
[What pain point does this process address?]

## Scope
[Which teams, services, and environments.]

## Proposed Process
1. [Step 1]
2. [Step 2]

## Exceptions and Escape Hatches
[When is deviation acceptable? Who authorizes it?]

## Success Metrics
- [Metric 1]
- 90-day review checkpoint: [Date]

## Consequences

### Positive
### Negative

## Links
`

const securityTemplate = `# ADR-{{.Number}}: {{.Title}}

## Status
Proposed - Pending Security Review

## Date
{{.Date}}

## Security Reviewer
[Name of security engineer - required before Accepted]

## Threat Model Summary
[Assets protected, adversary model, attack vectors in scope.]

## Context and Problem Statement
[What security requirement or incident is driving this?]

## Compliance Requirements
[PCI-DSS / SOC 2 / GDPR / HIPAA constraints.]

## Options Considered
[Each option: attack surface, key management, assumptions.]

## Decision
[Chosen option and honest residual risk statement.]

## Key Assumptions
[Assumptions that, if violated, make this insecure.]

## Consequences

### Positive
### Negative
### Residual Risk

## Security Review Sign-off
- [ ] Threat model reviewed
- [ ] Key management approach reviewed
- [ ] Compliance requirements satisfied
- [ ] Penetration test scope updated

## Links
`
```

Usage:

```bash
# Technology selection decision
go run ./tools/adrnew --type technology --title "Message Queue Selection for Order Service"

# Security decision
go run ./tools/adrnew --type security --title "JWT Signing Algorithm for Auth Service"

# Pattern decision
go run ./tools/adrnew --type pattern --title "Event Sourcing for Inventory Domain"
```

### Junior → FAANG: Matching the ADR Pattern to the Decision Type

The pattern taxonomy in this section solves a real problem: a security ADR and an infrastructure ADR have different audiences, different risk surfaces, and different review requirements. Using a single generic template for all of them produces documents that are missing critical information for some readers and cluttered with irrelevant sections for others.

As a junior engineer, the most important patterns to internalize are the infrastructure and dependency patterns, because those are the decision types you are most likely to be involved in. When your team is evaluating a new library or service, volunteer to write the ADR. The process of filling in the alternatives and consequences sections will force you to do the research that should be done before the decision anyway.

### Senior @ FAANG: Pattern Libraries as Platform Assets

A well-designed pattern library for ADR types is a platform asset that compounds in value as the organization grows. When a new team is evaluating database choices, being able to point them to a database ADR template that pre-populates the relevant evaluation criteria (consistency model, operational overhead, Go driver maturity, licensing, backup and recovery story) reduces their research time and improves the consistency of the resulting document.

At FAANG, platform teams often maintain ADR pattern libraries as part of their developer experience offering. The template is the opinionated starting point that embeds the organization's current best thinking about what questions must be answered for each class of decision. When the organization's thinking evolves, the template is updated, and teams evaluating similar decisions automatically get the benefit of accumulated organizational learning.

Security ADR patterns deserve special attention at the staff level because security decisions have a different failure mode than other decisions: the consequences of a wrong security decision are often not visible until they are catastrophically expensive. A security ADR that lacks an explicit threat model, a clear statement of what attack vectors the chosen approach mitigates, and an honest assessment of residual risk is not providing the governance it appears to provide. Staff engineers who review security ADRs should evaluate the threat model section with the same rigor they would apply to a security design review.

---
