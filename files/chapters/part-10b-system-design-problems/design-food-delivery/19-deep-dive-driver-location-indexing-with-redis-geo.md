## Deep Dive: Driver Location Indexing with Redis GEO

Driver location is the highest-throughput data in the entire system: 200K drivers sending GPS updates every 4 seconds produces 50K writes per second. Redis GEO commands provide O(log N) spatial indexing using sorted sets with geohash scores, making it ideal for both storing locations and querying for nearby drivers within a radius. Each driver's position is stored in two places: a GEO set for spatial queries (used by the Dispatch Service) and a hash with a 30-second TTL for detecting offline drivers. When the TTL expires without a fresh update, a cleanup job removes the driver from the active pool.

```go
package location

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type NearbyDriver struct {
	DriverID   string
	Lat        float64
	Lng        float64
	DistanceKm float64
}

// LocationService handles real-time driver location tracking
type LocationService struct {
	rdb *redis.ClusterClient
}

// UpdateDriverLocation stores the latest driver position
// Called every 4 seconds from driver app
func (s *LocationService) UpdateDriverLocation(ctx context.Context, driverID string, lat, lng float64) error {
	// Store in Redis GEO set for spatial queries
	_, err := s.rdb.GeoAdd(ctx, "drivers:active", &redis.GeoLocation{
		Name:      driverID,
		Latitude:  lat,
		Longitude: lng,
	}).Result()
	if err != nil {
		return fmt.Errorf("geo add: %w", err)
	}

	// Store detailed location data in a hash
	detailKey := fmt.Sprintf("driver:loc:%s", driverID)
	s.rdb.HSet(ctx, detailKey, map[string]any{
		"lat":       lat,
		"lng":       lng,
		"updated":   time.Now().Unix(),
	})
	s.rdb.Expire(ctx, detailKey, 30*time.Second) // TTL detects offline drivers

	return nil
}

// FindNearbyDrivers returns available drivers within radius
func (s *LocationService) FindNearbyDrivers(
	ctx context.Context,
	lat, lng float64,
	radiusMeters float64,
	limit int,
) ([]NearbyDriver, error) {
	results, err := s.rdb.GeoSearchLocation(ctx, "drivers:active", &redis.GeoSearchLocationQuery{
		GeoSearchQuery: redis.GeoSearchQuery{
			Longitude:  lng,
			Latitude:   lat,
			Radius:     radiusMeters,
			RadiusUnit: "m",
			Sort:       "ASC",
			Count:      limit,
		},
		WithCoord: true,
		WithDist:  true,
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("geo search: %w", err)
	}

	var drivers []NearbyDriver
	for _, r := range results {
		drivers = append(drivers, NearbyDriver{
			DriverID:   r.Name,
			Lat:        r.Latitude,
			Lng:        r.Longitude,
			DistanceKm: r.Dist / 1000.0,
		})
	}
	return drivers, nil
}

// RemoveOfflineDriver removes a driver who stopped sending updates
func (s *LocationService) RemoveOfflineDriver(ctx context.Context, driverID string) {
	s.rdb.ZRem(ctx, "drivers:active", driverID)
}

// CleanupOfflineDrivers removes drivers who haven't updated in 30 seconds
func (s *LocationService) CleanupOfflineDrivers(ctx context.Context) int {
	// Scan all members and check their detail hash TTL
	// If detail hash expired (no update in 30s), remove from GEO set
	members, _ := s.rdb.ZRange(ctx, "drivers:active", 0, -1).Result()
	removed := 0
	for _, driverID := range members {
		exists, _ := s.rdb.Exists(ctx, fmt.Sprintf("driver:loc:%s", driverID)).Result()
		if exists == 0 {
			s.rdb.ZRem(ctx, "drivers:active", driverID)
			removed++
		}
	}
	return removed
}
```

---
