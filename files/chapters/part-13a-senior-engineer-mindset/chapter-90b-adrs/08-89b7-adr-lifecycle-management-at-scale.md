## 90B.7 ADR Lifecycle Management at Scale

When you have only a handful of ADRs, managing them is straightforward. But as your organization grows, the ADR corpus can reach dozens or even hundreds of records, and manual management breaks down. Stale statuses, broken cross-references, and orphaned records accumulate silently until the ADR corpus becomes unreliable. This section teaches you how to manage ADRs at scale using defined state transitions, automated CI checks, dependency graph visualization, and search strategies that keep the corpus trustworthy.

As a codebase matures, an organization accumulates dozens or hundreds of ADRs. Managing that corpus - keeping statuses accurate, surfacing relevant decisions, linking supersessions - requires deliberate tooling and process. This section covers lifecycle management at the scale of a FAANG-style engineering organization.

### Status Transitions

Every ADR moves through a defined state machine. Understanding valid transitions prevents orphaned or contradictory records.

```
Proposed → Accepted
Proposed → Rejected
Accepted → Deprecated       (decision still applies but is no longer recommended for new work)
Accepted → Superseded       (a newer ADR replaces this decision entirely)
Deprecated → Superseded
Rejected → Proposed         (circumstances change; decision is reconsidered)
```

**Proposed** is the only mutable state. Once an ADR moves to Accepted, Rejected, Deprecated, or Superseded, its content is frozen. Do not edit the body. If you need to add context, add a postscript section clearly labeled "Added YYYY-MM-DD" and leave the original content unchanged. This preserves the historical record of what was known at decision time.

**Deprecated** is distinct from Superseded. Deprecated means the pattern still works but is discouraged for new work - for example, a sync HTTP client pattern that has been replaced by an async event-driven pattern in new services, but still operates in twenty legacy services that have not been migrated. Superseded means the decision has been actively replaced and no new code should follow the old pattern.

**Superseding ADRs must always reference the ADRs they supersede.** The superseding ADR's Links section should read:

```

## Links
- Supersedes: [ADR-0042](0042-database-selection.md)
- Supersedes: [ADR-0051](0051-caching-layer.md)
```

And the superseded ADR's status line should be updated:

```

## Status
Superseded by [ADR-0078](0078-unified-data-layer.md) - 2025-11-03
```

### Automated CI Checks for ADR Hygiene

A CI pipeline that lints ADR format and checks for broken cross-references prevents the most common drift patterns. The following GitHub Actions workflow demonstrates a practical implementation.

```yaml
# .github/workflows/adr-lint.yml
name: ADR Lint

on:
  pull_request:
    paths:
      - 'docs/adr/**'

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Build ADR linter
        run: go build -o /usr/local/bin/adrlint ./tools/adrlint

      - name: Lint ADR format
        run: adrlint lint docs/adr/

      - name: Check cross-references
        run: adrlint check-links docs/adr/

      - name: Verify superseded ADRs are marked
        run: adrlint check-supersessions docs/adr/
```

### Go CLI: ADR Dependency Graph Generator

The following Go program reads all ADR markdown files in a directory, extracts supersession relationships, and emits a Graphviz DOT file showing the dependency graph. At scale, this graph reveals clusters of related decisions and orphaned ADRs that have never been referenced.

```go
// tools/adrgraph/main.go
package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
    "sort"
	"strings"
)

// ADR represents a parsed architectural decision record.
type ADR struct {
	Number     string
	Title      string
	Status     string
	Supersedes []string // ADR numbers this ADR supersedes
	SupersededBy string  // ADR number that supersedes this ADR (if any)
	FilePath   string
}

var (
	// statusRe matches lines like "Superseded by [ADR-0078](0078-foo.md)"
	supersededByRe = regexp.MustCompile(`(?i)superseded\s+by\s+\[ADR-(\d+)\]`)
	// supersedes link in Links section
	supersedesRe = regexp.MustCompile(`(?i)supersedes:\s+\[ADR-(\d+)\]`)
	// title from first H1
	titleRe = regexp.MustCompile(`^#\s+ADR-(\d+):\s+(.+)$`)
	// status line
	statusRe = regexp.MustCompile(`(?i)^(proposed|accepted|rejected|deprecated|superseded)`)
)

func parseADR(path string) (*ADR, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	adr := &ADR{FilePath: path}
	inLinksSection := false
	inStatusSection := false
	scanner := bufio.NewScanner(f)

	for scanner.Scan() {
		line := scanner.Text()

		// Extract title and number from H1.
		if m := titleRe.FindStringSubmatch(line); m != nil {
			adr.Number = m[1]
			adr.Title = m[2]
			continue
		}

		// Detect ## Status section.
		if strings.TrimSpace(line) == "## Status" {
			inStatusSection = true
			inLinksSection = false
			continue
		}

		// Detect ## Links section.
		if strings.TrimSpace(line) == "## Links" {
			inLinksSection = true
			inStatusSection = false
			continue
		}

		// New H2 section resets context.
		if strings.HasPrefix(line, "## ") {
			inStatusSection = false
			inLinksSection = false
		}

		if inStatusSection {
			// Extract primary status keyword.
			if adr.Status == "" {
				if m := statusRe.FindString(strings.TrimSpace(line)); m != "" {
					adr.Status = strings.ToLower(m)
				}
			}
			// Check for superseded-by inline reference.
			if m := supersededByRe.FindStringSubmatch(line); m != nil {
				adr.SupersededBy = m[1]
			}
		}

		if inLinksSection {
			if m := supersedesRe.FindStringSubmatch(line); m != nil {
				adr.Supersedes = append(adr.Supersedes, m[1])
			}
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan %s: %w", path, err)
	}

	// Derive number from filename if not found in content.
	if adr.Number == "" {
		base := filepath.Base(path)
		if len(base) >= 4 {
			adr.Number = base[:4]
		}
	}

	return adr, nil
}

func loadADRs(dir string) ([]*ADR, error) {
	entries, err := filepath.Glob(filepath.Join(dir, "*.md"))
	if err != nil {
		return nil, err
	}

	var adrs []*ADR
	for _, entry := range entries {
		// Skip index and template files.
		base := filepath.Base(entry)
		if strings.HasPrefix(base, "0000") || base == "README.md" {
			continue
		}

		adr, err := parseADR(entry)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: %v\n", err)
			continue
		}
		adrs = append(adrs, adr)
	}

	sort.Slice(adrs, func(i, j int) bool {
		return adrs[i].Number < adrs[j].Number
	})

	return adrs, nil
}

func nodeColor(status string) string {
	switch status {
	case "accepted":
		return "#d4edda" // green
	case "proposed":
		return "#fff3cd" // yellow
	case "deprecated":
		return "#ffeeba" // amber
	case "superseded":
		return "#f8d7da" // red
	case "rejected":
		return "#dee2e6" // grey
	default:
		return "#ffffff"
	}
}

func emitDOT(adrs []*ADR) {
	fmt.Println("digraph ADRs {")
	fmt.Println(`  graph [rankdir=LR, fontname="Helvetica", bgcolor="#f8f9fa"];`)
	fmt.Println(`  node [shape=box, style=filled, fontname="Helvetica", fontsize=10];`)
	fmt.Println()

	// Emit nodes.
	for _, a := range adrs {
		label := fmt.Sprintf("ADR-%s\\n%s\\n[%s]", a.Number, truncate(a.Title, 30), a.Status)
		color := nodeColor(a.Status)
		fmt.Printf("  ADR%s [label=%q, fillcolor=%q];\n", a.Number, label, color)
	}

	fmt.Println()

	// Emit edges.
	for _, a := range adrs {
		for _, sup := range a.Supersedes {
			fmt.Printf("  ADR%s -> ADR%s [label=\"supersedes\", color=\"#dc3545\"];\n", a.Number, sup)
		}
	}

	fmt.Println("}")
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: adrgraph <adr-dir>")
		os.Exit(1)
	}

	adrs, err := loadADRs(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	emitDOT(adrs)
}
```

Run it with:

```bash
go run ./tools/adrgraph docs/adr/ | dot -Tsvg -o docs/adr-graph.svg
```

The resulting SVG can be embedded in your engineering wiki or Backstage catalog. At Uber, LinkedIn, and similar organizations, equivalent graphs are generated nightly and published to internal developer portals so architects can spot stale decisions at a glance.

### ADR Search and Discovery

The ADR corpus is only useful if engineers can find relevant records quickly. Three search patterns work at different scales:

**1. grep / ripgrep** - sufficient for repositories with fewer than 50 ADRs:

```bash
# Find all ADRs mentioning a technology
rg -l "kafka" docs/adr/

# Find all accepted ADRs
rg -l "^accepted" docs/adr/

# Find ADRs that affect the payments service
rg -l "payments" docs/adr/
```

**2. ADR index generation** - for 50-200 ADRs, generate a searchable markdown index using the `adrgraph` tool extended with a `list` subcommand (see section 90B.5).

**3. Backstage TechDocs / Confluence search** - for 200+ ADRs or organizations requiring non-engineering stakeholders to find decisions, mirror ADRs to a knowledge base. The canonical source remains the repository. The mirror is read-only.

### Junior → FAANG: Lifecycle Management as a Professional Habit

The lifecycle management described in this section sounds like overhead until you have experienced the cost of a stale ADR. A stale ADR, one that says "Accepted" for a decision that was reversed 18 months ago without anyone updating the document, is worse than no ADR: it actively misleads engineers who rely on it.

The first-job habit: when you implement a change that contradicts an existing ADR, update the ADR before merging your code. This takes five minutes and prevents the class of failure where an engineer six months from now sees the contradiction between the code and the ADR and spends an afternoon trying to understand which one is correct.

### Senior @ FAANG: Scaling ADR Governance Without Creating Overhead

The three-tier search strategy at the end of this section (ripgrep for small corpora, generated index for medium, Backstage for large) represents a platform decision that staff engineers should make explicitly, not discover by accident. An organization that grows from 20 ADRs to 200 ADRs without planning for the discoverability problem will find that their ADR corpus becomes unusable just as it becomes most valuable.

The quarterly audit recommended in this section should be owned by a named engineer with a specific charter. "Everyone is responsible for keeping ADRs up to date" is equivalent to "nobody is responsible." At FAANG, audit responsibilities like this are typically assigned to a staff engineer during quarterly planning, with the output of the audit reviewed by the engineering director. The audit output is not just a list of stale ADRs. It is a signal about which areas of the architecture are evolving fastest and may need additional governance attention.

Decision dependency graphs, where ADR-015 explicitly depends on ADR-003 still being valid, are an underused tool at scale. When ADR-003 is superseded, the dependency graph immediately surfaces all ADRs that need review. Implementing this programmatically requires investment, but the payoff is that architectural change propagation becomes visible rather than invisible. This is especially valuable during large migrations, where a single infrastructure decision can invalidate dozens of downstream ADRs simultaneously.

---
