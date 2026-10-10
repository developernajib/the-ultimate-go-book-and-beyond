## 83B.14 Tesla Deep Dive

### Overview for Go Engineers

Tesla is not a traditional software company, but it has one of the most sophisticated software engineering organizations in the automotive industry. Go is used in Tesla's data infrastructure, vehicle telemetry pipelines, internal tooling, and backend services. Tesla's engineering challenges are unique: processing sensor data from millions of vehicles (cameras, radar, ultrasonic), managing OTA (Over-The-Air) software updates to vehicle fleets, building state machines for autonomous driving features, and maintaining fleet telemetry pipelines that handle petabytes of data daily. Tesla interviews for software engineering roles (not Autopilot AI - those are separate ML roles) emphasize systems programming, embedded-adjacent thinking, reliability engineering, and the intersection of hardware and software. Engineers who understand state machines, sensor fusion concepts, and the constraints of safety-critical systems have a significant advantage. Tesla's culture values ownership, speed, and the willingness to work across hardware/software boundaries.

### Interview Process

Tesla's loop is fast, intense, and practical, often compressed into fewer rounds than FAANG peers:

```
┌──────────────────────────────────────────────────────────────────┐
│                   TESLA INTERVIEW PIPELINE                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Recruiter Screen (30 min)                                       │
│       │  - Role fit, experience, interest in Tesla mission       │
│       ▼                                                          │
│  Technical Phone Screen (60 min)                                 │
│       │  - Coding + system concepts                              │
│       ▼                                                          │
│  Take-Home Assignment (optional, 3-5 days)                       │
│       │  - Build a small system (state machine, data pipeline)   │
│       ▼                                                          │
│  Virtual/Onsite Interviews (4-5 rounds, 45-60 min each)          │
│       │  - 2 Coding rounds                                       │
│       │  - 1 System Design round                                 │
│       │  - 1 Domain-specific round (telemetry/OTA/state machines)│
│       │  - 1 Culture/Values round                                │
│       ▼                                                          │
│  Offer                                                           │
│  Timeline: 2-4 weeks (Tesla moves fast)                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Tesla's take-home assignment is distinctive - it tests real engineering judgment, not academic algorithms. Typical tasks: build a vehicle state machine, implement a telemetry aggregation pipeline, or design a simplified OTA update system. The domain-specific round tests knowledge of real-time systems, sensor data processing, and safety requirements - not ML/AI itself.

### Level Expectations

| Level | Title | Years | Base Salary | Total Comp (TC) | Interview Focus |
|-------|-------|-------|-------------|-----------------|-----------------|
| SWE I | Software Engineer | 0-2 | $130K-$165K | $180K-$270K | Coding + systems fundamentals |
| SWE II | Software Engineer II | 2-5 | $165K-$205K | $270K-$400K | System design + domain knowledge |
| Senior | Senior Engineer | 5-9 | $200K-$255K | $400K-$580K | Full system + cross-domain impact |
| Staff | Staff Engineer | 9-13 | $245K-$310K | $580K-$780K | Architecture + organizational scope |
| Principal | Principal Engineer | 13+ | $290K-$380K | $750K-$1M+ | Multi-product technical strategy |

*Note: Tesla's equity (stock grants) is below FAANG levels but has upside tied to stock performance.*

### Representative Interview Problems

#### Problem 1: Vehicle State Machine (Easy)

*Implement a state machine for a vehicle's charging session - modeling the transitions between states.*

```go
package main

import (
	"errors"
	"fmt"
)

type ChargeState int

const (
	StateIdle ChargeState = iota
	StatePluggedIn
	StateCharging
	StateChargingComplete
	StateFault
)

func (s ChargeState) String() string {
	return [...]string{"Idle", "PluggedIn", "Charging", "ChargingComplete", "Fault"}[s]
}

type ChargeEvent int

const (
	EventPlugIn ChargeEvent = iota
	EventStartCharge
	EventChargingComplete
	EventUnplug
	EventFault
	EventReset
)

func (e ChargeEvent) String() string {
	return [...]string{"PlugIn", "StartCharge", "ChargingComplete", "Unplug", "Fault", "Reset"}[e]
}

// transitions defines valid state → event → next state.
var transitions = map[ChargeState]map[ChargeEvent]ChargeState{
	StateIdle:             {EventPlugIn: StatePluggedIn},
	StatePluggedIn:        {EventStartCharge: StateCharging, EventUnplug: StateIdle, EventFault: StateFault},
	StateCharging:         {EventChargingComplete: StateChargingComplete, EventFault: StateFault},
	StateChargingComplete: {EventUnplug: StateIdle},
	StateFault:            {EventReset: StateIdle},
}

type ChargingStateMachine struct {
	state ChargeState
}

func (csm *ChargingStateMachine) Transition(event ChargeEvent) error {
	next, ok := transitions[csm.state][event]
	if !ok {
		return fmt.Errorf("invalid transition: %s + %s", csm.state, event)
	}
	fmt.Printf("  %s + %s → %s\n", csm.state, event, next)
	csm.state = next
	return nil
}

var ErrInvalidTransition = errors.New("invalid transition")

func main() {
	sm := &ChargingStateMachine{state: StateIdle}
	fmt.Printf("Initial state: %s\n", sm.state)

	events := []ChargeEvent{EventPlugIn, EventStartCharge, EventChargingComplete, EventUnplug}
	for _, ev := range events {
		if err := sm.Transition(ev); err != nil {
			fmt.Printf("  ERROR: %v\n", err)
		}
	}

	// Test invalid transition
	sm2 := &ChargingStateMachine{state: StateIdle}
	if err := sm2.Transition(EventStartCharge); err != nil {
		fmt.Printf("\nInvalid: %v\n", err)
	}

	// Test fault recovery
	sm3 := &ChargingStateMachine{state: StateCharging}
	_ = sm3.Transition(EventFault)
	_ = sm3.Transition(EventReset)
	fmt.Printf("After fault+reset: %s\n", sm3.state)
}
```

#### Problem 2: Sensor Data Anomaly Detection (Easy)

*Detect anomalous temperature sensor readings from vehicle battery using a rolling z-score.*

```go
package main

import (
	"fmt"
	"math"
)

type SensorReading struct {
	Timestamp int64
	Value     float64 // temperature in Celsius
	SensorID  string
}

// RollingStats maintains running mean and variance using Welford's algorithm.
type RollingStats struct {
	n    int
	mean float64
	m2   float64
}

func (rs *RollingStats) Update(x float64) {
	rs.n++
	delta := x - rs.mean
	rs.mean += delta / float64(rs.n)
	rs.m2 += delta * (x - rs.mean)
}

func (rs *RollingStats) StdDev() float64 {
	if rs.n < 2 {
		return 0
	}
	return math.Sqrt(rs.m2 / float64(rs.n-1))
}

func (rs *RollingStats) ZScore(x float64) float64 {
	std := rs.StdDev()
	if std == 0 {
		return 0
	}
	return (x - rs.mean) / std
}

const anomalyThreshold = 3.0

func DetectAnomalies(readings []SensorReading) []SensorReading {
	stats := &RollingStats{}
	var anomalies []SensorReading

	for _, r := range readings {
		if stats.n >= 5 { // need min samples before scoring
			z := stats.ZScore(r.Value)
			if math.Abs(z) > anomalyThreshold {
				anomalies = append(anomalies, r)
				fmt.Printf("  ANOMALY: sensor=%s value=%.1f°C z-score=%.2f\n", r.SensorID, r.Value, z)
			}
		}
		stats.Update(r.Value)
	}
	return anomalies
}

func main() {
	readings := []SensorReading{
		{1, 35.1, "bat_temp_1"},
		{2, 35.3, "bat_temp_1"},
		{3, 35.2, "bat_temp_1"},
		{4, 35.0, "bat_temp_1"},
		{5, 35.4, "bat_temp_1"},
		{6, 35.2, "bat_temp_1"},
		{7, 72.5, "bat_temp_1"}, // anomaly - thermal runaway?
		{8, 35.3, "bat_temp_1"},
		{9, 35.1, "bat_temp_1"},
	}

	fmt.Println("Analyzing battery temperature readings...")
	anomalies := DetectAnomalies(readings)
	fmt.Printf("\nFound %d anomalies\n", len(anomalies))
}
```

#### Problem 3: OTA Update Scheduler (Easy)

*Schedule OTA updates across a vehicle fleet, respecting battery level requirements and time windows.*

```go
package main

import (
	"fmt"
	"slices"
)

type Vehicle struct {
	VIN           string
	BatteryPct    int
	IsCharging    bool
	IsParked      bool
	LastUpdateVer string
}

type UpdatePackage struct {
	Version         string
	MinBatteryPct   int
	RequiresParked  bool
}

type ScheduleResult struct {
	VIN    string
	Status string
	Reason string
}

func ScheduleUpdates(vehicles []Vehicle, pkg UpdatePackage) []ScheduleResult {
	results := make([]ScheduleResult, len(vehicles))
	for i, v := range vehicles {
		if v.LastUpdateVer == pkg.Version {
			results[i] = ScheduleResult{v.VIN, "skip", "already on latest"}
			continue
		}
		if v.BatteryPct < pkg.MinBatteryPct && !v.IsCharging {
			results[i] = ScheduleResult{v.VIN, "defer", fmt.Sprintf("battery %d%% < min %d%%", v.BatteryPct, pkg.MinBatteryPct)}
			continue
		}
		if pkg.RequiresParked && !v.IsParked {
			results[i] = ScheduleResult{v.VIN, "defer", "vehicle not parked"}
			continue
		}
		results[i] = ScheduleResult{v.VIN, "schedule", "eligible for update"}
	}

	// Sort: scheduled first, deferred second, skip last
	priority := map[string]int{"schedule": 0, "defer": 1, "skip": 2}
	slices.SortFunc(results, func(a, b ScheduleResult) int {
		return priority[a.Status] - priority[b.Status]
	})
	return results
}

func main() {
	vehicles := []Vehicle{
		{VIN: "5YJ3E1EA", BatteryPct: 85, IsCharging: false, IsParked: true, LastUpdateVer: "2025.44.0"},
		{VIN: "5YJ3E1EB", BatteryPct: 22, IsCharging: true, IsParked: true, LastUpdateVer: "2025.44.0"},
		{VIN: "5YJ3E1EC", BatteryPct: 15, IsCharging: false, IsParked: false, LastUpdateVer: "2025.44.0"},
		{VIN: "5YJ3E1ED", BatteryPct: 90, IsCharging: false, IsParked: true, LastUpdateVer: "2025.48.3"},
	}

	pkg := UpdatePackage{Version: "2025.48.3", MinBatteryPct: 20, RequiresParked: true}

	results := ScheduleUpdates(vehicles, pkg)
	fmt.Printf("OTA Update %s scheduling results:\n", pkg.Version)
	for _, r := range results {
		fmt.Printf("  [%-8s] %s - %s\n", r.Status, r.VIN, r.Reason)
	}
}
```

#### Problem 4: Fleet Telemetry Aggregator (Medium)

*Aggregate telemetry signals from thousands of vehicles using concurrent fan-in pattern.*

```go
package main

import (
	"fmt"
	"sync"
)

type TelemetrySignal struct {
	VehicleID string
	Metric    string
	Value     float64
}

type AggregatedMetric struct {
	Metric string
	Count  int
	Sum    float64
	Min    float64
	Max    float64
}

func (a *AggregatedMetric) Average() float64 {
	if a.Count == 0 {
		return 0
	}
	return a.Sum / float64(a.Count)
}

// FanInTelemetry merges multiple vehicle telemetry channels into one.
func FanInTelemetry(channels ...<-chan TelemetrySignal) <-chan TelemetrySignal {
	merged := make(chan TelemetrySignal, 100)
	var wg sync.WaitGroup
	for _, ch := range channels {
		wg.Add(1)
		go func(c <-chan TelemetrySignal) {
			defer wg.Done()
			for sig := range c {
				merged <- sig
			}
		}(ch)
	}
	go func() {
		wg.Wait()
		close(merged)
	}()
	return merged
}

func SimulateVehicle(vin string, signals []TelemetrySignal) <-chan TelemetrySignal {
	ch := make(chan TelemetrySignal, len(signals))
	go func() {
		defer close(ch)
		for _, s := range signals {
			s.VehicleID = vin
			ch <- s
		}
	}()
	return ch
}

func Aggregate(signals <-chan TelemetrySignal) map[string]*AggregatedMetric {
	agg := make(map[string]*AggregatedMetric)
	for sig := range signals {
		m, ok := agg[sig.Metric]
		if !ok {
			m = &AggregatedMetric{Metric: sig.Metric, Min: sig.Value, Max: sig.Value}
			agg[sig.Metric] = m
		}
		m.Count++
		m.Sum += sig.Value
		if sig.Value < m.Min {
			m.Min = sig.Value
		}
		if sig.Value > m.Max {
			m.Max = sig.Value
		}
	}
	return agg
}

func main() {
	v1 := SimulateVehicle("VIN001", []TelemetrySignal{
		{Metric: "battery_temp", Value: 35.1},
		{Metric: "speed_mph", Value: 65.0},
		{Metric: "battery_temp", Value: 35.3},
	})
	v2 := SimulateVehicle("VIN002", []TelemetrySignal{
		{Metric: "battery_temp", Value: 36.2},
		{Metric: "speed_mph", Value: 72.5},
		{Metric: "battery_temp", Value: 36.8},
	})

	merged := FanInTelemetry(v1, v2)
	metrics := Aggregate(merged)

	for _, m := range metrics {
		fmt.Printf("%-15s count=%-4d avg=%.2f min=%.2f max=%.2f\n",
			m.Metric, m.Count, m.Average(), m.Min, m.Max)
	}
}
```

#### Problem 5: Hierarchical Sensor Fault Tolerance (Medium)

*Build a sensor voting system that tolerates individual sensor faults using majority voting across redundant sensors.*

```go
package main

import (
	"fmt"
	"math"
	"slices"
)

// SensorVoter selects the most reliable reading from N redundant sensors
// using median voting (robust to outliers/faults).
type SensorVoter struct {
	sensorCount int
	faultTolerance int // max faults tolerable
}

func NewSensorVoter(sensorCount, faultTolerance int) *SensorVoter {
	return &SensorVoter{sensorCount, faultTolerance}
}

type SensorReading2 struct {
	SensorID string
	Value    float64
	Healthy  bool
}

// Vote returns the consensus value and which sensors were outliers.
func (sv *SensorVoter) Vote(readings []SensorReading2) (consensus float64, outliers []string) {
	var healthy []float64
	for _, r := range readings {
		if r.Healthy {
			healthy = append(healthy, r.Value)
		}
	}

	if len(healthy) == 0 {
		return 0, nil
	}

	slices.Sort(healthy)
	// Median vote
	n := len(healthy)
	if n%2 == 0 {
		consensus = (healthy[n/2-1] + healthy[n/2]) / 2
	} else {
		consensus = healthy[n/2]
	}

	// Flag sensors more than 2 std devs from consensus as outliers
	var sum float64
	for _, v := range healthy {
		sum += v
	}
	mean := sum / float64(len(healthy))
	var variance float64
	for _, v := range healthy {
		d := v - mean
		variance += d * d
	}
	std := math.Sqrt(variance / float64(len(healthy)))

	for _, r := range readings {
		if r.Healthy && math.Abs(r.Value-consensus) > 2*std+0.01 {
			outliers = append(outliers, r.SensorID)
		}
	}
	return consensus, outliers
}

func main() {
	voter := NewSensorVoter(5, 2) // 5 sensors, tolerate 2 faults

	readings := []SensorReading2{
		{"radar_1", 45.2, true},
		{"radar_2", 45.1, true},
		{"radar_3", 45.4, true},
		{"radar_4", 87.3, true}, // faulty - spurious reading
		{"radar_5", 45.3, true},
	}

	consensus, outliers := voter.Vote(readings)
	fmt.Printf("Consensus distance: %.2f meters\n", consensus)
	fmt.Printf("Outlier sensors:    %v\n", outliers)
}
```

#### Problem 6: OTA Rollout with Canary Deployment (Medium)

*Implement a canary-based OTA rollout that progressively expands to more vehicles based on error rates.*

```go
package main

import (
	"fmt"
	"math/rand/v2"
)

type RolloutStage struct {
	PercentTarget float64 // % of fleet to include
	ErrorThreshold float64 // max acceptable error rate before halt
}

type RolloutController struct {
	stages          []RolloutStage
	currentStage    int
	enrolled        int
	totalFleet      int
	errors          int
	updates         int
}

func NewRolloutController(fleetSize int) *RolloutController {
	return &RolloutController{
		totalFleet: fleetSize,
		stages: []RolloutStage{
			{0.01, 0.05},  // 1% canary, stop if >5% errors
			{0.05, 0.03},  // 5% early adopters
			{0.20, 0.02},  // 20% broader rollout
			{0.50, 0.01},  // 50%
			{1.00, 0.01},  // 100%
		},
	}
}

func (rc *RolloutController) CurrentTarget() int {
	if rc.currentStage >= len(rc.stages) {
		return rc.totalFleet
	}
	return int(rc.stages[rc.currentStage].PercentTarget * float64(rc.totalFleet))
}

func (rc *RolloutController) ErrorRate() float64 {
	if rc.updates == 0 {
		return 0
	}
	return float64(rc.errors) / float64(rc.updates)
}

// SimulateUpdate simulates an OTA update event.
func (rc *RolloutController) SimulateUpdate(errorProb float64) string {
	if rc.enrolled >= rc.CurrentTarget() {
		return "fleet_target_reached"
	}

	rc.enrolled++
	rc.updates++
	if rand.Float64() < errorProb {
		rc.errors++
	}

	if rc.currentStage < len(rc.stages) {
		threshold := rc.stages[rc.currentStage].ErrorThreshold
		if rc.ErrorRate() > threshold {
			return fmt.Sprintf("HALT: error_rate=%.1f%% > threshold=%.1f%% at stage %d",
				rc.ErrorRate()*100, threshold*100, rc.currentStage+1)
		}
	}

	if rc.enrolled >= rc.CurrentTarget() && rc.currentStage < len(rc.stages)-1 {
		rc.currentStage++
		return fmt.Sprintf("advancing_to_stage_%d (%.0f%% target)", rc.currentStage+1, rc.stages[rc.currentStage].PercentTarget*100)
	}
	return "ok"
}

func main() {
	rc := NewRolloutController(10000)

	// Simulate successful rollout through first 3 stages
	events := map[string]int{}
	for range 200 {
		status := rc.SimulateUpdate(0.01) // 1% error rate
		if status != "ok" {
			events[status]++
		}
	}

	fmt.Printf("Enrolled: %d/%d vehicles\n", rc.enrolled, rc.totalFleet)
	fmt.Printf("Error rate: %.2f%%\n", rc.ErrorRate()*100)
	fmt.Printf("Current stage: %d\n", rc.currentStage+1)
	for ev, count := range events {
		fmt.Printf("Event: %s (×%d)\n", ev, count)
	}
}
```

#### Problem 7: Vehicle Trip Log Compressor (Medium)

*Compress a series of GPS waypoints by removing redundant intermediate points (Ramer-Douglas-Peucker simplification).*

```go
package main

import (
	"fmt"
	"math"
)

type Point struct {
	Lat, Lng float64
}

// perpendicularDistance returns the perpendicular distance from point p to line segment (start, end).
func perpendicularDistance(p, start, end Point) float64 {
	if start == end {
		dlat := p.Lat - start.Lat
		dlng := p.Lng - start.Lng
		return math.Sqrt(dlat*dlat + dlng*dlng)
	}
	dLat := end.Lat - start.Lat
	dLng := end.Lng - start.Lng
	num := math.Abs(dLat*(start.Lng-p.Lng) - (start.Lat-p.Lat)*dLng)
	den := math.Sqrt(dLat*dLat + dLng*dLng)
	return num / den
}

// RDPSimplify reduces waypoints using Ramer-Douglas-Peucker.
func RDPSimplify(points []Point, epsilon float64) []Point {
	if len(points) < 3 {
		return points
	}
	maxDist, maxIdx := 0.0, 0
	for i := 1; i < len(points)-1; i++ {
		d := perpendicularDistance(points[i], points[0], points[len(points)-1])
		if d > maxDist {
			maxDist, maxIdx = d, i
		}
	}
	if maxDist > epsilon {
		left := RDPSimplify(points[:maxIdx+1], epsilon)
		right := RDPSimplify(points[maxIdx:], epsilon)
		return append(left[:len(left)-1], right...)
	}
	return []Point{points[0], points[len(points)-1]}
}

func main() {
	// Simulated GPS waypoints along a route
	waypoints := []Point{
		{37.7749, -122.4194},
		{37.7751, -122.4190},
		{37.7753, -122.4186}, // nearly collinear - can be removed
		{37.7755, -122.4182},
		{37.7760, -122.4150}, // significant turn
		{37.7770, -122.4120},
		{37.7775, -122.4110},
		{37.7780, -122.4100}, // nearly collinear
		{37.7785, -122.4090},
		{37.7800, -122.4050}, // significant turn
	}

	simplified := RDPSimplify(waypoints, 0.0002)
	fmt.Printf("Original waypoints: %d\n", len(waypoints))
	fmt.Printf("Simplified waypoints: %d (%.0f%% reduction)\n",
		len(simplified), float64(len(waypoints)-len(simplified))/float64(len(waypoints))*100)
}
```

#### Problem 8: Distributed Fleet Command Bus (Hard)

*Build a command bus that dispatches OTA commands to vehicle groups with guaranteed ordering per vehicle.*

```go
package main

import (
	"fmt"
	"sync"
)

type Command struct {
	VehicleID string
	Payload   string
	SeqNum    int
}

type VehicleQueue struct {
	mu       sync.Mutex
	queue    []Command
	nextSeq  int
	pending  map[int]Command
}

func NewVehicleQueue() *VehicleQueue {
	return &VehicleQueue{pending: make(map[int]Command)}
}

// Enqueue adds a command, delivering buffered out-of-order commands in sequence.
func (vq *VehicleQueue) Enqueue(cmd Command) []Command {
	vq.mu.Lock()
	defer vq.mu.Unlock()

	vq.pending[cmd.SeqNum] = cmd

	var delivered []Command
	for {
		next, ok := vq.pending[vq.nextSeq]
		if !ok {
			break
		}
		delivered = append(delivered, next)
		delete(vq.pending, vq.nextSeq)
		vq.nextSeq++
	}
	vq.queue = append(vq.queue, delivered...)
	return delivered
}

type CommandBus struct {
	mu     sync.Mutex
	queues map[string]*VehicleQueue
}

func NewCommandBus() *CommandBus {
	return &CommandBus{queues: make(map[string]*VehicleQueue)}
}

func (cb *CommandBus) Send(cmd Command) []Command {
	cb.mu.Lock()
	if _, ok := cb.queues[cmd.VehicleID]; !ok {
		cb.queues[cmd.VehicleID] = NewVehicleQueue()
	}
	q := cb.queues[cmd.VehicleID]
	cb.mu.Unlock()
	return q.Enqueue(cmd)
}

func main() {
	bus := NewCommandBus()
	vid := "VIN001"

	// Send out-of-order commands (simulating network delivery)
	cmds := []Command{
		{VehicleID: vid, SeqNum: 2, Payload: "install-2025.48.3-part2"},
		{VehicleID: vid, SeqNum: 0, Payload: "pre-check"},
		{VehicleID: vid, SeqNum: 3, Payload: "reboot"},
		{VehicleID: vid, SeqNum: 1, Payload: "install-2025.48.3-part1"},
	}

	for _, cmd := range cmds {
		delivered := bus.Send(cmd)
		if len(delivered) > 0 {
			for _, d := range delivered {
				fmt.Printf("Delivered seq=%d: %s\n", d.SeqNum, d.Payload)
			}
		} else {
			fmt.Printf("Buffered  seq=%d (waiting for gap fill)\n", cmd.SeqNum)
		}
	}
}
```

#### Problem 9: Autopilot Feature Flag System (Hard)

*Implement a feature flag system for gradually enabling Autopilot features on specific vehicle configurations with rollback capability.*

```go
package main

import (
	"fmt"
	"sync"
)

type VehicleConfig struct {
	VIN          string
	ModelYear    int
	HWVersion    string // "HW3", "HW4"
	Region       string
	SoftwareVer  string
}

type FeatureFlag struct {
	Name         string
	Enabled      bool
	MinModelYear int
	RequiredHW   []string
	AllowedRegions []string
	RolloutPct   float64 // 0.0-1.0; use VIN hash for determinism
}

type FlagStore struct {
	mu    sync.RWMutex
	flags map[string]FeatureFlag
}

func NewFlagStore() *FlagStore {
	return &FlagStore{flags: make(map[string]FeatureFlag)}
}

func (fs *FlagStore) Set(f FeatureFlag) {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	fs.flags[f.Name] = f
}

// vinHash provides a deterministic 0.0-1.0 value from VIN for rollout.
func vinHash(vin string) float64 {
	var h uint32
	for _, c := range vin {
		h = h*31 + uint32(c)
	}
	return float64(h%100) / 100
}

func (fs *FlagStore) IsEnabled(flagName string, vehicle VehicleConfig) (bool, string) {
	fs.mu.RLock()
	flag, ok := fs.flags[flagName]
	fs.mu.RUnlock()

	if !ok || !flag.Enabled {
		return false, "flag disabled or not found"
	}
	if vehicle.ModelYear < flag.MinModelYear {
		return false, fmt.Sprintf("model year %d < required %d", vehicle.ModelYear, flag.MinModelYear)
	}
	hwOK := len(flag.RequiredHW) == 0
	for _, hw := range flag.RequiredHW {
		if vehicle.HWVersion == hw {
			hwOK = true
		}
	}
	if !hwOK {
		return false, fmt.Sprintf("hw version %s not in %v", vehicle.HWVersion, flag.RequiredHW)
	}
	regionOK := len(flag.AllowedRegions) == 0
	for _, r := range flag.AllowedRegions {
		if vehicle.Region == r {
			regionOK = true
		}
	}
	if !regionOK {
		return false, fmt.Sprintf("region %s not allowed", vehicle.Region)
	}
	if vinHash(vehicle.VIN) > flag.RolloutPct {
		return false, fmt.Sprintf("not in rollout cohort (%.0f%%)", flag.RolloutPct*100)
	}
	return true, "eligible"
}

func main() {
	store := NewFlagStore()
	store.Set(FeatureFlag{
		Name:           "fsd_v12",
		Enabled:        true,
		MinModelYear:   2023,
		RequiredHW:     []string{"HW4"},
		AllowedRegions: []string{"US", "CA"},
		RolloutPct:     0.50,
	})

	vehicles := []VehicleConfig{
		{VIN: "5YJ3E1EAAA", ModelYear: 2024, HWVersion: "HW4", Region: "US"},
		{VIN: "5YJ3E1EBBB", ModelYear: 2022, HWVersion: "HW4", Region: "US"},
		{VIN: "5YJ3E1ECCC", ModelYear: 2024, HWVersion: "HW3", Region: "US"},
		{VIN: "5YJ3E1EDDD", ModelYear: 2024, HWVersion: "HW4", Region: "EU"},
	}

	for _, v := range vehicles {
		enabled, reason := store.IsEnabled("fsd_v12", v)
		fmt.Printf("%-14s HW=%-3s Year=%d Region=%-2s → fsd_v12=%v (%s)\n",
			v.VIN[7:], v.HWVersion, v.ModelYear, v.Region, enabled, reason)
	}
}
```

#### Problem 10: Battery Degradation Predictor (Hard)

*Predict battery capacity degradation over time using linear regression on charge cycle data.*

```go
package main

import (
	"fmt"
	"math"
)

type ChargeCycle struct {
	CycleNumber    int
	CapacityKwh    float64 // measured capacity
}

// LinearRegression fits y = mx + b to the data, returning (slope, intercept).
func LinearRegression(data []ChargeCycle) (slope, intercept float64) {
	n := float64(len(data))
	if n < 2 {
		return 0, 0
	}
	var sumX, sumY, sumXY, sumXX float64
	for _, d := range data {
		x := float64(d.CycleNumber)
		y := d.CapacityKwh
		sumX += x
		sumY += y
		sumXY += x * y
		sumXX += x * x
	}
	slope = (n*sumXY - sumX*sumY) / (n*sumXX - sumX*sumX)
	intercept = (sumY - slope*sumX) / n
	return slope, intercept
}

// PredictCapacity predicts capacity at a given cycle number.
func PredictCapacity(slope, intercept float64, cycle int) float64 {
	return slope*float64(cycle) + intercept
}

// CyclesToThreshold estimates cycles until capacity falls below threshold.
func CyclesToThreshold(slope, intercept, threshold float64) int {
	if slope >= 0 {
		return -1 // not degrading
	}
	cycle := (threshold - intercept) / slope
	return max(0, int(math.Ceil(cycle)))
}

func main() {
	// Simulated battery capacity measurements over 500 charge cycles
	data := []ChargeCycle{
		{0, 100.0}, {50, 99.1}, {100, 98.3}, {150, 97.4},
		{200, 96.8}, {250, 96.0}, {300, 95.2}, {400, 93.7},
		{500, 92.1},
	}

	slope, intercept := LinearRegression(data)
	fmt.Printf("Degradation model: capacity = %.4f × cycles + %.2f\n", slope, intercept)
	fmt.Printf("Degradation rate: %.4f kWh per cycle\n", slope)

	for _, cycle := range []int{600, 800, 1000} {
		cap := PredictCapacity(slope, intercept, cycle)
		fmt.Printf("Predicted at cycle %d: %.1f kWh (%.1f%%)\n", cycle, cap, cap)
	}

	// Tesla warranty threshold: 70% of original capacity
	threshold := 70.0
	cycles := CyclesToThreshold(slope, intercept, threshold)
	fmt.Printf("\nPredicted cycles to <70%% capacity: %d\n", cycles)
}
```

---

### System Design Topics

**Top 5 Tesla System Design Questions:**

1. **Design Tesla's Vehicle Telemetry Pipeline** - Ingest sensor data from 5M+ vehicles globally in real time. Topics: Kafka with vehicle-ID partitioning, write-heavy time-series storage (InfluxDB/Apache Parquet), cold/hot data tiering, stream processing with windowed aggregations, data retention policies.

2. **Design the OTA Update System** - Deliver software updates to millions of vehicles safely. Topics: canary deployments, version compatibility checking, differential updates (binary diffs), rollback mechanisms, bandwidth management (batch scheduling at night/low-bandwidth zones).

3. **Design Fleet-Wide Anomaly Detection** - Detect abnormal vehicle behavior across the fleet in near real time. Topics: streaming ML inference, rolling statistics, alerting pipelines, feedback loops from service technicians, per-vehicle baselines vs. fleet-wide baselines.

4. **Design the Autopilot Feature Flag System** - Safely gate Autopilot features to specific vehicle configurations and geographic regions. Topics: distributed config management, deterministic rollout by VIN, multi-dimensional eligibility (HW version, region, model year), instant kill switches, audit logging.

5. **Design Vehicle-to-Cloud Message Protocol** - Efficient bidirectional communication between embedded systems and cloud. Topics: MQTT vs. WebSocket vs. custom binary protocol, message prioritization (safety-critical vs. telemetry), offline buffering, message deduplication, delta compression.

---

### Behavioral Focus

Tesla's culture centers on **"Move Fast, Take Ownership, Change the World."** Behavioral themes:

- **Mission-driven impact:** "Why Tesla? What about the mission of accelerating sustainable energy excites you as an engineer?"
- **Ownership in ambiguity:** "Tell me about a time you built something that crossed hardware and software boundaries."
- **Speed with safety:** "Describe a time you had to balance shipping quickly against the risk of a safety regression."
- **First principles:** "Tell me about a time you challenged a conventional approach and designed something from first principles."
- **Operational excellence:** "Describe a production incident you owned from detection through postmortem."

---

### Insider Tips

**Common Mistakes:**
- Treating Tesla as a typical SaaS company - the hardware/software integration is the most interesting and valued part.
- Not mentioning safety-critical system requirements (redundancy, fail-safe states) in system design.
- Ignoring the embedded constraints of vehicle systems (bandwidth, compute, battery drain).
- State machines without proper validation of transition guards and error states.

**Strong Hire Signals:**
- Mentioning safety requirements proactively ("for a safety-critical system, we'd need Byzantine fault tolerance / hardware watchdogs").
- Canary deployments in OTA design without being prompted.
- Discussing fleet-level anomaly detection using statistical methods (z-scores, Kalman filters).
- Understanding of data compression for telemetry (Tesla transmits high-frequency sensor data with severe bandwidth constraints).

**Red Flags:**
- Designing for cloud-only systems without considering offline vehicle behavior.
- Ignoring rollback in OTA design.
- Using floats for mission-critical sensor comparisons without discussing precision.
- Not asking about safety requirements in system design.

---

### 8-Week Preparation Timeline

```
Week 1: Embedded & Real-Time Systems Foundations
  Mon-Tue: State machines (FSM), event-driven systems, guard conditions
  Wed-Thu: Sensor fusion concepts, voting algorithms, Kalman filter basics
  Fri:     Real-time vs. eventually consistent data - when does it matter?
  Weekend: Build a vehicle state machine with full test coverage

Week 2: Telemetry & Data Pipelines
  Mon-Tue: Time-series data, InfluxDB concepts, Kafka for sensor streams
  Wed-Thu: Stream aggregation (windowed sum/avg/max), sliding windows
  Fri:     Data compression: delta encoding, RDP simplification
  Weekend: Build a telemetry aggregation pipeline in Go

Week 3: Algorithms - Regression, Statistics, Search
  Mon-Fri: 2 problems/day - rolling stats, anomaly detection, binary search variants
  Weekend: Linear regression, z-score, Welford's algorithm practice

Week 4: System Design - Vehicle Systems
  Mon-Tue: Design Tesla telemetry pipeline (whiteboard)
  Wed-Thu: Design OTA update system with canary rollout
  Fri:     Design fleet anomaly detection system
  Weekend: Mock system design interview

Week 5: Distributed Systems & Safety
  Mon-Tue: CAP theorem in safety-critical systems, consensus algorithms
  Wed-Thu: Canary deployments, feature flags, gradual rollouts
  Fri:     Redundancy patterns, Byzantine fault tolerance concepts
  Weekend: Design Autopilot feature flag system

Week 6: Go for Systems Engineering
  Mon-Tue: Channels for sensor event pipelines, goroutine fan-in/fan-out
  Wed-Thu: Struct embedding, interface design for hardware abstraction
  Fri:     Writing testable state machines in Go
  Weekend: Build OTA scheduler and command bus in Go

Week 7: Take-Home Assignment Prep
  Mon-Wed: Build a complete sample take-home project (vehicle telemetry processor)
  Thu:     Code review your take-home - eliminate edge cases
  Fri:     Research Tesla engineering blog + job posting technical requirements
  Weekend: Mock behavioral interview + take-home presentation practice

Week 8: Final Prep
  Mon-Tue: Mission alignment story prep + 5 STAR behavioral stories
  Wed:     Full mock onsite
  Thu:     Rest, logistics
  Fri:     Light review only
```

---


### Junior → FAANG: Tesla Interview Preparation Basics

Tesla Software Engineering interviews are distinct from pure software companies because the systems interact with the physical world. Interview focus areas depend heavily on the team: Autopilot involves computer vision, sensor fusion, and real-time control systems. Vehicle Software involves embedded systems, OTA update systems, and telematics. Energy Products involves distributed energy resource management and grid integration. Know the team's domain before preparing. Coding interviews are standard algorithmic. System design often involves embedded or real-time constraints not seen in pure web companies.

### Senior @ FAANG: Tesla Senior Engineer: Safety-Critical Systems and Hardware-Software Interfaces

At the senior level, Tesla's engineering culture places safety and reliability above all other concerns, because software defects have direct physical consequences. The interview bar for safety-critical roles includes: formal reasoning about system states and failure modes (state machines, invariants), deep understanding of concurrency in resource-constrained environments, and a risk-averse engineering philosophy that is atypical in high-velocity software organizations. Senior candidates should also understand the hardware-software co-design challenges unique to Tesla: every software decision has implications for vehicle hardware (compute resources, power budget, thermal envelope), and senior engineers must reason across both domains. The OTA update system is a specific domain worth understanding: updating 3M+ vehicles in the field requires idempotent update logic, rollback capability, staged rollout with health checks, and compatibility testing across multiple vehicle hardware generations simultaneously.

---
