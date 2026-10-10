## 90K.8 Formal Verification

NASA does not rely solely on testing to find bugs. Testing can only prove the presence of
bugs, never their absence. To achieve the near-zero defect rates required for
safety-critical software, NASA employs formal verification: mathematical proof that the
software satisfies its specification.

### Static Analysis

Static analysis examines source code without executing it. NASA uses multiple static
analyzers on every build:

- **Coverity** - finds null dereferences, buffer overflows, resource leaks, and
  concurrency errors.
- **LDRA** - measures structural coverage (MC/DC) and enforces coding standards.
- **CodeSonar** - performs deep interprocedural analysis for complex bugs.
- **Polyspace** - proves the absence of runtime errors (division by zero, overflow,
  out-of-bounds access).
- **SPIN** - model checks concurrent systems (created by Gerard Holzmann, the same
  person who wrote the Power of 10 rules).

### Model Checking

Model checking systematically explores all possible states of a concurrent system. If
any state violates a specified property (like a deadlock or a safety condition), the model
checker produces a counterexample - a specific sequence of events that leads to the
violation. SPIN can check systems with billions of states by using partial-order reduction
and bitstate hashing.

### Modified Condition/Decision Coverage (MC/DC)

DO-178C Level A (the highest safety level for avionics software) requires MC/DC coverage.
MC/DC goes beyond statement coverage and branch coverage. It requires that:

1. Every condition in a decision has been tested as true and false.
2. Every condition has been shown to independently affect the decision's outcome.

For a decision like `if (A && B || C)`, MC/DC requires test cases that prove:
- Changing A alone changes the outcome.
- Changing B alone changes the outcome.
- Changing C alone changes the outcome.

This is significantly more rigorous than 100% branch coverage.

### Formal Verification in Go

Go's tooling does not include formal verification, but we can apply the principles:

```go
package nasa

import (
    "errors"
    "fmt"
    "sync"
    "testing"
    "time"
)

// Assert checks an invariant and panics if false.
func Assert(condition bool, format string, args ...any) {
    if !condition {
        if len(args) == 0 {
            panic("assertion failed: " + format)
        }
        panic(fmt.Sprintf("assertion failed: "+format, args...))
    }
}

// === Assertion-Heavy Design (Executable Specifications) ===

// FlightComputer represents a simplified flight computer with
// NASA-style invariant checking at every state transition.
type FlightComputer struct {
    mu       sync.Mutex
    state    FlightState
    velocity float64
    altitude float64
    fuel     float64
    maxG     float64
    history  []StateTransition
}

// FlightState represents the spacecraft's operational state.
type FlightState int

const (
    FlightStatePreLaunch FlightState = iota
    FlightStateAscent
    FlightStateOrbit
    FlightStateDescent
    FlightStateLanded
    FlightStateAborted
)

// String returns the state name.
func (fs FlightState) String() string {
    names := [...]string{
        "PreLaunch", "Ascent", "Orbit", "Descent", "Landed", "Aborted",
    }
    if int(fs) < len(names) {
        return names[fs]
    }
    return fmt.Sprintf("Unknown(%d)", fs)
}

// StateTransition records a state change for audit.
type StateTransition struct {
    From      FlightState
    To        FlightState
    Reason    string
    Timestamp time.Time
}

// validTransitions defines the legal state machine.
// This is the specification - formal verification checks that
// the implementation only performs transitions in this table.
var validTransitions = map[FlightState][]FlightState{
    FlightStatePreLaunch: {FlightStateAscent, FlightStateAborted},
    FlightStateAscent:    {FlightStateOrbit, FlightStateAborted},
    FlightStateOrbit:     {FlightStateDescent, FlightStateAborted},
    FlightStateDescent:   {FlightStateLanded, FlightStateAborted},
    FlightStateLanded:    {}, // Terminal state.
    FlightStateAborted:   {}, // Terminal state.
}

// NewFlightComputer creates a flight computer in PreLaunch state.
func NewFlightComputer(fuel float64) *FlightComputer {
    Assert(fuel > 0, "initial fuel must be positive")

    return &FlightComputer{
        state:   FlightStatePreLaunch,
        fuel:    fuel,
        maxG:    0,
        history: make([]StateTransition, 0, 32),
    }
}

// Transition performs a state transition with full invariant checking.
// This is the core of formal-verification-inspired design:
// every transition is checked against the specification.
func (fc *FlightComputer) Transition(to FlightState, reason string) error {
    fc.mu.Lock()
    defer fc.mu.Unlock()

    // Pre-condition: transition must be valid.
    if !fc.isValidTransition(fc.state, to) {
        return fmt.Errorf("invalid transition: %s -> %s (reason: %s)",
            fc.state, to, reason)
    }

    // Pre-condition: reason must be provided.
    if reason == "" {
        return errors.New("transition reason is required")
    }

    from := fc.state
    fc.state = to

    // Record transition for audit trail.
    fc.history = append(fc.history, StateTransition{
        From:      from,
        To:        to,
        Reason:    reason,
        Timestamp: time.Now().UTC(),
    })

    // Post-condition: state must match.
    Assert(fc.state == to, "state mismatch after transition")

    // Post-condition: history must be non-empty.
    Assert(len(fc.history) > 0, "history must be non-empty after transition")

    // Invariant: fuel must be non-negative.
    Assert(fc.fuel >= 0, "fuel is negative: %f", fc.fuel)

    return nil
}

// isValidTransition checks the state machine specification.
func (fc *FlightComputer) isValidTransition(from, to FlightState) bool {
    valid, ok := validTransitions[from]
    if !ok {
        return false
    }
    for _, v := range valid {
        if v == to {
            return true
        }
    }
    return false
}

// UpdateTelemetry updates flight parameters with invariant checks.
func (fc *FlightComputer) UpdateTelemetry(velocity, altitude, gForce float64) error {
    fc.mu.Lock()
    defer fc.mu.Unlock()

    // Pre-conditions.
    Assert(altitude >= 0, "altitude must be non-negative: %f", altitude)

    // Store previous values for rate-of-change checks.
    prevVelocity := fc.velocity
    prevAltitude := fc.altitude

    fc.velocity = velocity
    fc.altitude = altitude

    if gForce > fc.maxG {
        fc.maxG = gForce
    }

    // Post-conditions.

    // During ascent, altitude should generally increase.
    if fc.state == FlightStateAscent && altitude < prevAltitude-100 {
        // Altitude decreased by more than 100m during ascent - anomaly.
        return fmt.Errorf("anomaly: altitude decreased during ascent (%.1f -> %.1f)",
            prevAltitude, altitude)
    }

    // G-force must be within survivable range for crewed missions.
    if gForce > 9.0 {
        return fmt.Errorf("g-force %.1f exceeds 9.0g safety limit", gForce)
    }

    // Velocity sanity check - no faster than escape velocity.
    if velocity > 12000 {
        return fmt.Errorf("velocity %.1f exceeds escape velocity", velocity)
    }

    _ = prevVelocity // Used in more complex delta-v calculations.

    return nil
}

// State returns the current flight state.
func (fc *FlightComputer) State() FlightState {
    fc.mu.Lock()
    defer fc.mu.Unlock()
    return fc.state
}

// === MC/DC-Inspired Test Coverage ===

// TestFlightComputerMCDC demonstrates MC/DC-style testing where
// each condition is shown to independently affect the outcome.
func TestFlightComputerMCDC(t *testing.T) {
    // Decision: isValidTransition(from, to) -> bool
    //
    // MC/DC requires:
    // 1. Test where 'from' is valid for a given 'to' -> true
    // 2. Test where 'from' is invalid for a given 'to' -> false
    // 3. Test where 'to' is valid for a given 'from' -> true
    // 4. Test where 'to' is invalid for a given 'from' -> false
    // 5. Each condition independently affects the outcome.

    tests := []struct {
        name     string
        from     FlightState
        to       FlightState
        expected bool
        reason   string
    }{
        // Case 1: Valid from, valid to -> true
        {
            name:     "PreLaunch to Ascent is valid",
            from:     FlightStatePreLaunch,
            to:       FlightStateAscent,
            expected: true,
            reason:   "from=valid, to=valid",
        },
        // Case 2: Invalid from for this to -> false
        {
            name:     "Orbit to Ascent is invalid",
            from:     FlightStateOrbit,
            to:       FlightStateAscent,
            expected: false,
            reason:   "from=invalid (Orbit cannot go to Ascent)",
        },
        // Case 3: Valid from, different valid to -> true
        {
            name:     "PreLaunch to Aborted is valid",
            from:     FlightStatePreLaunch,
            to:       FlightStateAborted,
            expected: true,
            reason:   "from=valid, to=valid (abort always allowed)",
        },
        // Case 4: Valid from, invalid to -> false
        {
            name:     "PreLaunch to Landed is invalid",
            from:     FlightStatePreLaunch,
            to:       FlightStateLanded,
            expected: false,
            reason:   "from=valid, to=invalid (can't land from PreLaunch)",
        },
        // Case 5: Terminal state, any to -> false
        {
            name:     "Landed to anything is invalid",
            from:     FlightStateLanded,
            to:       FlightStateAscent,
            expected: false,
            reason:   "terminal state has no valid transitions",
        },
        // Case 6: Aborted is terminal
        {
            name:     "Aborted to anything is invalid",
            from:     FlightStateAborted,
            to:       FlightStatePreLaunch,
            expected: false,
            reason:   "abort is terminal",
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            fc := NewFlightComputer(1000)
            fc.state = tt.from // Directly set for testing.
            result := fc.isValidTransition(tt.from, tt.to)
            if result != tt.expected {
                t.Errorf("%s: isValidTransition(%s, %s) = %v, want %v (%s)",
                    tt.name, tt.from, tt.to, result, tt.expected, tt.reason)
            }
        })
    }
}

// === Go Static Analysis Tools (NASA-Equivalent) ===

// GoStaticAnalysisChecklist documents the tools that provide
// NASA-equivalent static analysis for Go code.
//
// go vet ./...
//   - Detects: Printf format mismatches, unreachable code,
//     suspicious constructs, copying mutexes.
//   - NASA equivalent: Basic compiler warnings.
//
// staticcheck ./...
//   - Detects: Inefficient code, deprecated API usage,
//     concurrent map access, nil dereferences.
//   - NASA equivalent: Extended static analysis (Coverity-lite).
//
// go test -race ./...
//   - Detects: Data races at runtime.
//   - NASA equivalent: Concurrency analysis (SPIN-lite for data races only).
//
// golangci-lint run --enable-all
//   - Runs 50+ linters simultaneously.
//   - NASA equivalent: Running multiple analyzers (Coverity + LDRA + CodeSonar).
//
// govulncheck ./...
//   - Detects known vulnerabilities in dependencies.
//   - NASA equivalent: Component security analysis.
//
// nilaway
//   - Detects potential nil pointer dereferences statically.
//   - NASA equivalent: Null dereference analysis (Polyspace-lite).
//
// deadcode
//   - Detects unreachable code.
//   - NASA equivalent: Dead code analysis (LDRA).
```

---
