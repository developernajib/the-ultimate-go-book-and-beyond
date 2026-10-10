## Deep Dive: Restaurant Search with Geospatial Indexing

When a customer opens the app, the first thing they see is a list of nearby restaurants. This search must be fast (under 100ms) and accurate, filtering by distance, cuisine type, and whether the restaurant is currently open. The implementation uses Redis GEO commands for the spatial radius query to find candidate restaurants, then pipelines individual hash lookups to fetch each restaurant's details in a single round trip. This two-step approach avoids the overhead of a full-text search engine for simple proximity queries while still supporting filtering.

```go
package search

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

type ElasticsearchClient interface{}

type RestaurantSummary struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	CuisineType string  `json:"cuisine_type"`
	DistanceKm  float64 `json:"distance_km"`
}

// RestaurantSearchService handles nearby restaurant discovery
type RestaurantSearchService struct {
	rdb      *redis.ClusterClient
	esClient ElasticsearchClient
}

// NearbySearch finds restaurants near a location using Redis GEO
func (s *RestaurantSearchService) NearbySearch(
	ctx context.Context,
	lat, lng, radiusKm float64,
	cuisine string,
	sortBy string,
	limit int,
) ([]RestaurantSummary, error) {
	// GeoSearchLocation (not GeoSearch, which returns bare member
	// names) yields GeoLocation structs with Name and Dist populated.
	results, err := s.rdb.GeoSearchLocation(ctx, "restaurants:geo", &redis.GeoSearchLocationQuery{
		GeoSearchQuery: redis.GeoSearchQuery{
			Longitude:  lng,
			Latitude:   lat,
			Radius:     radiusKm,
			RadiusUnit: "km",
			Sort:       "ASC",
			Count:      limit * 3,
		},
		WithDist: true,
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("geo search: %w", err)
	}

	var restaurants []RestaurantSummary
	pipe := s.rdb.Pipeline()
	cmds := make([]*redis.MapStringStringCmd, len(results))

	for i, r := range results {
		cmds[i] = pipe.HGetAll(ctx, fmt.Sprintf("restaurant:%s", r.Name))
	}
	pipe.Exec(ctx)

	for i, cmd := range cmds {
		data, err := cmd.Result()
		if err != nil || len(data) == 0 {
			continue
		}
		if cuisine != "" && data["cuisine_type"] != cuisine {
			continue
		}
		if data["is_open"] != "1" {
			continue
		}
		restaurants = append(restaurants, RestaurantSummary{
			ID:          results[i].Name,
			Name:        data["name"],
			CuisineType: data["cuisine_type"],
			DistanceKm:  results[i].Dist,
		})
		if len(restaurants) >= limit {
			break
		}
	}

	return restaurants, nil
}
```

---
