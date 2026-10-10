## 83E.5 Problem 3: Elevator System

### Requirements

1. Building with N floors and M elevators
2. Users request elevators from a floor (with direction)
3. System dispatches the optimal elevator
4. Elevator processes requests in order (SCAN algorithm)

### Implementation

The elevator system design problem tests state machine design and scheduling algorithm knowledge, requiring candidates to handle edge cases such as door obstruction, overweight conditions, and concurrent floor requests. The following implementation uses a SCAN (elevator) algorithm for optimal floor servicing order.

```go
package elevator

import (
	"errors"
	"fmt"
	"math"
	"sync"
)

type Direction int

const (
	Up Direction = iota
	Down
	Idle
)

func (d Direction) String() string {
	return [...]string{"Up", "Down", "Idle"}[d]
}

type ElevatorState int

const (
	Moving ElevatorState = iota
	Stopped
	OutOfService
)

// --- Interfaces ---

type Dispatcher interface {
	Dispatch(floor int, direction Direction, elevators []*Elevator) *Elevator
}

// --- Elevator ---

type Elevator struct {
	mu           sync.Mutex
	ID           int
	CurrentFloor int
	Direction    Direction
	State        ElevatorState
	Destinations map[int]bool // floors to visit
	MinFloor     int
	MaxFloor     int
}

func NewElevator(id, minFloor, maxFloor int) *Elevator {
	return &Elevator{
		ID:           id,
		CurrentFloor: minFloor,
		Direction:    Idle,
		State:        Stopped,
		Destinations: make(map[int]bool),
		MinFloor:     minFloor,
		MaxFloor:     maxFloor,
	}
}

func (e *Elevator) AddDestination(floor int) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if floor < e.MinFloor || floor > e.MaxFloor {
		return fmt.Errorf("floor %d out of range [%d, %d]", floor, e.MinFloor, e.MaxFloor)
	}
	e.Destinations[floor] = true
	if e.State == Stopped {
		if floor > e.CurrentFloor {
			e.Direction = Up
		} else if floor < e.CurrentFloor {
			e.Direction = Down
		}
		e.State = Moving
	}
	return nil
}

func (e *Elevator) Step() {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.State != Moving || len(e.Destinations) == 0 {
		e.Direction = Idle
		e.State = Stopped
		return
	}

	// Move one floor in current direction
	if e.Direction == Up {
		e.CurrentFloor++
	} else if e.Direction == Down {
		e.CurrentFloor--
	}

	// Check if we arrived at a destination
	if e.Destinations[e.CurrentFloor] {
		delete(e.Destinations, e.CurrentFloor)
		// Door opens, passengers enter/exit
	}

	// Check if we need to change direction
	if len(e.Destinations) == 0 {
		e.Direction = Idle
		e.State = Stopped
		return
	}

	hasAbove, hasBelow := false, false
	for floor := range e.Destinations {
		if floor > e.CurrentFloor {
			hasAbove = true
		}
		if floor < e.CurrentFloor {
			hasBelow = true
		}
	}

	if e.Direction == Up && !hasAbove {
		e.Direction = Down
	} else if e.Direction == Down && !hasBelow {
		e.Direction = Up
	}
}

// --- Dispatcher (SCAN / Look algorithm) ---

type NearestDispatcher struct{}

func (nd *NearestDispatcher) Dispatch(floor int, dir Direction, elevators []*Elevator) *Elevator {
	var best *Elevator
	bestScore := math.MaxInt64

	for _, e := range elevators {
		e.mu.Lock()
		if e.State == OutOfService {
			e.mu.Unlock()
			continue
		}

		score := nd.calculateScore(e, floor, dir)
		e.mu.Unlock()

		if score < bestScore {
			bestScore = score
			best = e
		}
	}
	return best
}

func (nd *NearestDispatcher) calculateScore(e *Elevator, floor int, dir Direction) int {
	distance := abs(e.CurrentFloor - floor)

	// Prefer elevators already moving in the right direction
	if e.Direction == Idle {
		return distance // idle elevator - just use distance
	}
	if e.Direction == dir {
		// Moving in same direction
		if (dir == Up && e.CurrentFloor <= floor) ||
			(dir == Down && e.CurrentFloor >= floor) {
			return distance // on the way
		}
	}
	// Elevator is moving away or wrong direction - penalize
	return distance + 1000
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// --- Building ---

type Building struct {
	mu         sync.Mutex
	Elevators  []*Elevator
	Dispatcher Dispatcher
	MinFloor   int
	MaxFloor   int
}

type BuildingConfig struct {
	NumElevators int
	MinFloor     int
	MaxFloor     int
	Dispatcher   Dispatcher
}

func NewBuilding(cfg BuildingConfig) *Building {
	b := &Building{
		Dispatcher: cfg.Dispatcher,
		MinFloor:   cfg.MinFloor,
		MaxFloor:   cfg.MaxFloor,
	}
	for i := 0; i < cfg.NumElevators; i++ {
		b.Elevators = append(b.Elevators, NewElevator(i+1, cfg.MinFloor, cfg.MaxFloor))
	}
	return b
}

func (b *Building) RequestElevator(floor int, dir Direction) (*Elevator, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if floor < b.MinFloor || floor > b.MaxFloor {
		return nil, fmt.Errorf("floor %d out of range", floor)
	}

	elevator := b.Dispatcher.Dispatch(floor, dir, b.Elevators)
	if elevator == nil {
		return nil, errors.New("no elevator available")
	}

	if err := elevator.AddDestination(floor); err != nil {
		return nil, fmt.Errorf("add destination: %w", err)
	}

	return elevator, nil
}

func (b *Building) Tick() {
	for _, e := range b.Elevators {
		e.Step()
	}
}
```

### SOLID Analysis

- **S:** `Elevator` manages its own state, `Dispatcher` handles selection logic, `Building` orchestrates.
- **O:** New dispatching strategies (e.g., zone-based) implement `Dispatcher` without changing `Building`.
- **L:** Any `Dispatcher` implementation is interchangeable.
- **I:** `Dispatcher` is a single-method interface - minimal and focused.
- **D:** `Building` depends on the `Dispatcher` interface, not a concrete implementation.


### Junior → FAANG: Elevator System LLD Basics

The elevator system problem requires modeling the dispatcher, elevator cars, and the scheduling algorithm. Entities: ElevatorSystem, Elevator, ElevatorButton, FloorButton, ElevatorState. The scheduling algorithm is the most interesting part: SCAN (the elevator moves in one direction until it reaches the top or bottom, then reverses, similar to a disk scheduler) is the standard algorithm. In Go, model the elevator state machine (Idle, MovingUp, MovingDown) and the dispatcher as separate concerns with a channel-based request queue.

### Senior @ FAANG: Elevator System at the Senior Bar: Multi-Elevator Optimization and Safety

At the senior level, the elevator system discussion extends to multi-elevator optimization: how does the dispatcher assign incoming requests to the most efficient elevator? The naive approach (round-robin) is incorrect. The correct approach minimizes the expected wait time, which depends on each elevator's current position, direction, and pending requests. This is a scheduling optimization problem that senior candidates should be able to discuss at a high level: nearest car algorithm, directional scan with request integration, and the zonal assignment approach (each elevator serves a subset of floors). The safety concern is also senior-level: elevator control systems in the real world have hard safety constraints (no two elevators on the same shaft, maximum load capacity enforcement, door interlock requirements). Designing with these constraints requires explicit safety state checks that cannot be bypassed by callers.

---
