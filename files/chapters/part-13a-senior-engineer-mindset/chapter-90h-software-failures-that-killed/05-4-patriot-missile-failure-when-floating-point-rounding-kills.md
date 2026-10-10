## 90H.4 Patriot Missile Failure: When Floating-Point Rounding Kills (1991)

### The Background

During the 1991 Gulf War, American Patriot missile batteries were deployed to defend against Iraqi Scud missile
attacks. The Patriot system was designed as an anti-aircraft system and was adapted for the anti-ballistic missile
role during the Gulf War. The system used radar to track incoming missiles and guided Patriot interceptor missiles
to destroy them.

On February 25, 1991, an Iraqi Scud missile struck a U.S. Army barracks in Dhahran, Saudi Arabia, killing 28
American soldiers and injuring approximately 100 more. A Patriot missile battery was stationed nearby but failed
to intercept the Scud. The subsequent investigation by the U.S. General Accounting Office (GAO) determined that
the failure was caused by a software error in the Patriot's radar system: floating-point rounding error in the
system's time calculation.

### The Technical Root Cause

The Patriot system tracked time by counting the number of tenths of a second since the system was booted. This
counter was stored as a 24-bit integer. To calculate the actual time in seconds, the software multiplied the
counter by 0.1 (one-tenth).

The problem: the number 0.1 cannot be represented exactly in binary floating-point. In the Patriot's 24-bit
floating-point representation, 0.1 was represented as:

```
0.1 (decimal) ≈ 0.00011001100110011001100 (binary, 24 bits)
```

The exact decimal value of this binary representation is:

```
0.099999904632568359375
```

The error per tenth of a second is:

```
0.1 - 0.099999904632568359375 = 0.000000095367431640625 seconds
```

This error - approximately 0.0000001 seconds - seems negligible. But it accumulated with every tick of the
clock. Over time:

| Uptime | Accumulated Error |
|--------|------------------|
| 1 hour | 0.0034 seconds |
| 10 hours | 0.034 seconds |
| 100 hours | 0.34 seconds |

The Patriot battery in Dhahran had been running continuously for approximately 100 hours. By that time, the
clock had drifted by approximately 0.34 seconds.

**Why 0.34 seconds matters:** A Scud missile travels at approximately Mach 5 - about 1,676 meters per second.
In 0.34 seconds, a Scud travels approximately 570 meters - over half a kilometer. The Patriot system used the
time calculation to predict the Scud's position based on radar returns. With a 0.34-second error in the time
base, the predicted position was off by approximately 570 meters. The Patriot looked for the incoming Scud in
a "range gate" - a window of space where the missile was predicted to be. The Scud was outside this range gate.
The Patriot system classified the incoming object as a false alarm and did not fire an interceptor.

Twenty-eight soldiers were killed because a floating-point rounding error, accumulated over 100 hours of
continuous operation, caused a missile defense system to look for an incoming missile in the wrong part of the
sky.

### The Military's Reaction

- The Army had known about the timing drift issue before the Dhahran incident. On February 11, 1991 - two weeks
  before the attack - Israel identified the problem and reported it to the U.S. Army. The Army issued a
  bulletin recommending that Patriot batteries be rebooted periodically to reset the clock, but did not specify
  how often.
- The software patch that fixed the timing error arrived at the Dhahran base on February 26, 1991 - one day
  after the attack.
- The GAO report published in February 1992 (GAO/IMTEC-92-26) documented the failure in detail and attributed
  it directly to the floating-point rounding error.
- The incident led to significant changes in how military software handles time calculations, with requirements
  for periodic recalibration or use of integer-based time representations.

### Resolution

The fix was straightforward:

1. **Replaced floating-point time calculation with integer arithmetic.** Instead of multiplying the tick count by
   0.1 (introducing rounding error), the fixed code used integer division and modular arithmetic to convert ticks
   to seconds and fractional seconds without any floating-point operations.
2. **Added periodic recalibration.** The system was modified to periodically resync its internal clock against an
   external time reference.
3. **Rebooting schedule.** Until the patch was deployed, batteries were directed to reboot every 8 hours to limit
   error accumulation.

### How It Could Have Been Prevented

1. **Use integer arithmetic for time.** Represent time as integer nanoseconds or integer microseconds. Never use
   floating-point for cumulative time calculations.
2. **Use monotonic clocks.** Modern operating systems provide monotonic clocks that are not subject to the kind of
   drift caused by floating-point accumulation. Go's `time` package uses monotonic clocks by default.
3. **Bound error accumulation.** Any system that accumulates values over time must analyze worst-case error
   accumulation over the maximum expected operating period.
4. **Periodic recalibration.** Long-running systems should periodically resync against an authoritative time
   source.
5. **Test with realistic operating durations.** The Patriot was tested with short uptime periods. If it had been
   tested with 100+ hours of continuous operation, the drift would have been discovered.

### Go Code: Monotonic Clocks and Safe Time Handling

Go's `time` package is specifically designed to prevent the class of error that killed the Dhahran soldiers.
Since Go 1.9, `time.Now()` records both the wall clock time and a monotonic clock reading. Operations that
compute elapsed time automatically use the monotonic reading, which is immune to wall clock adjustments and
does not suffer from the floating-point accumulation error that affected the Patriot.

```go
package safetime

import (
	"fmt"
	"math"
	"time"
)

// DangerousPatriotClock demonstrates the WRONG way to track time  - 
// the method that killed 28 soldiers. The accumulated floating-point
// error grows with each tick.
type DangerousPatriotClock struct {
	tickCount   uint32  // Counts tenths of a second
	timeSeconds float64 // Calculated as tickCount * 0.1
}

// Tick advances the dangerous clock by one tenth of a second.
// Each tick accumulates a small floating-point error.
func (c *DangerousPatriotClock) Tick() {
	c.tickCount++
	// This is the fatal calculation. 0.1 cannot be represented exactly
	// in binary floating-point, so every multiplication introduces error.
	c.timeSeconds = float64(c.tickCount) * 0.1
}

// ActualError returns the accumulated error at the current tick count.
func (c *DangerousPatriotClock) ActualError() float64 {
	exactTime := float64(c.tickCount) / 10.0
	return math.Abs(exactTime - c.timeSeconds)
}

// DemonstratePatriotError shows how the error accumulates over 100 hours.
func DemonstratePatriotError() {
	clock := &DangerousPatriotClock{}

	checkpoints := []struct {
		hours int
		ticks uint32
	}{
		{1, 36000},        // 1 hour = 36,000 tenths of a second
		{10, 360000},      // 10 hours
		{100, 3600000},    // 100 hours - the Dhahran uptime
	}

	for _, cp := range checkpoints {
		// Advance to the checkpoint
		for clock.tickCount < cp.ticks {
			clock.Tick()
		}
		errorSec := clock.ActualError()
		// Scud speed ≈ 1676 m/s
		positionErrorMeters := errorSec * 1676.0
		fmt.Printf(
			"After %d hours: error = %.6f seconds, position error = %.1f meters\n",
			cp.hours, errorSec, positionErrorMeters,
		)
	}
}

// SafeMonotonicClock demonstrates the CORRECT way to track time using
// Go's monotonic clock. Go's time.Now() captures a monotonic reading
// that is used automatically for elapsed time calculations.
type SafeMonotonicClock struct {
	startTime time.Time // Contains monotonic reading since Go 1.9
}

// NewSafeMonotonicClock creates a clock anchored to the current time.
func NewSafeMonotonicClock() *SafeMonotonicClock {
	return &SafeMonotonicClock{
		startTime: time.Now(), // Captures monotonic reading
	}
}

// Elapsed returns the time since the clock was created.
// Go automatically uses the monotonic reading for this subtraction,
// so the result is:
// - Immune to wall clock changes (NTP adjustments, DST, leap seconds)
// - Computed using integer subtraction, not floating-point multiplication
// - Monotonically increasing - never goes backward
func (c *SafeMonotonicClock) Elapsed() time.Duration {
	return time.Since(c.startTime) // Uses monotonic clock internally
}

// ElapsedNanoseconds returns the elapsed time as integer nanoseconds.
// Integer arithmetic - no floating-point accumulation error possible.
func (c *SafeMonotonicClock) ElapsedNanoseconds() int64 {
	return time.Since(c.startTime).Nanoseconds()
}

// MissileTracker demonstrates a corrected tracking system that uses
// monotonic time for position prediction.
type MissileTracker struct {
	clock        *SafeMonotonicClock
	lastRadarHit time.Time
	lastPosition Position3D
	velocity     Velocity3D
}

// Position3D represents a position in 3D space using integer
// micrometers for precision without floating-point error.
type Position3D struct {
	XMicrometers int64
	YMicrometers int64
	ZMicrometers int64
}

// Velocity3D represents velocity in micrometers per nanosecond.
// Using integer arithmetic throughout prevents accumulation errors.
type Velocity3D struct {
	DxPerNanosecond int64
	DyPerNanosecond int64
	DzPerNanosecond int64
}

// PredictPosition predicts the current position based on the last
// radar hit and the elapsed time since that hit. Uses integer
// arithmetic throughout - no floating-point accumulation possible.
func (t *MissileTracker) PredictPosition() Position3D {
	// time.Since uses the monotonic clock - integer subtraction
	elapsed := time.Since(t.lastRadarHit).Nanoseconds()

	return Position3D{
		XMicrometers: t.lastPosition.XMicrometers + t.velocity.DxPerNanosecond*elapsed,
		YMicrometers: t.lastPosition.YMicrometers + t.velocity.DyPerNanosecond*elapsed,
		ZMicrometers: t.lastPosition.ZMicrometers + t.velocity.DzPerNanosecond*elapsed,
	}
}

// RangeGateCheck determines if a radar return is within the expected
// range gate for the predicted target position. The range gate is
// specified in micrometers for integer precision.
func (t *MissileTracker) RangeGateCheck(
	radarReturn Position3D,
	gateRadiusMicrometers int64,
) bool {
	predicted := t.PredictPosition()

	dx := radarReturn.XMicrometers - predicted.XMicrometers
	dy := radarReturn.YMicrometers - predicted.YMicrometers
	dz := radarReturn.ZMicrometers - predicted.ZMicrometers

	// Squared distance - avoids floating-point square root
	distSquared := dx*dx + dy*dy + dz*dz
	gateSquared := gateRadiusMicrometers * gateRadiusMicrometers

	return distSquared <= gateSquared
}
```

**Why Go prevents the Patriot failure:**
- `time.Now()` captures a monotonic clock reading (since Go 1.9) that uses integer nanoseconds internally.
- `time.Since()` and `time.Duration` operations use integer arithmetic - no floating-point accumulation.
- The type system encourages using `time.Duration` rather than raw floats for time calculations.
- Integer arithmetic for position and velocity calculations eliminates rounding error entirely.

### Engineering Lessons

1. **Floating-point arithmetic is not real arithmetic.** Floating-point numbers have finite precision. Operations
   that seem mathematically exact (like multiplying by 0.1) introduce rounding errors that accumulate over time.
2. **Use integer arithmetic for cumulative calculations.** When values are accumulated over many iterations, use
   integer arithmetic. Represent time as integer nanoseconds, positions as integer micrometers, currency as
   integer cents.
3. **Analyze error accumulation over maximum operating time.** If your system runs continuously, calculate the
   worst-case accumulated error after the maximum expected uptime. For the Patriot, a simple calculation would
   have shown the error reaching dangerous levels after approximately 20 hours.
4. **Test with realistic operating durations.** The Patriot was tested with short uptime periods. A 100-hour
   continuous test would have immediately revealed the drift.
5. **Periodic recalibration is a safety requirement.** Any system that accumulates state over time must
   periodically resync against an authoritative reference.

---

### Junior → FAANG: Integer Arithmetic and Monotonic Clocks as Go Interview Topics

The Patriot incident answers "why should you use integer arithmetic instead of floating-point for cumulative calculations?" The Patriot's tracking algorithm multiplied a floating-point representation of 1/10 by the tick count. Because 0.1 cannot be represented exactly in binary floating-point, each multiplication introduced a small error. After 100 hours, those errors accumulated to 0.34 seconds, which at Scud velocity produced a 687-meter position error, far outside the tracking window. In Go, the defense is `time.Duration` and `time.Since()`: both use integer nanoseconds internally, and `time.Now()` has captured a monotonic reading since Go 1.9. For currency, use integer cents. For positions, use integer micrometers. The rule: if a value accumulates through repeated arithmetic operations, use integer types. Floating-point is for one-shot calculations where rounding error does not accumulate.

### Senior @ FAANG: Numerical Error Budgets and Long-Duration Testing as Platform Standards

At L6, the Patriot incident is an argument for two platform engineering practices that most organizations skip. The first is numerical error budget analysis. For any system that performs cumulative arithmetic (timestamp tracking, cumulative counters, rolling averages, financial calculations), the platform should require a worst-case error analysis: given the maximum operating duration and the arithmetic precision used, what is the accumulated error at the end of that duration? If the accumulated error exceeds a safe threshold (in the Patriot's case, any error producing a range gate miss), the implementation must use higher-precision arithmetic or periodic recalibration. This analysis belongs in the service's design document, reviewed before implementation begins, not discovered during an incident investigation.

The second practice is long-duration soak testing. The Patriot's drift was not discoverable with the short test runs the system underwent before deployment. A 100-hour continuous operation test would have immediately revealed the drift. For any system that maintains state across multiple days of operation (counters, caches, accumulated metrics, rolling windows), the CI pipeline should include a soak test that runs the system under synthetic load for a duration that exercises the state accumulation behavior. A 24-hour soak test would have caught the Patriot drift in testing rather than in combat. The investment in soak test infrastructure is measured against the cost of discovering the same drift in production, and for any safety-critical or revenue-critical system, the infrastructure investment is always justified.

