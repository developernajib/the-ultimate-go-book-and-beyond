## Production Go Implementation: Group Call Coordinator

Group voice and video calls extend the 1:1 call signaling to multiple participants. Unlike 1:1 calls that use peer-to-peer WebRTC, group calls need a Selective Forwarding Unit (SFU) to relay media, because full-mesh P2P collapses quickly: with N participants every device sends N-1 streams, so upload bandwidth grows linearly per person and the mesh grows quadratically overall. A phone can manage that for three or four people and not for thirty. An SFU turns it into one upload and N-1 downloads per device.

The SFU is worth being precise about, since it is where a careless design breaks the encryption story. An SFU forwards streams, it does not decode them, so media stays encrypted in transit and the SFU is a router rather than an audience. It is not a full E2E guarantee in the way message content is (the media keys are shared with the forwarding infrastructure in most real deployments, and an MCU that mixes streams would necessarily decrypt), and the honest framing is that group calls trade some of the 1:1 P2P property for the ability to scale past a handful of people.

Two bugs in this code's shape are worth naming, because both are the kind that survive review. The participant map is guarded by a mutex, and the notification loop then iterates it *after* releasing the lock, which is a data race that `go test -race` catches instantly and production catches as a `concurrent map iteration and map write` panic. Snapshot under the lock and iterate the copy. Separately, the coordinator holds `activeCalls` in process memory: that makes every one of these calls single-server state in a fleet of a thousand servers, so a participant whose WebSocket landed elsewhere cannot join, and a restart strands the allocated SFU forever. In-memory is fine as a cache, and the durable record has to live somewhere both shared and reachable.

```go
package calling

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
)

// maxGroupCallParticipants matches WhatsApp's published group call limit.
const maxGroupCallParticipants = 32

var ErrCallFull = errors.New("call is full")

// GroupCallCoordinator manages multi-participant voice/video calls.
//
// activeCalls is a local cache of calls this server is coordinating. It is not
// the source of truth: callDB is. A thousand connection servers cannot each
// keep their own private idea of who is on a call, and a process restart must
// not strand an allocated SFU.
type GroupCallCoordinator struct {
	connRouter   ConnectionRouter
	callDB       CallStore
	groupSvc     GroupService
	sfuAllocator SFUAllocator

	mu          sync.RWMutex
	activeCalls map[string]*GroupCall
}

type GroupCall struct {
	ID              string    `json:"id"`
	GroupID         string    `json:"group_id"`
	Participants    []string  `json:"participants"`
	SFUURL          string    `json:"sfu_url"`
	MaxParticipants int       `json:"max_participants"`
	CreatedAt       time.Time `json:"created_at"`
}

// StartGroupCall initiates a group call and allocates an SFU.
func (c *GroupCallCoordinator) StartGroupCall(ctx context.Context, groupID, initiatorID string) (*GroupCall, error) {
	// You may not start a call in a group you are not in. Without this, a group
	// ID is enough to open a call into a conversation you were never part of
	// and ring everyone in it.
	member, err := c.groupSvc.IsMember(ctx, groupID, initiatorID)
	if err != nil {
		return nil, fmt.Errorf("authorize: %w", err)
	}
	if !member {
		return nil, ErrNotFound
	}

	sfuURL, err := c.sfuAllocator.Allocate(ctx, groupID)
	if err != nil {
		return nil, fmt.Errorf("allocate SFU: %w", err)
	}

	call := &GroupCall{
		ID:              uuid.NewString(),
		GroupID:         groupID,
		Participants:    []string{initiatorID},
		SFUURL:          sfuURL,
		MaxParticipants: maxGroupCallParticipants,
		CreatedAt:       time.Now(),
	}

	// Persist before caching. If Create fails we must release the SFU rather
	// than leak it, and we must not leave a call in local memory that no other
	// server can see.
	if err := c.callDB.Create(ctx, call); err != nil {
		if relErr := c.sfuAllocator.Release(ctx, sfuURL); relErr != nil {
			log.Printf("call %s: release SFU after failed create: %v", call.ID, relErr)
		}
		return nil, fmt.Errorf("create call: %w", err)
	}

	c.mu.Lock()
	if c.activeCalls == nil {
		c.activeCalls = make(map[string]*GroupCall)
	}
	c.activeCalls[call.ID] = call
	c.mu.Unlock()

	return call, nil
}

// JoinGroupCall adds a participant to an active group call.
func (c *GroupCallCoordinator) JoinGroupCall(ctx context.Context, callID, userID string) error {
	call, err := c.callDB.Get(ctx, callID)
	if err != nil {
		return fmt.Errorf("get call: %w", err)
	}

	member, err := c.groupSvc.IsMember(ctx, call.GroupID, userID)
	if err != nil {
		return fmt.Errorf("authorize: %w", err)
	}
	if !member {
		// Same error as a missing call: knowing a call ID must not reveal that
		// the call exists to someone with no right to join it.
		return ErrNotFound
	}

	// Admission is a conditional write in the shared store, not a check against
	// local memory. Two servers admitting the 32nd participant simultaneously
	// would each see 31 locally and both let their user in.
	joined, participants, err := c.callDB.AddParticipant(ctx, callID, userID, maxGroupCallParticipants)
	if err != nil {
		return fmt.Errorf("add participant: %w", err)
	}
	if !joined {
		return ErrCallFull
	}

	notice, err := json.Marshal(map[string]string{
		"type": "participant_joined", "call_id": callID, "user_id": userID,
	})
	if err != nil {
		return err
	}

	// participants is a snapshot returned by the store, so this loop touches no
	// shared mutable state. Ranging over a live map here, after releasing the
	// lock that guarded it, is a data race: the race detector flags it and
	// production eventually panics with "concurrent map iteration and map
	// write".
	for _, pid := range participants {
		if pid == userID {
			continue
		}
		if err := c.connRouter.DeliverToUser(ctx, pid, notice); err != nil {
			// A participant being unreachable does not fail the join.
			log.Printf("call %s: notify %s of join: %v", callID, pid, err)
		}
	}
	return nil
}

// LeaveGroupCall removes a participant and ends the call once it is empty.
func (c *GroupCallCoordinator) LeaveGroupCall(ctx context.Context, callID, userID string) error {
	remaining, err := c.callDB.RemoveParticipant(ctx, callID, userID)
	if err != nil {
		return fmt.Errorf("remove participant: %w", err)
	}

	notice, err := json.Marshal(map[string]string{
		"type": "participant_left", "call_id": callID, "user_id": userID,
	})
	if err != nil {
		return err
	}
	for _, pid := range remaining {
		if err := c.connRouter.DeliverToUser(ctx, pid, notice); err != nil {
			log.Printf("call %s: notify %s of leave: %v", callID, pid, err)
		}
	}

	if len(remaining) > 0 {
		return nil
	}

	// Last participant out: tear down. Ending the call in the store first means
	// a concurrent join loses (the call is gone) rather than joining a call
	// whose SFU we are in the middle of releasing.
	call, err := c.callDB.End(ctx, callID)
	if err != nil {
		return fmt.Errorf("end call: %w", err)
	}

	c.mu.Lock()
	delete(c.activeCalls, callID)
	c.mu.Unlock()

	if call != nil && call.SFUURL != "" {
		if err := c.sfuAllocator.Release(ctx, call.SFUURL); err != nil {
			// Leaking an SFU is expensive and invisible. Log loudly: a sweeper
			// reclaiming allocations with no live call is the backstop.
			log.Printf("call %s: release SFU %s: %v", callID, call.SFUURL, err)
			return fmt.Errorf("release SFU: %w", err)
		}
	}
	return nil
}

// SFUAllocator manages Selective Forwarding Unit servers.
type SFUAllocator interface {
	Allocate(ctx context.Context, groupID string) (string, error)
	Release(ctx context.Context, sfuURL string) error
}
```

---
