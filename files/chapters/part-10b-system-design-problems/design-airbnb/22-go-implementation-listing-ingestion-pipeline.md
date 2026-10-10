## Go Implementation: Listing Ingestion Pipeline

When a host creates a new listing, it must go through several processing steps before it becomes searchable by guests. The ingestion pipeline handles photo processing (resizing each uploaded image into large, medium, and thumbnail variants for different screen sizes), persists the listing in PostgreSQL as the source of truth, and then submits it for content moderation via a Kafka event. Only after moderation approval does the listing get indexed in Elasticsearch and become visible in search results. This pipeline ensures that every listing meets quality and safety standards before guests can see it.

```go
package listing

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

type GeoPoint struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

type DatabaseClient interface {
	Exec(ctx context.Context, query string, args ...any) error
}

type ElasticsearchClient interface {
	Index(index, id string, doc []byte) error
}

type ImageProcessingService interface {
	ProcessListingPhoto(ctx context.Context, photoURL, listingID string, index int) (*ProcessedPhoto, error)
}

type EventProducer interface {
	Publish(ctx context.Context, topic, key string, value any) error
}

type Listing struct {
	ID                 string
	HostID             string
	Title              string
	Description        string
	PropertyType       string
	Accommodates       int
	PricePerNightCents int64
	CleaningFeeCents   int64
	Amenities          []string
	Photos             []ProcessedPhoto
	Lat                float64
	Lng                float64
	Status             string
	CreatedAt          time.Time
}

// ListingIngestionService handles listing creation and indexing
type ListingIngestionService struct {
	db       DatabaseClient
	esClient ElasticsearchClient
	imgProc  ImageProcessingService
	kafka    EventProducer
}

type CreateListingRequest struct {
	HostID        string   `json:"host_id"`
	Title         string   `json:"title" validate:"required,min=10,max=500"`
	Description   string   `json:"description" validate:"required,min=50,max=5000"`
	PropertyType  string   `json:"property_type" validate:"required,oneof=entire_home private_room shared_room"`
	Accommodates  int      `json:"accommodates" validate:"required,min=1,max=16"`
	Bedrooms      int      `json:"bedrooms" validate:"min=0,max=50"`
	Bathrooms     float64  `json:"bathrooms" validate:"min=0,max=50"` // 1.5 baths, not money
	// Money in cents, so the bounds are cents: min=100 is the $1 floor.
	PricePerNightCents int64 `json:"price_per_night_cents" validate:"required,min=100"`
	CleaningFeeCents   int64 `json:"cleaning_fee_cents" validate:"min=0"`
	Amenities     []string `json:"amenities"`
	Photos        []string `json:"photo_urls" validate:"required,min=5"`
	Location      GeoPoint `json:"location" validate:"required"`
	Address       string   `json:"address" validate:"required"`
	HouseRules    string   `json:"house_rules"`
	CancellationPolicy string `json:"cancellation_policy" validate:"required,oneof=flexible moderate strict"`
}

// CreateListing handles new listing creation with photo processing
func (s *ListingIngestionService) CreateListing(ctx context.Context, req CreateListingRequest) (*Listing, error) {
	listingID := generateID()

	// 1. Process photos (resize, optimize)
	var processedPhotos []ProcessedPhoto
	for i, photoURL := range req.Photos {
		processed, err := s.imgProc.ProcessListingPhoto(ctx, photoURL, listingID, i)
		if err != nil {
			return nil, fmt.Errorf("process photo %d: %w", i, err)
		}
		processedPhotos = append(processedPhotos, *processed)
	}

	// 2. Save to database
	listing := &Listing{
		ID:            listingID,
		HostID:        req.HostID,
		Title:         req.Title,
		Description:   req.Description,
		PropertyType:  req.PropertyType,
		Accommodates:  req.Accommodates,
		PricePerNightCents: req.PricePerNightCents,
		CleaningFeeCents:   req.CleaningFeeCents,
		Amenities:     req.Amenities,
		Photos:        processedPhotos,
		Lat:           req.Location.Lat,
		Lng:           req.Location.Lng,
		Status:        "pending_review", // moderation before going live
		CreatedAt:     time.Now(),
	}

	if err := s.saveListing(ctx, listing); err != nil {
		return nil, err
	}

	// 3. Submit for moderation
	s.kafka.Publish(ctx, "listing-moderation", listingID, listing)

	return listing, nil
}

// ActivateListing makes a listing searchable after moderation
func (s *ListingIngestionService) ActivateListing(ctx context.Context, listingID string) error {
	// Update DB status
	s.db.Exec(ctx, "UPDATE listings SET status = 'active' WHERE id = $1", listingID)

	// Index in Elasticsearch
	listing, _ := s.getListing(ctx, listingID)
	esDoc, _ := json.Marshal(listing)
	s.esClient.Index("listings", listingID, esDoc)

	return nil
}

type ProcessedPhoto struct {
	OriginalURL  string `json:"original_url"`
	LargeURL     string `json:"large_url"`   // 1200px
	MediumURL    string `json:"medium_url"`  // 600px
	ThumbnailURL string `json:"thumbnail_url"` // 300px
}

func (s *ListingIngestionService) saveListing(ctx context.Context, listing *Listing) error {
	return nil
}

func (s *ListingIngestionService) getListing(ctx context.Context, listingID string) (*Listing, error) {
	return &Listing{ID: listingID}, nil
}

func generateID() string {
	return "listing-1"
}
```

---
