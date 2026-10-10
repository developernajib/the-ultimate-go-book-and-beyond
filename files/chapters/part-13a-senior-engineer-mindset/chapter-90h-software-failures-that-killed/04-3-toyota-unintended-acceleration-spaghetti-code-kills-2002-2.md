## 90H.3 Toyota Unintended Acceleration: Spaghetti Code Kills (2002-2010)

### The Background

Between 2002 and 2010, Toyota received thousands of complaints about vehicles that suddenly accelerated without
driver input. Drivers reported that their vehicles lurched forward unexpectedly, that pressing the brake pedal
did not stop the acceleration, and that the only way to stop was to turn off the ignition. Toyota initially
blamed floor mats that trapped the accelerator pedal, then blamed "sticky" accelerator pedals. They recalled
millions of vehicles for floor mat modifications and pedal replacements.

But the problems continued after the recalls. Drivers who had received the "fix" continued to report unintended
acceleration. NHTSA (the National Highway Traffic Safety Administration) launched an investigation. Toyota
maintained that their electronic throttle control software was not at fault. They provided reassurances that the
software had been thoroughly tested and was safe.

Between 2002 and 2010, unintended acceleration in Toyota vehicles was linked to at least 89 deaths and hundreds
of injuries. The most high-profile incident occurred on August 28, 2009, when a Lexus ES 350 loaned to off-duty
California Highway Patrol officer Mark Saylor accelerated out of control on a highway, reaching speeds estimated
at over 120 mph. Saylor, his wife, his daughter, and his brother-in-law were all killed when the vehicle crashed.
A 911 call from the vehicle captured their final moments.

### The Software Investigation

In 2013, a case went to trial: Bookout v. Toyota. The plaintiffs' legal team hired embedded systems expert
Michael Barr and his team at the Barr Group to conduct a forensic examination of Toyota's engine control
software. What they found was described as some of the worst production software ever analyzed:

**11,000 Global Variables:** The engine control software used over 11,000 global variables. Global variables are
accessible from anywhere in the code, making it impossible to reason about data flow, impossible to test
functions in isolation, and virtually guaranteed to produce unexpected interactions. Any function could read or
modify any global variable at any time, creating an astronomically large state space that no testing approach
could cover.

**Spaghetti Code Architecture:** The code had no clear modular structure. Functions called other functions in
deeply nested, unpredictable call chains. The control flow was so tangled that analysts could not reliably trace
the path from an input (sensor reading) to an output (throttle position).

**67 Untestable Functions:** Barr's team identified 67 functions that were so deeply entangled with global state
and other functions that they could not be tested in isolation using any practical testing methodology. These
functions essentially had to be tested as part of the entire 280,000-line codebase or not at all.

**No Defensive Programming:** The software lacked basic defensive programming practices. There were inadequate
checks for out-of-range values, no stack overflow protection on the critical task stack, and no monitoring of
the task that controlled the throttle.

**RTOS Task Vulnerabilities:** The throttle control ran as a real-time operating system (RTOS) task. If this task
died or was blocked, there was no watchdog or independent monitor that would detect the failure and force the
throttle to a safe position. Barr's team demonstrated that the task could be killed by a stack overflow in
specific call chains, leaving the throttle in whatever position it was in when the task died.

**Critical Single Bit Flip Vulnerability:** The throttle control system was vulnerable to single bit flips in
memory. Toyota's code did not use error-correcting RAM for all critical variables, and the mirroring strategy
for critical variables was inconsistently applied. Barr demonstrated that a single bit flip in the right memory
location could set the target throttle to wide open, and the system would not detect or correct the error.

**Inadequate Fail-Safe for Brake Override:** Toyota's implementation of brake override (cutting the throttle
when the brake pedal is pressed during acceleration) was incomplete. In certain code paths, the software could
enter a state where the brake override was not active even though the driver was pressing the brake.

### Toyota's Reaction

Toyota's response evolved from denial to damage control:

- Toyota initially attributed all unintended acceleration to floor mats and sticky pedals, denying any software
  involvement.
- When NHTSA investigation intensified, Toyota hired Exponent, a consulting firm known for defending corporations,
  to review the software. Exponent concluded the software was safe. This conclusion was later challenged by
  independent experts.
- Toyota paid a $1.2 billion criminal penalty to the DOJ in 2014 - the largest ever imposed on an automobile
  company - for concealing safety defects and misleading the public.
- Toyota paid hundreds of millions more in civil settlements and recalls.
- Internal documents revealed that Toyota engineers had identified some issues with the electronic throttle
  control software but that management did not authorize full fixes due to cost and schedule concerns.

### Resolution

The resolution included:

1. **Brake override became standard:** Toyota and eventually all manufacturers implemented brake override systems
   that cut throttle when the brake is applied during unintended acceleration.
2. **NHTSA expanded electronic systems oversight:** The investigation led to greater regulatory scrutiny of
   automotive software.
3. **Toyota reformed software practices:** Toyota overhauled its software development processes, though the
   specific changes were not fully disclosed publicly.
4. **Industry-wide standards strengthened:** The incidents accelerated adoption of ISO 26262, the functional safety
   standard for automotive electronics.

### How It Could Have Been Prevented

1. **Eliminate global variables.** Passing state explicitly through function parameters and return values makes
   data flow traceable, testable, and provable. The 11,000 global variables made Toyota's code fundamentally
   unanalyzable.
2. **Modular architecture.** Clean separation of concerns with well-defined interfaces between modules enables
   testing of each component in isolation.
3. **Independent safety monitors.** A watchdog process, running on independent hardware, should monitor the
   throttle control task and force a safe state (throttle closed) if the task stops responding.
4. **Error-correcting memory.** Critical variables controlling physical actuators must be stored in ECC RAM with
   software-level redundancy (mirroring, checksums).
5. **Static analysis.** Tools like MISRA-C compliance checkers, formal verification, and modern static analyzers
   would have identified many of the code quality issues.
6. **Testability as a design requirement.** If a function cannot be tested in isolation, it must be refactored
   until it can be.

### Go Code: Why Go Prevents Toyota's Failure Modes

Go's language design inherently prevents several of the failure modes that plagued Toyota's code. This is not
because Go is magic - it is because Go's designers made deliberate choices that eliminate entire categories of
bugs.

```go
package throttlecontrol

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// ThrottlePosition represents a validated throttle position.
// The type system enforces that only valid positions can exist.
// In Toyota's code, the throttle position was a raw integer that
// could hold any value, including out-of-range values.
type ThrottlePosition struct {
	percent float64 // 0.0 to 100.0, enforced by constructor
}

// NewThrottlePosition creates a validated throttle position.
// Invalid values are rejected at the point of creation, not at the
// point of use. This eliminates the "out-of-range value propagation"
// bug class entirely.
func NewThrottlePosition(percent float64) (ThrottlePosition, error) {
	if percent < 0 || percent > 100 {
		return ThrottlePosition{}, fmt.Errorf(
			"throttle position out of range: %.2f (must be 0-100)", percent,
		)
	}
	return ThrottlePosition{percent: percent}, nil
}

// Percent returns the throttle position as a percentage.
func (t ThrottlePosition) Percent() float64 {
	return t.percent
}

// SensorInput represents validated input from the accelerator pedal
// sensor. Like ThrottlePosition, the validation happens at creation.
type SensorInput struct {
	position ThrottlePosition
	sensorID string
	readAt   time.Time
}

// ThrottleState encapsulates ALL throttle-related state.
// Contrast with Toyota: state is private, accessible only through
// methods that enforce invariants. There are ZERO global variables.
// Go's package system makes this natural - unexported fields are
// inaccessible outside the package.
type ThrottleState struct {
	mu              sync.Mutex
	currentPosition ThrottlePosition
	targetPosition  ThrottlePosition
	brakeApplied    bool
	brakeOverride   bool
	lastUpdate      time.Time
}

// ThrottleController is the main controller. All dependencies are
// explicitly injected - no hidden global state.
// Toyota had 11,000 global variables. This struct has zero.
type ThrottleController struct {
	state       ThrottleState
	watchdog    *SafetyWatchdog
	sensorA     AcceleratorSensor
	sensorB     AcceleratorSensor
	brakeSensor BrakeSensor
	actuator    ThrottleActuator
	safetyLog   SafetyLogger
}

// AcceleratorSensor reads the accelerator pedal position.
type AcceleratorSensor interface {
	Read() (SensorInput, error)
}

// BrakeSensor reads whether the brake is applied.
type BrakeSensor interface {
	IsApplied() (bool, error)
}

// ThrottleActuator controls the physical throttle.
type ThrottleActuator interface {
	SetPosition(ThrottlePosition) error
	EmergencyClose() error
}

// SafetyLogger logs safety-critical events.
type SafetyLogger interface {
	LogEvent(event string, details map[string]any)
}

// NewThrottleController creates a controller with ALL dependencies
// explicitly injected. This is dependency inversion - the controller
// depends on interfaces, not concrete implementations. Every dependency
// can be mocked for testing. Toyota's 67 untestable functions were
// untestable precisely because their dependencies were hidden in globals.
func NewThrottleController(
	sensorA AcceleratorSensor,
	sensorB AcceleratorSensor,
	brake BrakeSensor,
	actuator ThrottleActuator,
	logger SafetyLogger,
) *ThrottleController {
	tc := &ThrottleController{
		sensorA:   sensorA,
		sensorB:   sensorB,
		brakeSensor: brake,
		actuator:  actuator,
		safetyLog: logger,
	}
	tc.watchdog = NewSafetyWatchdog(actuator, logger)
	return tc
}

// ControlLoop runs the main throttle control loop.
// This function is testable in isolation because all its dependencies
// are injected through interfaces. Contrast with Toyota's untestable
// functions that depended on thousands of global variables.
func (tc *ThrottleController) ControlLoop(ctx context.Context) error {
	ticker := time.NewTicker(10 * time.Millisecond) // 100 Hz control loop
	defer ticker.Stop()

	// Start the independent safety watchdog
	go tc.watchdog.Run(ctx)

	for {
		select {
		case <-ctx.Done():
			return tc.actuator.EmergencyClose()
		case <-ticker.C:
			if err := tc.controlCycle(); err != nil {
				tc.safetyLog.LogEvent("CONTROL_CYCLE_ERROR", map[string]any{
					"error": err.Error(),
					"time":  time.Now().UTC(),
				})
				// On any error, command throttle closed - fail safe
				if closeErr := tc.actuator.EmergencyClose(); closeErr != nil {
					tc.safetyLog.LogEvent("EMERGENCY_CLOSE_FAILED", map[string]any{
						"error": closeErr.Error(),
					})
				}
				return err
			}

			// Pet the watchdog - if we stop petting, the watchdog
			// will force an emergency close. This is the independent
			// monitor that Toyota's code lacked.
			tc.watchdog.Pet()
		}
	}
}

// controlCycle performs one cycle of the throttle control loop.
// This is a PURE function of its inputs (sensor readings) producing
// an output (throttle command). No hidden side effects through globals.
func (tc *ThrottleController) controlCycle() error {
	// Read both sensors and compare - redundancy
	readingA, errA := tc.sensorA.Read()
	readingB, errB := tc.sensorB.Read()

	if errA != nil && errB != nil {
		// Both sensors failed - fail safe
		return fmt.Errorf("both accelerator sensors failed: A=%v, B=%v", errA, errB)
	}

	var targetPosition ThrottlePosition
	if errA != nil || errB != nil {
		// One sensor failed - use the working one but log the failure
		tc.safetyLog.LogEvent("SENSOR_DEGRADED", map[string]any{
			"sensor_a_error": errA,
			"sensor_b_error": errB,
		})
		if errA == nil {
			targetPosition = readingA.position
		} else {
			targetPosition = readingB.position
		}
	} else {
		// Both sensors working - compare readings
		diff := readingA.position.Percent() - readingB.position.Percent()
		if diff < 0 {
			diff = -diff
		}
		if diff > 5.0 { // More than 5% disagreement
			// Sensor disagreement - fail safe, use lower reading
			tc.safetyLog.LogEvent("SENSOR_DISAGREEMENT", map[string]any{
				"sensor_a": readingA.position.Percent(),
				"sensor_b": readingB.position.Percent(),
			})
			if readingA.position.Percent() < readingB.position.Percent() {
				targetPosition = readingA.position
			} else {
				targetPosition = readingB.position
			}
		} else {
			// Sensors agree - use average
			avg := (readingA.position.Percent() + readingB.position.Percent()) / 2
			var err error
			targetPosition, err = NewThrottlePosition(avg)
			if err != nil {
				return fmt.Errorf("invalid averaged position: %w", err)
			}
		}
	}

	// BRAKE OVERRIDE - always check, unconditionally.
	// Toyota's brake override had code paths where it was not active.
	// Go's explicit control flow makes it impossible to accidentally
	// skip this check.
	brakeApplied, brakeErr := tc.brakeSensor.IsApplied()
	if brakeErr != nil {
		// Brake sensor failure - assume brake is applied, fail safe
		tc.safetyLog.LogEvent("BRAKE_SENSOR_FAILURE", map[string]any{
			"error": brakeErr.Error(),
		})
		brakeApplied = true
	}

	tc.state.mu.Lock()
	tc.state.brakeApplied = brakeApplied
	if brakeApplied && targetPosition.Percent() > 0 {
		// Brake override: if brake is pressed AND throttle is being
		// requested, cut throttle to zero. NO EXCEPTIONS.
		targetPosition = ThrottlePosition{percent: 0}
		tc.state.brakeOverride = true
		tc.safetyLog.LogEvent("BRAKE_OVERRIDE_ACTIVE", nil)
	} else {
		tc.state.brakeOverride = false
	}
	tc.state.targetPosition = targetPosition
	tc.state.lastUpdate = time.Now()
	tc.state.mu.Unlock()

	return tc.actuator.SetPosition(targetPosition)
}

// SafetyWatchdog is an INDEPENDENT monitor that forces a safe state
// if the main control loop stops responding. This is the critical
// safety mechanism that Toyota's code lacked - if the throttle control
// task died, there was nothing to detect the failure and close the
// throttle.
type SafetyWatchdog struct {
	lastPet   atomic.Int64 // Unix nanoseconds of last pet
	timeout   time.Duration
	actuator  ThrottleActuator
	logger    SafetyLogger
}

// NewSafetyWatchdog creates a watchdog with a default timeout.
func NewSafetyWatchdog(actuator ThrottleActuator, logger SafetyLogger) *SafetyWatchdog {
	return &SafetyWatchdog{
		timeout:  50 * time.Millisecond, // 5x the control loop period
		actuator: actuator,
		logger:   logger,
	}
}

// Pet signals that the control loop is alive.
func (w *SafetyWatchdog) Pet() {
	w.lastPet.Store(time.Now().UnixNano())
}

// Run monitors the control loop and forces an emergency stop if it
// stops responding.
func (w *SafetyWatchdog) Run(ctx context.Context) {
	w.Pet() // Initialize
	ticker := time.NewTicker(w.timeout / 2)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			last := time.Unix(0, w.lastPet.Load())
			if time.Since(last) > w.timeout {
				w.logger.LogEvent("WATCHDOG_TIMEOUT", map[string]any{
					"last_pet": last,
					"timeout":  w.timeout,
				})
				if err := w.actuator.EmergencyClose(); err != nil {
					w.logger.LogEvent("WATCHDOG_EMERGENCY_CLOSE_FAILED", map[string]any{
						"error": err.Error(),
					})
				}
			}
		}
	}
}
```

**Why Go's design prevents Toyota's failure modes:**

1. **Package-level encapsulation eliminates globals.** Go's unexported fields and package boundaries make it
   natural to encapsulate state. You must deliberately export a variable to make it globally accessible, and
   idiomatic Go never does this for mutable state.

2. **Interface-based dependency injection enables testability.** Every dependency is an interface that can be
   mocked. No function depends on hidden global state. All 67 of Toyota's "untestable" functions would be
   testable in Go with this pattern.

3. **Goroutines for independent monitoring.** The watchdog runs in its own goroutine, providing independent
   monitoring of the control loop. In Toyota's code, there was no independent monitor.

4. **Explicit error handling.** Go's explicit `error` return values mean that every failure must be handled at
   every call site. Silent failures that propagate corrupted state - a key Toyota failure mode - are visible
   in code review.

5. **No pointer arithmetic.** Go's memory safety eliminates buffer overflows, dangling pointers, and the memory
   corruption vulnerabilities that made Toyota's C code vulnerable to bit flips.

### Engineering Lessons

1. **Global variables are a safety hazard.** In safety-critical code, every global variable is a potential source
   of untracked state interaction. Eliminate them. Use dependency injection and explicit parameter passing.
2. **Untestable code is unsafe code.** If you cannot test a function in isolation, you cannot prove it is correct.
   Refactor until every function is independently testable.
3. **Independent safety monitors are mandatory.** Any task controlling a physical actuator must be independently
   monitored. If the task dies, the monitor must force a safe state.
4. **Brake override must be unconditional.** In automotive software, brake override must be checked on every
   control cycle with no exceptions and no code paths that can skip it.
5. **Code quality IS safety.** Spaghetti code with thousands of global variables is not just an aesthetic problem
   - it is a safety problem. The inability to reason about the code means the inability to ensure its correctness.

---

### Junior → FAANG: Global Variables and Testability as Interview Talking Points

The Toyota incident is the interview answer to "why are global variables problematic?" Most candidates say "they make code harder to reason about." The correct answer adds a second dimension: they make code untestable. Toyota's software had 11,000 global variables. The expert witnesses who analyzed the code found 67 functions that could not be unit tested in isolation because their behavior depended on global state that changed unpredictably across the codebase. Untestable functions cannot be proven correct. Unproven safety-critical functions killed people. The interview move: when asked about code quality principles, anchor the answer to testability as a proxy for correctness. "A function that cannot be tested in isolation cannot be proven correct, and code that cannot be proven correct is not safe for production." This framing elevates code quality from an aesthetic preference to an engineering obligation.

### Senior @ FAANG: Testability as a Safety Criterion and Independent Monitoring as an Architectural Standard

At L6, the Toyota incident is a code quality governance story. Toyota's ETCS had accumulated technical debt so severe that the software was functionally opaque: the experts hired to analyze it could not determine with confidence whether specific failure modes were possible. At staff level, testability is a production readiness criterion, not a team preference. Before any service is promoted to handle tier-0 traffic, every function in its critical path must have an isolated unit test that exercises the failure modes relevant to its safety invariants. "Critical path" is defined by blast radius: the functions that, if they fail silently, produce incorrect behavior that users experience without an error signal. In a throttle control system, that is the brake override function. In a payment service, that is the idempotency check. In a health data pipeline, that is the patient identifier validation. Identifying the critical path functions and verifying their isolation-testability is part of the production readiness review. The Toyota lesson is that allowing untestable critical path code to reach production is a governance failure, not a code quality preference.

The watchdog pattern in this section is also a platform standard. Any control loop that drives a physical actuator or an automated action with real-world consequences (auto-scaling, automated rollback, circuit breaker opening) must be independently monitored. The watchdog goroutine in this implementation is the Go idiom for that pattern: a separate goroutine with a heartbeat protocol that forces a safe state if the control loop stops. At scale, the watchdog may be an independent service rather than a goroutine, but the principle is identical: the monitoring must be independent enough that the failure of the controlled system does not prevent the watchdog from detecting the failure and responding.

