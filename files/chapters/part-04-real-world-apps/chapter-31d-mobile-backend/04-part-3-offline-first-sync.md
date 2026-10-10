## Part 3: Offline-First Sync

The offline-first sync protocol assigns a monotonically increasing server-side sequence number to every write, so clients can request all changes after their last known sequence number in a single paginated query. Conflict resolution uses last-write-wins semantics keyed on the `updated_at` timestamp: when the server receives a client write for a record that has been modified server-side since the client last synced, the higher timestamp wins and the loser is stored in a conflicts log for audit. Clients track their sync state in a local SQLite table. On reconnect, they replay any locally queued writes before fetching server deltas, ensuring local changes are not overwritten by a stale sync.

**When LWW is wrong.** Last-write-wins silently discards concurrent edits that a user genuinely made offline. For a settings record this is fine. For a collaborative document or a shopping cart, data loss is unacceptable. Escalate as the data demands:

1. **Server-authoritative LWW** (this section), defaults for 80% of mobile records (profile fields, task flags, read/unread markers).
2. **Vector clocks**, detect *true* concurrency (non-comparable clocks) so the server can surface a conflict instead of silently overwriting. Covered in `13-offline-first-and-data-synchronization.md`.
3. **CRDTs**, for commutative state (counters, sets, ordered lists, rich text). Pick a type that matches your operation: G-Counter / PN-Counter for numeric aggregates, OR-Set for tags/labels, RGA or Yjs/Automerge for collaborative text. CRDTs merge deterministically on both server and client with no coordinator, the right choice when offline collaboration is a feature, not an edge case.

```go
package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// SyncRecord represents a change that needs to be synced
type SyncRecord struct {
	ID         string          `json:"id"`
	EntityType string          `json:"entity_type"` // "note", "task", "contact"
	EntityID   string          `json:"entity_id"`
	Operation  string          `json:"operation"`  // "create", "update", "delete"
	Data       json.RawMessage `json:"data"`
	ClientTime time.Time       `json:"client_time"`
	DeviceID   string          `json:"device_id"`
	Version    int64           `json:"version"`     // server-assigned monotonic version
}

// SyncRequest is sent by mobile clients to push changes
type SyncRequest struct {
	DeviceID     string       `json:"device_id"`
	LastSyncTime time.Time    `json:"last_sync_time"`
	Changes      []SyncRecord `json:"changes"`
	MaxResults   int          `json:"max_results"`
}

// SyncResponse contains server changes and conflict resolutions
type SyncResponse struct {
	ServerChanges     []SyncRecord     `json:"server_changes"`
	Conflicts         []ConflictResult `json:"conflicts"`
	NextSyncToken     string           `json:"next_sync_token"`
	ServerTime        time.Time        `json:"server_time"`
	HasMore           bool             `json:"has_more"`
}

// ConflictResult is a resolved conflict
type ConflictResult struct {
	ClientRecord SyncRecord `json:"client_record"`
	ServerRecord SyncRecord `json:"server_record"`
	Resolution   string     `json:"resolution"` // "client_wins", "server_wins", "merged"
	MergedRecord SyncRecord `json:"merged_record,omitempty"`
}

// SyncServer handles bidirectional sync
type SyncServer struct {
	store    SyncStore
	resolver ConflictResolver
}

// SyncStore persists sync records
type SyncStore interface {
	GetChangesSince(ctx context.Context, userID string, since time.Time, limit int) ([]SyncRecord, error)
	ApplyChange(ctx context.Context, userID string, record SyncRecord) (*SyncRecord, error)
	GetRecord(ctx context.Context, userID, entityType, entityID string) (*SyncRecord, error)
}

// ConflictResolver determines which version wins
type ConflictResolver interface {
	Resolve(client, server SyncRecord) ConflictResult
}

// LastWriteWinsResolver resolves conflicts using the latest timestamp
type LastWriteWinsResolver struct{}

func (r *LastWriteWinsResolver) Resolve(client, server SyncRecord) ConflictResult {
	if client.ClientTime.After(server.ClientTime) {
		return ConflictResult{
			ClientRecord: client,
			ServerRecord: server,
			Resolution:   "client_wins",
			MergedRecord: client,
		}
	}
	return ConflictResult{
		ClientRecord: client,
		ServerRecord: server,
		Resolution:   "server_wins",
		MergedRecord: server,
	}
}

// HandleSync processes a sync request
func (s *SyncServer) HandleSync(w http.ResponseWriter, r *http.Request) {
	userID := r.Header.Get("X-User-ID")
	if userID == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var req SyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	if req.MaxResults <= 0 || req.MaxResults > 500 {
		req.MaxResults = 100
	}

	ctx := r.Context()

	// Process client changes
	var conflicts []ConflictResult
	for _, change := range req.Changes {
		existing, err := s.store.GetRecord(ctx, userID, change.EntityType, change.EntityID)
		if err != nil {
			http.Error(w, "store error", http.StatusInternalServerError)
			return
		}

		if existing != nil && existing.Version > change.Version {
			// Conflict: server has a newer version
			conflict := s.resolver.Resolve(change, *existing)
			conflicts = append(conflicts, conflict)

			if conflict.Resolution == "server_wins" {
				continue // don't apply client change
			}
		}

		if _, err := s.store.ApplyChange(ctx, userID, change); err != nil {
			// Log but continue processing other changes
			fmt.Printf("apply change error: %v\n", err)
		}
	}

	// Get server changes since last sync
	serverChanges, err := s.store.GetChangesSince(ctx, userID, req.LastSyncTime, req.MaxResults+1)
	if err != nil {
		http.Error(w, "store error", http.StatusInternalServerError)
		return
	}

	hasMore := len(serverChanges) > req.MaxResults
	if hasMore {
		serverChanges = serverChanges[:req.MaxResults]
	}

	resp := SyncResponse{
		ServerChanges:  serverChanges,
		Conflicts:      conflicts,
		NextSyncToken:  generateSyncToken(),
		ServerTime:     time.Now().UTC(),
		HasMore:        hasMore,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func generateSyncToken() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}
```

### Junior → FAANG: Why Sync Is The Hardest Thing On A Mobile Backend

If you read this section and thought "this looks straightforward," re-read it. Sync is the distributed systems problem in a mobile backend, and the code above is the simple case. The subtleties that bite production systems are: client clock skew (never trust `ClientTime` for conflict resolution without server-side sanity bounds, because a device with a wrong clock will dominate every conflict), partial application (a sync request with ten records applied five and then the request failed, so the client retries all ten, and the handler must be idempotent on the five already applied), replay attacks (a malicious client replays an old sync request with a forged timestamp), and cursor stability (if `NextSyncToken` encodes a timestamp and the server clock moves backward, the client can miss records).

Worked example of clock skew. A user's phone battery died, they replaced it at 3am, and the phone came up with a clock set two years in the future until it synced NTP. The app wrote three records with timestamps two years in the future. Under LWW those records will beat every future write for the next two years until a real write catches up. The fix is to reject client timestamps that exceed `server_time + allowed_skew` (commonly 5 minutes) and substitute server time at ingest. Never trust client time for ordering. Use it as metadata only.

Interview entry point. If asked to design offline sync for a mobile notes app, the signal is walking through the four problems (connectivity, concurrency, conflict, consistency) and naming a strategy for each. Connectivity: queue locally, retry with exponential backoff, surface sync status in the UI. Concurrency: per-record version number, idempotent apply. Conflict: LWW for the simple case, surface conflicts for collaborative records, CRDT for high-value collaborative data. Consistency: monotonic cursor, idempotent endpoint, server authoritative on ordering. Mentioning all four without being prompted is a senior-level signal even at new grad loops.

First-job context. You will inherit a sync system where the original author chose LWW and a new product requirement says "two users can edit the same record from two devices and both edits should survive." That requirement does not fit LWW. Your job is to recognize that the requirement has changed the problem class, escalate to a design review, and either introduce a CRDT for that record type or add a conflict UI that surfaces the diff to the user. Silently continuing with LWW and hoping the product team does not notice the data loss is the textbook junior mistake.

### Senior @ FAANG: Sync Engine Selection and the Reversal-Cost Calculus

Sync engine selection is the highest-reversal-cost decision in a mobile backend. The engine ships into every installed client, the client holds local state shaped by the engine's data model, and migrating to a different engine requires either a forced-update floor that excludes a segment of users or a dual-write bridging period that typically runs for a year. The staff-level expectation is that you have read the literature, have implemented at least one engine end to end, and can defend your choice against at least three alternatives with specific reference to the data characteristics of your product.

The landscape in April 2026 clusters into five categories. First, hand-rolled LWW with server-assigned sequence numbers, like the code above. Low infrastructure cost, adequate for 60-80% of mobile records in most products, explicit conflict surfacing requires extra work. Second, hand-rolled vector clocks or version vectors, which distinguish true concurrency from linear ordering. More expressive than LWW, significantly more code, most teams that adopted them ten years ago would not adopt them again and would pick a CRDT library instead. Third, CRDTs via libraries like Yjs or Automerge, which provide deterministic merge for text, maps, sets, and arrays. The right answer when collaborative editing is the product (Figma, Linear, Notion all use CRDT-adjacent architectures). Cost is the binary size of the CRDT runtime on the client and the learning curve for the team. Fourth, operational transformation, which Google Docs famously uses. OT requires a central coordinator that orders operations, which conflicts with offline-first requirements unless you accept that offline edits rebase when reconnecting. Almost no new systems choose OT over CRDT in 2026. Fifth, managed sync engines (Replicache, LiveStore, TinyBase with sync backends, PowerSync, ElectricSQL, Turso embedded replicas). These trade the build-your-own cost for vendor dependency and a less malleable data model. PowerSync and ElectricSQL in particular have matured significantly in 2025 and are defensible choices for new products at staff level, with the caveat that you are now in a vendor relationship and your sync semantics are whatever the vendor says they are.

The staff-level selection heuristic: start with LWW plus explicit conflict surfacing for records where conflicts are rare and recoverable. Upgrade to CRDT for records where conflicts are expected and silent merge is the product requirement (shared documents, shared lists, presence state). Reach for a managed sync engine only when the data model is so uniform across your product that the engine's opinionated model fits without contortion, and when the team lacks the appetite to own sync engine code long-term. Never mix two engines for the same record type in the same product. You can have LWW for user settings and CRDT for collaborative notes in the same app. You cannot have both LWW and CRDT for the same record class without creating an undecidable merge situation when a legacy client writes LWW-style while a new client writes CRDT-style.

Delta sync protocols are the bandwidth story. Full sync on every reconnect is a battery and data-plan violation at scale. The right shape is a cursor-based delta: the client sends its last known cursor, the server returns records changed since that cursor and a new cursor. Cursors must be monotonic, resilient to clock skew (use a logical sequence number or a Lamport clock, not wall-clock time), and opaque to the client so the server can change the cursor encoding without breaking clients. The staff-level ADR documents cursor format, cursor stability guarantees (what happens if the server is restored from a backup three hours old? cursors must still be valid or the server must detect and force a full resync), and the full-resync trigger (what cursor age or record-count threshold forces a full resync, and how is that communicated to the client).

Push-initiated sync versus pull is an ADR that touches battery, cost, and freshness. Pure polling (client hits `/sync` every N minutes) is expensive on battery and wasteful when nothing changed. Pure push (server sends silent push on every change, client wakes and pulls) is battery-efficient but depends on push reliability, which we established is best-effort. The pragmatic answer is hybrid: silent push wakes the client when something changed and the client has not synced recently, and the client falls back to polling at a long interval (commonly 15-30 minutes in foreground, hours in background) when silent push may have been dropped. The polling cadence is an ADR item because every doubling of frequency is a measurable battery impact on a non-trivial number of users, and you will be asked about it by the platform team.

Conflict resolution governance is the staff-level discipline that turns a sync engine from "works in happy path" to "trusted by users." The governance items to establish: which record types use which resolution strategy (matrix, documented, reviewed quarterly), how conflicts are surfaced to users (silent merge, notification, modal diff), how conflict rate is measured and alerted (per record type, per client version, rolling 7-day average), and how a conflict-resolution bug is rolled back (you cannot roll back a merge, so the recovery story is the conflict log and the ability to restore a prior version). Products that skip this discipline learn about it through user complaints that feel like data loss, which is the failure mode that kills app store ratings.

---
