// internal/api/rest/server.go
package rest

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/example/search-engine/internal/index/inverted"
	"github.com/example/search-engine/internal/query/executor"
	"github.com/example/search-engine/internal/query/parser"
	"go.uber.org/zap"
)

type Server struct {
	executor *executor.Executor
	index    *inverted.InvertedIndex
	parser   *parser.Parser
	logger   *zap.Logger
	server   *http.Server
}

func NewServer(addr string, exec *executor.Executor, idx *inverted.InvertedIndex, logger *zap.Logger) *Server {
	s := &Server{
		executor: exec,
		index:    idx,
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
		fields := make(map[string]string, len(doc.Fields)+1)
		var allText []string
		for k, v := range doc.Fields {
			fields[k] = v
			allText = append(allText, v)
		}
		if _, ok := fields["_all"]; !ok {
			fields["_all"] = strings.Join(allText, " ")
		}

		d := &inverted.Document{
			ID:     doc.ID,
			Fields: fields,
		}

		if s.index != nil {
			if err := s.index.IndexDocument(d); err != nil {
				resp.Errors = append(resp.Errors, err.Error())
				continue
			}
		}
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
