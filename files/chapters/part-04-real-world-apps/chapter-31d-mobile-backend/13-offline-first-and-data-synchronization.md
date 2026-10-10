## Offline-First and Data Synchronization

### Offline-First Architecture Principles

An offline-first backend is designed with the assumption that the mobile client may be unreachable for hours or days. The server must:

1. **Accept out-of-order writes** - a client may have been offline for 48 hours and submit a batch of changes with old timestamps.
2. **Expose a tombstone mechanism** - deleted records must be marked, not physically removed, until all clients have synced.
3. **Provide a deterministic conflict resolution policy** - clients and servers apply the same rules so they converge to identical state.
4. **Return server-authoritative timestamps** - never trust `updated_at` from the client payload.

### Conflict Resolution Strategies

| Strategy | Description | Best For |
|----------|-------------|----------|
| Last-Write-Wins (LWW) | Higher `updated_at` wins | Simple key-value settings, profile fields |
| Server-Wins | Server version always prevails | Financial records, inventory |
| Client-Wins | Client version always prevails | User-composed content (notes) |
| Three-Way Merge | Merge base + client change + server change | Documents, structured text |
| CRDTs | Mathematically conflict-free data types | Counters, shopping carts, collaborative lists |

### Vector Clocks for Conflict Detection

A vector clock assigns a logical counter to each replica. When two versions have non-comparable clocks, a true conflict exists (not just a stale update).

```go
package vectorclock

import "fmt"

// VectorClock is a map from node/device ID to logical counter.
type VectorClock map[string]uint64

// Increment advances the clock for the given node.
func (vc VectorClock) Increment(nodeID string) VectorClock {
	next := vc.Clone()
	next[nodeID]++
	return next
}

// Clone returns a deep copy.
func (vc VectorClock) Clone() VectorClock {
	c := make(VectorClock, len(vc))
	for k, v := range vc {
		c[k] = v
	}
	return c
}

// Merge returns a new clock with the element-wise maximum of both clocks.
// Used when merging two diverged versions.
func (vc VectorClock) Merge(other VectorClock) VectorClock {
	merged := vc.Clone()
	for k, v := range other {
		if v > merged[k] {
			merged[k] = v
		}
	}
	return merged
}

// Relation describes how two clocks relate to each other.
type Relation int

const (
	Before     Relation = iota // vc happened before other
	After                      // vc happened after other
	Concurrent                 // true conflict - neither dominates
	Equal                      // identical clocks
)

// Compare returns the causal relationship between vc and other.
func (vc VectorClock) Compare(other VectorClock) Relation {
	allKeys := make(map[string]struct{})
	for k := range vc {
		allKeys[k] = struct{}{}
	}
	for k := range other {
		allKeys[k] = struct{}{}
	}

	less, greater := false, false
	for k := range allKeys {
		a, b := vc[k], other[k]
		if a < b {
			less = true
		} else if a > b {
			greater = true
		}
		if less && greater {
			return Concurrent
		}
	}

	switch {
	case !less && !greater:
		return Equal
	case less:
		return Before
	default:
		return After
	}
}

func (r Relation) String() string {
	return [...]string{"before", "after", "concurrent", "equal"}[r]
}

// Example usage in a sync handler
func ExampleConflictDetection() {
	serverClock := VectorClock{"server": 5, "device-A": 3}
	clientClock := VectorClock{"server": 4, "device-A": 4} // device advanced independently

	rel := serverClock.Compare(clientClock)
	fmt.Printf("Relationship: %s\n", rel) // concurrent - real conflict
}
```

### Complete Sync Endpoint

This endpoint accepts a batch of client changes, applies conflict resolution, and returns server changes the client missed.

```go
package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// SyncRequest is the payload the mobile client sends.
type SyncRequest struct {
	// LastSyncAt is the ServerTime from the previous successful sync response.
	// Zero value means full sync (first-time or reset).
	LastSyncAt time.Time `json:"last_sync_at"`

	// Changes contains records created or modified on the device since last sync.
	Changes []ClientRecord `json:"changes"`
}

// ClientRecord is a single record sent from the mobile client.
type ClientRecord struct {
	ID          string                 `json:"id"`
	UpdatedAt   time.Time              `json:"updated_at"`  // client-side timestamp (advisory only)
	IsDeleted   bool                   `json:"is_deleted"`
	Fields      map[string]any `json:"fields"`
}

// SyncResponse is returned to the mobile client.
type SyncResponse struct {
	// ServerChanges are records the client needs to apply locally.
	ServerChanges []ServerRecord `json:"server_changes"`

	// DeletedIDs are IDs the client should remove from local storage.
	DeletedIDs []string `json:"deleted_ids"`

	// ServerTime must be persisted as LastSyncAt for the next sync call.
	ServerTime time.Time `json:"server_time"`

	// Conflicts describes records where the server version was retained.
	Conflicts []ConflictSummary `json:"conflicts,omitempty"`
}

// ServerRecord is a record with server-authoritative timestamps.
type ServerRecord struct {
	ID        string                 `json:"id"`
	UpdatedAt time.Time              `json:"updated_at"`
	Fields    map[string]any `json:"fields"`
}

// ConflictSummary informs the client that its version was overridden.
type ConflictSummary struct {
	ID             string    `json:"id"`
	ClientVersion  time.Time `json:"client_version"`
	ResolvedAt     time.Time `json:"resolved_at"`
	ResolutionRule string    `json:"resolution_rule"`
}

// SyncRepository is the storage interface required by the sync handler.
type SyncRepository interface {
	// ApplyChange upserts a client record using the server's conflict policy.
	// Returns the resolved server record and whether a conflict occurred.
	ApplyChange(ctx context.Context, userID string, rec ClientRecord) (ServerRecord, bool, error)

	// ChangedSince returns server records modified after since for the given user.
	ChangedSince(ctx context.Context, userID string, since time.Time) ([]ServerRecord, error)

	// DeletedSince returns IDs of records soft-deleted after since for the user.
	DeletedSince(ctx context.Context, userID string, since time.Time) ([]string, error)
}

type SyncHandler struct {
	repo SyncRepository
}

func NewSyncHandler(repo SyncRepository) *SyncHandler {
	return &SyncHandler{repo: repo}
}

func (h *SyncHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	userID := r.Context().Value("user_id").(string)

	var req SyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request body", http.StatusBadRequest)
		return
	}

	// Capture server time before any writes to avoid missing concurrent writes.
	serverTime := time.Now().UTC()

	// Apply client changes (writes)
	var conflicts []ConflictSummary
	for _, change := range req.Changes {
		_, hadConflict, err := h.repo.ApplyChange(r.Context(), userID, change)
		if err != nil {
			http.Error(w, "failed to apply change", http.StatusInternalServerError)
			return
		}
		if hadConflict {
			conflicts = append(conflicts, ConflictSummary{
				ID:             change.ID,
				ClientVersion:  change.UpdatedAt,
				ResolvedAt:     serverTime,
				ResolutionRule: "last-write-wins",
			})
		}
	}

	// Fetch server changes the client hasn't seen (reads)
	serverChanges, err := h.repo.ChangedSince(r.Context(), userID, req.LastSyncAt)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	deletedIDs, err := h.repo.DeletedSince(r.Context(), userID, req.LastSyncAt)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Null-safe arrays - mobile JSON parsers handle [] but not null gracefully
	if serverChanges == nil {
		serverChanges = []ServerRecord{}
	}
	if deletedIDs == nil {
		deletedIDs = []string{}
	}

	resp := SyncResponse{
		ServerChanges: serverChanges,
		DeletedIDs:    deletedIDs,
		ServerTime:    serverTime,
		Conflicts:     conflicts,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
```

### Handling Devices That Haven't Synced in Months

A device that syncs after 90 days of inactivity may miss tombstone records that were purged, or encounter schema fields that no longer exist. Handle this with a **sync reset threshold**:

```go
const MaxSyncGap = 90 * 24 * time.Hour

func (h *SyncHandler) resolveSyncStrategy(lastSyncAt time.Time) string {
	if lastSyncAt.IsZero() {
		return "full"
	}
	if time.Since(lastSyncAt) > MaxSyncGap {
		return "full" // too stale - force a complete re-sync
	}
	return "delta"
}
```

When `strategy == "full"`, the response omits `DeletedIDs` (no tombstone retention needed) and returns all current records. The client replaces its local store entirely. Include a `sync_strategy` field in the response so the client knows to truncate its local database.

### Junior → FAANG: Sync Is The Distributed Systems Final Exam

Read the vector clock code again. Read it a third time. Vector clocks are the smallest non-trivial distributed systems primitive, and the code above is their entire implementation in about fifty lines of Go. If you can produce this from memory on a whiteboard, explain the `Concurrent` relation in one sentence, and say why `Merge` uses element-wise max, you have demonstrated the foundational distributed-systems literacy that senior interviews probe. Most junior candidates can describe vector clocks in words. Few can implement them. Even fewer can explain why they are rarely used in practice today.

Worked example of the "rarely used" point. Vector clocks detect true concurrency, but they do not resolve it. They tell you "these two versions diverged." You still need a policy to merge them. For a user profile, LWW is the policy. For a collaborative document, a CRDT is the policy. Vector clocks alone are a detection mechanism, not a solution. This is why modern systems often skip the vector clock primitive and use a CRDT library that encapsulates both detection and merge. The chapter shows the primitive because understanding it is foundational, but in a production system you would reach for Yjs or Automerge instead of hand-rolling a vector-clock-plus-custom-merge.

Interview framing. If asked to design a sync protocol, walk through: client model (what state does the client hold, what mutations does it generate offline), server model (authoritative state, how is it versioned), conflict policy (per record type), delta protocol (cursor, paginated, idempotent), and recovery (what happens when the client has not synced in N days). Mentioning the `MaxSyncGap` reset as a separate policy from normal delta sync signals you have thought about the operational failure modes, not just the happy path.

First-job context. You will inherit a sync system where `MaxSyncGap` is set to 30 days for historical reasons and nobody remembers why. Half the user complaints will be from users coming back after a vacation whose data was wiped because `MaxSyncGap` triggered a full resync that clobbered local unsynced changes. The fix is twofold: raise `MaxSyncGap` to 90 or 180 days, and ensure the full-resync path merges local pending changes rather than clobbering them. This is often a quarter-long project because it requires careful migration of existing clients.

### Senior @ FAANG: Sync Engine Architecture, CRDTs In Practice, And The Managed-Engine Choice

The handler above implements server-authoritative sync with a last-write-wins policy. At staff level this is the starting point for a larger architectural conversation about the sync engine portfolio. Three questions define the conversation.

First: which record types need which policy? The matrix approach documents, for every persistent record type in the product, the conflict policy, the retention policy, the tombstone policy, and the expected conflict rate. Records that are effectively single-writer (user settings, account info) can use LWW with zero ceremony. Records that are multi-writer but low-contention (notes, tasks, calendar events) use LWW with conflict surfacing so the user can reconcile. Records that are genuinely collaborative (shared documents, shared lists, presence state) use CRDTs. Records with integrity constraints (money, inventory counts) use server-authoritative with no client write (the client can propose, the server decides). The matrix is the deliverable. Without it, every engineer makes an ad-hoc choice and the product accumulates conflict-handling inconsistencies.

Second: what is the CRDT strategy for the collaborative records? The landscape in 2026 has two clear leaders. Yjs (JavaScript-origin, with Go implementations such as `github.com/reearth/ygo` that are binary-compatible with the JS wire format) is the choice for rich text and structured document editing, and is widely used across the collaborative-editor ecosystem (notably ProseMirror/TipTap-based editors). Automerge (Rust core with bindings for Swift, Kotlin, Go, JavaScript) is the choice when a stronger functional-purity guarantee is desired and when the data model is closer to a JSON document than a rich text blob. Both are mature in 2026. The selection criteria: Yjs if rich text is a first-class product surface, Automerge if the data model is JSON-document-shaped and you want strong guarantees about causal consistency. The wrong choice is rolling your own CRDT, because CRDT correctness is subtle and the libraries have been battle-tested for years.

Third: is the sync engine a build-your-own asset or a managed service? The managed-engine landscape in 2026 includes Replicache (low-level, client-focused, brings its own data model), PowerSync (SQLite-focused, strong offline story, backend integration via change-data-capture), ElectricSQL (Postgres-to-SQLite replication with conflict resolution policies), TinyBase (in-memory with sync backends), LiveStore (SQLite-based with reactive queries), and Turso embedded replicas (libSQL with read replicas close to the device). Each has opinions about the data model, the conflict policy, and the transport. The staff-level trade-off: managed engines give you a large starting velocity at the cost of a vendor dependency and a less malleable data model. Build-your-own gives you full control at the cost of sustained engineering investment (a real sync engine is a multi-engineer multi-year project). For a new product that fits a managed engine's opinions, the managed choice is often right. For a product that has already built its own sync engine, the switching cost is almost always prohibitive, so the right move is to invest in the existing engine.

The vector clock primitive shown above has a production caveat: size. A vector clock grows linearly in the number of actors that have ever written to a record. In a system where every device is an actor, a record that has been edited from ten devices over its lifetime has a ten-entry vector clock. Over years this is unbounded growth. Real systems use one of three mitigations. Pruning (garbage-collect clock entries for actors that have not written in a long window, accepting that very-old concurrent writes cannot be detected). Dotted version vectors (Riak's approach, more efficient encoding). Actor-centric clocks where the actor is the user, not the device (bounded growth because users are bounded but gives up the ability to detect device-level conflicts). The staff-level ADR names which mitigation applies and why.

Tombstone retention is the operational concern that many sync designs under-specify. If a record is deleted and a client has not synced for longer than the tombstone retention, the client will not learn about the deletion, and the record will reappear on the next sync. The fix is the `MaxSyncGap` full-resync path shown in the code, but the trigger must match the tombstone retention. If tombstones are retained for 90 days and `MaxSyncGap` is 120 days, there is a 30-day window where a client can miss deletions. The invariant: `MaxSyncGap < TombstoneRetention`. Getting this wrong is a subtle data-integrity bug that shows up as ghost records in user reports months after the window opened.

The push-initiated sync pattern interacts with the sync engine. Silent push wakes the client, the client calls `/sync`, the server returns deltas. The latency from data change to client update is the push-delivery latency plus the sync round-trip. For most products this is fine (seconds). For products where the data change must be visible within seconds (presence indicators, typing indicators, live scores), the sync engine is the wrong transport. Use a WebSocket or Server-Sent Events for those specific flows, with the sync engine handling the durable state and the live transport handling the ephemeral updates. The architectural rule: sync engines handle durable state, live transports handle ephemeral state. Conflating them (using a sync engine for presence, using WebSocket for durable state) creates integrity and scaling problems.

---
