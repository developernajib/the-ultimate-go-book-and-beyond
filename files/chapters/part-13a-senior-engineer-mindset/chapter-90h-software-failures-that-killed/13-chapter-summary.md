## Exercises

Practical engineering exercises applying Go concurrency, type safety, and fault-tolerance patterns to prevent fatality-class system defects.

### Exercise 1: Mutex-Guarded Safety Interlock (Therac-25 Pattern)
- **Context:** Medical device firmware controlling an electron radiation emitter.
- **Task:** Implement an `EmissionController` struct that coordinates a turntable physical position with an electron beam emitter:
  1. In `ElectronMode` (low energy, 25 MeV), the turntable must be in position `TurntableTargetOut` with spreading foil engaged.
  2. In `XRayMode` (high energy, 25 MeV), the turntable must be in position `TurntableTargetIn` with a tungsten converter target and beam flattener.
  3. **Safety Invariant:** The beam emitter method `FireBeam(ctx context.Context, duration time.Duration) error` must acquire a hardware verification lock, verify that the physical position sensor matches the requested mode, and verify that beam energy calibration completed within the last 500ms. If any invariant fails, emit an emergency shutdown and return a strongly-typed `ErrSafetyInterlockTripped`.
  4. Ensure zero un-synchronized shared state and verify with `go test -race`.

### Exercise 2: Triple-Modular Redundant Sensor Voter (Boeing 737 MAX Pattern)
- **Context:** Flight control module evaluating Angle-of-Attack (AoA) sensor telemetry.
- **Task:** Build an N-modular redundancy voter `type SensorVoter struct`:
  1. Accepts reading from 3 independent AoA sensors: `AoASensorLeft`, `AoASensorRight`, and `AoASensorBackup`.
  2. Implement `Vote(readings []SensorReading, tolerance float64) (float64, error)`.
  3. If 2 or 3 sensors agree within `tolerance` degrees, return the median or mean of the agreeing sensors.
  4. If all 3 sensors disagree beyond `tolerance`, or if fewer than 2 sensors provide fresh telemetry (< 100ms old), the voter must immediately trip a `FailPassive` state, disable automated stabilizer trim, and alert the flight deck. Under no circumstances may an automated action occur on a single sensor's telemetry.

### Exercise 3: Overflow-Proof Narrowing Conversion Pipeline (Ariane 5 Pattern)
- **Context:** Inertial reference platform processing trajectory metrics.
- **Task:** Create a safe numerical conversion package `safeconv`:
  1. Implement `Int64ToInt16(val int64) (int16, error)` and `Float64ToInt16(val float64) (int16, error)`.
  2. If `val > math.MaxInt16` or `val < math.MinInt16`, return `0, ErrIntegerOverflow`.
  3. Implement a dead-code and active-state validator: ensure that if a diagnostic trajectory calculation is not required after liftoff (flight phase > 0), its goroutine is terminated or isolated from actuator channels.

### Exercise 4: Type-Safe Physical Units with Compile-Time Guarantees (Mars Climate Orbiter Pattern)
- **Context:** Deep-space trajectory thruster telemetry processing.
- **Task:** Construct a type-safe unit library:
  1. Define distinct non-interchangeable types: `type PoundForce float64`, `type Newton float64`, `type NewtonSecond float64`, and `type PoundForceSecond float64`.
  2. Provide explicit conversion methods: `(p PoundForce) ToNewtons() Newton` (1 lbf ≈ 4.4482216 N) and `(p PoundForceSecond) ToNewtonSeconds() NewtonSecond`.
  3. Implement `CalculateDeltaV(thrust NewtonSecond, massKg float64) float64`. Ensure that attempting to pass `PoundForceSecond` directly to `CalculateDeltaV` causes a compile-time failure.

### Exercise 5: Non-Blocking Alarm Pipeline with Staleness Watchdog (2003 Blackout Pattern)
- **Context:** Power grid supervisory control and data acquisition (SCADA) alarm pipeline.
- **Task:** Implement an `AlarmPipeline` that decouples telemetry ingestion from display rendering:
  1. Use buffered channels with non-blocking drops of low-priority events, but strict persistent queuing for severity `Critical` events.
  2. Implement an independent watchdog goroutine that sends heartbeat pings through the alarm processing queue every 1 second.
  3. If the alarm processor fails to process a heartbeat within 3 seconds (indicating deadlock, lock contention, or queue exhaustion), the watchdog trips an out-of-band acoustic and visual alert: "ALARM SUBSYSTEM SILENT FAILURE DETECTED".

---

## Summary

| Incident | Year | Deaths/Cost | Root Cause | Go Prevention |
|----------|------|-------------|------------|---------------|
| Therac-25 | 1985-87 | 4+ deaths | Race condition, incremented flag, no hardware interlock | `sync.Mutex`, explicit enum types, independent sensor verification |
| Boeing 737 MAX | 2018-19 | 346 deaths, $20B+ | Single AoA sensor, unlimited MCAS authority | Redundant sensor voting, authority limits, sensor disagreement disabling |
| Toyota UA | 2002-10 | 89+ deaths | 11,000 globals, untestable code, no watchdog | Package encapsulation, interface-based DI, independent watchdog goroutine |
| Patriot Missile | 1991 | 28 deaths | Float rounding, 0.34s drift over 100hrs | `time.Duration` integer nanoseconds, monotonic clock, integer arithmetic |
| Uber SDC | 2018 | 1 death | Classification reset, AEB disabled, jaywalking unmodeled | Classification-independent tracking, never disable safety systems |
| Ariane 5 | 1996 | $370M | 64-to-16 bit overflow, identical backup | Safe conversion with error return, diverse redundancy via interfaces |
| Mars Climate Orbiter | 1999 | $327M | lbf-s vs N-s unit mismatch | Type-safe unit types, compile-time unit enforcement |
| NE Blackout | 2003 | 55M without power, $6B | Race condition in alarm system, silent failure | Channel-based alarm processing, self-monitoring watchdog |
| VW Dieselgate | 2009-15 | $33.3B fines, public health | Deliberate defeat device | Engineering ethics - refuse, document, report |
| Boeing Starliner | 2019-22 | $1.5B+ overruns | 11hr timer offset, no E2E test | Clock sync verification, end-to-end test framework |

**The fundamental lesson:** Software quality in safety-critical systems is not a technical preference - it is a
moral obligation. Every practice covered in this chapter - proper concurrency, redundant sensors, safe type
conversions, monotonic clocks, type-safe units, self-monitoring alarms, end-to-end testing - is a well-understood
engineering technique. The incidents happened not because the solutions were unknown, but because the solutions
were not applied. As engineers, our obligation is to apply them, every time, without exception, regardless of
schedule pressure, budget constraints, or management directives. The alternative is measured in coffins.

### Junior → FAANG: The Summary Table as Interview Preparation

The summary table above is a study card for technical interviews. Each row gives you: the incident name for narrative context, the root cause category (race condition, integer overflow, single point of failure, type mismatch, missing test), and the specific Go pattern that addresses it. When an interviewer asks about race condition prevention, Therac-25 and the Northeast Blackout give you two concrete anchors. When they ask about type safety, MCO and Ariane 5 are your examples. When they ask about single points of failure, the Boeing 737 MAX is your answer. Memorize the root cause column. The technical patterns follow naturally from each root cause, and the incidents make the patterns memorable.

### Senior @ FAANG: Chapter Artifacts as Production Readiness Criteria

At L6, each Go implementation in this chapter is a candidate component of your production readiness review checklist for safety-critical or high-stakes systems. The `RedundantSensorVoter` is the sensor fusion pattern that any system relying on a single data source for automated action should implement. The `AlarmProcessor` with self-monitoring watchdog is the observability architecture standard for any alert-generating system. The `SafeConverter` functions are the type safety standard for any system that performs narrowing numeric conversions. The `EndToEndTestRunner` is the integration test framework template for any system with phase transitions between subsystems. Adding these patterns to your production readiness review, with explicit criteria for when each applies and what passing looks like, converts the lessons of this chapter from engineering knowledge into organizational standards. That conversion is the staff engineer's contribution: not implementing safety patterns in one service, but making safety patterns the default for every service your organization builds.

---

### What's Next

Proceed to **[Chapter 90I: Data Breaches and Security Disasters - Lessons from the Worst Hacks in History](../chapter-90i-data-breaches-security-disasters/00-introduction.md)** to examine how architectural vulnerabilities, supply chain compromises, and cryptographic implementation errors caused the largest data breaches in computing history - and how to construct defense-in-depth security architectures in Go.
