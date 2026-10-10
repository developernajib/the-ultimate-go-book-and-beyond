## Go Implementation: Typeahead WebSocket Handler

While HTTP works well for initial requests, a WebSocket connection strips away per-request HTTP header overhead and guarantees an already-warm connection for every keystroke, browsers reuse HTTP connections via keep-alive but each request still carries full headers. This is especially valuable for autocomplete, where a user might trigger five or more requests in rapid succession while typing a single query. The WebSocket handler maintains a persistent connection, processes suggestion requests with minimal latency, and records completed searches asynchronously.

```go
package websocket

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	ws "github.com/gorilla/websocket"
)

type Suggestion struct {
	Term  string  `json:"term"`
	Score float64 `json:"score"`
}

type SuggestRequest struct {
	Prefix string
	UserID string
	Domain string
	Limit  int
}

type SuggestResponse struct {
	Suggestions []Suggestion
}

type AutocompleteService struct{}

func (s *AutocompleteService) Suggest(ctx context.Context, req SuggestRequest) (*SuggestResponse, error) {
	return &SuggestResponse{}, nil
}

func (s *AutocompleteService) RecordSearch(ctx context.Context, query, userID string) {}

// TypeaheadWSHandler handles WebSocket connections for real-time suggestions
// Lower latency than HTTP for rapid keystroke-by-keystroke suggestions
type TypeaheadWSHandler struct {
	service  *AutocompleteService
	upgrader ws.Upgrader
}

type WSMessage struct {
	Type   string `json:"type"`   // "suggest" or "search"
	Prefix string `json:"prefix,omitempty"`
	Query  string `json:"query,omitempty"`
	Domain string `json:"domain,omitempty"`
	UserID string `json:"user_id,omitempty"`
}

type WSResponse struct {
	Type        string       `json:"type"` // "suggestions" or "ack"
	Prefix      string       `json:"prefix"`
	Suggestions []Suggestion `json:"suggestions,omitempty"`
	ElapsedMs   float64      `json:"elapsed_ms"`
}

// HandleConnection processes a WebSocket connection
func (h *TypeaheadWSHandler) HandleConnection(conn *ws.Conn, userID string) {
	defer conn.Close()

	// Set read deadline to detect disconnects
	conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(5 * time.Minute))
		return nil
	})

	// gorilla/websocket allows only one concurrent writer,
	// so the ping goroutine and the response path share a mutex
	var writeMu sync.Mutex

	// Ping ticker to keep connection alive
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			writeMu.Lock()
			err := conn.WriteMessage(ws.PingMessage, nil)
			writeMu.Unlock()
			if err != nil {
				return
			}
		}
	}()

	ctx := context.Background()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var msg WSMessage
		if json.Unmarshal(message, &msg) != nil {
			continue
		}

		switch msg.Type {
		case "suggest":
			start := time.Now()
			resp, err := h.service.Suggest(ctx, SuggestRequest{
				Prefix: msg.Prefix,
				UserID: userID,
				Domain: msg.Domain,
				Limit:  10,
			})
			if err != nil {
				continue
			}

			wsResp := WSResponse{
				Type:        "suggestions",
				Prefix:      msg.Prefix,
				Suggestions: resp.Suggestions,
				ElapsedMs:   float64(time.Since(start).Microseconds()) / 1000,
			}
			writeMu.Lock()
			conn.WriteJSON(wsResp)
			writeMu.Unlock()

		case "search":
			// Record completed search
			go h.service.RecordSearch(ctx, msg.Query, userID)
			writeMu.Lock()
			conn.WriteJSON(WSResponse{Type: "ack"})
			writeMu.Unlock()
		}
	}
}

// WebSocket advantages over HTTP for autocomplete:
// - No per-request headers, the connection stays warm
// - Lower per-message overhead than repeated HTTP requests
// - Server can push trending terms proactively
// - Debouncing can happen server-side (smarter)
//
// Trade-offs:
// - More server resources (persistent connections)
// - CDN caching doesn't work (bypass CDN)
// - Fallback to HTTP needed for older clients
//
// Recommendation: HTTP for first keystroke (CDN-cacheable),
// upgrade to WebSocket for subsequent keystrokes
```

---
