## 118D.6 AI for Documentation & Technical Writing

### Auto-Generating Godoc Comments

Go's documentation culture emphasizes godoc comments on all exported types and functions. AI generates these well because the pattern is formulaic: describe what the function does, its parameters, return values, and any important behavior (thread safety, nil handling, error conditions).

**Template: Godoc Generation Prompt**

````
Generate godoc comments for all exported types and functions in this
Go file. Follow Go documentation conventions:

1. Start with the name of the thing being documented
2. Use complete sentences
3. Document behavior, not implementation
4. Note thread safety if relevant
5. Document nil/zero-value behavior
6. Document error conditions
7. Use "Deprecated:" prefix for deprecated items

Describe only what the code actually does. If a function's behaviour
is unclear from its body, say so rather than documenting what the name
suggests it should do.

```text
[paste code without comments]
```
````

### Writing Architecture Decision Records (ADRs)

ADRs are among the most impactful documents in a software project, and AI generates excellent first drafts because the structure is standardized.

**Template: ADR Generation Prompt**

```
Generate an Architecture Decision Record (ADR) for the following
decision:

Decision: [what you decided]
Context: [why you needed to make this decision]
Options considered: [list 2-4 alternatives]
Date: [when]
Stakeholders: [who was involved]

Follow the standard ADR format:
- Title
- Status (Proposed/Accepted/Deprecated/Superseded)
- Context (the problem and forces at play)
- Decision (what we decided and why)
- Options Considered (with pros/cons for each)
- Consequences (positive, negative, and risks)
- Implementation Notes (how this affects the codebase)
```

### Go Code: Documentation Generator Tool

The documentation generator follows the same pattern as the other tools in this chapter: parse Go source with `go/ast`, extract the undocumented symbols, and send them to an LLM for godoc generation. The core logic is in `findDocTargets`, which identifies exported symbols missing documentation.

```go
package docgen

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
)

// DocTarget represents a Go symbol that needs documentation.
type DocTarget struct {
	Kind     string `json:"kind"` // "type", "func", "method"
	Name     string `json:"name"`
	Receiver string `json:"receiver,omitempty"`
	Source   string `json:"source"`
	HasDoc   bool   `json:"has_doc"`
}

// FindDocTargets scans a Go source file and returns exported symbols
// that are missing godoc comments.
func FindDocTargets(filename string, onlyMissing bool) ([]DocTarget, error) {
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, filename, nil, parser.ParseComments)
	if err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}

	var targets []DocTarget

	for _, decl := range node.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if !d.Name.IsExported() {
				continue
			}
			hasDoc := d.Doc != nil && len(d.Doc.List) > 0
			if onlyMissing && hasDoc {
				continue
			}

			var source bytes.Buffer
			printer.Fprint(&source, fset, d)

			target := DocTarget{
				Kind:   "func",
				Name:   d.Name.Name,
				Source: source.String(),
				HasDoc: hasDoc,
			}

			if d.Recv != nil && len(d.Recv.List) > 0 {
				target.Kind = "method"
				var recv bytes.Buffer
				printer.Fprint(&recv, fset, d.Recv.List[0].Type)
				target.Receiver = recv.String()
			}

			targets = append(targets, target)

		case *ast.GenDecl:
			for _, spec := range d.Specs {
				ts, ok := spec.(*ast.TypeSpec)
				if !ok || !ts.Name.IsExported() {
					continue
				}
				hasDoc := d.Doc != nil && len(d.Doc.List) > 0
				if onlyMissing && hasDoc {
					continue
				}

				var source bytes.Buffer
				printer.Fprint(&source, fset, d)

				targets = append(targets, DocTarget{
					Kind:   "type",
					Name:   ts.Name.Name,
					Source: source.String(),
					HasDoc: hasDoc,
				})
			}
		}
	}

	return targets, nil
}

// BuildDocPrompt creates the LLM prompt for generating godoc comments.
// Send this to the LLMClient.Complete method from Section 118D.2.
func BuildDocPrompt(targets []DocTarget) string {
	var sb bytes.Buffer
	sb.WriteString("Generate godoc comments for these Go symbols.\n")
	sb.WriteString("Follow Go conventions: start with symbol name, complete sentences,\n")
	sb.WriteString("document behavior and contracts, note thread safety and error conditions.\n\n")

	for _, t := range targets {
		sb.WriteString(fmt.Sprintf("--- %s %s ---\n%s\n\n", t.Kind, t.Name, t.Source))
	}

	sb.WriteString("Respond with JSON: [{\"name\": \"X\", \"comment\": \"// X does Y.\"}]")
	return sb.String()
}
```

The workflow: run `FindDocTargets` on each `.go` file (skipping `_test.go`), build the prompt with `BuildDocPrompt`, send it through the `LLMClient` interface, parse the JSON response, and either print or write the comments back to the source file using `go/printer`.

> **What AI Gets Wrong**: AI documentation tends to describe what the code does at a superficial level rather than documenting the contract. "CreateUser creates a user" is useless documentation. "CreateUser persists a new user to the database. It returns ErrDuplicateEmail if a user with the same email already exists. The caller must provide a valid context, and cancellation is respected during the database transaction." is useful documentation. Always review AI docs for specificity.
>
> There is a second failure that is worse than vagueness, because it is confidently wrong. AI documents what a function *appears* to do, inferred substantially from its name. Point it at a `Close()` that forgets to release a lock, and you will get a comment stating that it releases the lock, because that is what `Close` means everywhere else it has read. The comment now actively lies, and comments are trusted more than code by every reader in a hurry. Documentation generated from an implementation cannot validate that implementation, and it will paper over precisely the bugs where the code does not do what its name promises.
>
> Note the tension with the chapter's own framing. Generated documentation is not "living documentation that stays synchronized with your codebase": it is a snapshot, exactly as stale-able as a hand-written comment, unless you regenerate it as part of the change that made it wrong. The synchronization is a process you build (regenerate on the diff, review the delta), not a property the tool has.

> **Pro Tip**: The most impactful documentation AI generates is not godoc comments, it is incident runbooks and on-call playbooks. Feed AI your service's architecture, common failure modes, and monitoring dashboards, and ask it to generate a runbook for each alert. This documentation is tedious to write manually but invaluable at 3am when you're on call.

---

### Junior → FAANG: Documentation as Engineering Communication Practice

The "contract, not description" documentation standard from the "What AI Gets Wrong" note is the quality bar for FAANG-level technical writing. "CreateUser creates a user" is a description that adds no information beyond the function name. "CreateUser persists a new user to the database, returns ErrDuplicateEmail if a user with the same email already exists, and respects context cancellation during the database transaction" is a contract that tells callers what to expect, what errors to handle, and what behavior to count on. Practice writing contract-level documentation for every public function you author, and review AI-generated documentation to ensure it meets this standard.

The runbook pro tip is a career-advancing practice: writing runbooks before you are on-call demonstrates reliability engineering maturity that gets noticed in FAANG promotions. Generate runbooks for every alert in your service (using AI with the service architecture and alert description as context), review them for accuracy, and add them to the team's on-call documentation before your first on-call rotation. This preparation demonstrates the kind of proactive reliability engineering that FAANG performance reviews reward.

### Senior @ FAANG: Documentation Strategy as Organizational Knowledge Management

At senior level, documentation is organizational knowledge management, and AI is the tool that makes comprehensive documentation economically feasible. Without AI, the documentation cost (time per page of useful documentation) is too high to maintain comprehensive coverage across a large codebase. With AI, the per-page cost drops significantly because AI generates the boilerplate that takes most of the time. The human contribution is reviewing for accuracy, adding the implementation-specific context that AI cannot generate, and updating documentation when code changes.

The runbook generation pattern is particularly valuable at organizational scale. An organization with 50 services has hundreds of alerts, each requiring a runbook. Generating all runbooks with AI, having the service owners review and correct them, and then keeping them updated is feasible with AI assistance in a way that writing all of them from scratch is not. The staff engineer who drives the organization-wide runbook generation initiative, creates the standard runbook template, and establishes the review and maintenance process is making a direct contribution to the organization's incident response capability and on-call engineer experience.
