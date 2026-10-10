## Deep Dive: Surge Pricing Engine

Surge pricing balances supply and demand in real time by adjusting delivery fees when too many orders compete for too few drivers in a given area. The system divides the map into hexagonal cells using the H3 geospatial indexing library, which provides uniform area coverage without the distortion problems of square grids. Each cell independently tracks how many orders are being placed (demand) versus how many drivers are available (supply) within a rolling 5-minute window. When the demand-to-supply ratio exceeds defined thresholds, the delivery fee multiplier increases to attract more drivers to the area.

```go
package surge

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/uber/h3-go/v4"
)

// SurgePricingService calculates dynamic delivery fees
// Uses H3 hexagonal grid cells for geofenced zones
type SurgePricingService struct {
	rdb *redis.ClusterClient
}

type SurgeInfo struct {
	Multiplier  float64   `json:"multiplier"`
	H3Cell      string    `json:"h3_cell"`
	DemandCount int       `json:"demand_count"`
	SupplyCount int       `json:"supply_count"`
	ValidUntil  time.Time `json:"valid_until"`
}

// GetSurgeMultiplier returns the current surge multiplier for a location
func (s *SurgePricingService) GetSurgeMultiplier(ctx context.Context, lat, lng float64) (*SurgeInfo, error) {
	// Convert lat/lng to H3 cell at resolution 9 (~175m hexagon edge)
	cell, err := h3.LatLngToCell(h3.LatLng{Lat: lat, Lng: lng}, 9)
	if err != nil {
		return nil, fmt.Errorf("h3 cell: %w", err)
	}
	cellHex := cell.String()

	// Check cache first
	cacheKey := fmt.Sprintf("surge:%s", cellHex)
	if cached, err := s.rdb.Get(ctx, cacheKey).Float64(); err == nil {
		return &SurgeInfo{Multiplier: cached, H3Cell: cellHex}, nil
	}

	demandKey := fmt.Sprintf("demand:%s", cellHex)
	supplyKey := fmt.Sprintf("supply:%s", cellHex)

	demand, _ := s.rdb.Get(ctx, demandKey).Int()
	// supply is a set of driver IDs, so count it with SCARD, not GET
	supply64, _ := s.rdb.SCard(ctx, supplyKey).Result()
	supply := int(supply64)

	if supply == 0 {
		supply = 1
	}

	ratio := float64(demand) / float64(supply)
	multiplier := calculateMultiplier(ratio)

	info := &SurgeInfo{
		Multiplier:  multiplier,
		H3Cell:      cellHex,
		DemandCount: demand,
		SupplyCount: supply,
		ValidUntil:  time.Now().Add(5 * time.Minute),
	}

	s.rdb.Set(ctx, cacheKey, multiplier, 5*time.Minute)
	return info, nil
}

// RecordDemand increments the demand counter for an order placement
func (s *SurgePricingService) RecordDemand(ctx context.Context, lat, lng float64) {
	cell, err := h3.LatLngToCell(h3.LatLng{Lat: lat, Lng: lng}, 9)
	if err != nil {
		return
	}
	key := fmt.Sprintf("demand:%s", cell.String())
	s.rdb.Incr(ctx, key)
	s.rdb.Expire(ctx, key, 5*time.Minute)
}

// RecordSupply updates the available driver count in a cell
func (s *SurgePricingService) RecordSupply(ctx context.Context, lat, lng float64, driverID string) {
	cell, err := h3.LatLngToCell(h3.LatLng{Lat: lat, Lng: lng}, 9)
	if err != nil {
		return
	}
	key := fmt.Sprintf("supply:%s", cell.String())
	s.rdb.SAdd(ctx, key, driverID)
	s.rdb.Expire(ctx, key, 2*time.Minute)
}

func calculateMultiplier(ratio float64) float64 {
	switch {
	case ratio <= 1.0:
		return 1.0
	case ratio <= 1.5:
		return 1.2
	case ratio <= 2.0:
		return 1.5
	case ratio <= 3.0:
		return 1.8
	default:
		return math.Min(2.5, 1.0+ratio*0.5)
	}
}
```

---
