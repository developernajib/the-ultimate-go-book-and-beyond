## Failure Handling

A reliable messaging system must degrade gracefully rather than lose messages. The core pattern is a tiered delivery attempt: try the live WebSocket first, fall back to the offline queue if the user is disconnected, and send a push to wake the app. When the user reconnects, the queue drains in order.

Say plainly what the guarantee rests on, because "no message is ever lost" is a claim a design has to earn. The message is safe because it was durably written to Cassandra before any of this was attempted. Everything below is a latency optimization over that durable record, and the real backstop is that a reconnecting client re-requests everything after its last acknowledged message ID. Treating the queue as the guarantee, rather than the cache it is, is how systems end up losing messages while every component reports success.

```go
package delivery

import (
	"context"
	"fmt"
	"log"
)

type DeliveryManager struct {
	queue OfflineQueue
	conn  ConnectionRouter
	push  PushService
}

// Deliver attempts live delivery, then falls back to the offline queue.
//
// The fallback's errors are the ones that matter. If the queue write fails, the
// caller must know: the original code returned nil unconditionally, so a Redis
// outage looked exactly like a successful delivery to every caller upstream.
// A push failure is different in kind, and is only logged: the message is
// already queued, so the user gets it on their next connection. Losing the
// doorbell is not losing the message.
func (m *DeliveryManager) Deliver(ctx context.Context, uid string, msg []byte) error {
	if err := m.conn.DeliverToUser(ctx, uid, msg); err == nil {
		return nil
	}

	if err := m.queue.Enqueue(ctx, uid, msg); err != nil {
		return fmt.Errorf("enqueue offline for %s: %w", uid, err)
	}

	if err := m.push.SendWakeup(ctx, uid); err != nil {
		log.Printf("push wakeup for %s: %v", uid, err)
	}
	return nil
}

// OnReconnect drains the offline queue to a freshly connected client.
//
// Two rules govern the failure path, and the obvious implementation breaks
// both.
//
// Order: messages that could not be delivered must return to the *head* of the
// queue, not the tail. Re-enqueuing with a normal Enqueue (an RPUSH) puts an
// older message behind newer ones, so the user opens the app to a conversation
// that reads out of sequence, which is arguably worse than a missing message
// because nothing looks broken.
//
// Completeness: on the first failure, every *remaining* message must go back
// too. Breaking out of the loop after re-queuing only the message that failed
// silently discards the rest of the batch, which were already popped from Redis
// and exist nowhere else.
func (m *DeliveryManager) OnReconnect(ctx context.Context, uid string) error {
	for {
		msgs, err := m.queue.PopBatch(ctx, uid, 64)
		if err != nil {
			return fmt.Errorf("pop offline batch for %s: %w", uid, err)
		}
		if len(msgs) == 0 {
			return nil
		}

		for i, msg := range msgs {
			if err := m.conn.DeliverToUser(ctx, uid, msg); err != nil {
				// Return this message and everything after it, in order.
				if reErr := m.queue.PushFront(ctx, uid, msgs[i:]); reErr != nil {
					return fmt.Errorf("requeue %d messages for %s: %w", len(msgs[i:]), uid, reErr)
				}
				return fmt.Errorf("deliver to %s: %w", uid, err)
			}
		}
	}
}
```

| Failure | Degradation |
|---------|-------------|
| Connection server crash | Client auto-reconnects elsewhere and resyncs from its last acked message ID |
| Cassandra replica loss | `LOCAL_QUORUM` still commits while a minority of replicas is down, hinted handoff backfills them |
| Cassandra quorum loss | Reject the send and surface it to the sender: never ack a message you did not store |
| Redis down | Presence lookups fail, so treat every user as offline and rely on the durable store plus push |
| Push service down | Message stays queued, delivered on next app open |
| Key server down | Existing sessions keep working, only new sessions with new contacts are blocked |

The Cassandra row is worth splitting the way it is above, because "Cassandra down" is two different failures. Losing a *minority* of replicas is routine and `LOCAL_QUORUM` is designed to absorb it. Losing quorum is a different situation entirely, and the only correct behaviour is to fail the write and tell the sender, whose client then keeps the message queued with a single tick and retries. The tempting alternative, dropping to a weaker consistency level so writes keep succeeding, converts a visible outage into silent data loss, which is the worse trade in a system whose entire promise is that the message arrives.

---
