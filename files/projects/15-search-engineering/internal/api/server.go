package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/example/search-engineering/internal/autocomplete"
	"github.com/example/search-engineering/internal/highlight"
	"github.com/example/search-engineering/internal/index"
	"github.com/example/search-engineering/internal/query"
	"github.com/example/search-engineering/internal/rank"
)

// SearchServer is the main HTTP API for search
type SearchServer struct {
	idx          *index.InvertedIndex
	scorer       *rank.BM25Scorer
	parser       *query.Parser
	autocomplete *autocomplete.PopularityRanker
	highlighter  *highlight.Highlighter
}

// DocStore stores the original documents
type DocStore interface {
	Get(id index.DocID) (map[string]any, error)
	GetBatch(ids []index.DocID) ([]map[string]any, error)
}

// SearchRequest is the search API request
type SearchRequest struct {
	Query     string            `json:"q"`
	Filters   map[string]string `json:"filters,omitempty"`
	Page      int               `json:"page"`
	PageSize  int               `json:"page_size"`
	Fields    []string          `json:"fields,omitempty"`
	Highlight bool              `json:"highlight"`
	Sort      string            `json:"sort"` // "relevance", "date", "popularity"
}

// SearchResponse is the search API response
type SearchResponse struct {
	Total    int                     `json:"total"`
	Page     int                     `json:"page"`
	PageSize int                     `json:"page_size"`
	Hits     []SearchHit             `json:"hits"`
	Facets   map[string][]FacetValue `json:"facets,omitempty"`
	Took     string                  `json:"took"` // duration
	Query    string                  `json:"query"`
}

// SearchHit is a single search result
type SearchHit struct {
	ID         index.DocID         `json:"id"`
	Score      float64             `json:"score"`
	Document   map[string]any      `json:"document"`
	Highlights map[string][]string `json:"highlights,omitempty"`
}

// FacetValue is a facet bucket
type FacetValue struct {
	Value string `json:"value"`
	Count int    `json:"count"`
}

func NewSearchServer(idx *index.InvertedIndex) *SearchServer {
	scorer := rank.NewBM25Scorer(idx)
	return &SearchServer{
		idx:          idx,
		scorer:       scorer,
		parser:       query.NewParser(),
		autocomplete: autocomplete.NewPopularityRanker(),
		highlighter:  highlight.NewHighlighter(),
	}
}

func (s *SearchServer) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /search", s.handleSearch)
	mux.HandleFunc("POST /search", s.handleSearchPost)
	mux.HandleFunc("GET /autocomplete", s.handleAutocomplete)
	mux.HandleFunc("POST /index", s.handleIndexDocument)
}

func (s *SearchServer) handleSearch(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	q := r.URL.Query().Get("q")
	if q == "" {
		http.Error(w, "missing 'q' parameter", http.StatusBadRequest)
		return
	}

	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("size"))
	if pageSize < 1 || pageSize > 100 {
		pageSize = 10
	}

	// Record query for autocomplete
	s.autocomplete.RecordQuery(q)

	// Parse and execute query
	parsedQuery, err := s.parser.Parse(q)
	if err != nil {
		http.Error(w, fmt.Sprintf("invalid query: %v", err), http.StatusBadRequest)
		return
	}

	results := s.parser.Execute(parsedQuery, s.scorer)

	// Paginate
	total := len(results)
	startIdx := (page - 1) * pageSize
	end := startIdx + pageSize
	if startIdx >= total {
		startIdx = total
	}
	if end > total {
		end = total
	}
	pageResults := results[startIdx:end]

	var hits []SearchHit
	for _, result := range pageResults {
		hit := SearchHit{
			ID:    result.DocID,
			Score: result.Score,
			Document: map[string]any{
				"id": result.DocID,
			},
		}
		hits = append(hits, hit)
	}

	resp := SearchResponse{
		Total:    total,
		Page:     page,
		PageSize: pageSize,
		Hits:     hits,
		Took:     time.Since(start).String(),
		Query:    q,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *SearchServer) handleSearchPost(w http.ResponseWriter, r *http.Request) {
	var req SearchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	r.URL.RawQuery = "q=" + req.Query
	s.handleSearch(w, r)
}

func (s *SearchServer) handleAutocomplete(w http.ResponseWriter, r *http.Request) {
	prefix := r.URL.Query().Get("q")
	if len(prefix) < 2 {
		json.NewEncoder(w).Encode([]string{})
		return
	}

	suggestions := s.autocomplete.Suggest(prefix, 10)
	result := make([]string, len(suggestions))
	for i, sg := range suggestions {
		result[i] = sg.Word
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func (s *SearchServer) handleIndexDocument(w http.ResponseWriter, r *http.Request) {
	var doc struct {
		ID     index.DocID       `json:"id"`
		Fields map[string]string `json:"fields"`
	}
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	s.idx.IndexDocument(index.Document{ID: doc.ID, Fields: doc.Fields})
	w.WriteHeader(http.StatusCreated)
	fmt.Fprintf(w, `{"indexed": %d}`, doc.ID)
}
