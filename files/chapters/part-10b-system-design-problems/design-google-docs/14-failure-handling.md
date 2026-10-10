## Failure Handling

In a real-time collaborative system, failures must be handled gracefully without losing user edits. The recovery manager rebuilds document state by loading the latest snapshot from S3 and replaying all operations from the log since that snapshot. This combination of periodic snapshots plus an append-only operation log is a proven pattern (similar to database WAL + checkpoints) that provides both fast recovery and complete durability. The degradation table below shows how each failure mode is handled to keep the system available.

```go
package recovery

import ("context"; "fmt"; "time")

type RecoveryManager struct { opLog OperationLog; docStore DocumentStore }

func (r *RecoveryManager) RecoverDocument(ctx context.Context, docID string) (*DocumentSession, error) {
	content, rev, err := r.docStore.LoadLatestSnapshot(ctx, docID)
	if err != nil { content = ""; rev = 0 }
	ops, err := r.opLog.GetSince(ctx, docID, rev)
	if err != nil { return nil, fmt.Errorf("get ops: %w", err) }
	for _, op := range ops { content = applyOps(content, op.Ops); rev = op.Revision + 1 }
	return &DocumentSession{
		docID: docID, engine: &OTEngine{docID: docID, revision: rev, content: content},
		clients: make(map[string]*DocClient), lastSave: time.Now(),
	}, nil
}
```

| Failure | Degradation |
|---------|-------------|
| Doc Server crash | Recover from op log in <5s |
| Op log unavailable | Buffer in memory |
| S3 unavailable | Continue editing, defer saves |
| Redis down | Cache permissions locally |

---
