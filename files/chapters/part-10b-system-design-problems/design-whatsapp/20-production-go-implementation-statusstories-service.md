## Production Go Implementation: Status/Stories Service

WhatsApp Status is similar to Instagram Stories: users can post text, images, or videos that disappear after 24 hours. The service stores status items with a time-to-live so they are automatically cleaned up by Cassandra. When a user opens the Status tab, the system fetches active statuses from all their contacts and groups them by user. View tracking lets the poster see who has viewed their status, similar to read receipts for messages.

```go
package status

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
)

// StatusService manages WhatsApp Status (Stories feature)
type StatusService struct {
	statusDB   StatusStore
	mediaStore MediaStore
	contactSvc ContactService
}

type StatusItem struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Type      string    `json:"type"` // "text", "image", "video"
	MediaKey  string    `json:"media_key,omitempty"`
	MediaURL  string    `json:"media_url,omitempty"`
	Text      string    `json:"text,omitempty"`
	BGColor   string    `json:"bg_color,omitempty"` // for text statuses
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`

	// ViewCount is derived by counting the status_viewers partition, not stored
	// on the row. Cassandra cannot safely increment a plain INT (read-modify-
	// write loses concurrent updates) and refuses to put a COUNTER column in a
	// table that has ordinary columns. Populated on read for the poster only.
	ViewCount int `json:"view_count"`
}

// PostStatus creates a new status visible to contacts for 24 hours
func (s *StatusService) PostStatus(ctx context.Context, userID string, item StatusItem) (*StatusItem, error) {
	item.ID = uuid.NewString()
	item.UserID = userID
	// One clock reading, not two. Calling time.Now() twice lets the two fields
	// disagree, and expiry would drift from creation by however long the line
	// between them took.
	item.CreatedAt = time.Now()
	item.ExpiresAt = item.CreatedAt.Add(24 * time.Hour)

	if item.MediaKey != "" {
		url, err := s.mediaStore.GetURL(ctx, item.MediaKey)
		if err != nil {
			return nil, fmt.Errorf("get media url: %w", err)
		}
		item.MediaURL = url
	}

	if err := s.statusDB.Create(ctx, &item); err != nil {
		return nil, err
	}

	return &item, nil
}

// GetContactStatuses returns all active statuses from the user's contacts.
func (s *StatusService) GetContactStatuses(ctx context.Context, userID string) ([]StatusGroup, error) {
	contacts, err := s.contactSvc.GetContacts(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get contacts: %w", err)
	}
	if len(contacts) == 0 {
		return nil, nil
	}

	ids := make([]string, 0, len(contacts))
	for _, c := range contacts {
		ids = append(ids, c.UserID)
	}

	// One batched query rather than a GetActive per contact. The loop version
	// is an N+1: an address book of 500 contacts costs 500 sequential round
	// trips every time the Status tab is opened, which is both slow and a
	// needless multiplier on database load at 500M users.
	byUser, err := s.statusDB.GetActiveForUsers(ctx, ids)
	if err != nil {
		// The loop swallowed this with `if err != nil { continue }`, so a
		// database failure was indistinguishable from "your contacts posted
		// nothing". Silently showing an empty screen is worse than an error:
		// nobody gets paged and the feature just looks dead.
		return nil, fmt.Errorf("get active statuses: %w", err)
	}

	groups := make([]StatusGroup, 0, len(contacts))
	for _, contact := range contacts {
		items := byUser[contact.UserID]
		if len(items) == 0 {
			continue
		}
		groups = append(groups, StatusGroup{
			UserID:   contact.UserID,
			UserName: contact.Name,
			Items:    items,
		})
	}
	return groups, nil
}

// RecordView tracks who has seen a status.
//
// posterID is required, not incidental: status_items is partitioned by user_id,
// so a status cannot be fetched by its ID alone. The client already knows whose
// status it is opening, because it received them grouped by poster, and taking
// the parameter here beats adding a secondary index to work around an API shape
// that did not match the table.
//
// The authorization check is the point of the rest. Without it, a status ID is
// a guessable handle to someone else's post: a caller could record views on
// statuses they were never shown and, from whether the call succeeds, learn
// which IDs exist.
func (s *StatusService) RecordView(ctx context.Context, posterID, statusID, viewerID string) error {
	if posterID == viewerID {
		return nil // viewing your own status is not a view
	}

	item, err := s.statusDB.Get(ctx, posterID, statusID)
	if err != nil {
		return fmt.Errorf("load status: %w", err)
	}
	if time.Now().After(item.ExpiresAt) {
		return ErrNotFound // expired, treat as gone
	}

	visible, err := s.contactSvc.CanSeeStatus(ctx, posterID, viewerID)
	if err != nil {
		return fmt.Errorf("authorize: %w", err)
	}
	if !visible {
		// Same error a missing status returns, so this cannot be used to probe
		// for which status IDs are real.
		return ErrNotFound
	}

	// Idempotent: status_viewers is keyed on (status_id, viewer_id), so opening
	// the same status ten times records one viewer, not ten.
	if err := s.statusDB.AddViewer(ctx, statusID, viewerID, time.Now()); err != nil {
		return fmt.Errorf("add viewer: %w", err)
	}
	log.Printf("status %s viewed by %s", statusID, viewerID)
	return nil
}

type StatusGroup struct {
	UserID   string       `json:"user_id"`
	UserName string       `json:"user_name"`
	Items    []StatusItem `json:"items"`
}
```

The ID generation in `PostStatus` deserves a note, because the stub it replaces is the most dangerous kind of bug: one that compiles, runs, and quietly destroys data. A `generateStatusID` that returns `""` gives every status the same primary key. The store upserts, so each post overwrites the previous one, not just for that user but across all users, leaving exactly one row in the table. Every `RecordView` then targets that single shared row. Nothing errors and nothing logs. Placeholder functions that return a zero value are worth hunting for specifically, because the type checker cannot tell you that `""` was never meant to be a real ID.

---
