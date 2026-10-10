## Deep Dive: Offline Editing and Sync

Offline editing is critical for mobile users or anyone with unreliable connectivity. The key challenge is that while the user edits offline, other collaborators may have made changes on the server. When the offline user reconnects, the client must reconcile its local edits with everything that happened while it was disconnected. The approach is straightforward: queue all local operations with their base revision, then on reconnect, fetch all server operations since that revision, transform the pending local ops against them, and send the transformed ops to the server.

```go
package offline

import "context"

type OfflineBuffer struct {
	pendingOps []Operation; baseRevision int; localContent string; isOnline bool
}

func (b *OfflineBuffer) QueueOperation(op Operation) {
	b.pendingOps = append(b.pendingOps, op)
	b.localContent = applyOps(b.localContent, op.Ops)
}

func (b *OfflineBuffer) Sync(ctx context.Context, client *WebSocketClient) error {
	serverOps, err := client.GetOpsSince(ctx, b.baseRevision)
	if err != nil { return err }
	pending := make([]Operation, len(b.pendingOps))
	copy(pending, b.pendingOps)
	for _, sop := range serverOps {
		// Thread the server op through every pending op: pending[i] is
		// based on the state after pending[i-1], so the server op must
		// be transformed forward as well, not reused in its original form
		sOps := sop.Ops
		for i := range pending {
			pending[i].Ops, sOps, _ = transform(pending[i].Ops, sOps)
		}
		// After crossing all pending ops, sOps applies to local content
		b.localContent = applyOps(b.localContent, sOps)
	}
	for i, op := range pending {
		// Each pending op is based on the server having applied the
		// catch-up ops plus the pending ops sent before it
		op.Revision = b.baseRevision + len(serverOps) + i
		if err := client.SendOp(ctx, op); err != nil { return err }
	}
	b.baseRevision += len(serverOps) + len(pending)
	b.pendingOps = nil; b.isOnline = true
	return nil
}
```

---
