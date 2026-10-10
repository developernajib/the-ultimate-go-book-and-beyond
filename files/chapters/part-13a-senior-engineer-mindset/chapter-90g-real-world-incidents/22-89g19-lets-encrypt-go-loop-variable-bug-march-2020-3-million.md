## 90G.19 Let's Encrypt Go Loop Variable Bug (March 2020) - 3 Million Certificates Revoked

*"A bug in our certificate authority software caused us to skip rechecking some CAA records, resulting in the
need to revoke approximately 3 million certificates within 24 hours."* - Let's Encrypt

### The Incident

On February 29, 2020, Let's Encrypt - the world's largest certificate authority, providing free TLS certificates
that secure over 200 million websites - announced that they had to **revoke approximately 3 million active
certificates** due to a compliance bug. The bug was caused by one of Go's most infamous gotchas: the **loop
variable capture problem**.

Let's Encrypt's Boulder CA software, written entirely in Go, had a bug in its CAA (Certificate Authority
Authorization) record checking code. CAA records are DNS records that specify which certificate authorities are
permitted to issue certificates for a domain. Before issuing a certificate, the CA must check CAA records to
ensure it is authorized. The bug caused the CA to reuse a single CAA check result for multiple domain names
in a multi-domain certificate request, effectively skipping the CAA check for all domains except the last one.

The bug was a textbook Go loop variable capture issue. In Go versions before 1.22, the loop variable in a
`for` range loop was reused across iterations. If a closure captured the loop variable (or its address was
taken), all closures would reference the same variable - which would contain the value from the **last**
iteration by the time the closures executed.

### The Buggy Code Pattern

The following code demonstrates the exact class of bug that caused the incident. A goroutine launched inside a `for` loop captures a pointer to the loop variable `domain`, which is reused across iterations. By the time the goroutines execute, all of them reference the same memory address containing the last value assigned to `domain`.

```go
package caacheck

import (
	"sync"
)

// CAARecord represents a DNS CAA record.
type CAARecord struct {
	Domain string
	Tag    string // "issue", "issuewild", "iodef"
	Value  string // e.g., "letsencrypt.org"
}

// CAAResult holds the result of a CAA check for a single domain.
type CAAResult struct {
	Domain    string
	Permitted bool
	Records   []CAARecord
	Err       error
}

// THE BUGGY CODE (simplified from the actual Let's Encrypt bug)
// This demonstrates the pre-Go-1.22 loop variable capture problem.
func checkCAARecordsBuggy(domains []string) []CAAResult {
	results := make([]CAAResult, len(domains))
	var wg sync.WaitGroup

	for i, domain := range domains {
		wg.Add(1)
		// BUG: In Go < 1.22, 'domain' is the SAME variable in every iteration.
		// All goroutines capture a reference to the same 'domain' variable.
		// By the time goroutines execute, 'domain' contains the LAST value.
		go func() {
			defer wg.Done()
			// 'domain' here refers to the loop variable, not a copy.
			// When this goroutine runs, 'domain' may have already advanced
			// to the last element of the slice.
			results[i] = checkSingleDomain(domain) // BUG: 'i' and 'domain' are shared!
		}()
	}

	wg.Wait()
	return results
}

// THE FIXED CODE - Three different correct approaches.

// Fix 1: Shadow the loop variable (pre-Go 1.22 idiom).
func checkCAARecordsFixed1(domains []string) []CAAResult {
	results := make([]CAAResult, len(domains))
	var wg sync.WaitGroup

	for i, domain := range domains {
		i := i         // shadow i - creates a new variable for each iteration
		domain := domain // shadow domain - each goroutine gets its own copy
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = checkSingleDomain(domain) // now uses the shadowed copy
		}()
	}

	wg.Wait()
	return results
}

// Fix 2: Pass as goroutine function parameter (explicit copy).
func checkCAARecordsFixed2(domains []string) []CAAResult {
	results := make([]CAAResult, len(domains))
	var wg sync.WaitGroup

	for i, domain := range domains {
		wg.Add(1)
		go func(idx int, d string) {
			defer wg.Done()
			results[idx] = checkSingleDomain(d)
		}(i, domain) // values copied at goroutine launch
	}

	wg.Wait()
	return results
}

// Fix 3: Use Go 1.22+ where loop variables are per-iteration by default.
// No code change needed - the language semantics changed in Go 1.22.
// The original "buggy" code works correctly in Go 1.22+.
func checkCAARecordsGo122(domains []string) []CAAResult {
	results := make([]CAAResult, len(domains))
	var wg sync.WaitGroup

	for i, domain := range domains {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// In Go 1.22+, 'i' and 'domain' are new variables each iteration.
			results[i] = checkSingleDomain(domain)
		}()
	}

	wg.Wait()
	return results
}

func checkSingleDomain(domain string) CAAResult {
	// Simulated CAA check - in production this queries DNS.
	return CAAResult{
		Domain:    domain,
		Permitted: true,
		Records:   nil,
		Err:       nil,
	}
}
```

### Go Implementation: Static Analysis Tool for Loop Variable Capture

The Go team's `loopclosure` analyzer (part of `go vet`) catches some cases, but a more thorough
analysis tool can detect subtler instances.

```go
package caacheck

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
)

// LoopVarCapture describes a detected loop variable capture bug.
type LoopVarCapture struct {
	File      string
	Line      int
	Variable  string
	LoopLine  int
	Severity  string // "critical" if variable used in goroutine, "warning" otherwise
}

// DetectLoopVarCaptures performs a simplified AST analysis to find loop variable
// captures in closures. This is a teaching implementation - production tools should
// use golang.org/x/tools/go/analysis.
func DetectLoopVarCaptures(filename string, src string) ([]LoopVarCapture, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filename, src, parser.AllErrors)
	if err != nil {
		return nil, fmt.Errorf("parse error: %w", err)
	}

	var captures []LoopVarCapture

	ast.Inspect(file, func(n ast.Node) bool {
		rangeStmt, ok := n.(*ast.RangeStmt)
		if !ok {
			return true
		}

		// Collect loop variable names.
		var loopVars []string
		if ident, ok := rangeStmt.Key.(*ast.Ident); ok {
			loopVars = append(loopVars, ident.Name)
		}
		if rangeStmt.Value != nil {
			if ident, ok := rangeStmt.Value.(*ast.Ident); ok {
				loopVars = append(loopVars, ident.Name)
			}
		}

		// Walk the loop body looking for goroutine closures that capture loop vars.
		ast.Inspect(rangeStmt.Body, func(inner ast.Node) bool {
			goStmt, ok := inner.(*ast.GoStmt)
			if !ok {
				return true
			}

			// Check if the goroutine is a closure (function literal).
			funcLit, ok := goStmt.Call.Fun.(*ast.FuncLit)
			if !ok {
				return true
			}

			// Check if the closure body references loop variables.
			ast.Inspect(funcLit.Body, func(bodyNode ast.Node) bool {
				ident, ok := bodyNode.(*ast.Ident)
				if !ok {
					return true
				}
				for _, loopVar := range loopVars {
					if ident.Name == loopVar {
						captures = append(captures, LoopVarCapture{
							File:     filename,
							Line:     fset.Position(ident.Pos()).Line,
							Variable: ident.Name,
							LoopLine: fset.Position(rangeStmt.Pos()).Line,
							Severity: "critical",
						})
					}
				}
				return true
			})
			return true
		})
		return true
	})

	return captures, nil
}

// FormatCaptures produces a human-readable report of detected captures.
func FormatCaptures(captures []LoopVarCapture) string {
	if len(captures) == 0 {
		return "No loop variable captures detected."
	}

	var b strings.Builder
	b.WriteString(fmt.Sprintf("Detected %d potential loop variable capture(s):\n\n", len(captures)))
	for i, c := range captures {
		b.WriteString(fmt.Sprintf(
			"  %d. [%s] %s:%d - variable '%s' from loop at line %d captured in goroutine closure\n",
			i+1, c.Severity, c.File, c.Line, c.Variable, c.LoopLine,
		))
	}
	b.WriteString("\nFix: shadow the variable (v := v) or pass as a goroutine parameter.\n")
	b.WriteString("Note: Go 1.22+ changes loop variable semantics to per-iteration scope.\n")
	return b.String()
}
```

### The Impact and Go 1.22 Language Change

The Let's Encrypt bug was one of several high-profile incidents caused by Go's loop variable semantics. The
cumulative impact of these bugs across the Go ecosystem led to a **language-level change in Go 1.22** (released
February 2024): loop variables in `for` range loops now have per-iteration scope by default. This means the
"buggy" code pattern that caused the Let's Encrypt incident now works correctly in Go 1.22+.

However, engineers must still understand this bug class because:
- Many codebases still compile with Go < 1.22
- The pattern can still occur with explicit `for` loops (not range)
- Understanding closure capture semantics is fundamental to correct concurrent Go code
- Code review and static analysis remain essential complements to language safety

### Key Lessons for Go Engineers

1. **The most dangerous bugs look correct** - the Let's Encrypt code was not obviously wrong. It required
   deep understanding of Go's closure capture semantics to spot the problem.
2. **Language semantics bugs affect security** - a loop variable bug in certificate validation code meant
   3 million certificates were issued without proper authorization checks.
3. **Upgrade to Go 1.22+** - the language change eliminates this entire class of bugs for range loops.
4. **Run `go vet` and `staticcheck` in CI** - these tools detect loop variable capture issues before they
   reach production.

### Exercises

1. Write a **thorough test** for the CAA checking function that specifically tests with multiple domains
   to verify each domain is checked independently. Demonstrate that the test catches the buggy version.
2. Build a **Go version compatibility checker** that scans a codebase for loop variable capture patterns
   and reports which ones are safe only under Go 1.22+ semantics.
3. Implement a **certificate issuance audit log** that records exactly which CAA checks were performed for
   each domain in every certificate request, making it possible to detect and audit missed checks.

---

### Junior → FAANG: Loop Variable Capture as a Go Closure Semantics Interview Question

Go closure capture semantics appear in almost every Go-specific FAANG interview. The question takes the form of a code snippet with a goroutine inside a range loop, and the interviewer asks what value the goroutine will see for the loop variable. Before Go 1.22, the answer is: the value at the end of the loop, because all goroutines capture the same variable by reference. The correct fix before 1.22 is to shadow the variable inside the loop body (`v := v`) or pass it as a goroutine argument. In Go 1.22 and later, range loop variables have per-iteration scope and the bug does not exist. Know both answers and when each applies. The Let's Encrypt incident makes this abstract knowledge concrete: a closure capture bug in certificate validation code resulted in 3 million certificates issued without proper authorization checks. When you explain closure capture in an interview, this incident is your one-sentence anchor for why the behavior matters.

### Senior @ FAANG: Language Semantics Bugs as a Class and Static Analysis as a Platform Enforcement Mechanism

At L6, the Let's Encrypt incident represents a category of bug that static analysis tools should have caught before the code ever reached production. `go vet` has detected loop variable capture since before the incident. The question is not whether the tool existed: it is whether the tool was enforced in CI as a blocking gate. At staff level, your Go platform standard defines a minimum set of required static analysis passes that every service must pass before a pull request can merge: `go vet`, `staticcheck`, and a custom analyzer for any domain-specific invariants your org has identified. The minimum set is not optional, it is not a warning, and it is not waivable without an explicit exception review.

The deeper lesson from this incident is that language semantics bugs are a distinct category from logic bugs. A logic bug violates the programmer's intent. A semantics bug is correct according to the programmer's mental model but incorrect according to the language specification. Semantics bugs are dangerous because they pass code review by programmers who share the same incorrect mental model. The defenses are layered: automated static analysis catches patterns that tools know about, Go version upgrades eliminate entire categories (Go 1.22 eliminates this specific bug class for range loops), and pairing during code review by engineers with different experience levels breaks the shared-incorrect-mental-model problem. At staff level, you maintain a catalog of known Go semantics gotchas specific to your codebase (not just the textbook examples) and include them in your team's onboarding material and code review checklist. The Let's Encrypt bug, the goroutine leak patterns, and the GOMEMLIMIT misconfiguration examples from this chapter are the starting entries in that catalog.

