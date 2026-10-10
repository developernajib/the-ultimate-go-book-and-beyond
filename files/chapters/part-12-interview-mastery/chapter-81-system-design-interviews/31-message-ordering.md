## Message Ordering

Problem: Messages from different servers may arrive out of order.

Solution: Lamport timestamps + server-assigned sequence numbers

```go
package chat

import (
    "context"
    "time"
)

type Message struct {
    ID            string    `json:"id"`
    ConversationID string   `json:"conversation_id"`
    SenderID      string    `json:"sender_id"`
    Content       string    `json:"content"`

    // Ordering fields
    ClientTime    int64     `json:"client_time"`     // Lamport clock from client
    ServerTime    time.Time `json:"server_time"`     // Server timestamp
    SeqNum        int64     `json:"seq_num"`         // Per-conversation sequence
}

// MessageService handles message operations
type MessageService struct {
    store    MessageStore
    sequence SequenceGenerator
    fanout   MessageFanout
}

func (s *MessageService) SendMessage(ctx context.Context, msg *Message) error {
    // 1. Assign server timestamp
    msg.ServerTime = time.Now()

    // 2. Get next sequence number for conversation (atomic)
    seq, err := s.sequence.Next(ctx, msg.ConversationID)
    if err != nil {
        return err
    }
    msg.SeqNum = seq

    // 3. Generate message ID
    msg.ID = generateMessageID(msg.ConversationID, msg.SeqNum)

    // 4. Store message
    if err := s.store.Save(ctx, msg); err != nil {
        return err
    }

    // 5. Fan out to recipients
    return s.fanout.Broadcast(ctx, msg)
}
```


### Junior → FAANG: Message Ordering Guarantees

Message ordering is a classic distributed systems problem. In a chat system, users expect messages in a conversation to appear in the order they were sent. The challenge: in a distributed system with multiple servers and network partitions, defining 'the order messages were sent' requires a distributed clock or a sequencer. The simple approach is a monotonically increasing sequence number per conversation, assigned by a single-writer sequencer service. This gives total order within a conversation but is a single point of failure. Know the trade-off between strict ordering (requires coordination) and eventual ordering (more scalable but worse user experience).

### Senior @ FAANG: Message Ordering, Distributed Clocks, and Consistency Models

At the senior level, message ordering is a formal consistency problem. Total order within a conversation can be guaranteed with a single sequencer, but that sequencer is a bottleneck: all writes to a conversation must go through it. The throughput limit is the throughput of the sequencer. At high message volume (e.g., a large group chat with thousands of messages per second), this bottleneck becomes material. The solutions involve relaxing the ordering guarantee: causal ordering (messages are ordered respecting the happens-before relationship, which allows concurrent messages to appear in any order) or per-sender ordering (messages from the same sender are ordered, but messages from different senders can interleave). Each relaxation has a user experience implication. The bar-raiser question is which guarantee is actually required for your use case, and how you communicate the model to clients. At the staff level, message ordering interacts with message re-delivery for offline users: if messages are re-delivered after a user comes back online, they must be delivered in the correct order, which requires the offline message store to preserve sequence numbers and the client to re-render messages in sequence order regardless of delivery order.
