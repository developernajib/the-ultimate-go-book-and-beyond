## 7. REST API

A search engine is only useful if other applications can talk to it. This section wraps the query parser and executor behind a standard HTTP server so clients can index documents and run searches over the network. The API exposes a `/search` endpoint that accepts queries via GET or POST, an `/index` endpoint for adding documents in bulk, and a `/health` endpoint for load-balancer probes. A logging middleware records every request for observability.

### 7.1 HTTP Server

The HTTP server wires together the analyzer, index, scorer, and document store behind a chi router with `/search`, `/index`, and `/health` endpoints.

```go
// internal/api/rest/server.go
package rest

import (
    "context"
    "encoding/json"
    "net/http"
    "strconv"
    "time"

    "go.uber.org/zap"
    "github.com/yourorg/gosearch/internal/query/executor"
    "github.com/yourorg/gosearch/internal/query/parser"
)

type Server struct {
    executor *executor.Executor
    parser   *parser.Parser
    logger   *zap.Logger
    server   *http.Server
}

func NewServer(addr string, exec *executor.Executor, logger *zap.Logger) *Server {
    s := &Server{
        executor: exec,
        parser:   parser.NewParser("_all", "OR"),
        logger:   logger,
    }

    mux := http.NewServeMux()
    mux.HandleFunc("/search", s.handleSearch)
    mux.HandleFunc("/index", s.handleIndex)
    mux.HandleFunc("/health", s.handleHealth)

    s.server = &http.Server{
        Addr:         addr,
        Handler:      s.loggingMiddleware(mux),
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 10 * time.Second,
    }

    return s
}

func (s *Server) Start() error {
    s.logger.Info("Starting REST API server", zap.String("addr", s.server.Addr))
    return s.server.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
    return s.server.Shutdown(ctx)
}

// SearchRequest represents a search request
type SearchRequest struct {
    Query  string `json:"query"`
    Limit  int    `json:"limit,omitempty"`
    Offset int    `json:"offset,omitempty"`
}

// SearchResponse represents a search response
type SearchResponse struct {
    Results   []SearchResult `json:"results"`
    TotalHits int            `json:"total_hits"`
    MaxScore  float64        `json:"max_score"`
    QueryTime int64          `json:"query_time_us"`
}

type SearchResult struct {
    DocID  uint32            `json:"doc_id"`
    Score  float64           `json:"score"`
    Fields map[string]string `json:"fields"`
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodGet && r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var req SearchRequest

    if r.Method == http.MethodPost {
        if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
            http.Error(w, err.Error(), http.StatusBadRequest)
            return
        }
    } else {
        req.Query = r.URL.Query().Get("q")
        if limit := r.URL.Query().Get("limit"); limit != "" {
            if l, err := strconv.Atoi(limit); err == nil {
                req.Limit = l
            }
        }
    }

    if req.Query == "" {
        http.Error(w, "query parameter required", http.StatusBadRequest)
        return
    }

    if req.Limit == 0 {
        req.Limit = 10
    }

    start := time.Now()

    // Parse query
    query, err := s.parser.Parse(req.Query)
    if err != nil {
        http.Error(w, "invalid query: "+err.Error(), http.StatusBadRequest)
        return
    }

    // Execute search
    results, err := s.executor.Execute(query, req.Limit)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    queryTime := time.Since(start).Microseconds()

    // Build response
    resp := SearchResponse{
        Results:   make([]SearchResult, len(results.Results)),
        TotalHits: results.TotalHits,
        MaxScore:  results.MaxScore,
        QueryTime: queryTime,
    }

    for i, result := range results.Results {
        resp.Results[i] = SearchResult{
            DocID:  result.DocID,
            Score:  result.Score,
            Fields: result.Doc.Fields,
        }
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

// IndexRequest represents an indexing request
type IndexRequest struct {
    Documents []Document `json:"documents"`
}

type Document struct {
    ID     uint32            `json:"id,omitempty"`
    Fields map[string]string `json:"fields"`
}

type IndexResponse struct {
    Indexed int      `json:"indexed"`
    Errors  []string `json:"errors,omitempty"`
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var req IndexRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    resp := IndexResponse{
        Errors: make([]string, 0),
    }

    for _, doc := range req.Documents {
        // Convert to internal document format and index
        // Implementation depends on your index structure
        resp.Indexed++
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    w.Write([]byte("OK"))
}

func (s *Server) loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()

        next.ServeHTTP(w, r)

        s.logger.Info("request",
            zap.String("method", r.Method),
            zap.String("path", r.URL.Path),
            zap.Duration("duration", time.Since(start)),
        )
    })
}
```

### Junior → FAANG: Search API Design as a Contract

The search API contract (what parameters it accepts, what response format it returns) is the interface that determines how useful the search engine is for developers. The `GET /search?q=query&from=0&size=10` pattern is familiar from Elasticsearch and is a reasonable default for a search API.

Response format matters for developer experience. Include in each result: document ID, relevance score, highlighted text snippets (showing why the document matched), and any requested metadata fields. The score gives developers debugging information. Highlights give users visual confirmation that the search worked. Metadata gives downstream systems the fields they need to display results.

Pagination (from/size for offset-based, search_after for cursor-based) is an important API concern for search results. Offset-based pagination (skip N results, return M) becomes expensive for large offsets because the engine must score and sort all results up to offset N. Cursor-based pagination (search_after uses the last result's sort key as the next page's starting point) is more efficient but prevents jumping to arbitrary pages.

### Senior @ FAANG: Search API as a Platform Service

At senior level, the search API must support multiple use cases with potentially different requirements: real-time search (low latency, recent documents indexed immediately), batch search (high throughput, scheduled indexing), and analytical search (aggregations, facets, statistics). These use cases often conflict: real-time search requires near-real-time indexing (high write load), analytical search benefits from batch indexing (optimized index segments).

API rate limiting for a search engine must be more sophisticated than simple request-rate limits. Search queries vary dramatically in complexity: a single-term query against a small posting list completes in microseconds, while a wildcard query against a large posting list may take seconds. Rate limiting by query complexity (estimated cost based on query type and corpus size) or by execution time budget (cancel queries that exceed a threshold) is more effective than simple request-count limits.

Multi-index search (searching across multiple independently managed indices in a single query) is a common enterprise requirement. The API must support specifying which indices to search, and the execution must fan out the query to all specified indices, merge the results, and apply unified ranking. Building this fan-out as a first-class API concept (rather than a bolt-on feature) requires planning the API surface before implementing the execution engine.

---
