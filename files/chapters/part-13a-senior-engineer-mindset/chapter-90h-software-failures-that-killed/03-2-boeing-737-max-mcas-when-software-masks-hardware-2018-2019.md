## 90H.2 Boeing 737 MAX MCAS: When Software Masks Hardware (2018-2019)

### The Background

The Boeing 737 MAX was Boeing's answer to the Airbus A320neo. The A320neo offered significantly better fuel
efficiency due to its new, larger CFM LEAP-1A engines. Boeing faced a critical competitive decision: design an
entirely new aircraft (which would take 7-10 years and cost $15-20 billion) or modify the existing 737 to accept
larger engines (which could be done in 3-4 years at a fraction of the cost). Boeing chose the modification.

The problem was physics. The 737's design dated to the 1960s, when it sat low to the ground with small engines
slung beneath the wings. The new CFM LEAP-1B engines were significantly larger in diameter. They could not be
mounted in the same position under the wings without scraping the ground. Boeing's solution was to mount the
engines further forward and higher on the wing. This changed the aerodynamic characteristics of the aircraft.
At high angles of attack (nose pitched up), the larger, forward-mounted engines generated additional lift ahead
of the aircraft's center of gravity, creating a nose-up pitching moment. This meant the 737 MAX had a tendency
to pitch up further when already at a high angle of attack - a characteristic that could lead to an aerodynamic
stall.

Rather than redesigning the aircraft or requiring pilots to undergo extensive retraining (which would have
undermined Boeing's sales pitch that existing 737 pilots could fly the MAX with minimal additional training),
Boeing created a software system called MCAS - the Maneuvering Characteristics Augmentation System. MCAS was
designed to automatically push the nose down when sensors detected a high angle of attack, compensating for the
aerodynamic change introduced by the new engine placement. The intent was to make the 737 MAX feel identical to
the 737 NG for pilots.

### The Fatal Design Decisions

MCAS had several critical design flaws, each of which individually might have been survivable, but in combination
were lethal:

**Single Sensor Dependency:** MCAS read angle-of-attack (AoA) data from only one of the aircraft's two AoA
sensors. It did not compare the readings from both sensors or use any voting algorithm. If that single sensor
failed or provided erroneous data, MCAS would act on the bad data with no cross-check.

**Excessive Authority:** In early designs, MCAS could deflect the horizontal stabilizer by 0.6 degrees per
activation. After flight testing revealed that the aerodynamic issue was worse than initially modeled, Boeing
increased MCAS's authority to 2.5 degrees per activation - a four-fold increase. This change was made without
updating the safety analysis, which had been performed for the 0.6-degree limit.

**Repeated Activation:** MCAS could activate repeatedly, each time pushing the nose down further. There was no
limit on the total cumulative nose-down input. If MCAS was acting on erroneous sensor data, it would continue
pushing the nose down until the stabilizer reached its physical limit.

**No Pilot Notification:** MCAS was not described in the pilot training materials or the aircraft flight manual.
Pilots were not told it existed. When it activated erroneously, pilots had no understanding of what was
happening to their aircraft and no training on how to respond.

**Disagree Alert Sold as Optional:** Boeing offered an "AoA Disagree" indicator as an optional, extra-cost
feature. This indicator would have warned pilots when the two AoA sensors gave significantly different readings
 -  precisely the condition that would cause MCAS to malfunction. Airlines that did not purchase this option had
no warning that their AoA data was unreliable.

### The Crashes

**Lion Air Flight 610 - October 29, 2018:**

The aircraft, a nearly new 737 MAX 8, departed Jakarta, Indonesia. Immediately after takeoff, the captain's AoA
sensor began transmitting erroneous data showing the aircraft at a dangerously high angle of attack. The sensor
had been improperly repaired by a maintenance crew the previous day. MCAS activated, pushing the nose down. The
pilots pulled back on the control column to counteract the nose-down input. MCAS activated again. And again. For
eleven minutes, the pilots fought MCAS in a deadly tug-of-war. The pilots pulled up. MCAS pushed down. They
pulled up again. MCAS pushed down again. The flight data recorder showed 21 MCAS activations. The pilots never
understood what was happening - they had never been told MCAS existed. The aircraft crashed into the Java Sea at
over 400 knots, killing all 189 people on board.

**Ethiopian Airlines Flight 302 - March 10, 2019:**

Five months after Lion Air 610, and with the 737 MAX still in service worldwide, an Ethiopian Airlines 737 MAX 8
departed Addis Ababa. Within seconds of takeoff, the left AoA sensor again provided erroneous data. MCAS
activated. The captain and first officer, who had been briefed on the Lion Air crash and were aware of the
recommended procedure to disable the electric stabilizer trim, followed the procedure. They flipped the stabilizer
cutout switches to the off position. But at the speed the aircraft was traveling, the aerodynamic forces on the
stabilizer were so great that the pilots could not manually move it using the trim wheel. The aircraft's nose was
being forced down by the stabilizer position that MCAS had driven it to, and the pilots did not have the physical
strength to counteract it manually. In desperation, they turned the electric trim back on, hoping to use it to
correct the stabilizer position. MCAS immediately reactivated and drove the nose down further. The aircraft
crashed into a field six minutes after takeoff at over 500 knots, killing all 157 people on board.

Total death toll: 346 people.

### Boeing's Reaction

Boeing's response was widely condemned as prioritizing corporate reputation and financial interests over safety:

- After Lion Air 610, Boeing issued a bulletin reminding pilots of the existing runaway trim procedure, but did
  not ground the aircraft, did not disclose the full capabilities of MCAS, and did not explain that MCAS could
  repeatedly activate.
- After Ethiopian Airlines 302, Boeing initially resisted grounding the aircraft. It took pressure from regulators
  worldwide - including China, the EU, and eventually the FAA - to ground the fleet.
- Internal communications later revealed that Boeing employees had known about MCAS issues during development.
  One employee wrote in 2016: "This airplane is designed by clowns who in turn are supervised by monkeys."
  Another wrote: "I still haven't been forgiven by God for the covering up I did last year."
- Boeing's CEO Dennis Muilenburg was fired in December 2019.
- Boeing agreed to pay $2.5 billion in a deferred prosecution agreement with the DOJ in January 2021, including
  $500 million in compensation to the families of the 346 victims.
- Total estimated cost to Boeing exceeded $20 billion in grounding costs, settlements, lost orders, and
  production delays.

### Resolution

The 737 MAX was grounded worldwide for 20 months. The fix included:

1. MCAS now reads from **both** AoA sensors and compares them. If the sensors disagree by more than 5.5 degrees,
   MCAS is disabled.
2. MCAS can only activate **once** per erroneous event, not repeatedly.
3. MCAS's authority was reduced, and it can never command more nose-down input than the pilots can counteract.
4. The AoA Disagree alert is now **standard** on all 737 MAX aircraft.
5. Pilots must complete enhanced training that specifically covers MCAS.

### How It Could Have Been Prevented

1. **Redundant sensor voting.** A system that depends on sensor data for safety-critical decisions must use
   multiple independent sensors and a voting algorithm. A single sensor is a single point of failure.
2. **Authority limits.** No automated system should have more authority than a human can override. MCAS could
   drive the stabilizer to a position that pilots physically could not counteract.
3. **Transparent documentation.** Safety-critical automated systems must be documented in pilot training materials.
   Pilots cannot respond correctly to a system they do not know exists.
4. **Independent safety analysis when parameters change.** When MCAS authority was increased from 0.6 to 2.5
   degrees, the safety analysis should have been redone from scratch.
5. **Safety features must not be optional extras.** The AoA Disagree indicator should have been standard equipment
   from the beginning.

### Go Code: Redundant Sensor Voting System

The MCAS failure was fundamentally an architecture problem: a safety-critical actuator was controlled by a single, unverified data source. The `RedundantSensorVoter` below implements N-modular redundancy (the same principle used in fly-by-wire aircraft and nuclear control systems), requiring a quorum of sensors to agree before any value is trusted. If two AoA sensors diverge by more than the configured threshold (Boeing's post-crash fix uses 5.5°), the voter refuses to produce a fused value and the caller must disable the system rather than guess. The `MCASController` wraps this voter and enforces a one-activation-per-event ceiling, making it physically impossible to repeat the runaway stabilizer sequence that killed 346 people.

```go
package sensorvoting

import (
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

// SensorReading represents a single reading from a physical sensor.
type SensorReading struct {
	SensorID  string
	Value     float64
	Timestamp time.Time
	Valid     bool
}

// SensorFusionResult is the output of the voting algorithm.
type SensorFusionResult struct {
	FusedValue       float64
	Confidence       float64 // 0.0 to 1.0
	AgreementCount   int
	DisagreementCount int
	FailedSensors    []string
	Timestamp        time.Time
}

// VotingConfig configures the redundant sensor voting system.
type VotingConfig struct {
	// MinimumSensors is the minimum number of agreeing sensors required
	// to produce a valid fused reading. For safety-critical applications,
	// this should be at least 2.
	MinimumSensors int

	// DisagreementThreshold is the maximum allowed difference between
	// any two sensor readings before they are considered to disagree.
	// Boeing's fix uses 5.5 degrees for AoA sensors.
	DisagreementThreshold float64

	// StaleThreshold is the maximum age of a sensor reading before it
	// is considered stale and excluded from voting.
	StaleThreshold time.Duration
}

// RedundantSensorVoter implements N-modular redundancy with voting
// for safety-critical sensor fusion. This is what MCAS should have used.
type RedundantSensorVoter struct {
	mu       sync.RWMutex
	config   VotingConfig
	readings map[string]SensorReading // sensorID -> latest reading
}

// NewRedundantSensorVoter creates a new voter with the given configuration.
func NewRedundantSensorVoter(config VotingConfig) *RedundantSensorVoter {
	if config.MinimumSensors < 2 {
		// Safety-critical systems MUST require at least 2 agreeing sensors.
		// This is the fundamental lesson of MCAS.
		config.MinimumSensors = 2
	}
	return &RedundantSensorVoter{
		config:   config,
		readings: make(map[string]SensorReading),
	}
}

// UpdateReading records a new reading from a sensor.
func (v *RedundantSensorVoter) UpdateReading(reading SensorReading) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.readings[reading.SensorID] = reading
}

// Vote performs the sensor voting algorithm and returns the fused result.
// If insufficient sensors agree, the result indicates low confidence and
// the caller MUST NOT act on the fused value.
func (v *RedundantSensorVoter) Vote() (*SensorFusionResult, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	now := time.Now()
	result := &SensorFusionResult{Timestamp: now}

	// Step 1: Collect valid, non-stale readings.
	var validReadings []SensorReading
	for _, r := range v.readings {
		if !r.Valid {
			result.FailedSensors = append(result.FailedSensors, r.SensorID)
			continue
		}
		if now.Sub(r.Timestamp) > v.config.StaleThreshold {
			result.FailedSensors = append(result.FailedSensors, r.SensorID)
			continue
		}
		validReadings = append(validReadings, r)
	}

	if len(validReadings) < v.config.MinimumSensors {
		return result, fmt.Errorf(
			"insufficient valid sensors: have %d, need %d - SYSTEM DISABLED",
			len(validReadings), v.config.MinimumSensors,
		)
	}

	// Step 2: Find the largest group of sensors that agree within threshold.
	// This is a simplified clustering algorithm for sensor fusion.
	bestGroup := findLargestAgreementGroup(validReadings, v.config.DisagreementThreshold)

	if len(bestGroup) < v.config.MinimumSensors {
		// Sensors are providing contradictory data - exactly the MCAS failure mode.
		// The correct response is to DISABLE the system, not to trust one sensor.
		result.DisagreementCount = len(validReadings) - len(bestGroup)
		result.AgreementCount = len(bestGroup)
		return result, fmt.Errorf(
			"sensor disagreement detected: only %d of %d sensors agree (need %d) - SYSTEM DISABLED",
			len(bestGroup), len(validReadings), v.config.MinimumSensors,
		)
	}

	// Step 3: Compute the fused value as the median of agreeing sensors.
	// Median is more robust to outliers than mean.
	result.FusedValue = medianValue(bestGroup)
	result.AgreementCount = len(bestGroup)
	result.DisagreementCount = len(validReadings) - len(bestGroup)
	result.Confidence = float64(len(bestGroup)) / float64(len(validReadings))

	return result, nil
}

// findLargestAgreementGroup finds the largest subset of readings where
// all readings are within threshold of each other.
func findLargestAgreementGroup(readings []SensorReading, threshold float64) []SensorReading {
	if len(readings) == 0 {
		return nil
	}

	var bestGroup []SensorReading

	for i := range readings {
		var group []SensorReading
		group = append(group, readings[i])
		for j := range readings {
			if i == j {
				continue
			}
			if math.Abs(readings[i].Value-readings[j].Value) <= threshold {
				group = append(group, readings[j])
			}
		}
		if len(group) > len(bestGroup) {
			bestGroup = group
		}
	}

	return bestGroup
}

// medianValue computes the median of a set of sensor readings.
func medianValue(readings []SensorReading) float64 {
	if len(readings) == 0 {
		return 0
	}
	values := make([]float64, len(readings))
	for i, r := range readings {
		values[i] = r.Value
	}
	// Simple sort for small N (sensor count is typically 2-5)
	for i := range values {
		for j := i + 1; j < len(values); j++ {
			if values[j] < values[i] {
				values[i], values[j] = values[j], values[i]
			}
		}
	}
	mid := len(values) / 2
	if len(values)%2 == 0 {
		return (values[mid-1] + values[mid]) / 2
	}
	return values[mid]
}

// MCASController demonstrates a corrected MCAS-like system that uses
// redundant sensor voting instead of trusting a single sensor.
type MCASController struct {
	voter           *RedundantSensorVoter
	maxNoseDownAuth float64 // Maximum nose-down authority in degrees
	activationCount int     // Track activations for limiting
	maxActivations  int     // Maximum activations per event
	mu              sync.Mutex
}

// NewMCASController creates a corrected MCAS controller.
func NewMCASController() *MCASController {
	voter := NewRedundantSensorVoter(VotingConfig{
		MinimumSensors:        2,
		DisagreementThreshold: 5.5, // Degrees - Boeing's post-crash threshold
		StaleThreshold:        500 * time.Millisecond,
	})
	return &MCASController{
		voter:           voter,
		maxNoseDownAuth: 0.6, // Degrees - not the inflated 2.5
		maxActivations:  1,   // One activation per event - not unlimited
	}
}

// ErrMCASDisabled indicates that MCAS has been safely disabled.
var ErrMCASDisabled = errors.New("MCAS disabled due to sensor disagreement")

// Evaluate checks whether MCAS intervention is needed.
// Returns the recommended stabilizer adjustment, or an error if the
// system cannot make a safe determination.
func (c *MCASController) Evaluate() (float64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Check activation limit - prevents the repeated activation that
	// killed 346 people
	if c.activationCount >= c.maxActivations {
		return 0, nil // No further intervention
	}

	result, err := c.voter.Vote()
	if err != nil {
		// Sensor disagreement or insufficient sensors.
		// The correct response is to DISABLE MCAS, not guess.
		return 0, ErrMCASDisabled
	}

	// Only intervene if sensors agree on a high AoA
	if result.Confidence < 0.8 {
		return 0, ErrMCASDisabled
	}

	aoaDegrees := result.FusedValue

	// Only activate if AoA exceeds threshold
	const aoaThreshold = 12.0 // Degrees
	if aoaDegrees <= aoaThreshold {
		return 0, nil
	}

	// Calculate intervention, capped at maximum authority
	intervention := math.Min(aoaDegrees-aoaThreshold, c.maxNoseDownAuth)
	c.activationCount++

	return -intervention, nil // Negative = nose down
}

// Reset resets the activation counter. Called when the triggering
// condition clears.
func (c *MCASController) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.activationCount = 0
}
```

**Why this prevents the MCAS failure:**
- Requires at least 2 sensors to agree before acting - a single faulty sensor disables the system.
- Limits to one activation per event - no repeated nose-down commands.
- Caps authority at a level pilots can physically override.
- Sensor disagreement disables the system rather than trusting one sensor.

### Engineering Lessons

1. **Never use a single sensor for safety-critical decisions.** Single points of failure in sensor systems are
   architectural malpractice. Redundancy with voting is the minimum standard.
2. **Software should not mask hardware problems.** MCAS was designed to hide the aerodynamic consequences of a
   hardware design compromise. The correct solution was to fix the hardware (redesign the aircraft).
3. **Authority limits must be inviolable.** No automated system should have more authority than a human can
   override. MCAS could drive the stabilizer to a position pilots could not physically counteract.
4. **Safety features are not optional extras.** The AoA Disagree indicator should have been standard. Selling
   safety as an upgrade is unconscionable.
5. **When you change parameters, redo the safety analysis.** Increasing MCAS authority from 0.6 to 2.5 degrees
   without updating the safety analysis was a direct cause of the crashes.

---

### Junior → FAANG: Single Points of Failure in Sensor Systems as a System Design Pattern

The Boeing 737 MAX incident is the clearest possible illustration of why single points of failure are an architectural anti-pattern. MCAS trusted one angle-of-attack sensor. When that sensor failed (due to a faulty installation), the system made an incorrect determination and repeatedly drove the nose down, overriding the pilots. The interview framing: in any system where a single data source drives an automated action that is difficult to reverse, that data source is a single point of failure. The defense is N-modular redundancy with voting: collect readings from N independent sensors, compute agreement, and refuse to act if agreement is below threshold. The `RedundantSensorVoter` in this section implements this pattern in Go. It applies directly to non-aviation systems: a service that acts on a single health check signal, a configuration system that trusts a single source of truth, or an auto-scaling controller that reads from a single metrics endpoint are all the same architectural pattern as MCAS.

### Senior @ FAANG: Software Masking Hardware Problems as an Anti-Pattern and Authority Limits as a Platform Standard

At L6, the MCAS incident surfaces a design principle that applies to every automated system in your infrastructure: automated systems must have authority limits that humans can override, and those limits must be defined as architectural constraints, not as configuration parameters that can be changed without safety review. MCAS's authority was increased from 0.6 to 2.5 degrees without updating the safety analysis. At 2.5 degrees of repeated activation, the stabilizer reached a position pilots could not physically override. The principle: any automated system that takes an action affecting human safety must have a maximum authority that leaves the human in control, and that maximum must require a formal safety review to change.

For infrastructure automation, the same principle applies: an automated rollback system should never take an action that leaves the service in a state the on-call engineer cannot manually reverse. An auto-scaling system should never scale down below a minimum that the team has explicitly approved. A circuit breaker should never open in a way that requires a deployment to close. Authority limits for automated systems are a platform governance decision, not a team-level configuration choice. At staff level, you define the authority limit framework: what automated actions are permitted, at what scale, and what human approval is required to exceed those limits. The 346 people killed by MCAS died partly because a parameter change bypassed the safety review that would have caught the authority overrun. Your platform's governance process exists to prevent the same class of error in your domain.

