## Sync Protocol

Client-server sync using vector clocks:

```go
// SyncState tracks file versions across devices
type SyncState struct {
    FileID       string
    VectorClock  map[string]int64  // device_id -> version
    LastModified time.Time
}

// SyncService handles file synchronization
type SyncService struct {
    metadata MetadataStore
    changes  ChangeStream
}

// Sync compares local state with server and returns changes
func (s *SyncService) Sync(ctx context.Context, userID string, localState []SyncState) (*SyncResult, error) {
    result := &SyncResult{}

    // Get server state
    serverState, err := s.metadata.GetSyncState(ctx, userID)
    if err != nil {
        return nil, err
    }

    // Compare each file
    serverMap := make(map[string]SyncState)
    for _, state := range serverState {
        serverMap[state.FileID] = state
    }

    for _, local := range localState {
        server, exists := serverMap[local.FileID]

        if !exists {
            // New local file, upload to server
            result.ToUpload = append(result.ToUpload, local.FileID)
            continue
        }

        delete(serverMap, local.FileID)

        comparison := compareVectorClocks(local.VectorClock, server.VectorClock)
        switch comparison {
        case LocalNewer:
            result.ToUpload = append(result.ToUpload, local.FileID)
        case ServerNewer:
            result.ToDownload = append(result.ToDownload, local.FileID)
        case Conflict:
            result.Conflicts = append(result.Conflicts, ConflictInfo{
                FileID:      local.FileID,
                LocalClock:  local.VectorClock,
                ServerClock: server.VectorClock,
            })
        case Equal:
            // Already in sync
        }
    }

    // Files only on server = download
    for fileID := range serverMap {
        result.ToDownload = append(result.ToDownload, fileID)
    }

    return result, nil
}
```


### Junior → FAANG: Sync Protocol Design Fundamentals

A sync protocol defines how clients and servers negotiate the current state and exchange deltas. The key primitives: the client maintains a local revision cursor (a monotonic counter or vector clock), the server maintains a global change log, and the sync operation is a two-phase process: first pull changes from the server since the last cursor, then push local changes not yet acknowledged by the server. The common mistake is designing sync without conflict detection: if two clients modify the same file while offline, the server needs a policy for resolving the conflict (last-write-wins, create a conflict copy, or merge).

### Senior @ FAANG: Sync Protocol Correctness, Convergence, and Operational Maturity

At the senior level, a sync protocol is a distributed systems problem with formal correctness requirements: convergence (all clients eventually reach the same state), consistency (each client sees a valid state at each point), and progress (sync eventually terminates). These properties are hard to test with unit tests alone. They require simulation with concurrent clients under network partition conditions. The bar-raiser question is how you test your sync protocol: property-based testing with randomized client interleavings, linearizability checkers, or formal model checking for critical correctness properties. Staff-level concerns include the migration plan when the sync protocol needs a version bump: old clients must continue to function during a protocol upgrade, which requires backward compatibility in the server for at least one protocol version, a client upgrade mechanism with forced upgrade thresholds, and a monitoring strategy for detecting clients running stale protocol versions and their impact on server-side complexity.
