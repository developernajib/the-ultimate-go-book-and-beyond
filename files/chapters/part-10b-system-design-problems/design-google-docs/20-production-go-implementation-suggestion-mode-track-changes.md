## Production Go Implementation: Suggestion Mode (Track Changes)

Suggestion mode (similar to "Track Changes" in Microsoft Word) allows collaborators to propose edits without directly modifying the document. Each suggestion stores the proposed operations along with the original and replacement text so reviewers can see exactly what would change. The document owner or editors can then accept (which applies the operations to the real document) or reject (which discards them). This is critical for workflows where multiple people review content but only certain users have final approval authority.

```go
package suggestions

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Suggestion represents a proposed change that hasn't been accepted yet
type Suggestion struct {
	ID           string    `json:"id"`
	DocID        string    `json:"doc_id"`
	AuthorID     string    `json:"author_id"`
	AuthorName   string    `json:"author_name"`
	Ops          []Op      `json:"ops"`           // the proposed operations
	OriginalText string    `json:"original_text"` // text being replaced
	NewText      string    `json:"new_text"`      // proposed replacement
	Status       string    `json:"status"`        // "pending", "accepted", "rejected"
	CreatedAt    time.Time `json:"created_at"`
	ResolvedAt   *time.Time `json:"resolved_at,omitempty"`
	ResolvedBy   string    `json:"resolved_by,omitempty"`
}

// SuggestionService manages document suggestions (track changes)
type SuggestionService struct {
	suggestionDB SuggestionStore
	docServer    DocServerClient
	notifSvc     NotificationService
}

// CreateSuggestion adds a pending suggestion to the document
func (s *SuggestionService) CreateSuggestion(ctx context.Context, docID, authorID string, ops []Op) (*Suggestion, error) {
	suggestion := &Suggestion{
		ID:        generateID(),
		DocID:     docID,
		AuthorID:  authorID,
		Ops:       ops,
		Status:    "pending",
		CreatedAt: time.Now(),
	}

	// Extract original and new text from ops for display
	suggestion.OriginalText = extractDeletedText(ops)
	suggestion.NewText = extractInsertedText(ops)

	if err := s.suggestionDB.Create(ctx, suggestion); err != nil {
		return nil, err
	}

	// Notify document owner
	s.notifSvc.NotifySuggestion(ctx, docID, authorID, suggestion)

	return suggestion, nil
}

// AcceptSuggestion applies the suggested operations to the document
func (s *SuggestionService) AcceptSuggestion(ctx context.Context, suggestionID, resolverID string) error {
	suggestion, err := s.suggestionDB.Get(ctx, suggestionID)
	if err != nil { return err }

	// Only owners and editors may resolve suggestions
	if !s.docServer.CanEdit(ctx, suggestion.DocID, resolverID) {
		return fmt.Errorf("user %s cannot resolve suggestions on doc %s", resolverID, suggestion.DocID)
	}
	// Guard against double-resolution: accepting twice would apply
	// the operations twice
	if suggestion.Status != "pending" {
		return fmt.Errorf("suggestion %s already %s", suggestionID, suggestion.Status)
	}

	// Apply the suggestion's ops as real document operations. The doc
	// server transforms them against everything applied since the
	// suggestion was created, exactly like a reconnecting offline client
	if err := s.docServer.ApplyOps(ctx, suggestion.DocID, resolverID, suggestion.Ops); err != nil {
		return err
	}

	now := time.Now()
	suggestion.Status = "accepted"
	suggestion.ResolvedAt = &now
	suggestion.ResolvedBy = resolverID
	return s.suggestionDB.Update(ctx, suggestion)
}

// RejectSuggestion discards the suggestion without applying
func (s *SuggestionService) RejectSuggestion(ctx context.Context, suggestionID, resolverID string) error {
	suggestion, err := s.suggestionDB.Get(ctx, suggestionID)
	if err != nil { return err }

	if !s.docServer.CanEdit(ctx, suggestion.DocID, resolverID) {
		return fmt.Errorf("user %s cannot resolve suggestions on doc %s", resolverID, suggestion.DocID)
	}
	if suggestion.Status != "pending" {
		return fmt.Errorf("suggestion %s already %s", suggestionID, suggestion.Status)
	}

	now := time.Now()
	suggestion.Status = "rejected"
	suggestion.ResolvedAt = &now
	suggestion.ResolvedBy = resolverID
	return s.suggestionDB.Update(ctx, suggestion)
}

func extractDeletedText(ops []Op) string {
	// Delete ops carry only a length, so resolving the deleted text
	// requires the document snapshot the suggestion was based on.
	// Omitted here for brevity.
	return ""
}

func extractInsertedText(ops []Op) string {
	var b strings.Builder
	for _, op := range ops {
		if op.Insert != "" { b.WriteString(op.Insert) }
	}
	return b.String()
}

func generateID() string { return uuid.NewString() }
```

---
