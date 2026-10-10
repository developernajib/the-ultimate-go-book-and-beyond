## OOD Interview Problems

### Problem 1: LRU Cache

Design and implement an LRU (Least Recently Used) cache with O(1) get and put operations.

**C++ Implementation:**

```cpp
#include <list>
#include <unordered_map>
#include <optional>
#include <stdexcept>

template <typename Key, typename Value>
class LRUCache {
public:
    explicit LRUCache(size_t capacity) : capacity_(capacity) {
        if (capacity == 0) {
            throw std::invalid_argument("Capacity must be > 0");
        }
    }

    // Get value by key. Returns std::nullopt if not found.
    // Moves accessed item to front (most recently used).
    std::optional<Value> get(const Key& key) {
        auto it = map_.find(key);
        if (it == map_.end()) {
            return std::nullopt;
        }

        // Move to front of list (most recently used)
        list_.splice(list_.begin(), list_, it->second);
        return it->second->second;
    }

    // Insert or update a key-value pair.
    // If cache is full, evicts least recently used item.
    void put(const Key& key, const Value& value) {
        auto it = map_.find(key);

        if (it != map_.end()) {
            // Key exists: update value and move to front
            it->second->second = value;
            list_.splice(list_.begin(), list_, it->second);
            return;
        }

        // Evict if at capacity
        if (map_.size() >= capacity_) {
            auto& lru = list_.back();        // least recently used
            map_.erase(lru.first);           // remove from map
            list_.pop_back();                // remove from list
        }

        // Insert new entry at front
        list_.emplace_front(key, value);
        map_[key] = list_.begin();
    }

    size_t size() const { return map_.size(); }
    size_t capacity() const { return capacity_; }

    // Check if key exists without affecting LRU order
    bool contains(const Key& key) const {
        return map_.find(key) != map_.end();
    }

private:
    size_t capacity_;

    // Doubly-linked list: front = most recently used, back = least recently used
    // Each node stores a key-value pair.
    std::list<std::pair<Key, Value>> list_;

    // Hash map: key -> iterator into the list
    std::unordered_map<Key, typename std::list<std::pair<Key, Value>>::iterator> map_;
};

// Usage
int main() {
    LRUCache<std::string, int> cache(3);

    cache.put("a", 1);
    cache.put("b", 2);
    cache.put("c", 3);

    auto val = cache.get("a");  // returns 1, moves "a" to front
    // Order: a, c, b

    cache.put("d", 4);          // evicts "b" (least recently used)
    // Order: d, a, c

    auto evicted = cache.get("b"); // returns std::nullopt

    return 0;
}
```

**Why this design:**
- `std::list` provides O(1) splice (move node to front) and O(1) removal from back
- `std::unordered_map` provides O(1) lookup by key
- Iterator stability: `std::list` iterators are not invalidated by insertions/deletions elsewhere
- Template: works with any key/value types

**Go Implementation for Comparison:**

```go
package lru

import "container/list"

type LRUCache[K comparable, V any] struct {
    capacity int
    list     *list.List
    items    map[K]*list.Element
}

type entry[K comparable, V any] struct {
    key   K
    value V
}

func New[K comparable, V any](capacity int) *LRUCache[K, V] {
    return &LRUCache[K, V]{
        capacity: capacity,
        list:     list.New(),
        items:    make(map[K]*list.Element),
    }
}

func (c *LRUCache[K, V]) Get(key K) (V, bool) {
    if elem, ok := c.items[key]; ok {
        c.list.MoveToFront(elem)
        return elem.Value.(*entry[K, V]).value, true
    }
    var zero V
    return zero, false
}

func (c *LRUCache[K, V]) Put(key K, value V) {
    if elem, ok := c.items[key]; ok {
        c.list.MoveToFront(elem)
        elem.Value.(*entry[K, V]).value = value
        return
    }

    if c.list.Len() >= c.capacity {
        back := c.list.Back()
        c.list.Remove(back)
        delete(c.items, back.Value.(*entry[K, V]).key)
    }

    elem := c.list.PushFront(&entry[K, V]{key: key, value: value})
    c.items[key] = elem
}
```

**Comparison notes:**
- Both use the same algorithm: hash map + doubly linked list
- C++ version is generic via templates. Go version uses type parameters (Go 1.18+)
- C++ `std::optional` vs Go's multi-return `(V, bool)` pattern
- Go's `container/list` uses `interface{}` internally (type assertions needed), while C++ `std::list` is fully typed
- The C++ version's destructor handles cleanup automatically (Rule of Zero: `std::list` and `std::unordered_map` clean up their own memory)

### Problem 2: Parking Lot Design

Design a parking lot system that supports multiple vehicle sizes, multiple floors, and tracking of available spots.

**C++ Implementation:**

```cpp
#include <string>
#include <vector>
#include <unordered_map>
#include <memory>
#include <optional>
#include <iostream>
#include <chrono>
#include <iomanip>
#include <mutex>

// ---- Enums ----
enum class VehicleSize { Motorcycle, Compact, Regular, Large };

std::string vehicleSizeToString(VehicleSize s) {
    switch (s) {
        case VehicleSize::Motorcycle: return "Motorcycle";
        case VehicleSize::Compact:    return "Compact";
        case VehicleSize::Regular:    return "Regular";
        case VehicleSize::Large:      return "Large";
    }
    return "Unknown";
}

// ---- Vehicle (base class) ----
class Vehicle {
public:
    Vehicle(std::string licensePlate, VehicleSize size)
        : licensePlate_(std::move(licensePlate)), size_(size) {}
    virtual ~Vehicle() = default;

    const std::string& licensePlate() const { return licensePlate_; }
    VehicleSize size() const { return size_; }
    virtual std::string type() const = 0;

private:
    std::string licensePlate_;
    VehicleSize size_;
};

class Motorcycle : public Vehicle {
public:
    explicit Motorcycle(const std::string& plate)
        : Vehicle(plate, VehicleSize::Motorcycle) {}
    std::string type() const override { return "Motorcycle"; }
};

class Car : public Vehicle {
public:
    explicit Car(const std::string& plate)
        : Vehicle(plate, VehicleSize::Regular) {}
    std::string type() const override { return "Car"; }
};

class Truck : public Vehicle {
public:
    explicit Truck(const std::string& plate)
        : Vehicle(plate, VehicleSize::Large) {}
    std::string type() const override { return "Truck"; }
};

// ---- Parking Spot ----
class ParkingSpot {
public:
    ParkingSpot(int floor, int number, VehicleSize size)
        : floor_(floor), number_(number), size_(size) {}

    bool canFit(VehicleSize vehicleSize) const {
        return !occupied_ && vehicleSize <= size_;
    }

    bool park(const Vehicle* vehicle) {
        if (!canFit(vehicle->size())) return false;
        occupied_ = true;
        vehicle_ = vehicle;
        return true;
    }

    void vacate() {
        occupied_ = false;
        vehicle_ = nullptr;
    }

    bool isOccupied() const { return occupied_; }
    int floor() const { return floor_; }
    int number() const { return number_; }
    VehicleSize size() const { return size_; }
    const Vehicle* vehicle() const { return vehicle_; }

    std::string id() const {
        return "F" + std::to_string(floor_) + "-S" + std::to_string(number_);
    }

private:
    int floor_;
    int number_;
    VehicleSize size_;
    bool occupied_ = false;
    const Vehicle* vehicle_ = nullptr;
};

// ---- Ticket ----
struct ParkingTicket {
    std::string ticketId;
    std::string licensePlate;
    std::string spotId;
    std::chrono::steady_clock::time_point entryTime;
};

// ---- Pricing Strategy (Strategy Pattern) ----
class PricingStrategy {
public:
    virtual ~PricingStrategy() = default;
    virtual long long calculateCents(const ParkingTicket& ticket,
                                     std::chrono::steady_clock::time_point exitTime) const = 0;
};

class HourlyPricing : public PricingStrategy {
public:
    explicit HourlyPricing(long long ratePerHourCents) : rateCents_(ratePerHourCents) {}

    long long calculateCents(const ParkingTicket& ticket,
                             std::chrono::steady_clock::time_point exitTime) const override {
        auto duration = std::chrono::duration_cast<std::chrono::minutes>(
            exitTime - ticket.entryTime
        );
        long long hours = (duration.count() + 59) / 60; // ceil to whole hours
        if (hours < 1) hours = 1; // minimum 1 hour
        return hours * rateCents_; // money stays in integer cents
    }

private:
    long long rateCents_;
};

// ---- Parking Lot ----
class ParkingLot {
public:
    ParkingLot(int floors, int spotsPerFloor,
               std::unique_ptr<PricingStrategy> pricing)
        : pricing_(std::move(pricing)) {
        // Create spots: 20% motorcycle, 30% compact, 30% regular, 20% large
        for (int f = 0; f < floors; ++f) {
            for (int s = 0; s < spotsPerFloor; ++s) {
                VehicleSize size;
                double ratio = static_cast<double>(s) / spotsPerFloor;
                if (ratio < 0.2)      size = VehicleSize::Motorcycle;
                else if (ratio < 0.5) size = VehicleSize::Compact;
                else if (ratio < 0.8) size = VehicleSize::Regular;
                else                  size = VehicleSize::Large;

                spots_.emplace_back(f, s, size);
            }
        }
    }

    // Park a vehicle. Returns a ticket on success.
    std::optional<ParkingTicket> park(const Vehicle* vehicle) {
        std::lock_guard<std::mutex> lock(mutex_);

        // Check if already parked
        if (vehicleToSpot_.count(vehicle->licensePlate())) {
            return std::nullopt;
        }

        // Find first available spot that fits
        for (auto& spot : spots_) {
            if (spot.canFit(vehicle->size())) {
                spot.park(vehicle);

                ParkingTicket ticket{
                    generateTicketId(),
                    vehicle->licensePlate(),
                    spot.id(),
                    std::chrono::steady_clock::now()
                };

                tickets_[ticket.ticketId] = ticket;
                vehicleToSpot_[vehicle->licensePlate()] = &spot;

                return ticket;
            }
        }

        return std::nullopt; // no available spot
    }

    // Unpark: returns the amount owed
    std::optional<long long> unpark(const std::string& ticketId) {
        std::lock_guard<std::mutex> lock(mutex_);

        auto ticketIt = tickets_.find(ticketId);
        if (ticketIt == tickets_.end()) {
            return std::nullopt;
        }

        auto& ticket = ticketIt->second;
        auto spotIt = vehicleToSpot_.find(ticket.licensePlate);
        if (spotIt != vehicleToSpot_.end()) {
            spotIt->second->vacate();
            vehicleToSpot_.erase(spotIt);
        }

        auto exitTime = std::chrono::steady_clock::now();
        long long amountCents = pricing_->calculateCents(ticket, exitTime);

        tickets_.erase(ticketIt);
        return amountCents;
    }

    // Count available spots by size
    int availableSpots(VehicleSize size) const {
        std::lock_guard<std::mutex> lock(mutex_);
        int count = 0;
        for (const auto& spot : spots_) {
            if (spot.canFit(size)) ++count;
        }
        return count;
    }

    int totalSpots() const { return static_cast<int>(spots_.size()); }

private:
    std::string generateTicketId() {
        return "TKT-" + std::to_string(nextTicketId_++);
    }

    std::vector<ParkingSpot> spots_;
    std::unordered_map<std::string, ParkingTicket> tickets_;
    std::unordered_map<std::string, ParkingSpot*> vehicleToSpot_;
    std::unique_ptr<PricingStrategy> pricing_;
    int nextTicketId_ = 1;
    mutable std::mutex mutex_;
};

// Usage
int main() {
    auto pricing = std::make_unique<HourlyPricing>(500); // $5.00/hour in cents
    ParkingLot lot(3, 100, std::move(pricing)); // 3 floors, 100 spots each

    Car myCar("ABC-123");
    auto ticket = lot.park(&myCar);

    if (ticket) {
        std::cout << "Parked at " << ticket->spotId
                  << " (ticket: " << ticket->ticketId << ")\n";

        // ... time passes ...

        auto amountCents = lot.unpark(ticket->ticketId);
        if (amountCents) {
            std::cout << "Amount due: $" << *amountCents / 100 << "."
                      << std::setfill('0') << std::setw(2) << *amountCents % 100 << "\n";
        }
    } else {
        std::cout << "No spots available\n";
    }

    return 0;
}
```

**Design patterns used:**
1. **Strategy Pattern** - `PricingStrategy` allows different pricing models without modifying `ParkingLot`
2. **Inheritance hierarchy** - `Vehicle` base with `Motorcycle`, `Car`, `Truck` derived classes
3. **RAII** - `std::lock_guard` for thread-safe operations, `std::unique_ptr` for ownership
4. **Open-Closed Principle** - New vehicle types or pricing strategies require no changes to `ParkingLot`
5. **Single Responsibility** - Each class has one job

**Go Implementation for Comparison:**

```go
package parking

import (
    "fmt"
    "sync"
    "time"
)

type VehicleSize int

const (
    SizeMotorcycle VehicleSize = iota
    SizeCompact
    SizeRegular
    SizeLarge
)

// Vehicle is an interface, not a class hierarchy
type Vehicle interface {
    LicensePlate() string
    Size() VehicleSize
    Type() string
}

type Car struct {
    plate string
}

func (c *Car) LicensePlate() string { return c.plate }
func (c *Car) Size() VehicleSize    { return SizeRegular }
func (c *Car) Type() string         { return "Car" }

type ParkingSpot struct {
    Floor    int
    Number   int
    SpotSize VehicleSize
    vehicle  Vehicle
}

func (s *ParkingSpot) CanFit(size VehicleSize) bool {
    return s.vehicle == nil && size <= s.SpotSize
}

func (s *ParkingSpot) Park(v Vehicle) bool {
    if !s.CanFit(v.Size()) {
        return false
    }
    s.vehicle = v
    return true
}

func (s *ParkingSpot) Vacate() { s.vehicle = nil }

func (s *ParkingSpot) ID() string {
    return fmt.Sprintf("F%d-S%d", s.Floor, s.Number)
}

type ParkingTicket struct {
    TicketID     string
    LicensePlate string
    SpotID       string
    EntryTime    time.Time
}

// PricingStrategy as an interface (Go way)
type PricingStrategy interface {
    CalculateCents(ticket ParkingTicket, exitTime time.Time) int64
}

type HourlyPricing struct {
    RateCents int64
}

func (p HourlyPricing) CalculateCents(ticket ParkingTicket, exitTime time.Time) int64 {
    mins := int64(exitTime.Sub(ticket.EntryTime) / time.Minute)
    hours := (mins + 59) / 60 // ceil to whole hours
    if hours < 1 {
        hours = 1
    }
    return hours * p.RateCents // money stays in integer cents
}

type ParkingLot struct {
    mu             sync.Mutex
    spots          []*ParkingSpot
    tickets        map[string]ParkingTicket
    vehicleToSpot  map[string]*ParkingSpot
    pricing        PricingStrategy
    nextTicketID   int
}

func NewParkingLot(floors, spotsPerFloor int, pricing PricingStrategy) *ParkingLot {
    lot := &ParkingLot{
        tickets:       make(map[string]ParkingTicket),
        vehicleToSpot: make(map[string]*ParkingSpot),
        pricing:       pricing,
        nextTicketID:  1,
    }

    for f := 0; f < floors; f++ {
        for s := 0; s < spotsPerFloor; s++ {
            ratio := float64(s) / float64(spotsPerFloor)
            var size VehicleSize
            switch {
            case ratio < 0.2:
                size = SizeMotorcycle
            case ratio < 0.5:
                size = SizeCompact
            case ratio < 0.8:
                size = SizeRegular
            default:
                size = SizeLarge
            }
            lot.spots = append(lot.spots, &ParkingSpot{
                Floor: f, Number: s, SpotSize: size,
            })
        }
    }
    return lot
}

func (lot *ParkingLot) Park(v Vehicle) (*ParkingTicket, error) {
    lot.mu.Lock()
    defer lot.mu.Unlock()

    if _, exists := lot.vehicleToSpot[v.LicensePlate()]; exists {
        return nil, fmt.Errorf("vehicle %s already parked", v.LicensePlate())
    }

    for _, spot := range lot.spots {
        if spot.CanFit(v.Size()) {
            spot.Park(v)
            ticket := ParkingTicket{
                TicketID:     fmt.Sprintf("TKT-%d", lot.nextTicketID),
                LicensePlate: v.LicensePlate(),
                SpotID:       spot.ID(),
                EntryTime:    time.Now(),
            }
            lot.nextTicketID++
            lot.tickets[ticket.TicketID] = ticket
            lot.vehicleToSpot[v.LicensePlate()] = spot
            return &ticket, nil
        }
    }
    return nil, fmt.Errorf("no available spot for %s", v.Type())
}
```

**Key design differences between the C++ and Go implementations:**

| Aspect | C++ Approach | Go Approach |
|---|---|---|
| Vehicle hierarchy | Inheritance (`Vehicle` base class) | Interface (`Vehicle` interface) |
| Polymorphism | Virtual functions + vtable | Interface satisfaction |
| Memory management | `unique_ptr`, `shared_ptr`, RAII | Garbage collector |
| Thread safety | `std::mutex` + `lock_guard` (RAII) | `sync.Mutex` + `defer Unlock()` |
| Error handling | `std::optional`, exceptions | Error return values |
| Pricing flexibility | Strategy pattern via abstract class | Strategy pattern via interface |

---

### Junior → FAANG: Structuring OOD Answers in Interviews

OOD interview questions at FAANG (LRU cache, parking lot, file system, library system) are evaluated on process, not just the final design. The expected process: (1) clarify requirements (what operations are needed, what are the scale constraints?), (2) identify the key entities and their relationships (draw a class diagram mentally), (3) state your design with the key OOP decisions (inheritance vs. composition, which methods are virtual, which are `const`), (4) walk through one or two operations in detail (LRU cache `get` and `put`), (5) discuss trade-offs and alternatives.

Practicing this five-step process for each problem in this section is more valuable than memorizing the "correct" solution, because interviewers vary the requirements to see if you can adapt.

### Senior @ FAANG: Bar-Raiser Signals in OOD Interviews

At the L6 bar-raiser level, OOD interview questions are used to probe system thinking and trade-off judgment, not just OOP knowledge.

**The expected depth for an L6 candidate.** For an LRU cache question, the L6 answer discusses: thread safety (which methods need to be synchronized, and at what granularity), capacity policy (fixed size vs. adaptive based on memory pressure), eviction strategy (LRU vs. LFU vs. SLRU), observability (how do you know the cache hit rate?), and the API contract (does `get` return a copy or a reference, and what are the lifetime implications?). An L4 answer describes the data structure. An L6 answer describes the system.

**For the parking lot question.** The L6 signal is discussing: the pricing strategy as a policy object (Strategy pattern, allowing different pricing models to be swapped without changing the core logic), the observability layer (what metrics does the parking lot emit, and how?), the fault tolerance model (what happens when the entry sensor fails?), and the operational runbook (how does an operator recover from a stuck gate?). These dimensions are not in the naive OOD answer, and asking about them is what separates a bar-raiser from a standard interviewer.

