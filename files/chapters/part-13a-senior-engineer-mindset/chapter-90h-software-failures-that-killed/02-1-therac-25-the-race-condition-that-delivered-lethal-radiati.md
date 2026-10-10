## 90H.1 Therac-25: The Race Condition That Delivered Lethal Radiation (1985-1987)

### The Machine

The Therac-25 was a computer-controlled radiation therapy machine manufactured by Atomic Energy of Canada Limited
(AECL). It was the third in the Therac series, following the Therac-6 and Therac-20. The machine could operate in
two modes: electron beam mode, which delivered electrons directly to the tumor at relatively low energy, and X-ray
mode, which used a high-energy electron beam striking a tungsten target to produce X-rays. In X-ray mode, the beam
energy was approximately 100 times more powerful than in electron beam mode, requiring a beam flattener and
spreading filter to be placed in the beam path to shape and attenuate the radiation to safe therapeutic levels.

The critical difference between the Therac-25 and its predecessors was the removal of hardware safety interlocks.
The Therac-6 and Therac-20 had independent hardware circuits that physically prevented the high-energy beam from
firing without the proper filters in place. These were electromechanical systems - physical switches, relays, and
interlocks that operated independently of the software. Even if the software failed completely, the hardware
interlocks would prevent an unsafe beam configuration. The Therac-25's designers made a fateful decision: they
removed the hardware interlocks entirely and relied on software alone to ensure safety. The reasoning was that
software was more flexible, easier to update, and - they believed - more reliable than hardware interlocks. This
assumption proved to be catastrophically wrong.

### The Timeline of Deaths

**June 1985 - Kennestone Regional Oncology Center, Marietta, Georgia:** A patient received a massive overdose
during treatment. The machine displayed a "MALFUNCTION 54" error, which the operator manual described as a "dose
input 2" error with no further explanation. The patient developed radiation burns and eventually required surgical
removal of her shoulder and arm. She survived but was permanently disabled. AECL investigated and could not
reproduce the error. They told the hospital the error was "impossible" and that the overdose could not have occurred.

**July 1985 - Ontario Cancer Foundation, Hamilton, Ontario:** A patient received a massive overdose. The machine
displayed an error message, but the operator, following standard procedure, re-entered the treatment command. The
patient died of radiation overexposure in November 1985. AECL again could not reproduce the problem and attributed
it to a transient hardware failure.

**December 1985 - Yakima Valley Memorial Hospital, Yakima, Washington:** Another overdose incident. The patient
developed severe radiation burns. AECL investigated but again could not find a software cause.

**March 1986 - East Texas Cancer Center, Tyler, Texas:** A patient named Ray Cox was being treated for a tumor on
his upper back. The operator, an experienced technician, entered the treatment parameters. She initially typed "X"
for X-ray mode, then quickly corrected it to "E" for electron mode using the cursor-up key. This rapid editing
sequence - the exact trigger for the race condition - caused the machine to be configured for high-energy X-ray
power levels but with the turntable set to electron mode, meaning no beam flattener was in the path. The machine
delivered approximately 25,000 rads to a small area of Cox's body - roughly 125 times the intended dose. The
display showed "MALFUNCTION 54" and indicated zero dose delivered. The operator, seeing zero dose, pressed the
treatment button again, delivering another lethal dose. Cox reported feeling "an electric shock" and "fire" in his
back. He was coherent when he left the treatment room. He died five months later from the overdose.

**April 1986 - East Texas Cancer Center, Tyler, Texas:** Three weeks after Ray Cox's overdose, another patient at
the same facility experienced the identical failure. The operator again used the cursor-up key to correct a mode
selection, triggering the race condition again. This patient died three weeks later from the overdose.

**January 1987 - Yakima Valley Memorial Hospital, Yakima, Washington:** A sixth known overdose incident occurred.
The patient died three months later.

In total, at least six patients received massive radiation overdoses from the Therac-25. At least three died
directly from the overdoses. Three survived with severe injuries.

### The Technical Root Cause

The Therac-25 software was written in PDP-11 assembly language by a single programmer. The code had evolved from
the Therac-6 and Therac-20 software, which had been used safely for years - but those machines had hardware
interlocks that masked the software bugs. When the hardware interlocks were removed, the latent bugs became lethal.

**The Race Condition:** The software used a shared variable - a flag - to coordinate between the operator interface
task and the beam control task. These two tasks ran concurrently on the PDP-11. The critical bug was in how this
flag was managed:

1. The operator interface task set a shared variable called `Class3` (the treatment mode flag) when the operator
   selected a treatment mode. This variable was not set to a specific value - it was **incremented** by 1.

2. The turntable positioning task read this variable to determine the correct turntable position (which filter to
   place in the beam path).

3. A separate task checked whether the turntable was in the correct position before allowing the beam to fire.

4. The `Class3` variable was stored in a single byte. When it overflowed past 255 (its maximum value), it wrapped
   around to zero. Zero was interpreted as "no mode selected" or "safe to proceed" depending on the context.

**The Trigger Sequence:** If the operator typed the mode selection, then quickly used the cursor-up key to correct
it within approximately 8 seconds (the time it took for the turntable to begin repositioning), the following race
condition occurred:

1. The operator types "X" (X-ray mode). The interface task increments `Class3` and signals the turntable task to
   position for X-ray mode (high energy, beam flattener in path).
2. Before the turntable completes positioning, the operator uses cursor-up to change to "E" (electron mode). The
   interface task increments `Class3` again.
3. The turntable task re-reads the parameters and begins repositioning for electron mode (low energy, no filter).
4. However, the beam energy has already been set to high-energy X-ray levels and is not reset by the mode change.
5. The position-check task reads `Class3` and, due to the double increment, interprets the value as indicating
   that the position is correct (or, in some reconstructions, the value overflows to zero which bypasses the check
   entirely).
6. The high-energy beam fires without the beam flattener in the path, delivering the full unattenuated X-ray
   energy beam directly to the patient.

**The Overflow:** The `Class3` flag was incremented every time the operator selected a treatment mode, not just
when the mode changed. Over the course of a treatment session with multiple corrections, this counter could
overflow. When it overflowed past 255, it wrapped to zero. The position-check routine tested `Class3` using a
specific bit pattern - when the value was zero (after overflow), the test passed, and the safety check was
effectively bypassed. This meant that the more an operator used the machine (and made normal corrections), the
more likely the safety check was to be bypassed.

**No Hardware Backup:** In the Therac-6 and Therac-20, this bug existed in the software but never caused harm
because independent hardware interlocks physically prevented the high-energy beam from firing without the
correct filters in place. The hardware did not care what the software thought - it checked the physical position
of the turntable and the beam energy setting independently. The Therac-25 removed these interlocks. The software
was the only line of defense, and the software was wrong.

### AECL's Reaction

AECL's response to the incidents was a case study in organizational failure:

- After the first incident, AECL told the hospital the overdose was "impossible" based on their analysis of the
  software. They did not investigate the race condition.
- After the second incident, AECL attributed the problem to transient hardware failures, not software.
- AECL did not issue safety notices or notify other Therac-25 operators of the potential for overdoses.
- Internal correspondence revealed that AECL management believed the software was "proven safe" because it had
  been used in the Therac-6 and Therac-20 without incident - ignoring that those machines had hardware interlocks
  that the Therac-25 lacked.
- Even after the Tyler incidents in 1986, AECL's initial "fix" was to add a software patch that limited the number
  of retries after a MALFUNCTION 54 error - not to fix the underlying race condition or add hardware interlocks.
- The FDA eventually intervened, requiring AECL to add hardware interlocks, fix the software, and improve the
  error messages.

### Resolution

The Therac-25 was eventually recalled and modified with:

1. **Hardware interlocks restored:** Independent electromechanical circuits that physically prevented unsafe beam
   configurations regardless of software state.
2. **Software rewritten:** The race condition was fixed by using proper mutual exclusion (though the original
   programmer was not replaced).
3. **Error messages improved:** The cryptic "MALFUNCTION 54" was replaced with descriptive messages that told
   operators what had gone wrong.
4. **Independent safety analysis:** The FDA required independent review of the software, establishing precedent
   for software safety regulation in medical devices.

### How It Could Have Been Prevented

1. **Never remove hardware interlocks.** Software should be defense-in-depth, not the sole line of defense. If
   the Therac-25 had retained the hardware interlocks from its predecessors, no software bug could have delivered
   a lethal dose.
2. **Use mutual exclusion for shared state.** The `Class3` flag was accessed by multiple concurrent tasks without
   any synchronization primitive (mutex, semaphore, critical section). Proper mutual exclusion would have
   prevented the race condition.
3. **Set, don't increment, safety-critical flags.** The `Class3` variable was incremented, not set to a specific
   value. This made its value path-dependent and overflow-prone. Safety-critical state should be set to explicit,
   well-defined values.
4. **Independent verification.** The turntable position should have been verified by an independent sensor reading
   the physical position, not by reading a software variable that was supposed to represent the intended position.
5. **Testing with realistic usage patterns.** The race condition was triggered by rapid operator corrections - a
   normal usage pattern that was never tested.

### Go Code: Mutex-Based Safety Interlock System

The following Go implementation demonstrates how to build a safety interlock system that prevents unsafe machine
states using Go's concurrency primitives. The key insight is that mutual exclusion, explicit state enumeration, and
independent verification make race-condition-based safety bypasses impossible.

```go
package safetyinterlock

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// BeamMode represents the treatment mode with explicit enumeration.
// Unlike the Therac-25's incremented flag, this is a typed constant
// that can only hold valid values.
type BeamMode int

const (
	BeamModeNone     BeamMode = iota // No mode selected
	BeamModeElectron                 // Low-energy electron beam
	BeamModeXRay                     // High-energy X-ray (requires filter)
)

func (m BeamMode) String() string {
	switch m {
	case BeamModeNone:
		return "NONE"
	case BeamModeElectron:
		return "ELECTRON"
	case BeamModeXRay:
		return "XRAY"
	default:
		return "INVALID"
	}
}

// TurntablePosition represents the physical position of the beam filter.
type TurntablePosition int

const (
	TurntableUnknown  TurntablePosition = iota
	TurntableOpen                       // No filter - for electron mode
	TurntableFiltered                   // Beam flattener in path - for X-ray mode
)

// SafetyState holds the complete state of the machine.
// All fields are private and can only be modified through
// methods that enforce safety invariants.
type SafetyState struct {
	mu                sync.Mutex
	selectedMode      BeamMode
	turntablePosition TurntablePosition
	beamEnergy        float64 // in MeV
	interlockEngaged  bool
	beamActive        bool
	lastVerification  time.Time
}

// SafetyError represents a safety interlock violation.
type SafetyError struct {
	Violation   string
	CurrentMode BeamMode
	Turntable   TurntablePosition
	BeamEnergy  float64
}

func (e *SafetyError) Error() string {
	return fmt.Sprintf(
		"SAFETY INTERLOCK VIOLATION: %s [mode=%s turntable=%d energy=%.1f MeV]",
		e.Violation, e.CurrentMode, e.Turntable, e.BeamEnergy,
	)
}

// RequiredTurntablePosition returns the turntable position required
// for the given beam mode. This is a pure function - no shared state,
// no race conditions possible.
func RequiredTurntablePosition(mode BeamMode) TurntablePosition {
	switch mode {
	case BeamModeElectron:
		return TurntableOpen
	case BeamModeXRay:
		return TurntableFiltered
	default:
		return TurntableUnknown
	}
}

// MaxSafeEnergy returns the maximum safe beam energy for the given
// turntable position. If the filter is not in place, only low energy
// is safe.
func MaxSafeEnergy(pos TurntablePosition) float64 {
	switch pos {
	case TurntableFiltered:
		return 25.0 // MeV - X-ray mode with filter
	case TurntableOpen:
		return 2.0 // MeV - electron mode only
	default:
		return 0.0 // Unknown position - no beam allowed
	}
}

// RadiationMachine represents the complete machine with safety interlocks.
type RadiationMachine struct {
	state           SafetyState
	turntableSensor TurntableSensor // Hardware sensor - independent verification
	auditLog        AuditLogger
}

// TurntableSensor represents an independent hardware sensor that reads
// the physical turntable position. This is the equivalent of the hardware
// interlock that the Therac-25 removed.
type TurntableSensor interface {
	ReadPhysicalPosition() (TurntablePosition, error)
}

// AuditLogger records all safety-critical operations for post-incident analysis.
type AuditLogger interface {
	Log(event string, details map[string]any)
}

// NewRadiationMachine creates a machine with interlocks engaged by default.
func NewRadiationMachine(sensor TurntableSensor, logger AuditLogger) *RadiationMachine {
	return &RadiationMachine{
		state: SafetyState{
			selectedMode:     BeamModeNone,
			interlockEngaged: true,
		},
		turntableSensor: sensor,
		auditLog:        logger,
	}
}

// SelectMode sets the treatment mode. Unlike the Therac-25's increment
// operation, this explicitly sets the mode to a typed constant value.
// The mutex ensures that concurrent access cannot create an inconsistent
// state.
func (m *RadiationMachine) SelectMode(mode BeamMode) error {
	m.state.mu.Lock()
	defer m.state.mu.Unlock()

	if m.state.beamActive {
		return errors.New("cannot change mode while beam is active")
	}

	oldMode := m.state.selectedMode
	m.state.selectedMode = mode
	m.state.interlockEngaged = true // Re-engage interlock on any mode change

	m.auditLog.Log("MODE_CHANGE", map[string]any{
		"old_mode": oldMode.String(),
		"new_mode": mode.String(),
		"time":     time.Now().UTC(),
	})

	return nil
}

// SetBeamEnergy configures the beam energy level.
func (m *RadiationMachine) SetBeamEnergy(energyMeV float64) error {
	m.state.mu.Lock()
	defer m.state.mu.Unlock()

	if m.state.beamActive {
		return errors.New("cannot change energy while beam is active")
	}

	if energyMeV <= 0 {
		return fmt.Errorf("beam energy must be positive, got %.2f", energyMeV)
	}

	m.state.beamEnergy = energyMeV
	m.state.interlockEngaged = true // Re-engage interlock on energy change

	return nil
}

// VerifyAndFire performs ALL safety checks, including reading the
// independent hardware sensor, before allowing the beam to fire.
// This is the critical function that the Therac-25 got wrong.
func (m *RadiationMachine) VerifyAndFire(ctx context.Context) error {
	m.state.mu.Lock()
	defer m.state.mu.Unlock()

	// CHECK 1: Mode must be explicitly selected (not NONE or invalid)
	if m.state.selectedMode == BeamModeNone {
		return &SafetyError{
			Violation:   "no treatment mode selected",
			CurrentMode: m.state.selectedMode,
			Turntable:   m.state.turntablePosition,
			BeamEnergy:  m.state.beamEnergy,
		}
	}

	// CHECK 2: Read the PHYSICAL turntable position from hardware sensor.
	// This is the independent verification that the Therac-25 lacked.
	// We release the lock briefly to do I/O, then re-acquire and re-verify.
	m.state.mu.Unlock()
	physicalPos, err := m.turntableSensor.ReadPhysicalPosition()
	m.state.mu.Lock()

	if err != nil {
		return fmt.Errorf("hardware sensor read failed - beam inhibited: %w", err)
	}

	// CHECK 3: Physical turntable position must match required position for mode.
	requiredPos := RequiredTurntablePosition(m.state.selectedMode)
	if physicalPos != requiredPos {
		return &SafetyError{
			Violation: fmt.Sprintf(
				"turntable position mismatch: physical=%d required=%d for mode %s",
				physicalPos, requiredPos, m.state.selectedMode,
			),
			CurrentMode: m.state.selectedMode,
			Turntable:   physicalPos,
			BeamEnergy:  m.state.beamEnergy,
		}
	}

	// CHECK 4: Beam energy must not exceed maximum safe energy for current
	// turntable position. This catches the exact Therac-25 failure mode:
	// high energy with no filter.
	maxEnergy := MaxSafeEnergy(physicalPos)
	if m.state.beamEnergy > maxEnergy {
		return &SafetyError{
			Violation: fmt.Sprintf(
				"beam energy %.1f MeV exceeds maximum safe energy %.1f MeV for turntable position %d",
				m.state.beamEnergy, maxEnergy, physicalPos,
			),
			CurrentMode: m.state.selectedMode,
			Turntable:   physicalPos,
			BeamEnergy:  m.state.beamEnergy,
		}
	}

	// CHECK 5: Context must not be canceled (operator abort)
	if ctx.Err() != nil {
		return fmt.Errorf("operation canceled: %w", ctx.Err())
	}

	// ALL CHECKS PASSED - fire beam
	m.state.beamActive = true
	m.state.interlockEngaged = false
	m.state.lastVerification = time.Now()

	m.auditLog.Log("BEAM_FIRED", map[string]any{
		"mode":              m.state.selectedMode.String(),
		"energy_mev":        m.state.beamEnergy,
		"turntable_pos":     physicalPos,
		"verification_time": m.state.lastVerification.UTC(),
	})

	return nil
}

// EmergencyStop immediately terminates the beam and engages all interlocks.
func (m *RadiationMachine) EmergencyStop() {
	m.state.mu.Lock()
	defer m.state.mu.Unlock()

	m.state.beamActive = false
	m.state.interlockEngaged = true

	m.auditLog.Log("EMERGENCY_STOP", map[string]any{
		"time": time.Now().UTC(),
	})
}
```

**Why this prevents the Therac-25 failure:**
- The `BeamMode` type is an explicit enum, not an incrementing counter - it cannot overflow.
- The `sync.Mutex` prevents race conditions between concurrent operations.
- The `TurntableSensor` interface represents the independent hardware verification that the Therac-25 removed.
- The `MaxSafeEnergy` check catches the exact failure: high energy beam without a filter in the path.
- Mode changes re-engage the interlock, requiring full re-verification before firing.

### Engineering Lessons

1. **Software must never be the sole safety mechanism.** Defense in depth requires independent layers - software,
   hardware interlocks, physical stops - each capable of preventing harm independently.
2. **Race conditions are not edge cases.** If two tasks share mutable state without synchronization, the race
   condition is not a theoretical possibility - it is a guaranteed future failure. The only question is when.
3. **Set, don't increment.** Safety-critical flags must be set to explicit, well-defined values. Incrementing
   creates path-dependent state that can overflow, wrap, and produce values that bypass safety checks.
4. **Verify against physical reality, not software state.** The software's model of the world can diverge from
   the physical state. Independent sensors that read physical reality are the only reliable safety check.
5. **"It worked before" is not a safety argument.** The Therac-25 software "worked" in the Therac-6 and Therac-20
   only because hardware interlocks masked its bugs. Removing those interlocks revealed that the software had
   never been safe.

---

### Junior → FAANG: Race Conditions and Safety Interlocks as Interview Fundamentals

The Therac-25 is the textbook example for "explain how a race condition can cause a critical failure" in technical interviews. The race condition between the operator typing quickly (decrementing a flag) and the machine entering treatment mode (checking that flag) produced a state where the software believed the filter was in place when it was not. The Go implementation in this section demonstrates the correct defense: a mutex that ensures the entire verification sequence (read physical sensor, check energy against turntable position, fire beam) executes atomically. Interviewers asking about mutex usage want to see that you understand what invariant the mutex is protecting. Here, the invariant is: "the physical turntable position must be verified against the selected mode and energy level before the beam fires, and no state change can occur between that verification and the firing." Stating the invariant explicitly before writing the mutex code is the interview move that distinguishes L4 from L5 candidates.

### Senior @ FAANG: Defense in Depth as an Architectural Non-Negotiable for Safety-Critical Systems

At L6, the Therac-25 incident is an argument for defense in depth as an architectural constraint, not a design preference. AECL removed the hardware interlocks because they trusted the software. The correct principle is that software alone is never a sufficient safety barrier for any system where failure causes physical harm. Safety-critical architecture requires independent layers: software checks, hardware interlocks, and physical constraints, each capable of preventing the unsafe state independently. No single layer's failure should be able to produce harm.

In Go systems at FAANG scale that are not radiation therapy machines but have high-consequence failure modes (financial transaction systems, infrastructure control planes, health data pipelines), defense in depth means: the application layer enforces business rules, the infrastructure layer enforces capacity and rate constraints, and the data layer enforces referential integrity. No single layer's bypass should be able to produce a harmful state. When you review system designs at L6, the question "what happens if this safety check is bypassed?" applied to each layer in sequence is how you identify defense in depth gaps. A system where bypassing the application layer's authorization check allows unrestricted data access has the same architectural flaw as the Therac-25: a single layer is the only safety barrier, and its failure produces harm directly.

