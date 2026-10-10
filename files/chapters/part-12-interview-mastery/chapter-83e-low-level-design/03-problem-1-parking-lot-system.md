## 83E.3 Problem 1: Parking Lot System

### Requirements

1. Multiple floors, each with multiple parking spots
2. Three vehicle types: motorcycle, car, truck
3. Motorcycle fits in any spot. car fits in compact or large. truck needs large
4. Track which spots are occupied
5. Calculate parking fee based on duration

### API Design

Start by defining the public interface. These three operations cover the core use cases: parking a vehicle, retrieving it, and querying availability. Keeping the API minimal forces you to think about what information flows through the system.

```
ParkVehicle(vehicle) → ticket, error
UnparkVehicle(ticket) → fee, error
GetAvailableSpots(vehicleType) → count
```

### Implementation

The implementation models vehicles, spots, and floors as separate types connected through interfaces. The `ParkingLot` struct coordinates spot assignment using a size-matching strategy, and fee calculation is delegated to a `FeeCalculator` interface so pricing logic can change independently of the parking logic.

```go
package parkinglot

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// --- Enums ---

type VehicleType int

const (
	Motorcycle VehicleType = iota
	Car
	Truck
)

func (v VehicleType) String() string {
	return [...]string{"Motorcycle", "Car", "Truck"}[v]
}

type SpotSize int

const (
	SmallSpot SpotSize = iota
	CompactSpot
	LargeSpot
)

// --- Interfaces ---

type Vehicle interface {
	Type() VehicleType
	LicensePlate() string
}

type FeeCalculator interface {
	Calculate(duration time.Duration, vehicleType VehicleType) int64 // cents
}

// --- Vehicle implementations ---

type motorcycle struct{ plate string }

func (m *motorcycle) Type() VehicleType    { return Motorcycle }
func (m *motorcycle) LicensePlate() string { return m.plate }
func NewMotorcycle(plate string) Vehicle   { return &motorcycle{plate: plate} }

type car struct{ plate string }

func (c *car) Type() VehicleType    { return Car }
func (c *car) LicensePlate() string { return c.plate }
func NewCar(plate string) Vehicle   { return &car{plate: plate} }

type truck struct{ plate string }

func (t *truck) Type() VehicleType    { return Truck }
func (t *truck) LicensePlate() string { return t.plate }
func NewTruck(plate string) Vehicle   { return &truck{plate: plate} }

// --- Parking Spot ---

type ParkingSpot struct {
	ID      string
	Floor   int
	Size    SpotSize
	Vehicle Vehicle // nil if available
}

func (ps *ParkingSpot) IsAvailable() bool {
	return ps.Vehicle == nil
}

func (ps *ParkingSpot) CanFit(v Vehicle) bool {
	switch v.Type() {
	case Motorcycle:
		return true // fits in any spot
	case Car:
		return ps.Size >= CompactSpot
	case Truck:
		return ps.Size == LargeSpot
	default:
		return false
	}
}

func (ps *ParkingSpot) Park(v Vehicle) error {
	if !ps.IsAvailable() {
		return errors.New("spot is occupied")
	}
	if !ps.CanFit(v) {
		return errors.New("vehicle does not fit in this spot")
	}
	ps.Vehicle = v
	return nil
}

func (ps *ParkingSpot) Unpark() Vehicle {
	v := ps.Vehicle
	ps.Vehicle = nil
	return v
}

// --- Ticket ---

type Ticket struct {
	ID        string
	Vehicle   Vehicle
	Spot      *ParkingSpot
	EntryTime time.Time
}

// --- Fee Calculator ---

type HourlyFeeCalculator struct {
	Rates map[VehicleType]int64 // cents per hour
}

func NewHourlyFeeCalculator() FeeCalculator {
	return &HourlyFeeCalculator{
		Rates: map[VehicleType]int64{
			Motorcycle: 100, // $1/hour
			Car:        200, // $2/hour
			Truck:      300, // $3/hour
		},
	}
}

func (h *HourlyFeeCalculator) Calculate(duration time.Duration, vType VehicleType) int64 {
	hours := int64(duration.Hours())
	if duration.Minutes() > float64(hours)*60 {
		hours++ // round up to next hour
	}
	if hours == 0 {
		hours = 1 // minimum 1 hour
	}
	return hours * h.Rates[vType]
}

// --- Parking Lot ---

type ParkingLot struct {
	mu            sync.Mutex
	name          string
	floors        int
	spots         []*ParkingSpot
	activeTickets map[string]*Ticket // ticketID -> ticket
	feeCalc       FeeCalculator
	nextTicketID  int
}

type ParkingLotConfig struct {
	Name          string
	Floors        int
	SpotsPerFloor map[SpotSize]int
	FeeCalculator FeeCalculator
}

func NewParkingLot(cfg ParkingLotConfig) *ParkingLot {
	pl := &ParkingLot{
		name:          cfg.Name,
		floors:        cfg.Floors,
		activeTickets: make(map[string]*Ticket),
		feeCalc:       cfg.FeeCalculator,
	}

	spotID := 0
	for floor := 1; floor <= cfg.Floors; floor++ {
		for size, count := range cfg.SpotsPerFloor {
			for i := 0; i < count; i++ {
				spotID++
				pl.spots = append(pl.spots, &ParkingSpot{
					ID:    fmt.Sprintf("F%d-S%d", floor, spotID),
					Floor: floor,
					Size:  size,
				})
			}
		}
	}

	return pl
}

func (pl *ParkingLot) ParkVehicle(v Vehicle) (*Ticket, error) {
	pl.mu.Lock()
	defer pl.mu.Unlock()

	// Find the smallest available spot that fits
	var bestSpot *ParkingSpot
	for _, spot := range pl.spots {
		if spot.IsAvailable() && spot.CanFit(v) {
			if bestSpot == nil || spot.Size < bestSpot.Size {
				bestSpot = spot
			}
		}
	}

	if bestSpot == nil {
		return nil, errors.New("no available spot for this vehicle")
	}

	if err := bestSpot.Park(v); err != nil {
		return nil, fmt.Errorf("park vehicle: %w", err)
	}

	pl.nextTicketID++
	ticket := &Ticket{
		ID:        fmt.Sprintf("T-%d", pl.nextTicketID),
		Vehicle:   v,
		Spot:      bestSpot,
		EntryTime: time.Now(),
	}
	pl.activeTickets[ticket.ID] = ticket

	return ticket, nil
}

func (pl *ParkingLot) UnparkVehicle(ticketID string) (int64, error) {
	pl.mu.Lock()
	defer pl.mu.Unlock()

	ticket, exists := pl.activeTickets[ticketID]
	if !exists {
		return 0, errors.New("ticket not found")
	}

	duration := time.Since(ticket.EntryTime)
	fee := pl.feeCalc.Calculate(duration, ticket.Vehicle.Type())

	ticket.Spot.Unpark()
	delete(pl.activeTickets, ticketID)

	return fee, nil
}

func (pl *ParkingLot) GetAvailableSpots(vType VehicleType) int {
	pl.mu.Lock()
	defer pl.mu.Unlock()

	// Create a temporary vehicle to check fit
	var tempV Vehicle
	switch vType {
	case Motorcycle:
		tempV = &motorcycle{}
	case Car:
		tempV = &car{}
	case Truck:
		tempV = &truck{}
	}

	count := 0
	for _, spot := range pl.spots {
		if spot.IsAvailable() && spot.CanFit(tempV) {
			count++
		}
	}
	return count
}
```

### SOLID Analysis

- **S (Single Responsibility):** `ParkingSpot` manages spot state, `FeeCalculator` handles pricing, `ParkingLot` orchestrates.
- **O (Open-Closed):** New vehicle types or fee strategies can be added without modifying existing code.
- **L (Liskov Substitution):** Any `Vehicle` implementation works interchangeably.
- **I (Interface Segregation):** `Vehicle` and `FeeCalculator` are small, focused interfaces.
- **D (Dependency Inversion):** `ParkingLot` depends on `FeeCalculator` interface, not a concrete type.


### Junior → FAANG: Parking Lot LLD Basics

The parking lot problem is the classic LLD warm-up. Entities: ParkingLot, ParkingFloor, ParkingSpot, Vehicle, Ticket. Key behaviors: find an available spot for a vehicle type, park a vehicle (assign spot, issue ticket), exit a vehicle (compute fee, free spot). In Go, model each entity as a struct with methods, and use interfaces for the spot-selection strategy (nearest, random, specific type priority). The most common mistake is conflating the data model with the business logic: the spot-finding algorithm should be behind an interface, not hardcoded into the ParkingLot struct.

### Senior @ FAANG: Parking Lot LLD at the Senior Bar: Concurrency and Extensibility

At the senior level, the parking lot LLD must address concurrency: multiple vehicles may attempt to park simultaneously, and the spot assignment must be atomic to prevent two vehicles from being assigned the same spot. In Go, this requires a sync.Mutex protecting the spot availability state, or a channel-based serialized spot assignment service. The design should also be evaluated for extensibility: how would you add dynamic pricing (different rates for different hours of the day), handicapped spot reservation, or a waiting queue when the lot is full? Senior candidates should identify the extension points proactively and explain how their interface design enables each extension without modifying existing code.

---
