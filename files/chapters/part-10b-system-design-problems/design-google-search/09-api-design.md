## API Design

A clean API contract is essential for any system design interview. These structs define the public interface that clients use to search and get autocomplete suggestions. Notice the validation tags on the request fields and the inclusion of metadata like `elapsed_ms` in the response, which helps clients measure performance. Keeping the API simple with just two endpoints (search and suggest) makes the system easy to integrate with any frontend.

```go
package api

import "time"

// GET /api/v1/search?q=golang+tutorial&page=0&size=10&lang=en
type SearchAPIRequest struct {
	Query    string `json:"q" validate:"required,max=2048"`
	Page     int    `json:"page"`
	PageSize int    `json:"size"`
	Language string `json:"lang"`
	SafeMode string `json:"safe"`
}

type SearchAPIResponse struct {
	Query           string      `json:"query"`
	Corrected       string      `json:"corrected,omitempty"`
	TotalHits       int64       `json:"total_hits"`
	Hits            []SearchHit `json:"hits"`
	RelatedSearches []string    `json:"related_searches"`
	ElapsedMs       float64     `json:"elapsed_ms"`
}

type SearchHit struct {
	URL         string     `json:"url"`
	Title       string     `json:"title"`
	Snippet     string     `json:"snippet"`
	PublishedAt *time.Time `json:"published_at,omitempty"`
}

// GET /api/v1/suggest?q=golan&limit=10
type SuggestResponse struct {
	Suggestions []string `json:"suggestions"`
}
```

---
