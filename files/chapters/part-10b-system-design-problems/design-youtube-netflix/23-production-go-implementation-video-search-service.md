## Production Go Implementation: Video Search Service

Search is one of the primary ways users discover content, and it needs to return relevant results in under 200 milliseconds against 500 million indexed videos. This implementation uses Elasticsearch with a multi-match query that boosts title matches (3x) and tag matches (2x) over description matches, so "Go tutorial" ranks a video with that title above one that merely mentions Go in a description. It also filters by category and duration and sorts by relevance, date, or view count.

Three details in this code are the difference between a search service and a service that pretends to search.

**The document ID does not live in `_source`.** Elasticsearch returns it as `_id`, a sibling of `_source`, not a field inside it. Unmarshal `_source` into a struct with an `ID` field and that field stays empty forever, no matter what you put in the `_source` filter list. Every result then comes back perfectly relevant, correctly ranked, and impossible to link to, because you have a title and no video ID. The tests pass, the ranking looks great, and the feature is useless.

**A failed search must not look like an empty one.** If you ignore the decode error and skip the HTTP status check, an Elasticsearch error document decodes cleanly into your response struct, producing zero hits and a nil error. Search then reports "no results found" for every query for the entire duration of an outage, which is indistinguishable from a working search over an empty index and will not page anyone. Never let "we could not ask" render as "there is no answer".

**Deep pagination has a hard wall.** `from + size` above `index.max_result_window`, 10,000 by default, is rejected outright, and it is expensive long before that, because every shard must produce and sort `from + size` hits. Relatedly, the `total` you report is a lie by default: Elasticsearch stops counting at 10,000 and tells you so via `relation: "gte"`, which the naive struct silently discards while reporting exactly 10,000.

```go
package search

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// VideoSearchService provides full-text search over video metadata
type VideoSearchService struct {
	esURL  string
	client *http.Client
}

type VideoSearchRequest struct {
	Query    string `json:"query"`
	Category string `json:"category,omitempty"`
	Duration string `json:"duration,omitempty"` // "short", "medium", "long"
	SortBy   string `json:"sort_by"`            // "relevance", "date", "views"
	Page     int    `json:"page"`
	PageSize int    `json:"page_size"`
}

type VideoSearchResult struct {
	Videos []VideoHit `json:"videos"`
	Total  int64      `json:"total"`
	// TotalIsLowerBound reports that Elasticsearch stopped counting at
	// trackTotalHits and Total is a floor, not a count. Render this as
	// "10,000+ results" rather than claiming a precise number that is wrong.
	TotalIsLowerBound bool    `json:"total_is_lower_bound"`
	ElapsedMs         float64 `json:"elapsed_ms"`
}

type VideoHit struct {
	// ID is populated from the hit's _id, not from _source. See Search below.
	ID           string     `json:"id"`
	Title        string     `json:"title"`
	Description  string     `json:"description"`
	ThumbnailKey string     `json:"thumbnail_key"`
	DurationSecs int        `json:"duration_secs"`
	ViewCount    int64      `json:"view_count"`
	UploaderName string     `json:"uploader_name"`
	PublishedAt  *time.Time `json:"published_at"` // nil for anything unpublished
	Score        float64    `json:"score"`
}

const (
	// Elasticsearch rejects from+size beyond index.max_result_window.
	maxResultWindow = 10_000
	// Count precisely up to here, then report a lower bound. Counting every
	// match across 500M documents to tell someone there are 4,182,933 results
	// is expensive and nobody reads past page 3 anyway.
	trackTotalHits  = 10_000
	defaultPageSize = 20
	maxPageSize     = 100
)

// normalize clamps client-supplied paging. Page size is attacker-controlled
// input: unvalidated, size=0 returns nothing and size=100000 asks Elasticsearch
// to build a 100,000-hit result set per shard on demand.
func (r *VideoSearchRequest) normalize() error {
	if r.PageSize <= 0 {
		r.PageSize = defaultPageSize
	}
	if r.PageSize > maxPageSize {
		r.PageSize = maxPageSize
	}
	if r.Page < 0 {
		r.Page = 0
	}
	if (r.Page+1)*r.PageSize > maxResultWindow {
		// Fail loudly rather than letting Elasticsearch reject it with a 500,
		// and rather than silently clamping the user onto a page they did not
		// ask for. Deep paging needs search_after, see below.
		return fmt.Errorf("page %d exceeds the %d result window: use search_after for deep pagination",
			r.Page, maxResultWindow)
	}
	return nil
}

func (s *VideoSearchService) Search(ctx context.Context, req VideoSearchRequest) (*VideoSearchResult, error) {
	start := time.Now()

	if err := req.normalize(); err != nil {
		return nil, err
	}

	// Build Elasticsearch query
	must := []map[string]any{}
	if req.Query != "" {
		must = append(must, map[string]any{
			"multi_match": map[string]any{
				"query":  req.Query,
				"fields": []string{"title^3", "description", "tags^2", "uploader_name"},
				"type":   "best_fields",
			},
		})
	}

	filter := []map[string]any{}
	if req.Category != "" {
		filter = append(filter, map[string]any{"term": map[string]any{"category": req.Category}})
	}
	if req.Duration != "" {
		var dRange map[string]any
		switch req.Duration {
		case "short":
			dRange = map[string]any{"lt": 240}
		case "medium":
			dRange = map[string]any{"gte": 240, "lte": 1200}
		case "long":
			dRange = map[string]any{"gt": 1200}
		}
		if dRange != nil {
			filter = append(filter, map[string]any{"range": map[string]any{"duration_secs": dRange}})
		}
	}

	sortField := "_score"
	sortOrder := "desc"
	switch req.SortBy {
	case "date":
		sortField = "published_at"
	case "views":
		sortField = "view_count"
	}

	query := map[string]any{
		"query": map[string]any{
			"bool": map[string]any{
				"must":   must,
				"filter": filter,
			},
		},
		"sort": []map[string]any{
			{sortField: sortOrder},
		},
		"from":             req.Page * req.PageSize,
		"size":             req.PageSize,
		"track_total_hits": trackTotalHits,
		// No "id" here on purpose: the document id is _id, a sibling of
		// _source, and listing it in this filter would not conjure it into
		// _source. It is read from hit.ID below.
		"_source": []string{"title", "description", "thumbnail_key", "duration_secs",
			"view_count", "uploader_name", "published_at"},
	}

	body, err := json.Marshal(query)
	if err != nil {
		return nil, fmt.Errorf("marshal query: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.esURL+"/videos/_search", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("elasticsearch: %w", err)
	}
	defer resp.Body.Close()

	// Check the status before trusting the body. An error document unmarshals
	// perfectly happily into the struct below and yields zero hits.
	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("elasticsearch status %d: %s", resp.StatusCode, snippet)
	}

	var esResp struct {
		Hits struct {
			Total struct {
				Value    int64  `json:"value"`
				Relation string `json:"relation"` // "eq" (exact) or "gte" (floor)
			} `json:"total"`
			Hits []struct {
				ID     string   `json:"_id"` // the document id lives HERE
				Score  float64  `json:"_score"`
				Source VideoHit `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&esResp); err != nil {
		// Never swallow this. A decode failure returning (empty, nil) turns
		// every outage into a silent "no results found".
		return nil, fmt.Errorf("decode elasticsearch response: %w", err)
	}

	videos := make([]VideoHit, 0, len(esResp.Hits.Hits))
	for _, hit := range esResp.Hits.Hits {
		v := hit.Source
		v.ID = hit.ID // without this every result is unlinkable
		v.Score = hit.Score
		videos = append(videos, v)
	}

	return &VideoSearchResult{
		Videos:            videos,
		Total:             esResp.Hits.Total.Value,
		TotalIsLowerBound: esResp.Hits.Total.Relation == "gte",
		ElapsedMs:         float64(time.Since(start).Microseconds()) / 1000,
	}, nil
}
```

---
