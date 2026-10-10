## API Design

A well-defined API is the contract between the autocomplete service and its clients. The endpoints below cover the three main use cases: fetching suggestions as the user types, recording completed searches to update frequencies, and surfacing trending terms. Admin endpoints allow manual boosting and blocklist management without redeploying code.

### REST & gRPC Endpoints

External clients use REST endpoints for fetching suggestions and recording searches, while internal services communicate over gRPC for lower latency and type safety. The admin endpoints support operational tasks like blocklist management and trie rebuilds without code deployments.

```go
package api

import "time"

// GET /api/v1/suggestions?prefix=gol&domain=web&user_id=u123&limit=10
// Response: SuggestResponse

// POST /api/v1/search
// Request: SearchRequest (records completed search for frequency counting)
// Response: 204 No Content

type SearchRequest struct {
	Query  string `json:"query" validate:"required,min=1,max=500"`
	UserID string `json:"user_id,omitempty"`
	Domain string `json:"domain" validate:"required,oneof=web product user"`
}

// GET /api/v1/trending?domain=web&limit=10
// Response: TrendingResponse

type TrendingTerm struct {
	Term               string  `json:"term"`
	VelocityMultiplier float64 `json:"velocity_multiplier"`
}

type TrendingResponse struct {
	Terms     []TrendingTerm `json:"terms"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// DELETE /api/v1/users/{user_id}/history?term=golang (remove one term)
// DELETE /api/v1/users/{user_id}/history (clear all history)

// ========== Admin APIs ==========

// POST /api/v1/admin/blocklist { "term": "...", "reason": "hate_speech" }
// POST /api/v1/admin/boost { "term": "golang 1.27", "boost_factor": 2.0, "expires_at": "..." }
// POST /api/v1/admin/trie/rebuild (triggers async rebuild)

// ========== Internal gRPC ==========
// service AutocompleteService {
//   rpc Suggest(SuggestRequest) returns (SuggestResponse) - //   rpc RecordSearch(RecordSearchRequest) returns (google.protobuf.Empty);
//   rpc GetTrending(GetTrendingRequest) returns (TrendingResponse) - // }
```

---
