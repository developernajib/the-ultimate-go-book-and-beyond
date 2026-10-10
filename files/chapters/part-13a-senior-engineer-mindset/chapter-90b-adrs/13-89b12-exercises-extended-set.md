## Exercises

The best way to internalize the ADR practice is to do it yourself. Reading examples builds understanding, but writing your own ADR and building your own tooling forces you to confront the judgment calls that make the difference between a useful ADR and a useless one. These exercises are designed to be done with a real codebase or a realistic scenario, not toy examples. If you work through both exercises, you will have both the writing skill and the tooling to introduce ADRs to any team.

### Exercise 3: Write an ADR for a Real Architectural Decision

**Objective**: Apply the MADR format to a real decision from your own experience.

**Background**: The best way to internalize the ADR format is to write one for a decision you were actually involved in - a database selection, a caching strategy, a service boundary, an API versioning approach. Unlike toy examples, a real decision forces you to reconstruct the actual constraints and trade-offs rather than inventing them.

**Task**: Select an architectural decision you have made or observed. It should meet the ADR threshold: hard to reverse, affecting multiple components, with genuine trade-offs between options.

Write a complete MADR-format ADR including:
1. A context section specific enough that an engineer with no prior context could understand why the decision was non-trivial
2. At least two alternatives that were genuinely evaluated, with honest trade-off analysis
3. A scoring matrix (even if the original decision did not use one - reconstruct what the weights would have been)
4. A consequences section that honestly acknowledges negatives

**Example scenario** (if you do not have a recent decision to draw from): You are building a high-read, moderate-write user profile service that stores 10 million user records. You need to decide between:
- PostgreSQL with a read replica
- DynamoDB with a GSI
- Redis Cluster with PostgreSQL as a backing store

Write the full ADR for this decision, choosing the option that best fits the constraints you define.

**Review criteria**: Have a peer read your ADR and ask: "Do you understand why we did not choose option B?" If they cannot answer from the ADR alone, the alternatives section needs more work.

---

### Exercise 4: Build a Go CLI `adr` Tool

**Objective**: Build a production-quality CLI tool for managing ADRs in a repository.

**Background**: The `adr` command-line tool should codify the ADR workflow described throughout this chapter. Building it forces you to think precisely about the data model of an ADR corpus: what fields are required, what invariants must hold, what queries are useful.

**Requirements**:

The tool must support three subcommands:

```
adr new --type <type> --title <title>    Create a new ADR from template
adr list [--status <status>]             List all ADRs with their status
adr check                                Check for superseded ADRs not marked
```

**`adr new`**:
- Determines the next sequential ADR number from existing files
- Generates the correct template based on `--type` (general, technology, pattern, process, security)
- Creates the file in `docs/adr/` with the naming convention `NNNN-title-slug.md`
- Prints the created filename

**`adr list`**:
- Parses all ADR files in `docs/adr/`
- Extracts number, title, and status from each file
- Outputs a formatted table:

```
NUM   STATUS      TITLE
0001  accepted    PostgreSQL for User Service
0002  accepted    gRPC for Internal Communication
0003  deprecated  Redis as Primary Cache
0004  superseded  Kubernetes 1.24 Upgrade Path
0005  proposed    Event Sourcing for Order Domain
```

- Supports `--status` filter: `adr list --status accepted`
- Supports `--format json` for machine-readable output

**`adr check`**:
- Identifies ADRs where an ADR references "Supersedes: ADR-NNNN" but the referenced ADR's status has not been updated to "superseded"
- Outputs a list of inconsistencies as warnings
- Exits with code 1 if any inconsistencies are found (suitable for CI)

**Solution skeleton**:

```go
// cmd/adr/main.go
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/yourorg/yourrepo/tools/adr/internal/corpus"
	"github.com/yourorg/yourrepo/tools/adr/internal/generator"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	switch os.Args[1] {
	case "new":
		cmdNew(os.Args[2:])
	case "list":
		cmdList(os.Args[2:])
	case "check":
		cmdCheck(os.Args[2:])
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand: %s\n", os.Args[1])
		printUsage()
		os.Exit(1)
	}
}

func cmdNew(args []string) {
	fs := flag.NewFlagSet("new", flag.ExitOnError)
	adrType := fs.String("type", "general", "ADR type: technology|pattern|process|security|general")
	title := fs.String("title", "", "ADR title (required)")
	dir := fs.String("dir", "docs/adr", "ADR directory")
	fs.Parse(args)

	if *title == "" {
		fmt.Fprintln(os.Stderr, "--title is required")
		os.Exit(1)
	}

	path, err := generator.Create(*dir, *adrType, *title)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Created:", path)
}

func cmdList(args []string) {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	status := fs.String("status", "", "filter by status")
	format := fs.String("format", "table", "output format: table|json")
	dir := fs.String("dir", "docs/adr", "ADR directory")
	fs.Parse(args)

	adrs, err := corpus.Load(*dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	if *status != "" {
		adrs = corpus.FilterByStatus(adrs, *status)
	}

	switch *format {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.Encode(adrs)
	default:
		fmt.Printf("%-6s %-12s %s\n", "NUM", "STATUS", "TITLE")
		fmt.Printf("%-6s %-12s %s\n", "----", "------", "-----")
		for _, a := range adrs {
			fmt.Printf("%-6s %-12s %s\n", a.Number, a.Status, a.Title)
		}
	}
}

func cmdCheck(args []string) {
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	dir := fs.String("dir", "docs/adr", "ADR directory")
	fs.Parse(args)

	adrs, err := corpus.Load(*dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	issues := corpus.CheckSupersessions(adrs)
	if len(issues) == 0 {
		fmt.Println("All ADR supersession references are consistent.")
		return
	}

	for _, issue := range issues {
		fmt.Fprintln(os.Stderr, "WARNING:", issue)
	}
	os.Exit(1)
}

func printUsage() {
	fmt.Println(`adr - Architectural Decision Record management tool

Usage:
  adr new --type <type> --title <title>
  adr list [--status <status>] [--format table|json]
  adr check

Subcommands:
  new     Create a new ADR from template
  list    List all ADRs in the ADR directory
  check   Check for inconsistent supersession references`)
}
```

**Testing requirements**:

Write table-driven tests for the corpus parser that cover:
- ADR with all four standard status values
- ADR with a supersedes link
- ADR with a superseded-by reference
- ADR with a malformed status line (should not panic. Return empty status)
- Directory with no ADR files (should return empty slice, not error)

Write integration tests for `cmdCheck` that use a temporary directory with:
- A consistent supersession pair (ADR A supersedes ADR B. ADR B is marked superseded) - should pass
- An inconsistent pair (ADR A says it supersedes ADR B. ADR B is still marked accepted) - should fail with exit code 1

**Stretch goal**: Add an `adr graph` subcommand that emits Graphviz DOT format using the dependency graph logic from section 90B.7.

### Junior → FAANG: Treating Exercises as Portfolio Projects

The exercises in this section produce artifacts that belong in a portfolio. A Go CLI tool that validates ADR consistency, tested with integration tests against realistic ADR scenarios, demonstrates both Go competency and architectural thinking. These are exactly the kinds of projects that FAANG interviewers ask about: "tell me about a tool you built to improve your team's engineering process."

Complete the exercises in order of increasing complexity. The first exercise, writing ADRs for real decisions, requires no code but produces the most immediate value. Complete it for your current project before moving to the coding exercises. The ADRs you write become the test corpus for the tooling exercises, which makes the tooling work more meaningful and the resulting tool more practical.

### Senior @ FAANG: Extending the Tool to Production Readiness

The CLI tool described in the stretch goal is production-applicable at the staff level. FAANG engineering platforms teams regularly build and maintain internal tooling of this complexity to enforce documentation standards at scale. The design considerations that matter for production: where does the tool run (local pre-commit hook, CI pipeline, or both), what is the failure mode when the tool is broken, how is the tool versioned and distributed across teams, and who owns its maintenance.

These design questions are worth documenting in an ADR for the tool itself. A meta-ADR that captures "we chose to run this as a CI check rather than a pre-commit hook because we cannot mandate pre-commit hook installation across all developer environments" is both good practice and a demonstration of the principle the tool enforces. Tools that eat their own dog food make the strongest implicit argument for the practice they support.

---

## Summary

Architectural Decision Records (ADRs) are a foundational practice for managing institutional knowledge in evolving software systems. By recording the context, options, decision, and consequences of significant technical choices, engineering teams prevent decision debt and make their architecture understandable to future maintainers.

### Key Takeaways

1. **Document the "Why", Not Just the "What"**: ADRs capture the constraints and forces driving a decision, preserving the reasoning when teams and technologies evolve.
2. **Standardize on Lightweight Formats**: Use Nygard for focused architectural choices and MADR when structured comparison matrices and detailed consequences are required.
3. **Co-locate with Code**: Keep ADRs in version control (`docs/adr/`) and link them directly from Go doc comments and code annotations.
4. **Active Lifecycle Management**: Ensure status transitions (Proposed, Accepted, Deprecated, Superseded) are maintained and verified via automated linters and CI checks.
5. **Demonstrate Staff-Level Impact**: A documented track record of sound architectural decisions serves as permanent, verifiable evidence for staff and principal engineer advancement.

---

*Next: Chapter 90C - Engineering Metrics: DORA, Flow, and Team Health*

---
