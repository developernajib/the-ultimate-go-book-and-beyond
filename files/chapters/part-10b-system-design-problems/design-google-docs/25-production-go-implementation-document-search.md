## Production Go Implementation: Document Search

Users need to search across all their documents by content or title. This implementation uses PostgreSQL's built-in full-text search with `tsvector` and `tsquery`, which provides good-enough search quality for most use cases without requiring a separate search infrastructure like Elasticsearch. The search query joins against the permissions table to ensure users only see documents they have access to, and uses `ts_headline` to generate relevant snippets for the search results page.

```go
package search

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type DocumentSearchService struct {
	db *pgxpool.Pool
}

type DocSearchResult struct {
	DocID     string    `json:"doc_id"`
	Title     string    `json:"title"`
	Snippet   string    `json:"snippet"`
	OwnerName string    `json:"owner_name"`
	UpdatedAt time.Time `json:"updated_at"`
	Rank      float64   `json:"rank"`
}

// SearchUserDocuments searches across all documents the user can access
func (s *DocumentSearchService) SearchUserDocuments(ctx context.Context, userID, query string, limit int) ([]DocSearchResult, error) {
	rows, err := s.db.Query(ctx, `
		SELECT d.id, d.title, d.updated_at,
		       ts_rank(si.content_tsv, plainto_tsquery('english', $1)) as rank,
		       ts_headline('english', si.content_text, plainto_tsquery('english', $1),
		                   'MaxWords=30, MinWords=15, ShortWord=3') as snippet,
		       u.display_name as owner_name
		FROM documents d
		JOIN document_search_index si ON si.doc_id = d.id
		JOIN doc_permissions p ON p.doc_id = d.id AND p.user_id = $2
		JOIN users u ON u.id = d.owner_id
		WHERE si.content_tsv @@ plainto_tsquery('english', $1)
		   OR si.title_tsv @@ plainto_tsquery('english', $1)
		ORDER BY rank DESC
		LIMIT $3`,
		query, userID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	defer rows.Close()

	var results []DocSearchResult
	for rows.Next() {
		var r DocSearchResult
		if err := rows.Scan(&r.DocID, &r.Title, &r.UpdatedAt, &r.Rank, &r.Snippet, &r.OwnerName); err != nil {
			continue
		}
		results = append(results, r)
	}
	return results, nil
}

// UpdateSearchIndex rebuilds the search index for a document
func (s *DocumentSearchService) UpdateSearchIndex(ctx context.Context, docID, content, title string) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO document_search_index (doc_id, content_tsv, title_tsv, content_text, updated_at)
		VALUES ($1, to_tsvector('english', $2), to_tsvector('english', $3), $2, NOW())
		ON CONFLICT (doc_id) DO UPDATE
		SET content_tsv = to_tsvector('english', $2),
		    title_tsv = to_tsvector('english', $3),
		    content_text = $2,
		    updated_at = NOW()`,
		docID, content, title,
	)
	return err
}
```

---
