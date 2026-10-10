## Deep Dive: Fraud Detection

Fraud detection is essential in a platform that handles millions of financial transactions daily. Common fraud patterns include GPS manipulation (spoofing location to inflate fares), driver-rider collusion (fake trips to earn promotions), and short-distance trips with suspiciously high fares. This service combines rule-based checks with a machine learning model to produce a composite fraud score.

Before the working version, study the one below, because it is the most instructive piece of broken code in this chapter. It is what a fraud detector looks like when nobody checks whether it detects fraud.

```go
// BROKEN. Study this, do not copy it.
func (d *FraudDetector) Analyze(ctx context.Context, trip Trip, pay Payment) *FraudSignal {
	s := &FraudSignal{TripID: trip.ID, Timestamp: time.Now()}
	if trip.DistanceKm < 0.5 && trip.FinalPrice > 50 {
		s.Signals = append(s.Signals, "short_dist_high_fare"); s.Score += 0.3
	}
	if d.isRouteManipulated(trip) { s.Signals = append(s.Signals, "gps_manipulation"); s.Score += 0.5 }
	if d.isCollusion(ctx, trip.RiderID, trip.DriverID) { s.Signals = append(s.Signals, "collusion"); s.Score += 0.4 }
	mlScore := d.ml.Predict(ctx, trip, pay)
	s.Score = (s.Score + mlScore) / 2
	if s.Score > 0.7 { d.alerts.Raise(ctx, s) }
	return s
}

func (d *FraudDetector) isRouteManipulated(t Trip) bool { return false }
func (d *FraudDetector) isCollusion(ctx context.Context, r, dr string) bool { return false }
```

That code raises an alert exactly zero times, for any input, forever. Work through why, because every step is a mistake you will meet again.

The two stubs `return false`. Not "return false for now", not a TODO, just false. So the `gps_manipulation` and `collusion` branches are unreachable, and the two highest-weighted rules in the system are decoration. The only rule that can fire contributes 0.3, which halves to 0.15, against a threshold of 0.7.

Now suppose you implement both stubs. The alert still never fires on rules alone: all three rules firing is 0.3+0.5+0.4 = 1.2, and `(1.2 + 0)/2 = 0.6`, still under 0.7. A trip that trips every fraud rule the team wrote is not reported. Worse, the ML model cannot fire alone either, since a model screaming 1.0 certainty with no rules hit yields `(0 + 1.0)/2 = 0.5`. Averaging two sources means each one silently caps at half the combined score, so neither can ever raise the alarm by itself, which is the opposite of what a detector is for. The averaging also lets the total reach 1.1, which is a nonsense value for something the threshold treats as a probability.

Then the failure mode that ties it together: `Predict` returns a bare `float64` with no error. When the model service times out, it returns the zero value, and zero means innocent. A fraud pipeline that reads "model unreachable" as "this trip is fine" fails open on money, at exactly the moment an attacker who noticed the outage would want it to.

None of this shows up in testing, because the thing being tested is silence, and the code is silent when it works and silent when it is broken. That is the property to be afraid of. When a component's success condition is "nothing happened", you must test that it can still say something, or you have not tested it at all.

The version below fixes each of these: real checks instead of stubs, a normalized score with each source able to escalate independently, and an ML failure that degrades toward review rather than toward silence.

```go
package fraud

import (
	"context"
	"fmt"
	"math"
	"time"
)

// Scores are probabilities in [0,1]. Anything that can produce 1.1 is not one.
const (
	alertThreshold    = 0.7
	ruleOnlyThreshold = 0.6 // rules can escalate without the model's agreement
)

type FraudDetector struct {
	ml     FraudMLModel
	trips  TripHistory
	alerts AlertService
	clock  func() time.Time
}

type FraudSignal struct {
	TripID    string
	Score     float64
	Signals   []string
	Degraded  bool // true when the model could not be consulted
	Timestamp time.Time
}

// Analyze scores a completed trip and escalates when warranted.
// It returns an error only when it could not reach a verdict at all, which the
// caller must treat as "needs review", never as "clean".
func (d *FraudDetector) Analyze(ctx context.Context, trip Trip, pay Payment) (*FraudSignal, error) {
	s := &FraudSignal{TripID: trip.ID, Timestamp: d.clock()}

	ruleScore := 0.0
	add := func(name string, weight float64) {
		s.Signals = append(s.Signals, name)
		ruleScore += weight
	}

	// Fare wildly out of line with distance covered. Money in cents.
	if trip.DistanceKm < 0.5 && trip.FinalPriceCents > 5_000 {
		add("short_dist_high_fare", 0.3)
	}

	// GPS manipulation: a real check, not a stub. Road distance can never be
	// shorter than the straight line between the endpoints, so a reported
	// distance below that is physically impossible and means the trace was
	// fabricated. The tolerance absorbs honest GPS noise.
	straightLineKm := haversineKm(trip.PickupLat, trip.PickupLng, trip.DropoffLat, trip.DropoffLng)
	if trip.DistanceKm < straightLineKm*0.95 {
		add("impossible_route_distance", 0.5)
	}

	// Implausible average speed for the trip's duration.
	if trip.DurationSeconds > 0 {
		kmh := trip.DistanceKm / (float64(trip.DurationSeconds) / 3600)
		if kmh > 200 {
			add("impossible_speed", 0.5)
		}
	}

	// Collusion: the same rider and driver pairing repeatedly is the signature
	// of fake trips farming promotions. A genuine repeat pairing happens, so
	// this is a signal, not a verdict.
	pairCount, err := d.trips.CountPairTrips(ctx, trip.RiderID, trip.DriverID, 7*24*time.Hour)
	if err != nil {
		// Cannot evaluate the rule. Say so rather than scoring it as clean.
		return nil, fmt.Errorf("collusion history for trip %s: %w", trip.ID, err)
	}
	if pairCount >= 5 {
		add("repeat_pairing", 0.4)
	}

	ruleScore = math.Min(ruleScore, 1.0) // stays a probability

	mlScore, err := d.ml.Predict(ctx, trip, pay)
	if err != nil {
		// The model is down. Fall back to the rules rather than treating a
		// missing opinion as an innocent one, and mark the verdict degraded so
		// the queue can re-score it once the model returns.
		s.Degraded = true
		s.Score = ruleScore
	} else {
		// max, not mean: either source may escalate on its own authority. A
		// certain model and a certain rule set each reach the threshold alone,
		// and agreement is not required to act.
		s.Score = math.Max(ruleScore, mlScore)
	}

	if s.Score >= alertThreshold || ruleScore >= ruleOnlyThreshold || s.Degraded && len(s.Signals) > 0 {
		if err := d.alerts.Raise(ctx, s); err != nil {
			return s, fmt.Errorf("raise alert for trip %s: %w", trip.ID, err)
		}
	}
	return s, nil
}
```

One caveat worth stating out loud, because it is the difference between a fraud system and a liability: none of this decides anything about a person. It routes trips to a human queue. A score above a threshold is evidence for review, not a finding, and the cost of the two error types is wildly asymmetric. A false negative costs the fare. A false positive withholds a driver's earnings and accuses them of theft on the strength of a GPS reading in a city full of tunnels and urban canyons where multipath error is routine. Build the review path first, keep the signals explainable enough to show a human what tripped, and never let a threshold auto-deactivate an account.

---
