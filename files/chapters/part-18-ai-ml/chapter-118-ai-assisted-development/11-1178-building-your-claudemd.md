## 118.8 Building Your CLAUDE.md

### What to Put in CLAUDE.md

CLAUDE.md is your project's constitution for AI assistance. When it is well written, every Claude Code session starts with your project's context already loaded. When it is poorly written, or absent, every session starts from zero and you retype the same corrections forever.

**Structure for a Go microservice CLAUDE.md**:

```markdown
# CLAUDE.md - [Service Name]

## What This Is
[Two or three sentences: what the service does, its data stores, its
 key external integrations. Include the Go and datastore versions.]

## Architecture
[Directory tree with one line on what each directory owns.]

## Patterns We Use
[The conventions a new contributor would otherwise violate.]

## Patterns We Do Not Use
[The highest-value section. Everything here is something the model
 will otherwise reintroduce, because it is common in public Go code.]

## Error Handling
## Security Requirements
## Testing
## Dependencies (pinned)
[Major versions. The model's training data is full of the last one.]

## Commands
[How to build, test, and lint. Be exact: the AI will run these.]
```

The sections that follow work through each of these in turn on a running example.

Three rules keep a CLAUDE.md useful. **Keep it short**, because it is prepended to your context on every session and every token spent restating general Go style is a token not spent on your code. **Write only what is surprising**, since the model already knows Go: it does not know that your money type is `decimal.Decimal` cents. And **grow it from real mistakes**: every time you correct the same thing twice, that correction belongs in the file. A CLAUDE.md written up front from imagination is mostly guesses. One grown from a month of corrections is a record of exactly where this project's reality diverges from the model's priors, which is the only thing it needed to be told.

One thing CLAUDE.md is not: a security control. Writing "never log PII" here makes it less likely the AI logs PII in a first draft. It does not stop PII reaching your logs. Only a redacting logger and a review do that. The "Security Requirements" section below returns to this distinction, because it is the one people get wrong.

### Junior → FAANG: CLAUDE.md as Engineering Communication Practice

Writing a CLAUDE.md for every project you work on is practice for writing system documentation at the architectural level. The skills required are the same: identify the key constraints, articulate the patterns without being verbose, explain what not to do as clearly as what to do, and keep the document current as the project evolves. Engineers who can write a clear CLAUDE.md for a project they know well have the documentation skill needed for FAANG-level technical writing (design documents, ADRs, runbooks). Engineers who cannot write a clear CLAUDE.md for a project they work on every day have a gap in documentation communication that will limit their advancement at L5 and above.

The "project's constitution for AI assistance" framing is accurate and generalizable: a CLAUDE.md is the project's most important piece of living documentation because it encodes the decisions that are not obvious from reading the code. Why raw SQL instead of an ORM? Why chi instead of gin? Why context propagated as the first argument? These decisions are in CLAUDE.md. New engineers who join the team, AI tools being applied to the codebase, and future maintainers all benefit from having these decisions documented in one authoritative place.

For FAANG interview preparation, the CLAUDE.md structure (what the service does, architecture, patterns used, patterns not used, error handling, security, testing, key dependencies) is a design document template. Practice writing this document for any system you have worked on in sufficient depth to describe its architecture. The exercise forces you to articulate decisions you may have made implicitly, which prepares you for the "walk me through the architecture of a system you built" question that appears in every FAANG design interview.

### Senior @ FAANG: CLAUDE.md as Organizational Knowledge Management

At senior level, the CLAUDE.md is one component of a broader organizational knowledge management strategy. The other components are: design documents (pre-implementation architectural decisions), ADRs (technology and pattern decisions), runbooks (operational procedures), and API documentation (interface contracts). CLAUDE.md is unique in that it is optimized for AI consumption rather than human reading, which means it should be more prescriptive and less explanatory than human-facing documentation.

The organizational challenge is keeping CLAUDE.md current as the project evolves. Without a maintenance process, CLAUDE.md drifts from reality: patterns listed as "we use" become outdated, anti-patterns listed as "we do not use" get introduced by engineers who have not read the file, and the dependency list falls behind the actual go.mod. Assign CLAUDE.md maintenance as a periodic task (quarterly review), include CLAUDE.md review in the onboarding checklist for new team members (a new engineer who reads the CLAUDE.md and finds an error is doing valuable maintenance), and add CLAUDE.md to the PR checklist when a code change contradicts something in it.

The template at the end of this section (CLAUDE.md for a Go microservice) should be the organization's starting point for every new service. Distributing the template through the service creation runbook, the internal developer platform, or the organization's code scaffold tool ensures that every new service starts with a populated CLAUDE.md rather than an empty repository. This is a platform engineering contribution that scales the benefits of good CLAUDE.md practice to teams that would not otherwise invest in it.
