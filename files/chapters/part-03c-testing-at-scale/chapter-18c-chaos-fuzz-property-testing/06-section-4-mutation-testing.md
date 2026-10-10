## Section 4: Mutation Testing

### 4.1 Measuring Test Suite Quality

Line coverage tells you which code your tests execute, but it says nothing about whether they actually verify the results. A test that calls every function but never checks a return value gets 100% coverage while catching zero bugs. Mutation testing fills this gap by introducing deliberate bugs, called mutants, into your source code and running the test suite against each one. If a mutant survives (tests still pass), that code path lacks meaningful assertions.

The Go ecosystem has two mutation testing tools worth knowing. `gremlins` (github.com/go-gremlins/gremlins) is actively maintained and inspired by PITest. It targets typical microservice-sized modules, integrates as a CI quality gate, and supports incremental analysis limited to changed files via `--diff`. `go-mutesting` is the older option. Avito maintains a fork (`github.com/avito-tech/go-mutesting`) that keeps the original alive, but gremlins is the default recommendation for new projects in 2026. Both apply mutations such as flipping comparison operators (`>` to `>=`), swapping return values, removing function calls, and negating conditionals. Each mutation creates a slightly broken version of your code. The mutation score, `killed / (killed + lived)`, is the percentage of mutants your tests detect.

Quick start with gremlins:

```bash
go install github.com/go-gremlins/gremlins/cmd/gremlins@latest

# Full run across the module
gremlins unleash ./...

# Diff-only mode for PR-scoped CI
gremlins unleash --diff origin/main ./...
```

> **Senior track**: treat mutation scores as a targeting aid, not a hard gate. 100% is unreachable because of equivalent mutants (semantically identical code that no test could distinguish). Aim for 70-80% on business logic and ignore boilerplate (setters, pass-through adapters, generated code).

The following example contrasts a weak test (low mutation kill rate) with a strong test (high kill rate) for a simple `Max` function, illustrating why boundary values and distinct input orderings matter for catching operator and return-value mutations.

```go
package mutation_test

import (
	"math"
	"testing"
)

// Mutation testing in Go in 2026 is best driven by gremlins.
// Run: gremlins unleash ./...
// It reports a mutation score: killed / (killed + lived).

// Example: testing this function thoroughly enough to catch mutations
func Max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Weak test: passes even if mutation changes > to >= or swaps a/b return
func TestMax_Weak(t *testing.T) {
	if Max(1, 2) != 2 {
		t.Fatal("expected 2")
	}
}

// Strong test. Which case kills which mutant, precisely:
//   - a > b → a < b:        killed by {1,2} and by {2,1}
//   - return b → return a:  killed by {1,2} (a > b is false, so b must win)
//   - return a → return b:  killed by {2,1} (a > b is true, so a must win)
//   - a > b → a >= b:       NOT killed by anything, and never can be.
//
// That last one is worth sitting with, because it is the honest version of
// the story. When a == b the two branches return the same value, so `>` and
// `>=` describe the same function. No test can distinguish them. This is an
// *equivalent mutant*, and it is exactly why a 100% mutation score is not a
// reachable target. A tool reports it as "lived", a keen engineer spends an
// afternoon trying to kill it, and there was never a bug to find.
func TestMax_Strong(t *testing.T) {
	cases := []struct{ a, b, want int }{
		{1, 2, 2},    // b > a: must return b
		{2, 1, 2},    // a > b: must return a
		{5, 5, 5},    // equal: either branch returns 5, see the note above
		{-1, -2, -1}, // negatives
		{0, 0, 0},
		// Use MinInt/MaxInt, not MinInt64/MaxInt64: these fields are `int`,
		// and the 64-bit constants do not fit in an int on a 32-bit build.
		{math.MinInt, math.MaxInt, math.MaxInt},
	}
	for _, tc := range cases {
		if got := Max(tc.a, tc.b); got != tc.want {
			t.Errorf("Max(%d, %d) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

// MutationResult mirrors what gremlins reports.
type MutationResult struct {
	Killed   int
	Lived    int
	NoCov    int // mutant in code not covered by any test (gremlins: NOT COVERED)
	Timeout  int // mutant caused test timeout (counts as killed)
	Runnable int
	Score    float64
}

// GremlinsConfig generates a minimal .gremlins.yaml.
// See https://gremlins.dev for the full schema.
//
// Note the nesting. Every unleash setting lives under an `unleash:` key, and
// the thresholds nest one level deeper still. Only `silent` is top-level.
// This matters more than it looks: gremlins reads its config through viper,
// which simply does not find a misplaced key and silently falls back to the
// default. Put `threshold-efficacy` at the top level and you get no error, no
// warning, and a CI gate that never fires.
func GremlinsConfig() string {
	return `silent: false
unleash:
  tags: ""
  test-cpu: 0
  timeout-coefficient: 3
  threshold:
    efficacy: 80
    mutant-coverage: 80
mutants:
  arithmetic-base:
    enabled: true
  conditionals-boundary:
    enabled: true
  conditionals-negation:
    enabled: true
  increment-decrement:
    enabled: true
  invert-assignments:
    enabled: true
  invert-bitwise:
    enabled: true
  invert-bwassign:
    enabled: true
  invert-logical:
    enabled: true
  invert-loopctrl:
    enabled: true
  invert-negatives:
    enabled: true
  remove-self-assignments:
    enabled: true
`
}
```

### 4.2 When mutation testing is worth the CPU

Mutation testing is expensive. A run that takes 10 seconds as `go test` can take 30 minutes under mutation testing because each mutant requires the test suite to run again. Three rules to keep the cost worth paying. First, run it incrementally in PR CI (`gremlins unleash --diff`) rather than on the full codebase every build. Diff mode finishes in seconds on a typical PR. Second, run the full suite nightly, not on every push. The full score is a lagging indicator that leadership can track monthly. Third, focus mutation testing on business logic, not on boilerplate. A mutation score on request routing or dependency wiring is not informative, because the tests for those should be integration tests anyway. Mutation testing is most valuable on the code where correctness matters most: pricing logic, authorization checks, rate-limit math, consensus algorithms. Run it there, and the cost pays back. Run it everywhere, and teams start ignoring the signal.

### 4.3 Junior → FAANG: the weakness-vs-strength comparison

Look at the contrast between `TestMax_Weak` and `TestMax_Strong` in section 4.1. Internalize what makes the strong test strong: table-driven cases covering each meaningful boundary (a > b, a < b, a == b, negatives, zero, extremes). Then look at your own most recent test. Ask: if I flipped the comparison from `>` to `>=`, would my test still pass? If I returned the wrong argument, would my test catch it? If the answer is "probably not," your test is weak. Rewrite it following the strong pattern. Do this for ten tests in a row and you will internalize the boundary-coverage habit. This is the core skill mutation testing is trying to teach, and once you have internalized it, mutation testing becomes a verification tool rather than a discovery tool.

### 4.4 Senior @ FAANG: mutation score as a team signal

At staff level, mutation score is a team-level signal, not a per-PR gate. Set a target (70 percent on business logic is reasonable, 80 percent is aspirational) and track it monthly. When the score drops, investigate which new code added untested paths. When the score plateaus, the team has probably reached the equivalent-mutant ceiling and further improvement requires structural changes (often removing dead code rather than adding tests). Do not enforce mutation score in PR CI. The false-positive rate and the CPU cost are both too high. Use it as a quarterly review metric that informs test-quality conversations. Teams that treat mutation score this way benefit from the signal without drowning in noise. Teams that try to hard-gate on it tend to game the metric (writing tests that kill mutants without genuinely improving correctness) and lose the underlying value.

---
