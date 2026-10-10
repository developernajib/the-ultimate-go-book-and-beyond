## 90J.8 Southwest Airlines: Legacy Code Cancels Christmas (2022)

### The Incident

During the December 2022 holiday season, a severe winter storm hit most of the United States. While all airlines
experienced disruptions, every other major airline recovered within one to two days. Southwest Airlines did not.
Between December 21 and December 29, 2022, Southwest canceled approximately 16,700 flights, stranding over two
million passengers during the busiest travel period of the year. The total cost exceeded $800 million.

### The Background: SkySolver

Southwest Airlines' crew scheduling system, internally called SkySolver, was built in the early 1990s. Unlike
hub-and-spoke airlines where crews operate from fixed bases, Southwest's point-to-point network means crews and
aircraft are scattered across dozens of cities with complex, overlapping routes. When disruptions occur, the
scheduling system needs to solve a massive optimization problem: reassigning thousands of crew members to
thousands of flights across hundreds of airports, respecting FAA rest requirements, union rules, crew
qualifications, and aircraft availability.

SkySolver was designed for small-scale disruptions - a few dozen canceled flights at most. It was never designed
to handle the cascading failure of hundreds of flights across the entire network simultaneously.

### The Timeline

**December 21-22, 2022: The Storm**

Winter Storm Elliott hit the United States, causing widespread flight cancellations across all airlines.
Southwest canceled approximately 3,000 flights on December 22 and 23.

**December 23-24: The Cascade**

As other airlines recovered by reducing schedules and repositioning crew, Southwest's SkySolver system began
failing under the computational load. The system could not solve the optimization problem with so many disrupted
crew assignments. As crew members called in to report their status and availability, the phone system was
overwhelmed - hold times exceeded 8 hours, and the system crashed repeatedly.

Without SkySolver functioning, crew schedulers had to manually assign pilots and flight attendants to flights.
With over 20,000 crew members scattered across the country in wrong positions, manual scheduling was impossible
at scale.

**December 25-28: The Meltdown**

Southwest entered a death spiral. Each day of canceled flights created more mispositioned crew and aircraft,
making the next day's scheduling problem even larger. The company was forced to cancel its entire schedule and
rebuild from scratch - a process called a "controlled reset" that took days. Southwest ultimately canceled
approximately 16,700 flights between December 21 and December 29.

**The Aftermath**

Southwest's CEO Bob Jordan faced intense scrutiny. The Department of Transportation fined Southwest $140 million - the largest
fine in DOT history. The airline spent over $800 million on refunds, reimbursements, compensation, and
operational losses. The incident exposed years of underinvestment in technology that employees and their
unions had warned about repeatedly.

### Root Cause Analysis

1. **Legacy system designed for small disruptions**: SkySolver could not handle network-wide cascading failures
2. **Point-to-point vulnerability**: Southwest's unique network model created more complex scheduling problems
3. **No graceful degradation**: When SkySolver failed, there was no fallback
4. **Phone system dependency**: Crew had to call in by phone, and the phone system could not handle the volume
5. **Years of underinvestment**: Technology modernization had been deferred repeatedly
6. **No controlled degradation plan**: No procedure for preemptively reducing the schedule to manageable levels

### Go Code: Resilient Scheduling System with Graceful Degradation

The key insight from the Southwest failure is that an optimization algorithm must know when to stop optimizing and switch to a cheaper, faster approximation. The `ResilientScheduler` below implements four distinct modes (optimal, heuristic, emergency, and reset), selected automatically based on how many flights are unassigned. When the solver detects a critical disruption, it abandons global optimization entirely and performs a controlled reset: canceling all flights and returning crew to home bases so the schedule can be rebuilt from a clean, consistent state rather than compounding errors on a corrupted one.

```go
package scheduling

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// -----------------------------------------------------------------------
// Crew scheduling system with graceful degradation
// -----------------------------------------------------------------------

// CrewMember represents a pilot or flight attendant.
type CrewMember struct {
	ID             string
	Name           string
	Role           string // "pilot", "first_officer", "flight_attendant"
	Qualifications []string
	HomeBase       string
	CurrentCity    string
	AvailableFrom  time.Time
	MaxDutyHours   float64
	DutyHoursUsed  float64
	RestRequired   time.Duration
	LastDutyEnd    time.Time
}

// Flight represents a scheduled flight.
type Flight struct {
	ID            string
	FlightNumber  string
	Origin        string
	Destination   string
	DepartureTime time.Time
	ArrivalTime   time.Time
	RequiredCrew  CrewRequirement
	AssignedCrew  []string // crew member IDs
	Status        string   // "scheduled", "canceled", "delayed", "completed"
	Priority      int      // higher = more important to operate
}

// CrewRequirement specifies the minimum crew needed for a flight.
type CrewRequirement struct {
	Pilots          int
	FirstOfficers   int
	FlightAttendants int
}

// DisruptionLevel indicates the scale of the current disruption.
type DisruptionLevel int

const (
	DisruptionNone     DisruptionLevel = iota
	DisruptionMinor                     // < 50 flights affected
	DisruptionModerate                  // 50-200 flights affected
	DisruptionMajor                     // 200-500 flights affected
	DisruptionCritical                  // > 500 flights affected
)

// SchedulerMode controls the algorithm used based on disruption level.
type SchedulerMode int

const (
	ModeOptimal    SchedulerMode = iota // Full optimization - normal operations
	ModeHeuristic                        // Fast heuristics - moderate disruption
	ModeEmergency                        // Greedy assignment - major disruption
	ModeReset                            // Controlled reset - catastrophic disruption
)

// SchedulingResult captures the outcome of a scheduling attempt.
type SchedulingResult struct {
	Mode              SchedulerMode
	FlightsScheduled  int
	FlightsCanceled   int
	CrewAssigned      int
	CrewUnassigned    int
	SolveTime         time.Duration
	DisruptionLevel   DisruptionLevel
	Warnings          []string
}

// ResilientScheduler implements a crew scheduling system that
// gracefully degrades as disruption severity increases, rather
// than failing completely like SkySolver did.
type ResilientScheduler struct {
	mu            sync.RWMutex
	crew          map[string]*CrewMember
	flights       map[string]*Flight
	mode          SchedulerMode
	disruption    DisruptionLevel
	maxSolveTime  time.Duration
	canceledCount int
}

// NewResilientScheduler creates a scheduler with graceful degradation.
func NewResilientScheduler() *ResilientScheduler {
	return &ResilientScheduler{
		crew:         make(map[string]*CrewMember),
		flights:      make(map[string]*Flight),
		maxSolveTime: 30 * time.Second,
	}
}

// AddCrew registers crew members.
func (rs *ResilientScheduler) AddCrew(members ...*CrewMember) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for _, m := range members {
		rs.crew[m.ID] = m
	}
}

// AddFlights registers flights.
func (rs *ResilientScheduler) AddFlights(flights ...*Flight) {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for _, f := range flights {
		rs.flights[f.ID] = f
	}
}

// Solve attempts to assign crew to all unassigned flights, using the
// appropriate algorithm based on the current disruption level.
func (rs *ResilientScheduler) Solve(ctx context.Context) (*SchedulingResult, error) {
	rs.mu.Lock()
	defer rs.mu.Unlock()

	// Assess disruption level.
	rs.assessDisruption()
	rs.selectMode()

	start := time.Now()
	var result *SchedulingResult

	switch rs.mode {
	case ModeOptimal:
		result = rs.solveOptimal(ctx)
	case ModeHeuristic:
		result = rs.solveHeuristic(ctx)
	case ModeEmergency:
		result = rs.solveEmergency(ctx)
	case ModeReset:
		result = rs.solveReset(ctx)
	}

	result.SolveTime = time.Since(start)
	result.Mode = rs.mode
	result.DisruptionLevel = rs.disruption

	fmt.Printf("[SCHEDULER] Mode: %d, Disruption: %d, Scheduled: %d, Canceled: %d, Time: %v\n",
		rs.mode, rs.disruption, result.FlightsScheduled, result.FlightsCanceled, result.SolveTime)

	return result, nil
}

// assessDisruption determines the current disruption level based on
// the number of unassigned flights.
func (rs *ResilientScheduler) assessDisruption() {
	unassigned := 0
	for _, f := range rs.flights {
		if f.Status == "scheduled" && len(f.AssignedCrew) == 0 {
			unassigned++
		}
	}

	rs.canceledCount = 0
	for _, f := range rs.flights {
		if f.Status == "canceled" {
			rs.canceledCount++
		}
	}

	total := unassigned + rs.canceledCount

	switch {
	case total > 500:
		rs.disruption = DisruptionCritical
	case total > 200:
		rs.disruption = DisruptionMajor
	case total > 50:
		rs.disruption = DisruptionModerate
	case total > 0:
		rs.disruption = DisruptionMinor
	default:
		rs.disruption = DisruptionNone
	}
}

// selectMode chooses the scheduling algorithm based on disruption level.
func (rs *ResilientScheduler) selectMode() {
	switch rs.disruption {
	case DisruptionNone, DisruptionMinor:
		rs.mode = ModeOptimal
	case DisruptionModerate:
		rs.mode = ModeHeuristic
	case DisruptionMajor:
		rs.mode = ModeEmergency
	case DisruptionCritical:
		rs.mode = ModeReset
	}
}

// solveOptimal uses full optimization for normal operations.
func (rs *ResilientScheduler) solveOptimal(ctx context.Context) *SchedulingResult {
	result := &SchedulingResult{}

	// Sort flights by departure time.
	flights := rs.getUnassignedFlights()
	sort.Slice(flights, func(i, j int) bool {
		return flights[i].DepartureTime.Before(flights[j].DepartureTime)
	})

	for _, f := range flights {
		if err := ctx.Err(); err != nil {
			result.Warnings = append(result.Warnings, "solve timeout - switching to heuristic")
			return rs.solveHeuristic(ctx)
		}

		assigned := rs.assignCrewToFlight(f, false)
		if assigned {
			result.FlightsScheduled++
		} else {
			f.Status = "canceled"
			result.FlightsCanceled++
		}
	}

	return result
}

// solveHeuristic uses faster, approximate assignment for moderate disruption.
func (rs *ResilientScheduler) solveHeuristic(ctx context.Context) *SchedulingResult {
	result := &SchedulingResult{}

	// Prioritize flights by importance and departure time.
	flights := rs.getUnassignedFlights()
	sort.Slice(flights, func(i, j int) bool {
		if flights[i].Priority != flights[j].Priority {
			return flights[i].Priority > flights[j].Priority
		}
		return flights[i].DepartureTime.Before(flights[j].DepartureTime)
	})

	for _, f := range flights {
		if err := ctx.Err(); err != nil {
			result.Warnings = append(result.Warnings, "heuristic timeout")
			break
		}
		assigned := rs.assignCrewToFlight(f, true)
		if assigned {
			result.FlightsScheduled++
		} else {
			f.Status = "canceled"
			result.FlightsCanceled++
		}
	}

	return result
}

// solveEmergency uses greedy assignment, prioritizing hub-to-hub flights.
func (rs *ResilientScheduler) solveEmergency(ctx context.Context) *SchedulingResult {
	result := &SchedulingResult{}
	result.Warnings = append(result.Warnings,
		"EMERGENCY MODE: Only high-priority flights will be assigned")

	flights := rs.getUnassignedFlights()

	// In emergency mode, only attempt to schedule high-priority flights.
	var highPriority, lowPriority []*Flight
	for _, f := range flights {
		if f.Priority >= 5 {
			highPriority = append(highPriority, f)
		} else {
			lowPriority = append(lowPriority, f)
		}
	}

	// Cancel all low-priority flights immediately.
	for _, f := range lowPriority {
		f.Status = "canceled"
		result.FlightsCanceled++
	}

	// Try to schedule high-priority flights.
	for _, f := range highPriority {
		if err := ctx.Err(); err != nil {
			break
		}
		assigned := rs.assignCrewToFlight(f, true)
		if assigned {
			result.FlightsScheduled++
		} else {
			f.Status = "canceled"
			result.FlightsCanceled++
		}
	}

	return result
}

// solveReset performs a controlled reset - cancel everything and rebuild
// from scratch. This is the "nuclear option" that Southwest should have
// used days earlier.
func (rs *ResilientScheduler) solveReset(ctx context.Context) *SchedulingResult {
	result := &SchedulingResult{}
	result.Warnings = append(result.Warnings,
		"RESET MODE: All flights canceled. Rebuilding schedule from scratch.")

	// Cancel all scheduled flights.
	for _, f := range rs.flights {
		if f.Status == "scheduled" {
			f.Status = "canceled"
			f.AssignedCrew = nil
			result.FlightsCanceled++
		}
	}

	// Reset all crew to their home bases (logical reset).
	for _, c := range rs.crew {
		c.DutyHoursUsed = 0
		c.CurrentCity = c.HomeBase
		c.AvailableFrom = time.Now().Add(12 * time.Hour) // Mandatory rest
	}

	fmt.Printf("[SCHEDULER] CONTROLLED RESET: %d flights canceled, %d crew reset to home bases\n",
		result.FlightsCanceled, len(rs.crew))

	return result
}

// assignCrewToFlight attempts to assign available crew to a flight.
func (rs *ResilientScheduler) assignCrewToFlight(f *Flight, greedy bool) bool {
	needed := f.RequiredCrew
	var assigned []string

	// Find available crew at the origin city.
	available := rs.getAvailableCrewAt(f.Origin, f.DepartureTime)

	// Assign pilots.
	pilots := filterByRole(available, "pilot")
	for i := 0; i < needed.Pilots && i < len(pilots); i++ {
		assigned = append(assigned, pilots[i].ID)
		pilots[i].CurrentCity = f.Destination
		pilots[i].AvailableFrom = f.ArrivalTime.Add(30 * time.Minute)
	}
	if len(assigned) < needed.Pilots {
		return false
	}

	// Assign first officers.
	fos := filterByRole(available, "first_officer")
	foCount := 0
	for i := 0; i < needed.FirstOfficers && i < len(fos); i++ {
		assigned = append(assigned, fos[i].ID)
		fos[i].CurrentCity = f.Destination
		fos[i].AvailableFrom = f.ArrivalTime.Add(30 * time.Minute)
		foCount++
	}
	if foCount < needed.FirstOfficers {
		return false
	}

	// Assign flight attendants.
	fas := filterByRole(available, "flight_attendant")
	faCount := 0
	for i := 0; i < needed.FlightAttendants && i < len(fas); i++ {
		assigned = append(assigned, fas[i].ID)
		fas[i].CurrentCity = f.Destination
		fas[i].AvailableFrom = f.ArrivalTime.Add(30 * time.Minute)
		faCount++
	}
	if faCount < needed.FlightAttendants {
		return false
	}

	f.AssignedCrew = assigned
	return true
}

// getUnassignedFlights returns flights that need crew assignment.
func (rs *ResilientScheduler) getUnassignedFlights() []*Flight {
	var result []*Flight
	for _, f := range rs.flights {
		if f.Status == "scheduled" && len(f.AssignedCrew) == 0 {
			result = append(result, f)
		}
	}
	return result
}

// getAvailableCrewAt returns crew members available at a given city
// and time.
func (rs *ResilientScheduler) getAvailableCrewAt(city string, when time.Time) []*CrewMember {
	var available []*CrewMember
	for _, c := range rs.crew {
		if c.CurrentCity == city && c.AvailableFrom.Before(when) {
			if c.DutyHoursUsed < c.MaxDutyHours {
				available = append(available, c)
			}
		}
	}
	return available
}

func filterByRole(crew []*CrewMember, role string) []*CrewMember {
	var result []*CrewMember
	for _, c := range crew {
		if c.Role == role {
			result = append(result, c)
		}
	}
	return result
}
```

### Engineering Lessons

1. **Systems must degrade gracefully** - when optimal scheduling fails, switch to simpler algorithms.
2. **Technical debt has a compound interest rate** - every year of deferred modernization makes the eventual
   failure worse.
3. **Test with catastrophic scenarios** - if your system has never been tested with 500+ disruptions, you
   do not know what it will do.
4. **Build a controlled reset capability** - the ability to cancel everything and rebuild is better than
   days of cascading failures.
5. **Unique business models create unique failure modes** - Southwest's point-to-point network needed
   different tools than hub-and-spoke airlines.

---

### Junior → FAANG: Technical Debt and Graceful Degradation as Interview Entry Points

Southwest Airlines is the interview answer to "what is the real cost of technical debt?" The cost of not modernizing SkySolver for 30 years was $825 million in a single week. The system worked under normal conditions and failed catastrophically under the specific stress scenario it was never tested against: hundreds of simultaneous disruptions with crew members geographically stranded. For FAANG behavioral interviews, the Southwest incident is a frame for "tell me about a system that failed under stress that worked fine under normal conditions." The key technical lesson is that graceful degradation requires explicit design: SkySolver had no fallback algorithm for when its optimization engine could not find a solution. It stopped. A system that stops under stress is a system with no degraded mode. For any scheduling or optimization system, define what the system does when the optimal solution cannot be computed within the time budget: does it return the best partial solution found so far, does it fall back to a simpler heuristic algorithm, or does it halt? Halting is never the correct answer for a production system.

### Senior @ FAANG: Legacy System Risk Assessment and Modernization Governance as Staff Responsibilities

At L6, Southwest Airlines is a case study in what happens when technical debt risk is not quantified and tracked as a business metric. The SkySolver system's brittleness was presumably known to Southwest's engineering teams for years before the 2022 Christmas incident. The failure was not that engineers did not understand the risk. The failure was that the risk was never translated into business terms that would have justified the modernization investment before the incident forced it. The staff engineer's contribution to legacy system governance is the risk quantification framework: define the specific failure scenarios the legacy system cannot handle, estimate the business impact of each scenario (revenue loss, regulatory exposure, reputational damage), and present the modernization investment as insurance against those scenarios. For a scheduling system, the specific failure scenario is "what happens when the number of simultaneous disruptions exceeds X?", and the answer should be a quantified business impact, not a vague statement about system stability. Once the risk is quantified, the modernization investment has a maximum justified cost: you should not spend more than the expected value of the prevented incident. Southwest's $825 million loss from one incident would have funded a very substantial modernization program. The second lesson is chaos engineering applied to optimization systems: define the maximum disruption load the system is tested against, and treat anything below that threshold as a known safe operating range and anything above as an untested failure mode. Southwest's system had never been tested against 500 simultaneous disruptions. Establishing that threshold as a known limit, and engineering a fallback for when the limit is exceeded, is cheaper than the alternative.

---
