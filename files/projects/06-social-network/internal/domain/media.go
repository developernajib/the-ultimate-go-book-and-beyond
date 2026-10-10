// internal/domain/media.go
package domain

import (
	"time"

	"github.com/google/uuid"
)

// Media represents an uploaded media asset.
type Media struct {
	ID           uuid.UUID  `json:"id" db:"id"`
	UserID       uuid.UUID  `json:"user_id" db:"user_id"`
	OriginalURL  string     `json:"original_url" db:"original_url"`
	ThumbnailURL *string    `json:"thumbnail_url" db:"thumbnail_url"`
	MediumURL    *string    `json:"medium_url" db:"medium_url"`
	LargeURL     *string    `json:"large_url" db:"large_url"`
	MediaType    string     `json:"media_type" db:"media_type"`
	MimeType     string     `json:"mime_type" db:"mime_type"`
	SizeBytes    int64      `json:"size_bytes" db:"size_bytes"`
	Width        *int       `json:"width" db:"width"`
	Height       *int       `json:"height" db:"height"`
	CreatedAt    time.Time  `json:"created_at" db:"created_at"`
}
