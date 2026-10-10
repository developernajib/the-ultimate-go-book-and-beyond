## 90H.6 Ariane 5: The $370 Million Integer Overflow (1996)

### The Background

On June 4, 1996, the European Space Agency's Ariane 5 rocket launched on its maiden flight (Flight 501). The
rocket carried four Cluster spacecraft - scientific satellites designed to study the Earth's magnetosphere. The
total payload value was approximately $370 million.

Approximately 37 seconds after launch, the rocket veered sharply off course, broke apart under aerodynamic
forces, and was destroyed by the range safety officer. The entire payload was lost.

The Ariane 5 was the successor to the highly successful Ariane 4, which had completed 113 flights with only
3 failures. The Ariane 5 was a completely new design with significantly different flight characteristics, but
many software components were reused from the Ariane 4 program. This reuse was intended to take advantage of proven,
reliable software. Instead, it was the direct cause of the failure.

### The Technical Root Cause

The investigation board, chaired by Jacques-Louis Lions, produced one of the most thorough and influential
failure analyses in the history of software engineering. The root cause was an unhandled data conversion
exception in the Inertial Reference System (IRS):

**The Overflow:** The IRS contained a function that calculated horizontal velocity (called BH - Bias Horizontal).
This function converted a 64-bit floating-point number to a 16-bit signed integer. The 64-bit value represented
the horizontal velocity of the rocket relative to the launch platform.

On the Ariane 4, the maximum horizontal velocity during the period when this function was active was well within
the range of a 16-bit signed integer (maximum value: 32,767). The function worked correctly for every Ariane 4
flight because the values never exceeded the 16-bit range.

The Ariane 5, however, had a fundamentally different flight profile. Its more powerful engines and different
trajectory meant that the horizontal velocity during the early flight phase was significantly higher than the
Ariane 4's. Approximately 37 seconds after launch, the horizontal velocity exceeded 32,767 - the maximum value
of a 16-bit signed integer. The conversion from 64-bit float to 16-bit integer caused an arithmetic overflow
exception.

**The Exception Handler:** The conversion was performed in Ada, which raises an exception on overflow by default
(unlike C, which silently wraps). The Ada code did not have an exception handler for this specific conversion.
When the exception occurred, it propagated up the call stack and was caught by a generic handler that performed
a diagnostic dump - writing the contents of the processor registers and memory to a bus that was connected to
the rocket's on-board computer (OBC).

The OBC interpreted this diagnostic data stream as navigation data. The diagnostic dump included a pattern that
the OBC interpreted as a massive course correction command. The OBC dutifully executed this "command," causing
the rocket's nozzles to swivel to their maximum deflection. The rocket pitched over violently. Within seconds,
the aerodynamic forces exceeded the structural limits of the vehicle, and it broke apart. The range safety
officer then triggered the self-destruct charges.

**The Identical Backup:** The Ariane 5 had a redundant IRS design - two independent Inertial Reference Systems
running in parallel, with automatic switchover if the primary failed. This should have been an effective safety
measure. However, both IRS units ran **identical software**. Both units experienced the **identical overflow** at
the **same moment**. When the primary IRS failed and the system switched to the backup, the backup had already
failed in the same way. The backup was not backup - it was a clone.

**The Unnecessary Calculation:** The function that overflowed (BH) was only needed **before launch**, during
the alignment phase of the inertial navigation system. It served no purpose after liftoff. The function
continued running after launch because it was part of a pre-launch calibration sequence that had a fixed
duration of 50 seconds - longer than the time between launch and the overflow. On the Ariane 4, this was
irrelevant because the values never exceeded the 16-bit range. On the Ariane 5, the function was running
unnecessarily, computing values that were irrelevant, and failing catastrophically because of values that
could never have occurred in the context for which it was designed.

### ESA's Reaction

The Lions report was published on July 19, 1996, just 45 days after the failure. It was remarkably thorough,
transparent, and self-critical:

- The report explicitly stated that the failure was a software design error, not a random hardware failure or
  an unpredictable event.
- The report identified that the conversion from 64-bit to 16-bit was not protected because an analysis had
  been performed for the Ariane 4 showing that the value could not exceed the 16-bit range. This analysis was
  correct for the Ariane 4 but had not been repeated for the Ariane 5's different flight profile.
- The report criticized the decision to reuse the Ariane 4 software without validating all assumptions against
  the Ariane 5's flight characteristics.
- The report recommended independent software validation, proper exception handling, and testing with flight-
  realistic data.

### Resolution

1. **All data conversions were protected against overflow** in subsequent Ariane 5 software versions.
2. **The BH function was modified to stop executing at liftoff**, since it was not needed during flight.
3. **The backup IRS was changed to use diverse software** - not an identical clone - so that a single software
   defect could not disable both units simultaneously.
4. **Testing was performed with Ariane 5 flight profile data**, not just Ariane 4 profiles.

### How It Could Have Been Prevented

1. **Protect every type conversion.** Every narrowing conversion (64-bit to 16-bit, float to int) must be
   explicitly checked for overflow at the point of conversion.
2. **Diverse redundancy, not cloned redundancy.** Backup systems must use independently developed software.
   Identical clones provide zero protection against software defects.
3. **Revalidate assumptions when reusing code.** When software is moved from one system to another, every
   assumption about the operating environment must be re-examined. The Ariane 4 assumption about maximum
   horizontal velocity was invalid for the Ariane 5.
4. **Disable unnecessary functions.** The BH function should have been terminated at liftoff. Code that has
   no purpose during a given operating phase should not be running.
5. **Test with realistic data from the target system.** The Ariane 5 software was tested with data from the
   Ariane 4 flight profile. A single test with the Ariane 5 trajectory would have revealed the overflow.

### Go Code: Safe Type Conversion

In Ada, narrowing conversions raise an exception when the value is out of range. The problem on Ariane 5 was not that Ada lacked protection, but that the exception was unhandled and its diagnostic output was misread as flight data. Go silently truncates out-of-range integer conversions, which is even more dangerous because there is no signal to catch. The `Float64ToInt16` function below makes the bounds check explicit and returns a typed `ConversionError` that the compiler forces the caller to handle. The `DiverseRedundancy` struct pairs two `NavigationComputer` implementations behind an interface so that primary and secondary can be independently developed, ensuring that a single software defect cannot simultaneously destroy both units, as happened when the Ariane 5's "backup" IRS failed identically to the primary.

```go
package safeconv

import (
	"errors"
	"fmt"
	"math"
)

// ConversionError represents a type conversion failure with full context.
type ConversionError struct {
	FromType string
	ToType   string
	Value    any
	Reason   string
}

func (e *ConversionError) Error() string {
	return fmt.Sprintf(
		"unsafe conversion from %s to %s: value %v - %s",
		e.FromType, e.ToType, e.Value, e.Reason,
	)
}

// Float64ToInt16 safely converts a float64 to int16, returning an error
// if the value would overflow. This is the exact conversion that
// destroyed the Ariane 5. In Ada, the overflow raises an exception.
// In C, it silently wraps. In Go with this function, it returns an
// explicit error that MUST be handled.
func Float64ToInt16(value float64) (int16, error) {
	if math.IsNaN(value) {
		return 0, &ConversionError{
			FromType: "float64",
			ToType:   "int16",
			Value:    value,
			Reason:   "value is NaN",
		}
	}
	if math.IsInf(value, 0) {
		return 0, &ConversionError{
			FromType: "float64",
			ToType:   "int16",
			Value:    value,
			Reason:   "value is infinite",
		}
	}
	if value > math.MaxInt16 || value < math.MinInt16 {
		return 0, &ConversionError{
			FromType: "float64",
			ToType:   "int16",
			Value:    value,
			Reason: fmt.Sprintf(
				"value %.2f outside int16 range [%d, %d]",
				value, math.MinInt16, math.MaxInt16,
			),
		}
	}
	return int16(value), nil
}

// Float64ToInt32 safely converts a float64 to int32.
func Float64ToInt32(value float64) (int32, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, &ConversionError{
			FromType: "float64",
			ToType:   "int32",
			Value:    value,
			Reason:   "value is NaN or infinite",
		}
	}
	if value > math.MaxInt32 || value < math.MinInt32 {
		return 0, &ConversionError{
			FromType: "float64",
			ToType:   "int32",
			Value:    value,
			Reason: fmt.Sprintf(
				"value %.2f outside int32 range [%d, %d]",
				value, math.MinInt32, math.MaxInt32,
			),
		}
	}
	return int32(value), nil
}

// Int64ToInt16 safely converts an int64 to int16.
func Int64ToInt16(value int64) (int16, error) {
	if value > math.MaxInt16 || value < math.MinInt16 {
		return 0, &ConversionError{
			FromType: "int64",
			ToType:   "int16",
			Value:    value,
			Reason: fmt.Sprintf(
				"value %d outside int16 range [%d, %d]",
				value, math.MinInt16, math.MaxInt16,
			),
		}
	}
	return int16(value), nil
}

// Uint64ToUint16 safely converts a uint64 to uint16.
func Uint64ToUint16(value uint64) (uint16, error) {
	if value > math.MaxUint16 {
		return 0, &ConversionError{
			FromType: "uint64",
			ToType:   "uint16",
			Value:    value,
			Reason: fmt.Sprintf(
				"value %d exceeds uint16 max %d",
				value, math.MaxUint16,
			),
		}
	}
	return uint16(value), nil
}

// SafeConverter provides a generic approach to safe numeric conversions
// with configurable overflow handling.
type SafeConverter struct {
	// OnOverflow is called when an overflow is detected.
	// It can log, alert, trigger a safe mode, etc.
	OnOverflow func(err *ConversionError)
}

// DemonstrateAriane5Failure shows the exact scenario that destroyed the rocket.
func DemonstrateAriane5Failure() {
	// Simulated horizontal velocity values during Ariane 5 flight
	// These are representative values showing how velocity increases
	velocities := []float64{
		1000.0,   // T+10s: well within int16 range
		15000.0,  // T+20s: still within range
		28000.0,  // T+30s: approaching limit
		32767.0,  // T+35s: at the limit
		32768.0,  // T+36s: OVERFLOW - this value destroyed Ariane 5
		40000.0,  // T+37s: the value at the time of actual failure
	}

	for i, vel := range velocities {
		result, err := Float64ToInt16(vel)
		if err != nil {
			// In the Ariane 5, this exception was unhandled and caused
			// a diagnostic dump that was misinterpreted as flight data.
			// With explicit error handling, we can take safe action.
			fmt.Printf("T+%ds: OVERFLOW DETECTED - velocity=%.0f - %v\n",
				(i+1)*5+5, vel, err)
			fmt.Println("  → Safe action: disable BH calculation (not needed in flight)")
			continue
		}
		fmt.Printf("T+%ds: velocity=%.0f → int16=%d (safe)\n",
			(i+1)*5+5, vel, result)
	}
}

// DiverseRedundancy demonstrates why backup systems must use different
// software. The Ariane 5's backup IRS was an identical clone.
type DiverseRedundancy struct {
	primary   NavigationComputer
	secondary NavigationComputer
}

// NavigationComputer is an interface for navigation computation.
// By using an interface, the primary and secondary can have different
// implementations - true diverse redundancy.
type NavigationComputer interface {
	ComputeVelocity(sensorData []float64) (float64, error)
	Name() string
}

// ErrAllComputersFailed indicates complete redundancy failure.
var ErrAllComputersFailed = errors.New("all navigation computers failed")

// ComputeWithFailover attempts the primary computer first, then the
// secondary. Unlike the Ariane 5, the secondary uses DIFFERENT software.
func (d *DiverseRedundancy) ComputeWithFailover(sensorData []float64) (float64, string, error) {
	result, err := d.primary.ComputeVelocity(sensorData)
	if err == nil {
		return result, d.primary.Name(), nil
	}

	// Primary failed - try secondary (which uses different implementation)
	fmt.Printf("WARNING: %s failed: %v - switching to %s\n",
		d.primary.Name(), err, d.secondary.Name())

	result, err = d.secondary.ComputeVelocity(sensorData)
	if err == nil {
		return result, d.secondary.Name(), nil
	}

	// Both failed - this is the catastrophic case
	return 0, "", fmt.Errorf(
		"%w: %s error: %v, %s error: %v",
		ErrAllComputersFailed,
		d.primary.Name(), err,
		d.secondary.Name(), err,
	)
}
```

**Why this prevents the Ariane 5 failure:**
- Every narrowing conversion explicitly checks for overflow and returns a typed error.
- Go's error handling forces the caller to deal with the overflow - it cannot silently propagate.
- The `DiverseRedundancy` pattern uses interfaces, ensuring primary and backup can have different implementations.
- The demonstration function shows exactly where the Ariane 5 overflow occurred and how it would be caught.

### Engineering Lessons

1. **Every narrowing type conversion is a potential overflow.** Treat every conversion from a wider type to a
   narrower type as a potential failure point. Check bounds explicitly.
2. **Identical backups provide zero software fault tolerance.** If the backup runs the same code, it will fail
   in the same way at the same time. True redundancy requires diverse implementation.
3. **Reused code carries reused assumptions.** When moving software from one system to another, every assumption
   about the operating environment must be re-examined. The valid range for Ariane 4 was not valid for Ariane 5.
4. **Disable code that has no purpose.** The function that overflowed was not needed during flight. Unnecessary
   running code is unnecessary risk.
5. **Test with target system data.** Testing the Ariane 5 software with Ariane 4 data was meaningless. Test with
   realistic data from the system you are actually deploying to.

---

### Junior → FAANG: Safe Type Conversion and Diverse Redundancy as Interview Topics

The Ariane 5 incident is the textbook example for "what is an integer overflow and how do you prevent it?" In Go, narrowing type conversions (from `int64` to `int16`, from `float64` to `int32`) silently truncate by default. The value 32768 converted to `int16` wraps to -32768 with no error, no panic, and no warning. The defense is explicit bounds checking before every narrowing conversion, as shown in the `Float64ToInt16` function in this section. For FAANG interviews, the lesson extends beyond the specific types: any time you move data from a wider representation to a narrower one (float to int, int64 to int32, string to fixed-length buffer), treat it as a potential failure point and validate the input explicitly. The second lesson is diverse redundancy: the backup IRS ran the same code on the same data. When the primary failed due to the overflow, the backup failed identically one millisecond later. True redundancy requires different implementations, not just different hardware. The `DiverseRedundancy` interface in this section demonstrates the Go idiom: primary and secondary implement the same interface, so they are interchangeable, but they can have completely different underlying implementations.

### Senior @ FAANG: Software Reuse Validation and Code That Has No Purpose as Platform Standards

At L6, the Ariane 5 incident surfaces two platform standards. The first is software reuse validation. When code developed for one system is reused in a new system, every assumption baked into the original code must be re-examined against the new system's parameters. The BH algorithm was safe for Ariane 4 because Ariane 4's horizontal velocity never exceeded the `int16` range. Ariane 5's higher velocity made that assumption false. At staff level, when a team proposes to reuse an existing component in a new context, the review must include an explicit assumption audit: what does this component assume about its input ranges, its execution environment, its timing constraints, and its callers? Each assumption must be verified against the new context before the reuse is approved.

The second standard is dead code removal. The BH function was not needed during Ariane 5's flight phase, but it continued running because nobody disabled it. Dead code that continues executing is a liability: it consumes resources, can interact with active code in unexpected ways, and as demonstrated by Ariane 5, can fail in ways that corrupt live system state. At platform level, the production readiness review includes a dead code audit: any code path that executes in production but is not exercised by any observable use case must be removed or explicitly disabled with a documented rationale for why it exists. The Go build system's build tags and the `//go:build ignore` constraint are the mechanisms for this. Production binaries should not contain unreachable code paths in safety-critical components.

