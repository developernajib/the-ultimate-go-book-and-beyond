## Part 1: Backend for Frontend (BFF) Pattern

Mobile clients need different API shapes than web clients - fewer round trips, aggregated data, smaller payloads. The BFF pattern creates a dedicated backend per client type. Instead of forcing an iOS app to make four sequential network calls to render its home screen, a single BFF endpoint fans out to all downstream services concurrently and returns one aggregated response. This cuts latency on cellular connections from four round trips to one.

**Protocol choice (2026 state-of-the-art).** The BFF wire protocol is a per-boundary decision, not a religion:

- **REST + JSON (gzip/Brotli-compressed):** universal, debuggable, adequate for most CRUD. Still the default for public mobile APIs.
- **GraphQL:** one endpoint, client-selected fields. Useful when many screens share overlapping data (Facebook, GitHub). Costly query planning on 2G.
- **gRPC / gRPC-Web:** smallest payload, streaming, strict typing, but HTTP/2 framing forces gRPC-Web (proxy layer) for browsers and some mobile middleboxes interfere.
- **Connect (buf.build):** a drop-in gRPC successor that speaks gRPC, gRPC-Web, and its own plain HTTP/1.1-compatible protocol from a single handler. In 2026 this is the recommended choice for new mobile+web BFFs that want protobuf contracts without the gRPC-Web proxy dance.

Pick REST for public partner surfaces, Connect or gRPC for first-party mobile + internal service RPC, and GraphQL only when the field-selection story justifies the complexity.

The following implementation shows a `HomeHandler` that fetches user data, feed items, notifications, and stats in parallel using goroutines, then assembles a single JSON response. It uses partial success semantics: if one downstream call fails, the handler still returns the data it could gather rather than failing the entire request.

```go
package bff

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// MobileHomeResponse aggregates data for the app home screen
// Instead of: GET /user + GET /feed + GET /notifications + GET /stats (4 requests)
// Use: GET /v1/home (1 request)
type MobileHomeResponse struct {
	User          UserSummary       `json:"user"`
	Feed          []FeedItem        `json:"feed"`
	Notifications []Notification    `json:"notifications"`
	Stats         UserStats         `json:"stats"`
	Unread        int               `json:"unread_count"`
	LastSync      time.Time         `json:"last_sync"`
}

type UserSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Avatar      string `json:"avatar_url"`
	Verified    bool   `json:"verified"`
}

type FeedItem struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Title     string    `json:"title"`
	Thumbnail string    `json:"thumbnail_url,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	Score     int       `json:"score"`
}

type Notification struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Message   string    `json:"message"`
	Read      bool      `json:"read"`
	CreatedAt time.Time `json:"created_at"`
}

type UserStats struct {
	Posts      int `json:"posts"`
	Followers  int `json:"followers"`
	Following  int `json:"following"`
	Views      int `json:"views"`
}

// Downstream service contracts
type UserService interface {
	GetSummary(ctx context.Context, userID string) (UserSummary, error)
}

type FeedService interface {
	GetFeed(ctx context.Context, userID string, limit int) ([]FeedItem, error)
}

type NotificationService interface {
	GetRecent(ctx context.Context, userID string, limit int) ([]Notification, error)
}

type StatsService interface {
	GetUserStats(ctx context.Context, userID string) (UserStats, error)
}

// HomeHandler fetches all data concurrently and assembles the response
type HomeHandler struct {
	userSvc         UserService
	feedSvc         FeedService
	notificationSvc NotificationService
	statsSvc        StatsService
}

func (h *HomeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("X-User-ID")
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	ctx := r.Context()
	var (
		user          UserSummary
		feed          []FeedItem
		notifications []Notification
		stats         UserStats
		mu            sync.Mutex
		errs          []error
		wg            sync.WaitGroup
	)

	collect := func(fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		}()
	}

	collect(func() error {
		u, err := h.userSvc.GetSummary(ctx, userID)
		if err != nil {
			return err
		}
		mu.Lock()
		user = u
		mu.Unlock()
		return nil
	})

	collect(func() error {
		items, err := h.feedSvc.GetFeed(ctx, userID, 20)
		if err != nil {
			return err
		}
		mu.Lock()
		feed = items
		mu.Unlock()
		return nil
	})

	collect(func() error {
		notifs, err := h.notificationSvc.GetRecent(ctx, userID, 5)
		if err != nil {
			return err
		}
		mu.Lock()
		notifications = notifs
		mu.Unlock()
		return nil
	})

	collect(func() error {
		s, err := h.statsSvc.GetUserStats(ctx, userID)
		if err != nil {
			return err
		}
		mu.Lock()
		stats = s
		mu.Unlock()
		return nil
	})

	wg.Wait()

	// Partial success: return what we have, log errors
	if len(errs) == 4 {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}

	unread := 0
	for _, n := range notifications {
		if !n.Read {
			unread++
		}
	}

	resp := MobileHomeResponse{
		User:          user,
		Feed:          feed,
		Notifications: notifications,
		Stats:         stats,
		Unread:        unread,
		LastSync:      time.Now().UTC(),
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
```

### Junior → FAANG: Understanding Why This Code Looks The Way It Does

The handler above uses a `sync.WaitGroup` with a mutex-guarded slice of errors and per-field mutex-guarded assignment. A junior reader looking at this for the first time often asks why not `errgroup.Group` from `golang.org/x/sync/errgroup`, and the answer is the partial-success semantics. `errgroup` with the default context cancels siblings on first error, which is correct for "all or nothing" operations and wrong for BFF aggregation where one downstream failure should not blank the entire home screen. If you replace `sync.WaitGroup` with `errgroup.Group` here without thinking, you will convert a resilient aggregator into a brittle one. Both patterns are correct. The code review signal is that the author named the trade-off.

Worked exercise for readiness. Take the handler and instrument it. Add OpenTelemetry spans per downstream call, record the per-call duration, and log the degraded-response case (one or more errors but not all four). Then write a table-driven test where each of the four services can be configured to succeed, fail with a timeout, or fail with a 500. Verify that three-of-four success still returns 200, four-of-four failure returns 503, and the response shape contains empty slices rather than nil for JSON consistency (mobile clients parsing nil as missing key rather than empty array is a real bug class). This exercise is the BFF interview question in at least three FAANG mobile teams.

Interview framing. If asked "how would you aggregate four downstream services for a mobile home screen," the bad answer is "I would call each one and combine the results." The good answer names the concurrency primitive, the partial-success posture, the per-call timeout independent of request timeout, the circuit breaker around each downstream, and the shape contract with the client including how missing downstreams are represented. You do not need to implement all of that in the interview. You need to name it.

First-job context. The handler you inherit will not look this clean. It will have six downstreams, three of which are legacy SOAP services proxied through a gateway, one of which has a 2-second p99 latency that dominates the entire BFF response. Your first useful PR is often not adding a feature. It is moving the slow downstream behind a cache with a short TTL and a stale-while-revalidate policy so the home screen stops being held hostage by a 2003-era billing service.

### Senior @ FAANG: BFF Protocol Selection, Persisted Queries, and the Client-Skew Problem

At staff level the protocol table above is the starting point for a conversation, not the end. The real question is how the protocol choice interacts with three forces: client version skew, schema evolution velocity, and provider redundancy. Mobile clients cannot be forced to upgrade. A decision you make today ships to a device that will still be on that version in 2029. Every protocol choice is therefore a multi-year commitment with a non-trivial reversal cost.

REST plus JSON with Brotli is the low-reversal-cost baseline. You can ship it, regret it, and replace the server side without breaking any installed client that did not hard-code field names. The cost is payload size and the lack of a machine-checkable contract. Protobuf over Connect inverts this: you get a strong typed contract, smaller wire size, and you can generate clients for Swift and Kotlin from the same `.proto` file that generates the Go server. The cost is that proto field deprecation has a long tail because you must keep old field numbers alive for the lifetime of any installed client that reads them, and you must never repurpose a field number. GraphQL sits between: the contract is schema-checked and clients select fields, but without persisted queries you are shipping the schema surface to every client and paying query planning cost per request.

Persisted queries are the staff-level GraphQL discipline that junior teams skip. The pattern: clients do not send ad-hoc GraphQL queries to production. Instead, at build time the client's queries are extracted, hashed, and registered with the server. At runtime the client sends only the hash. The server rejects any hash it does not know. This closes three problems at once: unauthenticated query-of-death denial-of-service (an attacker cannot craft a pathological query because only registered hashes are accepted), query planning cost (the server can precompile), and schema-exposure risk (you can run introspection off in production because clients do not need it). Apollo Persisted Queries, Relay's persisted query support, and Meta's internal systems all converged on this pattern independently. If you are running GraphQL at mobile scale without persisted queries, that is a staff-level tech-debt item that should be on the next roadmap.

HTTP/3 and QUIC change the mobile BFF latency math enough to warrant a separate ADR in 2026. The headline benefit for mobile is connection migration: when a device switches from Wi-Fi to LTE to 5G mid-request, QUIC preserves the connection identifier and the session survives without a TCP handshake penalty. On a subway commute where handoffs happen every ninety seconds, this can cut p99 latency in half for users in active sessions. The cost is operational complexity: not every load balancer, WAF, and observability stack supports HTTP/3 cleanly as of April 2026. The ADR should name which edge (Cloudflare, Fastly, AWS CloudFront, GCP Cloud Load Balancing) terminates QUIC, whether your BFF speaks HTTP/2 to the edge and lets the edge handle QUIC (the common pattern) or speaks QUIC end to end (rare, justified only for latency-critical flows like live streaming or ride dispatch), and how you handle the degradation case when QUIC is blocked by corporate firewalls or some national networks. Go does not ship HTTP/3 in its standard library. The production-grade Go implementation is `github.com/quic-go/quic-go` (with its `http3` subpackage); the official `golang.org/x/net/http3` and `golang.org/x/net/quic` packages remain experimental and not production-ready as of 2026. An all-Go BFF can speak QUIC directly via quic-go if the operational story supports it.

Mobile-first API versioning is the discipline that prevents the most expensive mobile backend incident class: a breaking change that shipped before the forced-update floor caught up. The rule at staff level is that the BFF does not break. The BFF adds. New fields are added, old fields are preserved, and deprecated fields are marked in the schema with a deprecation date that aligns with the client version that stops reading them. This requires a schema registry with ownership, a deprecation workflow with dashboards showing which installed client versions still read a field, and a hard rule that no field is removed until the read traffic falls below a threshold (commonly 0.1% of active users, measured over a 30-day window). Teams that skip this discipline get one breaking change wrong and watch their app store rating collapse over the weekend as users on older client versions see blank screens.

Netflix's Falcor story is the cautionary tale worth re-reading. Falcor, released in 2015, solved over-fetching with a path-based query model that predated GraphQL's wide adoption. Technically it worked. It lost because it did not ship with schema tooling comparable to GraphQL's SDL, because the learning curve for client teams was steep, and because the ecosystem around it never reached critical mass. The lesson for your BFF ADR in 2026 is not technical. It is that protocol choice is also an ecosystem bet. Picking a technically superior protocol with a weak ecosystem means your BFF team spends its cycles building tooling that someone else's protocol gets for free, and that is a multi-year tax on feature velocity.

---
